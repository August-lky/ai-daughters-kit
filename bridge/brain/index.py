"""
两个人的脑子（小鲸鱼 / 姐姐）的记忆索引。一个模型，多个 brain，各自一份 vectors.db。

2026-10-29 搬家（大脑方案）：以前只有 memory/ 一个本子堆，索引只认「小鲸鱼」。现在每个人有自己的
  <家>/脑子/（见 brains.json），索引放在 脑子/.索引/vectors.db。这里按 brains.json 遍历，不再写死路径。

分层（脑子里的文件夹）：
  身份/   soul / self / 我自己      —— 不变的人格，不衰减
  长期/   关于老大、答应过的事、日常、memory —— 重要事实，半年衰减一半
  人/     在意的人各一页
  日子/   日记、碎碎念、成长札记    —— 日记和碎碎念两周衰减一半，其余两个月
  最近/   交接、便签                —— 两周
  笔记/   学到的、工具集            —— 半年
  向量库  上面这些的 chunk + embedding，用来"想不起来时按意思找"
  瞬间/   发生过的原话（jsonl，一个瞬间一块）—— 2026-10-29 下半接进来，按话题想起时能翻到
不进索引的：归档/（含旧稿）、作品/（她写的诗和故事，不是发生过的事）、
  共享/合写 里的小说、家/妈妈（不属于脑子）——小说和编的句子不能被当成事实想起来。

用法：
  python index.py build [brain|all]       重建索引（缺省：全部）
  python index.py search "文本" [--brain sister]
  python index.py stats [brain]
"""
import array
import hashlib
import json
import math
import os
import re
import sqlite3
import sys
import time as _time
from datetime import datetime, timedelta, timezone
from pathlib import Path

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

HERE = Path(__file__).resolve().parent
CONFIG_FILE = HERE / "brains.json"
MODEL = "BAAI/bge-small-zh-v1.5"
MAX_CHUNK = 420          # 每块最多多少字
MIN_CHUNK = 40           # 比这短的块并到上一块

# ── 鲜活度（会淡忘）────────────────────────────────────────────────────────
# 记忆不该是平铺的一堆纸。不同的层配不同的半衰期（天），衰减只影响排序，**不删除任何东西**。
# 鲜活度最多影响分数的 45%，剩下的 55% 永远是语义+字面重合，"很久以前但非常相关"的不会被时间压掉。
FRESH_WEIGHT = 0.45
HALF_LIFE_BY_TOP = {
    "身份": None, "长期": 180, "人": 180, "笔记": 180,
    "日子": 60, "最近": 14, "聊天记录": 14, "记过的事": 90, "瞬间": 120,
}
# 日子/ 里的日记、碎碎念流水本来就该淡得快
FAST_FADE_MARKERS = ("日记", "碎碎念")

DATE_RE = re.compile(r"(20\d{2})[-/](\d{1,2})[-/](\d{1,2})")
# 不进索引的顶层目录（相对脑子目录）。瞬间/ 是 jsonl，不走 md 这条路，由 moment_rows 单独收。
SKIP_TOP_DIRS = {"归档", "作品", "瞬间"}
# 索引表的版本：加了 private / weight / meta 三列（2026-10-29 下半）。旧库缺这几列也能读（见 _load_corpus）。
SCHEMA_VERSION = 2


# ───────────────────────────── 配置 ─────────────────────────────

def _expand(p, base):
    s = str(p or "")
    if not s:
        return None
    if s.startswith("~"):
        s = os.path.expanduser(s)
    q = Path(s)
    if not q.is_absolute():
        q = base / q
    return Path(os.path.abspath(q))


