"""
按话题想起：打分、想起、降权、睡前整理建议、压在心里的事。service.py 只管 HTTP，规则都在这里。

2026-10-29 大脑方案下半（老大：记忆统一，不拆；私聊只标注不过滤）。参照「鱼的记忆」里 astrbot_plugin_memory_brain 的
engine.py，机制照着重写，不调模型：
  打分 = 关键词 0.46 + 语义 0.18 + 重要度 0.14 + 新鲜度 0.11 + 同源邻居 0.11（engine 里的「图谱」这一路，我们没有实体图，
        改成「同一本子里已经有话题接近的段落」），再乘降权表，最后本地去重（两段话 2-gram 重合 ≥0.82 只留一段）。
  关键词那一路：engine 用全文检索的名次，我们用「带 IDF 的 2-gram 覆盖率」（专有名词、外号、歌名靠它），
        覆盖到 50% 就算满分；语义那一路：bge-small 的余弦值里「不相干」也有 0.3～0.45，所以把 0.35～0.80 拉成 0～1。

想起（/recall）：用「这句 + 前两句」去搜。私聊带 2 条；群里带 1 条，门槛更高（关键词 / 语义都要更贴）。
  不收：身份/（每次都带着）、最近/ 的便签和交接（唤醒里已经有）、当天的聊天记录和 30 分钟内的瞬间（就在眼前）、
  跟这句话一字不差的（自己回声）。小说本来就不进索引（见 index.py 的 is_novel_path）。
  结果带出处；来自私聊的标「（私聊里的）」——只标注，不过滤，说不说她自己掂量。
  每次想起的写进 .索引/recall-log.jsonl，老大说「记错了」时 /demote 从里面取最近一次，写进 .索引/降权.json。

没有任何东西调模型；也不写她的本子（只写 .索引/ 下面的日志和降权表）。
"""
import hashlib
import json
import math
import os
import random
import re
import time
from collections import Counter, defaultdict
from pathlib import Path

import index as memindex

# ───────────────────────────── 参数（按评估集调；改了跑 scripts/test-brain-recall.py）─────────────────────────────
W_SEM = 0.18
W_KW = 0.46
W_IMP = 0.14
W_REC = 0.11
W_GRAPH = 0.11
KW_FULL = 0.50            # 关键词覆盖到这个比例就算满分
IDF_ENOUGH = 14.0         # 命中的词的 IDF 权重加起来到这个数才算证据够（约三个不常见的词；按 1200 块的语料算，小语料按 ln(块数) 等比缩）
TOPIC_MIN = 16.0          # 「这句 + 前两句」所有词的 IDF 权重加起来不到这个数（好的 / 哈哈 / 晚安 / 嗯嗯 这类），没有话题可想，直接什么都不想起
IDF_REF_CHUNKS = 1200
SEM_FLOOR, SEM_CEIL = 0.35, 0.80
DEDUP_SIMILARITY = 0.82
DEMOTE_FACTOR = (1.0, 0.35, 0.15)   # 被降权 0 / 1 / ≥2 次后分数乘多少
PART_WEIGHTS = (1.0, 0.6, 0.4)      # 这句 / 前一句 / 前两句 在关键词那一路的权重

RULES = {
    # 门槛是拿真索引里十几句试问法手调的（2026-10-29）；recall-log 攒几天后用真实情况再调，调之前后各跑一遍 test-brain-recall.py
    "private": {"k": 2, "min_score": 0.30, "kw_gate": 0.20, "cos_gate": 0.55},   # 10-29 按真实分数调：相关旧记忆一般 0.28~0.4
    "group": {"k": 1, "min_score": 0.40, "kw_gate": 0.30, "cos_gate": 0.65},
}
PRESSED_PROB = 0.35        # 话题相近时，压着的事浮上来的概率
PRESSED_COOLDOWN_H = 6     # 同一件压着的事，浮上来过之后多久内不再浮
PRESSED_GATE = {"kw": 0.25, "cos": 0.62}
RECENT_MOMENT_MIN = 30     # 这么近的瞬间就在眼前，不再「想起」
LOG_KEEP = 400             # recall-log 留多少行

_CJK = re.compile(r"[一-鿿]+")
_WORD = re.compile(r"[A-Za-z0-9_]{2,}")


# ───────────────────────────── 小工具 ─────────────────────────────

