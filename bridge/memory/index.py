"""
小鲸鱼 / 妈妈 的记忆索引。

分层：
  soul.md    —— 不变的人格
  memory.md  —— 重要且稳定的事实
  diary/     —— 按日期的流水
  向量库     —— 上面三者的 chunk + embedding，用来"想不起来时按意思找"

用法：
  python index.py build            重建索引
  python index.py search "文本"     语义检索
  python index.py stats            看索引状态
"""
import os
import sys
import json
import re
import sqlite3
import hashlib
from datetime import datetime
from pathlib import Path

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

ROOT = Path(__file__).resolve().parent
DB = ROOT / "vectors.db"
MODEL = "BAAI/bge-small-zh-v1.5"
MAX_CHUNK = 420          # 每块最多多少字
MIN_CHUNK = 40           # 比这短的块并到上一块

# ── 鲜活度（会淡忘）────────────────────────────────────────────────────────
# 借鉴 dsh-fish-memory 的思路：记忆不该是平铺的一堆纸。
# 以前 diary 里三个月前的琐事和「夜里长睡白天最多两小时」是平权的，
# 搜「睡觉」可能先跳出某天的流水。这里给不同层配不同的半衰期：
#   soul   —— 不衰减。她是谁，不该随时间变淡
#   memory —— 半年衰减一半。重要事实，但也会被更新的事实取代
#   diary  —— 两周衰减一半。流水本来就该淡
# 衰减只影响排序，**不删除任何东西** —— 淡下去的内容永远还能翻到。
HALF_LIFE_DAYS = {"soul": None, "memory": 180, "diary": 14}
# 鲜活度最多影响分数的 45%，剩下的 55% 永远是语义+字面重合。
# 这样"很久以前但非常相关"的记忆不会被时间完全压掉。
FRESH_WEIGHT = 0.45

DATE_RE = re.compile(r"(20\d{2})[-/](\d{1,2})[-/](\d{1,2})")


def parse_date_ts(text, fallback=0.0):
    """从文本里找第一个 2026-10-20 / 2026/10/20 形状的日期，找不到用兜底值。"""
    m = DATE_RE.search(str(text or ""))
    if not m:
        return fallback
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3))).timestamp()
    except ValueError:
        return fallback


def freshness(kind, date_ts, now=None):
    """0~1 之间的鲜活度。1 = 刚刚，0.5 = 过了一个半衰期。"""
    half = HALF_LIFE_DAYS.get(kind)
    if not half:
        return 1.0
    if not date_ts:
        return 1.0
    import time as _time
    now = now if now is not None else _time.time()
    age_days = max(0.0, (now - float(date_ts)) / 86400.0)
    return 0.5 ** (age_days / float(half))


# 2026-10-22：她用 memory_append 写的本子（主人.md、答应过的事.md、日常.md…）都在 memory/ 根目录，
# 每天的日记写在 Rambling/碎碎念/碎碎念.md —— 以前这两处都不在索引里，memory_recall 永远翻不到。
RAMBLING = Path(r"E:\qq-bridge\Rambling\碎碎念\碎碎念.md")


def source_rel(path):
    """索引里显示的相对路径；不在 ROOT 下的（碎碎念）用「碎碎念/文件名」。"""
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return "碎碎念/" + path.name


def rambling_as_entries(text):
    """碎碎念是"——10月22日 周四——"分天、一行一句的流水，整天连成一段切出来太粗。
    转成「## 2026-10-22」+ 每行一条「- …」，这样一句一块、每块都带日期（淡忘也按那天算）。"""
    import re as _re
    year = datetime.now().year
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        m = _re.match(r"^—+\s*(\d{1,2})月(\d{1,2})日", s)
        if m:
            out.append(f"\n## {year}-{int(m.group(1)):02d}-{int(m.group(2)):02d}\n")
            continue
        out.append("- " + s.lstrip("-* ").rstrip("*").strip())
    return "\n".join(out)