class Brain:
    """一个人的脑子在哪。属性都是 Path。"""

    def __init__(self, bid, conf, base, dsh):
        self.id = bid
        self.name = conf.get("name") or bid
        self.aliases = {str(a).lower() for a in conf.get("aliases", [])} | {bid.lower(), self.name.lower()}
        self.home = _expand(conf.get("home"), base)
        self.dir = _expand(conf.get("brain"), base)
        self.index_dir = self.dir / ".索引"
        self.db = self.index_dir / "vectors.db"
        self.archive = self.dir / "归档"
        self.merged_fish = self.archive / "remember-旧会话.json"
        # 2026-10-29 下半：按话题想起要用到的文件
        self.moments = self.dir / "瞬间"
        self.pressed = self.moments / "压着.json"
        self.demote = self.index_dir / "降权.json"
        self.recall_log = self.index_dir / "recall-log.jsonl"
        self.root = base
        self.extra = [(_expand(e.get("path"), base), e.get("kind") or "外部") for e in conf.get("extraSources", [])]
        self.fish = bool(conf.get("fishMemory"))
        self.dsh = dsh


class Config:
    def __init__(self, raw):
        self.base = _expand(raw.get("root", ".."), CONFIG_FILE.parent)
        self.dsh = _expand(raw.get("dsh", "~/.dsh"), self.base)
        self.default = raw.get("default", "whale")
        self.novel_root = _expand(raw.get("novelRoot", "共享/合写"), self.base)
        self.mom_dir = _expand(raw.get("momDir", "家/妈妈"), self.base)
        self.brains = {bid: Brain(bid, c, self.base, self.dsh) for bid, c in raw.get("brains", {}).items()}

    def resolve(self, name=None):
        """名字、别名、None（缺省小鲸鱼，兼容老调用方）都认。认不出返回 None。"""
        if name is None or str(name).strip() == "":
            return self.brains.get(self.default)
        key = str(name).strip().lower()
        if key in self.brains:
            return self.brains[key]
        for b in self.brains.values():
            if key in b.aliases:
                return b
        return None


_config = None


def config():
    global _config
    if _config is None:
        _config = Config(json.loads(CONFIG_FILE.read_text(encoding="utf-8-sig")))
    return _config


def get_brain(name=None):
    b = config().resolve(name)
    if b is None:
        raise KeyError(f"不认识的 brain：{name}")
    return b


# ───────────────────────────── 小说不进回忆 ─────────────────────────────

def _norm_path(p):
    # 和 novel.js 的 norm 一样：绝对路径、斜杠统一、去尾斜杠、小写。不解析联接（path.resolve 也不解析）。
    return os.path.abspath(str(p)).replace("\\", "/").rstrip("/").lower()


def is_novel_path(p):
    """规则对齐 src/novel.js 的 isNovelPath：合写目录里的、旧稿目录（归档/旧稿）里的，都是小说，不进回忆。
    小说里的句子不是发生过的事，被当成回忆想起来就成了「编的句子被当成事实」。"""
    if not p:
        return False
    q = _norm_path(p)
    cfg = config()
    r = _norm_path(cfg.novel_root)
    if q == r or q.startswith(r + "/"):
        return True
    if re.search(r"(^|/)共享/合写(/|$)", q):          # 根目录搬了家也认得
        return True
    if re.search(r"(^|/)归档/旧稿(/|$)", q):           # 两份合并前的旧稿
        return True
    return False


def is_mom_path(p):
    """家/妈妈 不属于任何人的脑子，不进索引。"""
    q = _norm_path(p)
    r = _norm_path(config().mom_dir)
    return q == r or q.startswith(r + "/")


# ───────────────────────────── 日期与鲜活度 ─────────────────────────────

def parse_date_ts(text, fallback=0.0):
    """从文本里找第一个 2026-10-20 / 2026/10/20 形状的日期，找不到用兜底值。"""
    m = DATE_RE.search(str(text or ""))
    if not m:
        return fallback
    try:
        return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3))).timestamp()
    except ValueError:
        return fallback


def half_life_for(kind, rel=""):
    if kind == "日子" and any(m in rel for m in FAST_FADE_MARKERS):
        return 14
    return HALF_LIFE_BY_TOP.get(kind, 90)


def freshness(kind, date_ts, now=None, rel=""):
    """0~1 之间的鲜活度。1 = 刚刚，0.5 = 过了一个半衰期。"""
    half = half_life_for(kind, rel)
    if not half or not date_ts:
        return 1.0
    now = now if now is not None else _time.time()
    age_days = max(0.0, (now - float(date_ts)) / 86400.0)
    return 0.5 ** (age_days / float(half))