def grams(text):
    """文本里的「词」：中文连续字的 2-gram，加上英文 / 数字串（小写）。"""
    t = str(text or "").lower()
    out = set()
    for seg in _CJK.findall(t):
        for i in range(len(seg) - 1):
            out.add(seg[i:i + 2])
    out.update(_WORD.findall(t))
    return out


def text_hash(text):
    return hashlib.sha1(re.sub(r"\s+", "", str(text or ""))[:300].encode("utf-8")).hexdigest()[:12]


def overlap(ga, gb):
    """两段话的重合度：共有的词 / 较短那段的词数（engine.py 的 _similar）。太短的不算（<4 个词）。"""
    if min(len(ga), len(gb)) < 4:
        return 0.0
    return len(ga & gb) / min(len(ga), len(gb))


def mask_digits(text):
    return re.sub(r"\d{7,}", "…", str(text or ""))


def clip(text, n):
    t = re.sub(r"\s+", " ", str(text or "")).strip().replace("**", "")
    t = re.sub(r"^[-*>]\s*", "", t)
    return t if len(t) <= n else t[: n - 1] + "…"


def ago_text(age_days):
    if age_days is None:
        return ""
    if age_days < 1:
        return "今天"
    if age_days < 2:
        return "昨天"
    if age_days < 30:
        return f"{int(age_days)} 天前"
    if age_days < 365:
        return f"{int(age_days // 30)} 个月前"
    return "很久以前"


def _read_json(p, default):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8-sig"))
    except Exception:  # noqa: BLE001
        return default


def _write_json_atomic(p, obj):
    p = Path(p)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, p)


# ───────────────────────────── 语料（一个 brain 的整份索引 + 词表）─────────────────────────────

class Corpus:
    """读好的索引 + 每块的词集合、词的倒排表和文档频率（IDF 用）。按 vectors.db 的修改时间缓存。"""

    def __init__(self, rows, mat):
        self.rows = rows
        self.mat = mat
        self.n = len(rows)
        self.gsets = [grams(r["text"]) for r in rows]
        self.postings = defaultdict(list)
        for i, gs in enumerate(self.gsets):
            for g in gs:
                self.postings[g].append(i)
        self.scale = math.log(self.n + 1) / math.log(IDF_REF_CHUNKS + 1)   # 语料小的时候 IDF 数值都小，阈值跟着缩
        self.ths = [text_hash(r["text"]) for r in rows]
        self.by_ep = {r["meta"]["epId"]: i for i, r in enumerate(rows) if r.get("meta") and r["meta"].get("epId")}

    def idf(self, g):
        return math.log((self.n + 1) / (len(self.postings.get(g, ())) + 0.5))


_corpus_cache = {}


def load_corpus(db):
    key = str(db)
    st = Path(db).stat()
    hit = _corpus_cache.get(key)
    if hit and hit[0] == st.st_mtime_ns and hit[1] == st.st_size:
        return hit[2]
    rows, mat = memindex.load_vectors(Path(db))
    c = Corpus(rows, mat)
    _corpus_cache[key] = (st.st_mtime_ns, st.st_size, c)
    return c


def embed_texts(model, texts):
    import numpy as np
    vecs = []
    for v in model.embed(list(texts)):
        a = np.asarray(v, dtype=np.float32)
        n = float(np.linalg.norm(a)) or 1.0
        vecs.append(a / n)
    return vecs


# ───────────────────────────── 降权表 ─────────────────────────────

def load_demote(brain):
    """{文字指纹: 被降权的次数}。这段文字被她改过（指纹变了）就自动不再降权。"""
    j = _read_json(brain.demote, {})
    out = {}
    for it in (j.get("items") or []) if isinstance(j, dict) else []:
        if isinstance(it, dict) and it.get("th"):
            out[str(it["th"])] = int(it.get("n") or 1)
    return out


def demote_factor(n):
    return DEMOTE_FACTOR[min(int(n or 0), len(DEMOTE_FACTOR) - 1)]


# ───────────────────────────── 打分 ─────────────────────────────