def iter_sources():
    """产出 (person, kind, path)。跳过 _old / 隐藏目录。"""
    for person_dir in sorted(ROOT.iterdir()):
        if not person_dir.is_dir():
            continue
        if person_dir.name.startswith(".") or person_dir.name.startswith("_"):
            continue
        for md in sorted(person_dir.rglob("*.md")):
            rel = md.relative_to(person_dir).as_posix()
            kind = rel.split("/")[0] if "/" in rel else rel.replace(".md", "")
            yield person_dir.name, kind, md
    # 根目录的本子：她自己的长期事实，按 memory 的慢淡忘算
    for md in sorted(ROOT.glob("*.md")):
        yield "小鲸鱼", "memory", md
    # 碎碎念 = 日记，按 diary 的快淡忘算
    if RAMBLING.exists():
        yield "小鲸鱼", "diary", RAMBLING


def chunk_text(text, source_label):
    """
    切块策略：**按条目**，不是按段落。
    - `## 标题` 切节
    - `- xxx` / `> xxx` 每个条目单独成块（记忆天然是条目化的，整段一起会稀释语义）
    - 普通段落按空行切
    - 太短的块并到上一块，超过 MAX_CHUNK 的再拆
    """
    raw_blocks = []
    head = ""
    buf = []

    def flush():
        nonlocal buf
        if buf:
            body = "\n".join(buf).strip()
            if body:
                raw_blocks.append((head, body))
            buf = []

    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        if s.startswith("## "):
            flush()
            head = s[3:].strip()
            continue
        if s.startswith("- ") or s.startswith("> ") or s.startswith("* "):
            flush()
            buf = [s]
            continue
        if s.startswith("#"):
            continue  # 一级标题不进正文
        buf.append(s)
    flush()

    # 过长的块再按句子拆，过短的并到上一块
    out = []
    for h, b in raw_blocks:
        while len(b) > MAX_CHUNK:
            cut = b.rfind("。", 0, MAX_CHUNK)
            if cut < MAX_CHUNK // 2:
                cut = MAX_CHUNK
            out.append((h, b[:cut].strip()))
            b = b[cut:].strip()
        if not b:
            continue
        if out and len(b) < MIN_CHUNK:
            ph, pb = out[-1]
            out[-1] = (ph, pb + "\n" + b)
        else:
            out.append((h, b))

    return [(h, b) for h, b in out if len(b) >= 8]


def build(model=None):
    """
    切块 + 生成向量 + 重写 vectors.db。

    model 可传入已加载的模型实例（service.py 常驻进程复用同一个，避免反复加载）。
    返回切出的块数，0 表示没有内容可索引。
    """
    from fastembed import TextEmbedding

    rows = []
    for person, kind, path in iter_sources():
        text = path.read_text(encoding="utf-8")
        if path == RAMBLING:
            text = rambling_as_entries(text)
        rel = source_rel(path)
        # 文件级兜底日期：文件名里的日期（diary/2026-10-20.md）优先，其次文件 mtime。
        try:
            file_ts = path.stat().st_mtime
        except OSError:
            file_ts = 0.0
        file_ts = parse_date_ts(path.name, file_ts)
        for idx, (head, body) in enumerate(chunk_text(text, rel)):
            label = f"{person}/{kind}" + (f" · {head}" if head else "")
            rows.append({
                "id": hashlib.sha1(f"{rel}#{idx}".encode()).hexdigest()[:16],
                "person": person,
                "kind": kind,
                "source": rel,
                "heading": head,
                "label": label,
                "text": body,
                # 条目自己的日期最重要（"2026-10-20：没事做不等于困"），找不到才退回文件级。
                "date_ts": parse_date_ts(f"{head}\n{body}", file_ts),
            })

    if not rows:
        print("没有可索引的内容", flush=True)
        return 0

    print(f"切出 {len(rows)} 块，开始生成向量…", flush=True)
    if model is None:
        model = TextEmbedding(MODEL)
    # 2026-10-26：默认一批 256 段、每段最长 512 字，注意力矩阵一批就要 ~2GB，推理库内存池记住峰值不还，
    # 服务跑几天涨到 5.9GB。一批 16 段，峰值一百多 MB，188 段照样几秒建完。
    vecs = list(model.embed([r["text"] for r in rows], batch_size=16))

    conn = sqlite3.connect(DB, timeout=10)
    conn.execute("DROP TABLE IF EXISTS chunks")
    conn.execute("""
        CREATE TABLE chunks (
            id TEXT PRIMARY KEY,
            person TEXT, kind TEXT, source TEXT, heading TEXT, label TEXT,
            text TEXT, vec BLOB, date_ts REAL
        )
    """)
    import array
    for r, v in zip(rows, vecs):
        arr = array.array("f", [float(x) for x in v])
        conn.execute(
            "INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)",
            (r["id"], r["person"], r["kind"], r["source"], r["heading"], r["label"], r["text"], arr.tobytes(), r["date_ts"]),
        )
    conn.commit()
    conn.close()
    print(f"索引完成 → {DB}（{DB.stat().st_size // 1024} KB）", flush=True)
    return len(rows)