# ───────────────────────────── 读来源 ─────────────────────────────

def rambling_as_entries(text):
    """碎碎念是"——10月22日 周四——"分天、一行一句的流水，整天连成一段切出来太粗。
    转成「## 2026-10-22」+ 每行一条「- …」，这样一句一块、每块都带日期（淡忘也按那天算）。"""
    year = datetime.now().year
    out = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            continue
        m = re.match(r"^—+\s*(\d{1,2})月(\d{1,2})日", s)
        if m:
            out.append(f"\n## {year}-{int(m.group(1)):02d}-{int(m.group(2)):02d}\n")
            continue
        out.append("- " + s.lstrip("-* ").rstrip("*").strip())
    return "\n".join(out)


def iter_sources(brain):
    """产出 (kind, path, rel)：kind 是脑子里的顶层文件夹名（身份/长期/…），rel 是索引里显示的相对路径（不带 .md）。"""
    base = brain.dir
    if base.exists():
        for md in sorted(base.rglob("*.md")):
            rel_parts = md.relative_to(base).parts
            if any(p.startswith(".") for p in rel_parts[:-1]):
                continue                                   # .索引 / .obsidian 这类
            if len(rel_parts) > 1 and rel_parts[0] in SKIP_TOP_DIRS:
                continue
            if is_novel_path(md) or is_mom_path(md):
                continue
            kind = rel_parts[0] if len(rel_parts) > 1 else "长期"
            yield kind, md, "/".join(rel_parts)[:-3]
    for xdir, xkind in brain.extra:
        if not xdir or not xdir.exists():
            continue
        for md in sorted(xdir.rglob("*.md")):
            if is_novel_path(md) or is_mom_path(md):
                continue
            yield xkind, md, f"{xkind}/{md.stem}"


_plugin_cache = {}


def _iso_ts(s):
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:  # noqa: BLE001
        return 0.0


def _load_json(p):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8-sig"))
    except Exception:  # noqa: BLE001
        return None


def plugin_memories(brain, max_age=60.0):
    """dsh-fish-memory 里她 remember 过的事（只读）：旧会话合并档 + 现在在用的会话。
    返回 [{id, text, ts, label, key}]，同一个事实键只留最新的。缓存 max_age 秒——在用的会话文件每轮都在写，
    不能每 5 秒都重读 600KB。"""
    if not brain.fish:
        return []
    hit = _plugin_cache.get(brain.id)
    if hit and _time.time() - hit[0] < max_age:
        return hit[1]
    sources = []
    if brain.merged_fish.exists():
        sources.append((brain.merged_fish, "以前的会话"))
    links = _load_json(brain.dsh / "fish-memory-links.json") or {}
    for g in links.get("groups", []) or []:
        for sid, label in (g.get("sessions") or {}).items():
            if str(sid).startswith("session-"):
                f = brain.dsh / "fish-memory" / (re.sub(r"[^a-zA-Z0-9_-]", "_", sid) + ".json")
                if f.exists():
                    sources.append((f, str(label)))
    by_key, plain = {}, {}
    for f, label in sources:
        data = _load_json(f) or {}
        for m in data.get("memories", []) or []:
            if not isinstance(m, dict) or not m.get("text") or m.get("refinedSkip") or m.get("已被取代"):
                continue
            ts = _iso_ts(m.get("at") or m.get("createdAt") or "")
            item = {"id": str(m.get("id") or hashlib.sha1(m["text"].encode()).hexdigest()[:12]),
                    "text": str(m["text"]).strip(), "ts": ts, "label": label,
                    "key": m.get("事实键") or ""}
            if item["key"]:
                old = by_key.get(item["key"])
                if old is None or old["ts"] <= ts:
                    by_key[item["key"]] = item
            else:
                norm = re.sub(r"\s+", "", item["text"])
                old = plain.get(norm)
                if old is None or old["ts"] <= ts:
                    plain[norm] = item
    out = list(by_key.values()) + list(plain.values())
    _plugin_cache[brain.id] = (_time.time(), out)
    return out