def _coverage(corpus, qgrams):
    """qgrams 在每一块里的关键词分（0~1）：两样都要够——
       ① 覆盖率：命中的词的 IDF 权重 / 查询里所有词的权重（语料里从没出现过的词也算在分母里：一句话里只有「今天」「的」这种
          常用词对上了，覆盖率就很低）；覆盖到 KW_FULL 就满分；
       ② 证据量：命中的词的 IDF 权重加起来要够 IDF_ENOUGH（大概两三个不常见的词）。「好的」「哈哈」「晚安」这种一两个常用词的短句，
          覆盖率能到 100%，但证据量不够，所以拿不到高分。
    返回每一块的分数列表。"""
    total = sum(corpus.idf(g) for g in qgrams)
    cov = [0.0] * corpus.n
    if not qgrams or total <= 0:
        return cov
    for g in qgrams:
        post = corpus.postings.get(g)
        if not post:
            continue
        w = corpus.idf(g)
        for i in post:
            cov[i] += w
    enough = IDF_ENOUGH * corpus.scale
    return [min(1.0, c / total / KW_FULL) * min(1.0, c / enough) for c in cov]


def rank(corpus, brain, parts, sims, now=None, person=None, demote=None):
    """给语料里的每一块打分，返回按分数从高到低的列表（不去重、不卡门槛）。
    parts：[(权重, 文字)]，第一个是「这句」；sims：每一块和查询的余弦（numpy 数组，或 None 就不算语义）。"""
    now = now if now is not None else time.time()
    cur_cov = []
    for w, text in parts:
        if not str(text or "").strip():
            continue
        cov = _coverage(corpus, grams(text))
        cur_cov.append((w, cov))
    base = []
    for i, r in enumerate(corpus.rows):
        if person and r["person"] != person:
            continue
        kw = 0.0
        for w, cov in cur_cov:
            kw = max(kw, w * cov[i])
        cos = float(sims[i]) if sims is not None else 0.0
        sem = min(1.0, max(0.0, (cos - SEM_FLOOR) / (SEM_CEIL - SEM_FLOOR)))
        imp = r["weight"] if r.get("weight") is not None else memindex.importance_for(r["kind"], r["text"])
        fresh = memindex.freshness(r["kind"], r["date_ts"], now, r["source"])
        base.append({"i": i, "kw": kw, "cos": cos, "sem": sem, "imp": float(imp), "fresh": fresh,
                     "pre": W_KW * kw + W_SEM * sem})
    # 同源邻居：话题最贴的前 5 块（有点贴的才算）所在的本子里，其余的块也沾一点光
    seeds = [b for b in sorted(base, key=lambda b: -b["pre"])[:5] if b["pre"] >= 0.10]
    seed_src = Counter(corpus.rows[b["i"]]["source"] for b in seeds)
    seed_idx = {b["i"] for b in seeds}
    out = []
    for b in base:
        r = corpus.rows[b["i"]]
        shared = seed_src.get(r["source"], 0) - (1 if b["i"] in seed_idx else 0)
        graph = min(1.0, max(0, shared) / 3.0)
        score = b["pre"] + W_IMP * b["imp"] + W_REC * b["fresh"] + W_GRAPH * graph
        n_dem = (demote or {}).get(corpus.ths[b["i"]], 0)
        score *= demote_factor(n_dem)
        age_days = int(max(0.0, (now - float(r["date_ts"])) / 86400.0)) if r["date_ts"] else None
        out.append({**b, "graph": graph, "score": score, "demoted": n_dem, "age_days": age_days, "date_ts": r["date_ts"],
                    "id": r["id"], "person": r["person"], "label": r["label"], "text": r["text"], "kind": r["kind"],
                    "source": r["source"], "private": bool(r.get("private")), "meta": r.get("meta"), "th": corpus.ths[b["i"]]})
    out.sort(key=lambda h: -h["score"])
    return out


def dedup(corpus, hits, k):
    """本地去重：和已经选上的某一块重合度 ≥0.82 的跳过。"""
    picked, pg = [], []
    for h in hits:
        g = corpus.gsets[h["i"]]
        if any(overlap(g, other) >= DEDUP_SIMILARITY or h["text"] == picked[j]["text"] for j, other in enumerate(pg)):
            continue
        picked.append(h)
        pg.append(g)
        if len(picked) >= k:
            break
    return picked