def literal_score(query, text):
    """字面重合度：query 的 2-gram 在文本里出现了多少比例。专有名词靠这个。"""
    q = "".join(query.split())
    if not q:
        return 0.0
    grams = {q[i:i + 2] for i in range(len(q) - 1)} if len(q) > 1 else {q}
    if not grams:
        return 0.0
    hits = sum(1 for g in grams if g in text)
    return hits / len(grams)


def search(query, k=5, person=None, model=None):
    import array
    import math
    import time as _time

    if not DB.exists():
        print("还没有索引，先跑 build")
        return []
    from fastembed import TextEmbedding
    if model is None:
        model = TextEmbedding(MODEL)
    qv = list(model.embed([query]))[0]
    q = array.array("f", [float(x) for x in qv])
    qn = math.sqrt(sum(x * x for x in q)) or 1.0

    now = _time.time()
    conn = sqlite3.connect(DB, timeout=10)
    sql = "SELECT person, label, text, vec, kind, date_ts FROM chunks"
    args = ()
    if person:
        sql += " WHERE person = ?"
        args = (person,)
    hits = []
    for p, label, text, blob, kind, date_ts in conn.execute(sql, args):
        v = array.array("f")
        v.frombytes(blob)
        dot = sum(a * b for a, b in zip(q, v))
        vn = math.sqrt(sum(x * x for x in v)) or 1.0
        vec = dot / (qn * vn)
        lit = literal_score(query, text)
        # 混合打分：语义为主，字面兜专有名词（歌名、BV号、外号）
        base = 0.65 * vec + 0.35 * lit
        # 再乘一层时间感：新的更容易被想起来，旧的慢慢沉下去（但不删）。
        fresh = freshness(kind, date_ts, now)
        score = base * (1.0 - FRESH_WEIGHT + FRESH_WEIGHT * fresh)
        age_days = int(max(0.0, (now - float(date_ts)) / 86400.0)) if date_ts else None
        hits.append((score, vec, lit, p, label, text, age_days, fresh))
    conn.close()
    hits.sort(key=lambda x: -x[0])
    return [(h[0], h[3], h[4], h[5], h[6]) for h in hits[:k]]


def stats():
    if not DB.exists():
        print("还没有索引")
        return
    conn = sqlite3.connect(DB)
    total = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    print(f"总块数: {total}   ({DB.stat().st_size // 1024} KB)")
    for person, n in conn.execute("SELECT person, COUNT(*) FROM chunks GROUP BY person"):
        print(f"  {person}: {n}")
    for kind, n in conn.execute("SELECT kind, COUNT(*) FROM chunks GROUP BY person, kind"):
        print(f"    · {kind}: {n}")
    conn.close()


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "stats"
    if cmd == "build":
        build()
    elif cmd == "search":
        q = " ".join(sys.argv[2:])
        for score, person, label, text, age_days in search(q):
            age = f"（{age_days} 天前）" if age_days is not None else ""
            print(f"[{score:.3f}] {label}{age}")
            print("   " + text.replace("\n", " ")[:140])
    elif cmd == "stats":
        stats()
    else:
        print(__doc__)