BJ = timezone(timedelta(hours=8))


def clock_skew_ms(brain):
    """这台机器的时钟比真实时间快多少毫秒（桥接量出来存在 state/clock-skew.json）；读不到就是 0。只用来给人看的时间校正。"""
    try:
        j = json.loads((Path(brain.root) / "state" / "clock-skew.json").read_text(encoding="utf-8-sig"))
        return float(j.get("skewMs") or 0)
    except Exception:  # noqa: BLE001
        return 0.0


def bj_label(ms, skew_ms=0.0, fmt="%m/%d %H:%M"):
    """机器毫秒时间戳 → 北京时间的 月/日 时:分（减掉时钟偏差）。"""
    try:
        return datetime.fromtimestamp((float(ms) - float(skew_ms)) / 1000.0, tz=BJ).strftime(fmt)
    except Exception:  # noqa: BLE001
        return "??/?? ??:??"


def key_safe(key):
    """和 src/episodes.js 的 keySafe 一样：会话 key → 文件名安全的形式（private:123 → private_123）。"""
    return re.sub(r"[^\w一-龥.\-]", "_", str(key or "").replace(":", "_"))


def moment_place(stem):
    """瞬间文件名（会话 key 的安全形式）→ 给人看的地方。不带 QQ 号。"""
    if stem.startswith("private_"):
        return "私聊"
    if stem.startswith("group_"):
        return "群里"
    if stem == "douyin_dm":
        return "抖音私信"
    if stem.startswith("douyin_friend_"):
        return "抖音私信"
    return "某处"


def is_private_stem(stem):
    """瞬间文件是不是私聊类（QQ 私聊、抖音私信）：在别处想起来时要标「私聊里的」。"""
    return stem.startswith(("private_", "douyin_"))


def _clip(text, n):
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    return t if len(t) <= n else t[: n - 1] + "…"


def moment_rows(brain):
    """瞬间/<出处>.jsonl 里的每个瞬间一块。检索时 text 用全文，展示用 meta.brief（短）。"""
    d = brain.moments
    if not d.exists():
        return []
    skew = clock_skew_ms(brain)
    out = []
    for f in sorted(d.glob("*.jsonl")):
        stem = f.stem
        try:
            lines = f.read_text(encoding="utf-8-sig").splitlines()
        except OSError:
            continue
        place = moment_place(stem)
        private = is_private_stem(stem)
        for line in lines:
            if not line.strip():
                continue
            try:
                ep = json.loads(line)
            except ValueError:
                continue
            them = [str(x) for x in (ep.get("them") or []) if x]
            me = [str(x) for x in (ep.get("me") or []) if x]
            if not them and not me:
                continue
            at = float(ep.get("at") or 0)
            felt = str(ep.get("felt") or "").strip()
            inner = str(ep.get("inner") or "").strip()
            mood = ep.get("mood") if isinstance(ep.get("mood"), dict) else None
            when = bj_label(at, skew)
            parts = [f"{when} {place}：" + "；".join(them)]
            if me:
                parts.append("你：" + "；".join(me))
            if inner:
                parts.append("当时心里：" + inner)
            if felt:
                parts.append("后来写下的感觉：" + felt)
            text = _clip("；".join(parts), 800)
            first = them[-1] if them else ""
            brief = first + (f" → 你：{me[0]}" if me else "")
            brief = _clip(brief, 110) + (f"（你写下的感觉：{_clip(felt, 50)}）" if felt else "")
            heavy = bool(mood) and (abs(float(mood.get("d") or 0)) >= 3 or abs(float(mood.get("dd") or 0)) >= 4)
            weight = min(1.0, 0.5 + (0.25 if felt else 0) + (0.1 if ep.get("source") == "live" else 0) + (0.1 if heavy else 0))
            ep_id = str(ep.get("id") or hashlib.sha1(line.encode()).hexdigest()[:10])
            cid = hashlib.sha1(f"瞬间/{stem}#{ep_id}".encode()).hexdigest()[:16]
            out.append({
                "id": cid, "person": brain.name, "kind": "瞬间", "source": f"瞬间/{stem}", "heading": place,
                "label": f"瞬间 · {when} {place}", "text": text, "date_ts": at / 1000.0 if at else 0.0,
                "private": 1 if private else 0, "weight": weight,
                "meta": {"epId": ep_id, "file": stem, "brief": brief, "felt": bool(felt), "heavy": heavy,
                         "mood": mood or None},
            })
    return out