def _query_sims(corpus, model, texts):
    """每一块和查询的余弦。texts 里每个都算一遍，取最大（这句本身 > 三句连起来 × 0.9）。"""
    sims = None
    for j, v in enumerate(embed_texts(model, texts)):
        s = corpus.mat @ v
        if j > 0:
            s = s * 0.9
        sims = s if sims is None else __import__("numpy").maximum(sims, s)
    return sims


def search_hits(brain, query, k=5, person=None, model=None, now=None, explain=False):
    """/search 和命令行：整个索引里按分数找，不卡门槛、不排除任何层。返回 hit 列表。"""
    brain = brain if isinstance(brain, memindex.Brain) else memindex.get_brain(brain)
    if not brain.db.exists():
        return []
    if model is None:
        from fastembed import TextEmbedding
        model = TextEmbedding(memindex.MODEL)
    corpus = load_corpus(brain.db)
    if not corpus.n:
        return []
    q = str(query or "").strip()
    sims = _query_sims(corpus, model, [q])
    hits = rank(corpus, brain, [(1.0, q)], sims, now=now, person=person, demote=load_demote(brain))
    out = []
    for h in dedup(corpus, hits, k):
        # 老调用方用的字段名：vec = 余弦，lit = 关键词，fresh = 新鲜度
        out.append({**h, "vec": h["cos"], "lit": h["kw"]})
    return out


# ───────────────────────────── 想起 ─────────────────────────────

def passes_gate(h, rule):
    """总分够了，而且关键词或语义至少有一路真的贴（光靠重要度和新鲜度撑起来的不算）。"""
    return h["score"] >= rule["min_score"] and (h["kw"] >= rule["kw_gate"] or h["cos"] >= rule["cos_gate"])


def _excluded_for_recall(h, cur, now):
    """想起的时候不收的：身份（每次都带着）、最近/ 的便签交接（唤醒里已经有）、当天的聊天记录和 30 分钟内的瞬间（就在眼前）、
    小说和旧稿（索引本来就不收，这里再拦一道）、跟这句话一字不差的（自己的回声）。"""
    kind, src, text = h["kind"], h["source"], h["text"]
    if kind == "身份" or src.startswith("最近/") or src.startswith("笔记/工具集"):   # 工具集是用法说明，不是回忆
        return True
    if re.search(r"(^|/)(旧稿|合写)(/|$)", src) or "半只耳朵" in src:
        return True
    if kind == "聊天记录" and (h["age_days"] is not None and h["age_days"] < 1):
        return True
    if kind == "瞬间" and h.get("date_ts") and now - float(h["date_ts"]) < RECENT_MOMENT_MIN * 60:
        return True
    if len(cur) >= 6 and cur in text:
        return True
    return False


def _line_of(h, viewer_safe):
    meta = h.get("meta") or {}
    body = meta.get("brief") or clip(h["text"], 150)
    body = clip(body, 170)
    when = ago_text(h["age_days"])
    private = bool(h["private"]) and not (meta.get("file") and meta.get("file") == viewer_safe)
    return f"· {body}（出处：{h['label']}{'，' + when if when else ''}）" + ("（私聊里的）" if private else ""), private


def _recent_log(brain, n=LOG_KEEP):
    try:
        lines = Path(brain.recall_log).read_text(encoding="utf-8").splitlines()[-n:]
    except OSError:
        return []
    out = []
    for ln in lines:
        try:
            out.append(json.loads(ln))
        except ValueError:
            continue
    return out