def importance_for(kind, text):
    """块的重要度（0~1）：看它在哪一层，再看有没有「答应 / 一定 / 别忘」这类字。engine.py 的 importance 的本地版，不调模型。"""
    base = {"身份": 0.9, "长期": 0.8, "人": 0.7, "记过的事": 0.65, "笔记": 0.55, "瞬间": 0.6,
            "日子": 0.5, "最近": 0.4, "聊天记录": 0.35}.get(kind, 0.5)
    if re.search(r"答应|承诺|一定|必须|千万|别忘|记住|重要|约好|生日|喜欢|讨厌|害怕", str(text or "")):
        base += 0.1
    return min(1.0, base)


def is_private_chatlog(stem):
    """姐姐的聊天记录：文件名里带 -群 的是群聊，其余（-老大 和跟小鲸鱼的）都是私聊。"""
    return "-群" not in stem


def source_signature(brain):
    """本子的指纹：路径 + 修改时间 + 大小；加上她 remember 过的事和瞬间的指纹。任何一处被改都会变。"""
    items = []
    for _kind, md, rel in iter_sources(brain):
        try:
            st = md.stat()
        except OSError:
            continue
        items.append(f"{rel}:{st.st_mtime_ns}:{st.st_size}")
    if brain.moments.exists():
        for f in sorted(brain.moments.glob("*.jsonl")):
            try:
                st = f.stat()
            except OSError:
                continue
            items.append(f"瞬间/{f.stem}:{st.st_mtime_ns}:{st.st_size}")
    items.append(f"schema:{SCHEMA_VERSION}")
    pm = plugin_memories(brain)
    if pm:
        h = hashlib.sha1("|".join(sorted(f"{m['id']}:{len(m['text'])}" for m in pm)).encode()).hexdigest()[:12]
        items.append(f"remember:{len(pm)}:{h}")
    return "|".join(items)


def chunk_text(text):
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


def collect_rows(brain):
    rows = {}
    for kind, path, rel in iter_sources(brain):
        try:
            text = path.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        if path.name == "碎碎念.md":
            text = rambling_as_entries(text)
        try:
            file_ts = path.stat().st_mtime
        except OSError:
            file_ts = 0.0
        file_ts = parse_date_ts(path.name, file_ts)   # 文件名里的日期（日记/2026-10-20.md）优先，其次 mtime
        for idx, (head, body) in enumerate(chunk_text(text)):
            cid = hashlib.sha1(f"{rel}#{idx}".encode()).hexdigest()[:16]
            rows[cid] = {
                "id": cid, "person": brain.name, "kind": kind, "source": rel, "heading": head,
                "label": rel + (f" · {head}" if head else ""),
                "text": body,
                # 条目自己的日期最重要（"2026-10-20：没事做不等于困"），找不到才退回文件级。
                "date_ts": parse_date_ts(f"{head}\n{body}", file_ts),
                # 姐姐的聊天记录里，私聊的标「私聊里的」（想起来时说不说她自己掂量）
                "private": 1 if (kind == "聊天记录" and is_private_chatlog(path.stem)) else 0,
                "weight": importance_for(kind, body),
                "meta": None,
            }
    for m in plugin_memories(brain):
        cid = hashlib.sha1(f"remember#{m['id']}".encode()).hexdigest()[:16]
        rows[cid] = {
            "id": cid, "person": brain.name, "kind": "记过的事", "source": f"remember/{m['id']}", "heading": m["label"],
            "label": f"记过的事 · {m['label']}", "text": m["text"][:800],
            "date_ts": m["ts"] or 0.0, "private": 0, "weight": importance_for("记过的事", m["text"]), "meta": None,
        }
    for r in moment_rows(brain):
        rows[r["id"]] = r
    return list(rows.values())


# ───────────────────────────── 建索引 ─────────────────────────────

def _table_columns(conn):
    return {r[1] for r in conn.execute("PRAGMA table_info(chunks)")}


def _existing_vectors(db):
    """旧索引里 (id → (text, 向量字节))：文字没变的块直接沿用旧向量，不再喂模型（瞬间一条条加进来时重建才快）。
    模型换了或旧库读不出来就返回空。"""
    if not db.exists():
        return {}
    try:
        conn = sqlite3.connect(db, timeout=10)
        try:
            meta = dict(conn.execute("SELECT k, v FROM meta").fetchall())
        except sqlite3.Error:
            meta = {}
        if meta.get("model") != MODEL:
            conn.close()
            return {}
        out = {rid: (text, vec) for rid, text, vec in conn.execute("SELECT id, text, vec FROM chunks")}
        conn.close()
        return out
    except Exception:  # noqa: BLE001
        return {}


def build(brain=None, model=None):
    """
    切块 + 生成向量 + 重写这个 brain 的 vectors.db。

    model 可传入已加载的模型实例（service.py 常驻进程复用同一个，避免反复加载）。
    文字没变的块沿用旧向量（只给新的、改过的块算向量）。
    返回切出的块数，0 表示没有内容可索引。
    """
    brain = brain if isinstance(brain, Brain) else get_brain(brain)
    rows = collect_rows(brain)
    if not rows:
        print(f"[{brain.id}] 没有可索引的内容", flush=True)
        return 0

    old = _existing_vectors(brain.db)
    todo = [r for r in rows if old.get(r["id"], (None, None))[0] != r["text"]]
    print(f"[{brain.id}] 切出 {len(rows)} 块（其中 {len(todo)} 块要新算向量）…", flush=True)
    fresh = {}
    if todo:
        if model is None:
            from fastembed import TextEmbedding
            model = TextEmbedding(MODEL)
        # 2026-10-26：默认一批 256 段、每段最长 512 字，注意力矩阵一批就要 ~2GB，推理库内存池记住峰值不还，
        # 服务跑几天涨到 5.9GB。一批 16 段，峰值一百多 MB。
        for r, v in zip(todo, model.embed([r["text"] for r in todo], batch_size=16)):
            fresh[r["id"]] = array.array("f", [float(x) for x in v]).tobytes()

    brain.index_dir.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(brain.db, timeout=10)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY,
            person TEXT, kind TEXT, source TEXT, heading TEXT, label TEXT,
            text TEXT, vec BLOB, date_ts REAL
        )
    """)
    # 2026-10-29 下半：新加三列（旧库补上）——private（私聊来源）、weight（重要度）、meta（瞬间的编号 / 短摘要 / 心情）
    have = _table_columns(conn)
    for col, decl in (("private", "INTEGER DEFAULT 0"), ("weight", "REAL"), ("meta", "TEXT")):
        if col not in have:
            conn.execute(f"ALTER TABLE chunks ADD COLUMN {col} {decl}")
    conn.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
    # 一个事务里整体换掉：正在搜的读者看到的要么全是旧的、要么全是新的。
    with conn:
        conn.execute("DELETE FROM chunks")
        for r in rows:
            blob = fresh.get(r["id"]) or old[r["id"]][1]
            conn.execute(
                "INSERT INTO chunks (id, person, kind, source, heading, label, text, vec, date_ts, private, weight, meta) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (r["id"], r["person"], r["kind"], r["source"], r["heading"], r["label"], r["text"],
                 blob, r["date_ts"], int(r.get("private") or 0), r.get("weight"),
                 json.dumps(r["meta"], ensure_ascii=False) if r.get("meta") else None),
            )
        conn.execute("INSERT OR REPLACE INTO meta VALUES ('model', ?)", (MODEL,))
        conn.execute("INSERT OR REPLACE INTO meta VALUES ('schema', ?)", (str(SCHEMA_VERSION),))
    conn.close()
    _vec_cache.pop(str(brain.db), None)
    print(f"[{brain.id}] 索引完成 → {brain.db}（{brain.db.stat().st_size // 1024} KB）", flush=True)
    return len(rows)


# ───────────────────────────── 检索 ─────────────────────────────

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


_vec_cache = {}   # db路径 -> (mtime_ns, size, rows, matrix)


def load_vectors(db):
    """读一个 vectors.db：返回 (rows, 归一化的矩阵)。rows 是 dict 列表（旧库没有 private / weight / meta 列就补默认）。
    按文件的修改时间缓存。"""
    import numpy as np
    key = str(db)
    st = db.stat()
    hit = _vec_cache.get(key)
    if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
        return hit[2], hit[3]
    conn = sqlite3.connect(db, timeout=10)
    cols = _table_columns(conn)
    sel = "id, person, label, text, vec, kind, date_ts, source, heading"
    for col in ("private", "weight", "meta"):
        sel += f", {col}" if col in cols else ", NULL"
    rows, vecs = [], []
    for rid, person, label, text, blob, kind, date_ts, source, heading, private, weight, meta in conn.execute(f"SELECT {sel} FROM chunks"):
        try:
            meta_obj = json.loads(meta) if meta else None
        except ValueError:
            meta_obj = None
        rows.append({"id": rid, "person": person, "label": label, "text": text, "kind": kind,
                     "date_ts": date_ts or 0.0, "source": source, "heading": heading or "",
                     "private": int(private or 0), "weight": weight, "meta": meta_obj})
        vecs.append(np.frombuffer(blob, dtype=np.float32))
    conn.close()
    mat = np.vstack(vecs) if vecs else np.zeros((0, 1), dtype=np.float32)
    norms = np.linalg.norm(mat, axis=1)
    norms[norms == 0] = 1.0
    mat = mat / norms[:, None]
    _vec_cache[key] = (st.st_mtime_ns, st.st_size, rows, mat)
    return rows, mat


def search(query, k=5, brain=None, person=None, model=None):
    """命令行和老调用用的检索：打分走 recall.py（关键词 / 语义 / 重要度 / 新鲜度 / 同源邻居 + 本地去重，不调模型）。
    返回 [{score, vec, lit, fresh, person, label, text, age_days, source, kind, ...}]，按分数从高到低。"""
    import recall
    brain = brain if isinstance(brain, Brain) else get_brain(brain)
    return recall.search_hits(brain, query, k=k, person=person, model=model)


def stats(brain=None):
    brain = brain if isinstance(brain, Brain) else get_brain(brain)
    if not brain.db.exists():
        return {"ok": False, "error": "还没有索引"}
    conn = sqlite3.connect(brain.db, timeout=10)
    try:
        total = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        by_kind = {k: n for k, n in conn.execute("SELECT kind, COUNT(*) FROM chunks GROUP BY kind")}
    finally:
        conn.close()
    return {"ok": True, "brain": brain.id, "total": total, "byKind": by_kind,
            "kb": brain.db.stat().st_size // 1024}


def _cli():
    argv = sys.argv[1:]
    cmd = argv[0] if argv else "stats"
    rest = argv[1:]
    brain_arg = None
    if "--brain" in rest:
        i = rest.index("--brain")
        brain_arg = rest[i + 1] if i + 1 < len(rest) else None
        rest = rest[:i] + rest[i + 2:]
    if cmd == "build":
        target = (rest[0] if rest else brain_arg) or "all"
        names = list(config().brains) if target == "all" else [target]
        for n in names:
            t0 = _time.time()
            c = build(n)
            print(f"[{get_brain(n).id}] {c} 块，用时 {_time.time() - t0:.1f}s")
    elif cmd == "search":
        q = " ".join(rest)
        for h in search(q, brain=brain_arg):
            age = f"（{h['age_days']} 天前）" if h["age_days"] is not None else ""
            print(f"[{h['score']:.3f}] {h['label']}{age}")
            print("   " + h["text"].replace("\n", " ")[:140])
    elif cmd == "stats":
        names = [rest[0]] if rest else (list(config().brains) if not brain_arg else [brain_arg])
        for n in names:
            print(json.dumps(stats(n), ensure_ascii=False))
    else:
        print(__doc__)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass
    _cli()