def _append_log(brain, entry):
    p = Path(brain.recall_log)
    p.parent.mkdir(parents=True, exist_ok=True)
    with open(p, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    try:
        if p.stat().st_size > 512 * 1024:
            keep = p.read_text(encoding="utf-8").splitlines()[-LOG_KEEP:]
            tmp = p.with_name(p.name + f".{os.getpid()}.tmp")
            tmp.write_text("\n".join(keep) + "\n", encoding="utf-8")
            os.replace(tmp, p)
    except OSError:
        pass


def _pressed_pick(brain, corpus, qgrams, sims, cur_len, now, rng, prob):
    """压着的事：话题相近（比平常的门槛严）才有机会，再按概率掷一次；同一件 6 小时内浮过就不再浮。返回一条 dict 或 None。"""
    j = _read_json(brain.pressed, {})
    items = [x for x in (j.get("items") or []) if isinstance(x, dict) and x.get("id")] if isinstance(j, dict) else []
    if not items:
        return None
    cooled = set()
    since = (now - PRESSED_COOLDOWN_H * 3600) * 1000
    for e in _recent_log(brain):
        if e.get("at", 0) >= since:
            cooled.update(p.get("epId") for p in e.get("picks", []) if p.get("pressed"))
    usable = [(g, corpus.idf(g)) for g in qgrams if g in corpus.postings]
    total = sum(corpus.idf(g) for g in qgrams) or 1.0
    best = None
    for it in items:
        if it["id"] in cooled:
            continue
        if now * 1000 - float(it.get("at") or 0) < RECENT_MOMENT_MIN * 60 * 1000:
            continue
        ig = grams(f"{it.get('text', '')} {it.get('felt', '')}")
        hit = sum(w for g, w in usable if g in ig)
        kw = min(1.0, hit / total / KW_FULL) * min(1.0, hit / (IDF_ENOUGH * corpus.scale))
        idx = corpus.by_ep.get(it["id"])
        cos = float(sims[idx]) if (idx is not None and sims is not None) else 0.0
        if kw >= PRESSED_GATE["kw"] or cos >= PRESSED_GATE["cos"]:
            rel = max(kw, (cos - SEM_FLOOR) / (SEM_CEIL - SEM_FLOOR))
            if best is None or rel > best[0]:
                best = (rel, it, kw, cos)
    if best is None or rng.random() >= prob:
        return None
    return {"item": best[1], "kw": best[2], "cos": best[3]}


def recall(brain, query, prev=(), mode="private", viewer="", k=None, model=None, now=None, rng=None,
           pressed_prob=None, explain=False, write_log=True):
    """按话题想起：用「这句 + 前两句」去搜。返回 {"mode","items":[…],"pressed":{…}|None,"lines":[…]}。"""
    brain = brain if isinstance(brain, memindex.Brain) else memindex.get_brain(brain)
    mode = "group" if str(mode or "").lower() in ("group", "群", "群聊") else "private"
    rule = dict(RULES[mode])
    if k:
        rule["k"] = max(1, min(5, int(k)))
    now = now if now is not None else time.time()
    rng = rng or random
    cur = re.sub(r"\s+", " ", str(query or "")).strip()
    prevs = [re.sub(r"\s+", " ", str(x or "")).strip() for x in (prev or [])]
    prevs = [x for x in prevs if x][-2:]
    empty = {"mode": mode, "items": [], "pressed": None, "lines": []}
    if not cur or not brain.db.exists():
        return empty
    corpus = load_corpus(brain.db)
    if not corpus.n:
        return empty
    if model is None:
        from fastembed import TextEmbedding
        model = TextEmbedding(memindex.MODEL)
    topic_grams = set()
    for t in [cur] + prevs:
        topic_grams |= grams(t)
    if sum(corpus.idf(g) for g in topic_grams) < TOPIC_MIN * corpus.scale:
        return empty            # 「好的」「哈哈哈」「晚安」这种，没有话题可想
    texts = [cur]
    if prevs:
        texts.append(" ".join(prevs + [cur]))
    sims = _query_sims(corpus, model, texts)
    parts = [(PART_WEIGHTS[0], cur)] + [(PART_WEIGHTS[1 + j], p) for j, p in enumerate(reversed(prevs))]
    hits = rank(corpus, brain, parts, sims, now=now, demote=load_demote(brain))
    good = []
    for h in hits:
        if h["score"] < rule["min_score"]:
            break
        if not passes_gate(h, rule):
            continue
        if _excluded_for_recall(h, cur, now):
            continue
        good.append(h)
    picked = dedup(corpus, good, rule["k"])
    viewer_safe = memindex.key_safe(viewer) if viewer else ""
    items, lines = [], []
    for h in picked:
        line, private = _line_of(h, viewer_safe)
        lines.append(line)
        it = {"id": h["id"], "th": h["th"], "score": round(h["score"], 4), "label": h["label"], "kind": h["kind"],
              "source": h["source"], "private": private, "ageDays": h["age_days"], "text": clip((h.get("meta") or {}).get("brief") or h["text"], 170),
              "line": line}
        if explain:
            it["why"] = {k_: round(h[k_], 3) for k_ in ("kw", "cos", "sem", "imp", "fresh", "graph")}
            it["why"]["demoted"] = h["demoted"]
        items.append(it)
    pressed = None
    if mode == "private" and (pressed_prob is None or pressed_prob > 0):
        qg = set()
        for _w, t in parts:
            qg |= grams(t)
        in_picked = {(h.get("meta") or {}).get("epId"): n for n, h in enumerate(picked)}
        pk = _pressed_pick(brain, corpus, qg, sims, len(cur), now, rng, PRESSED_PROB if pressed_prob is None else pressed_prob)
        if pk and pk["item"]["id"] in in_picked:
            # 话题直接就扯到了这件压着的事，它已经在平常的两条里了：不另加一条，只在那一条后面注明
            n = in_picked[pk["item"]["id"]]
            items[n]["line"] += "（这件事你一直压着）"
            items[n]["pressed"] = True
            lines[n] = items[n]["line"]
            pk = None
        if pk:
            it = pk["item"]
            private = str(it.get("file", "")).startswith(("private_", "douyin_")) and str(it.get("file")) != viewer_safe
            when = ago_text(max(0.0, (now * 1000 - float(it.get("at") or 0)) / 86400000.0))
            felt = f"；你写下的感觉：{clip(it.get('felt'), 60)}" if it.get("felt") else ""
            line = f"· 这件事你一直压着：{clip(it.get('text'), 130)}{felt}（出处：瞬间 · {it.get('place') or '某处'}，{when}）" + ("（私聊里的）" if private else "")
            pressed = {"id": it["id"], "line": line, "private": private, "place": it.get("place") or "", "ageText": when}
            lines.append(line)
    result = {"mode": mode, "items": items, "pressed": pressed, "lines": lines}
    if write_log and (items or pressed):
        try:
            _append_log(brain, {
                "at": int(now * 1000), "mode": mode, "q": mask_digits(cur)[:60],
                "picks": [{"id": h["id"], "th": h["th"], "label": h["label"], "score": round(h["score"], 3), "preview": clip(h["text"], 60)} for h in picked]
                         + ([{"id": "pressed:" + pressed["id"], "epId": pressed["id"], "pressed": True, "label": "压着", "preview": clip((pk or {}).get("item", {}).get("text"), 60)}] if pressed else []),
            })
        except OSError:
            pass
    return result


# ───────────────────────────── 记错了 → 降权 ─────────────────────────────

def demote_last(brain, max_age_min=30, reason="老大说记错了", now=None):
    """从 recall-log 取最近一次想起的条目（不超过 max_age_min 分钟），写进降权表。压着的事不降权（那不是在说某个事实）。
    返回 {"demoted":[{label, preview}], "reason"}；最近没想起过什么就是空。"""
    brain = brain if isinstance(brain, memindex.Brain) else memindex.get_brain(brain)
    now = now if now is not None else time.time()
    last = None
    for e in reversed(_recent_log(brain, 100)):
        picks = [p for p in e.get("picks", []) if not p.get("pressed")]
        if picks:
            last = e
            break
    if last is None or now * 1000 - float(last.get("at") or 0) > max_age_min * 60 * 1000:
        return {"demoted": [], "note": "最近没有想起过什么"}
    return demote_picks(brain, last["picks"], reason, now)


def demote_picks(brain, picks, reason="记错了", now=None):
    now = now if now is not None else time.time()
    j = _read_json(brain.demote, {})
    items = [x for x in (j.get("items") or []) if isinstance(x, dict)] if isinstance(j, dict) else []
    by_th = {x["th"]: x for x in items if x.get("th")}
    done = []
    for p in picks:
        if p.get("pressed") or not p.get("th"):
            continue
        cur = by_th.get(p["th"])
        if cur is None:
            cur = {"th": p["th"], "id": p.get("id", ""), "label": p.get("label", ""), "preview": p.get("preview", ""), "n": 0}
            items.append(cur)
            by_th[p["th"]] = cur
        cur["n"] = int(cur.get("n") or 0) + 1
        cur["at"] = int(now * 1000)
        cur["reason"] = reason
        done.append({"label": cur["label"], "preview": cur["preview"]})
    if done:
        _write_json_atomic(brain.demote, {"version": 1, "items": items[-200:]})
    return {"demoted": done}


# ───────────────────────────── 睡前整理建议（只列，不动）─────────────────────────────

TIDY_KINDS = {"身份", "长期", "人", "笔记", "最近"}
PROMISE_SRC = re.compile(r"答应|约定|待办|便签|计划|提醒")
DONE_RE = re.compile(r"已完成|做完了?|搞定|办完|办了|已经(做|办|完成)|✅|✓|已兑现|兑现了|取消了")
DATE_RES = (
    re.compile(r"(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})"),
    re.compile(r"(?<!\d)(\d{1,2})月(\d{1,2})[日号]?"),
    re.compile(r"(?<!\d)(\d{1,2})[/.](\d{1,2})(?!\d)"),
)
DEADLINE_CUE = re.compile(r"(到|在|于|等到|截止|截至|约在|定在|约好|最迟)\s*$|^\s*(之前|前|截止|为止|交|见面|考试|演出|开始|上线|比赛|生日)")
RELATIVE = (("后天", 2), ("明天", 1), ("明晚", 1), ("今晚", 0), ("今天", 0))
ANTONYMS = (("喜欢", "讨厌"), ("爱", "恨"), ("开心", "难过"), ("同意", "反对"), ("相信", "怀疑"), ("答应", "拒绝"), ("早", "晚"))
NEG_RE = re.compile(r"不|没|别|无|未|非|勿|莫")


def _today_bj(brain, now):
    return memindex.datetime.fromtimestamp(now - memindex.clock_skew_ms(brain) / 1000.0, tz=memindex.BJ).date()


def _dates_in(text, year):
    """文本里所有日期，返回 [(date, 起止位置)]。"""
    import datetime as _dt
    found = []
    for pat in DATE_RES:
        for m in pat.finditer(text):
            g = m.groups()
            try:
                if len(g) == 3:
                    d = _dt.date(int(g[0]), int(g[1]), int(g[2]))
                else:
                    d = _dt.date(year, int(g[0]), int(g[1]))
            except ValueError:
                continue
            if not any(s <= m.start() < e for _d, s, e in found):
                found.append((d, m.start(), m.end()))
    return sorted(found, key=lambda x: x[1])


def deadline_of(text, entry_date, year):
    """一句约定里的「到期日」：① 日期前后有「到 / 之前 / 截止」这类字；② 「明天 / 后天 / 今晚」按这句话写下的日期推；③ 「周末 / 下周」。
    认不出返回 (None, '')。"""
    import datetime as _dt
    ds = _dates_in(text, year)
    for d, s, e in ds:
        if DEADLINE_CUE.search(text[max(0, s - 6):s]) or DEADLINE_CUE.search(text[e:e + 6]):
            return d, f"写的是「{text[max(0, s - 2):e + 2].strip()}」"
    base = entry_date or (ds[0][0] if ds else None)
    if base is None:
        return None, ""
    for word, plus in RELATIVE:
        if word in text:
            return base + _dt.timedelta(days=plus), f"写的是「{word}」（那句话是 {base.month}月{base.day}日写的）"
    if re.search(r"周末|这周末|本周末", text):
        return base + _dt.timedelta(days=(6 - base.weekday()) % 7), f"写的是「周末」（那句话是 {base.month}月{base.day}日写的）"
    if "下周" in text:
        return base + _dt.timedelta(days=13 - base.weekday()), f"写的是「下周」（那句话是 {base.month}月{base.day}日写的）"
    return None, ""


def _tidy_entries(brain):
    """整理建议要看的条目：身份 / 长期 / 人 / 笔记 / 最近 里的 md，一行（一条）一个。日记和碎碎念是流水，不看。"""
    for kind, md, rel in memindex.iter_sources(brain):
        if kind not in TIDY_KINDS:
            continue
        try:
            text = md.read_text(encoding="utf-8-sig")
        except OSError:
            continue
        head = ""
        for line in text.splitlines():
            s = line.strip()
            if not s:
                continue
            if s.startswith("## "):
                head = s[3:].strip()
                continue
            if s.startswith("#"):
                continue
            body = re.sub(r"^[-*>]\s*", "", s)
            if len(body) < 8:
                continue
            yield {"kind": kind, "rel": rel, "head": head, "text": body, "label": rel + (f" · {head}" if head else "")}


def tidy(brain, now=None, max_each=5):
    """睡前整理建议：列出本子里重复的段落、过期的约定、互相矛盾的句子。只列，不改任何东西，留不留、改不改她定。
    不用模型、不用索引：直接读本子，按条（一行一条）比词重合。"""
    brain = brain if isinstance(brain, memindex.Brain) else memindex.get_brain(brain)
    now = now if now is not None else time.time()
    out = {"duplicates": [], "expired": [], "conflicts": []}
    today = _today_bj(brain, now)
    entries = list(_tidy_entries(brain))
    gs = [grams(e["text"]) for e in entries]
    seen_dup = set()
    seen_pair = set()
    for i in range(len(entries)):
        for j in range(i + 1, len(entries)):
            a, b = entries[i], entries[j]
            if a["text"] == b["text"] and a["label"] == b["label"]:
                continue
            ov = overlap(gs[i], gs[j])
            if ov >= 0.75 or a["text"] == b["text"]:
                if len(out["duplicates"]) < max_each and i not in seen_dup and j not in seen_dup:
                    out["duplicates"].append({"a": {"label": a["label"], "text": clip(a["text"], 110)}, "b": {"label": b["label"], "text": clip(b["text"], 110)},
                                              "note": "这两段说的差不多，可以留一段，也可以都留着"})
                    seen_dup.update((i, j))
                continue
            if len(out["conflicts"]) >= max_each or (i, j) in seen_pair:
                continue
            why = _conflict_reason(a["text"], b["text"], ov) if (len(a["text"]) <= 200 and len(b["text"]) <= 200) else ""
            if why:
                out["conflicts"].append({"a": {"label": a["label"], "text": clip(a["text"], 110)}, "b": {"label": b["label"], "text": clip(b["text"], 110)},
                                         "note": f"这两句好像对不上（{why}），可以看看哪句是现在的样子"})
                seen_pair.add((i, j))
    # ② 过期的约定
    year = today.year
    for e in entries:
        if not PROMISE_SRC.search(e["rel"] + e["head"]) or DONE_RE.search(e["text"]):
            continue
        ds = _dates_in(f"{e['head']} {e['text']}", year)
        entry_date = ds[0][0] if ds else None
        dl, why = deadline_of(e["text"], entry_date, year)
        if dl is not None and (today - dl).days >= 1:
            out["expired"].append({"a": {"label": e["label"], "text": clip(e["text"], 110)},
                                   "note": f"{why}，那是 {dl.month}月{dl.day}日，已经过去 {(today - dl).days} 天了；做完了可以划掉，没做可以重新约个时间"})
            if len(out["expired"]) >= max_each:
                break
    total = sum(len(v) for v in out.values())
    return {**out, "total": total, "text": _tidy_text(out)}


def _conflict_reason(a, b, ov):
    """两条话题很像的话，看看是不是一句肯定一句否定、一句说「喜欢」一句说「讨厌」，或者数字对不上。认不出返回 ''。"""
    ga, gb = grams(a), grams(b)
    jacc = len(ga & gb) / max(1, len(ga | gb))
    if jacc < 0.3:
        return ""
    if bool(NEG_RE.search(a)) != bool(NEG_RE.search(b)):
        return "一句是肯定、一句是否定"
    for x, y in ANTONYMS:
        if (x in a and y in b and y not in a and x not in b) or (y in a and x in b and x not in a and y not in b):
            return f"一句说「{x}」、一句说「{y}」"
    da, db = re.findall(r"\d+(?:[:：]\d+)?", a), re.findall(r"\d+(?:[:：]\d+)?", b)
    if da and db and set(da) != set(db) and jacc >= 0.5:
        return "数字不一样"
    return ""


def _tidy_text(t):
    if not (t["duplicates"] or t["expired"] or t["conflicts"]):
        return ""
    lines = ["【睡前整理的小建议】（只是帮你列出来，留不留、改不改都你定；不想理它也行）"]
    n = 0
    for title, key in (("本子里重复的", "duplicates"), ("可能过期的约定", "expired"), ("可能对不上的", "conflicts")):
        for it in t[key]:
            n += 1
            if it.get("b"):
                lines.append(f"{n}. {title}：「{it['a']['text']}」（{it['a']['label']}）和「{it['b']['text']}」（{it['b']['label']}）。{it['note']}。")
            else:
                lines.append(f"{n}. {title}：「{it['a']['text']}」（{it['a']['label']}）。{it['note']}。")
    return "\n".join(lines)
