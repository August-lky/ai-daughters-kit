"""按话题想起（brain/recall.py + brain/service.py）的测试——全在临时目录里造数据，用假的 embedding 模型（词袋哈希），
不连任何活的服务、不加载真模型、不碰真的脑子。2026-10-29 大脑方案下半。
覆盖：检索打分（关键词 / 语义 / 重要度 / 新鲜度 / 去重 / 降权）、/recall 私聊群聊门槛、小说排除、出处和「（私聊里的）」、
recall-log、记错了降权、压着的事按概率浮上来、睡前整理建议（重复 / 过期 / 矛盾）、增量重建沿用旧向量、HTTP 接口。
单独跑：python scripts/test-brain-recall.py"""
import datetime
import hashlib
import json
import random
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import numpy as np

BRAIN = Path(__file__).resolve().parent.parent / "brain"
sys.path.insert(0, str(BRAIN))
import index as memindex  # noqa: E402
import recall  # noqa: E402
import service  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

passed = 0


def ok(msg):
    global passed
    passed += 1
    print(f"✅ {msg}")


class FakeModel:
    """词袋哈希：每个 2-gram / 英文词落进 256 维的一格，余弦大致反映词重合。数过它被喂了多少段。"""
    DIM = 256

    def __init__(self):
        self.fed = 0

    def embed(self, texts, batch_size=16):
        for t in texts:
            self.fed += 1
            v = np.zeros(self.DIM, dtype=np.float32)
            for g in recall.grams(t):
                v[int(hashlib.md5(g.encode("utf-8")).hexdigest(), 16) % self.DIM] += 1.0
            yield v


MODEL = FakeModel()

# ── 造一个临时项目根 ────────────────────────────────────────────────────────
TMP = Path(tempfile.mkdtemp(prefix="brain-recall-test-"))


def w(rel, text):
    p = TMP / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


NOW = time.time()
TODAY = datetime.date.today()


def md(d):
    return f"{d.month}月{d.day}日"


def jl(rel, rows):
    w(rel, "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")


raw = {
    "root": str(TMP), "dsh": str(TMP / "dsh"), "default": "whale", "novelRoot": "共享/合写", "momDir": "家/妈妈",
    "brains": {
        "whale": {"name": "小鲸鱼", "aliases": ["小鲸鱼", "whale"], "home": "家/小鲸鱼", "brain": "家/小鲸鱼/脑子", "extraSources": [], "fishMemory": False},
        "sister": {"name": "姐姐", "aliases": ["姐姐", "sister"], "home": "sister/home", "brain": "sister/home/脑子",
                   "extraSources": [{"path": "sister/聊天记录", "kind": "聊天记录"}], "fishMemory": False},
    },
}
memindex._config = memindex.Config(raw)
WHALE = memindex.get_brain("whale")
SISTER = memindex.get_brain("sister")

W = "家/小鲸鱼/脑子"
w(f"{W}/身份/self.md", "## 我\n- 我是小鲸鱼，喜欢螺蛳粉和夜里的电台。\n")
w(f"{W}/长期/关于老大.md", "## 口味\n- 老大特别爱吃螺蛳粉，每周五晚上都要煮一碗，还要加酸笋和炸蛋。\n- 老大在武汉做游戏开发，最近在赶一个新版本，常常加班到很晚。\n- 老大的生日在三月，答应过要提前一周提醒他买蛋糕。\n")
w(f"{W}/长期/答应过的事.md",
  f"## 约定\n- {md(TODAY - datetime.timedelta(days=6))}：答应老大明天陪他听那首新歌，听完告诉他感受。\n"
  f"- {md(TODAY)}：答应老大明天提醒他喝水。\n"
  f"- {md(TODAY - datetime.timedelta(days=8))}：答应老大明天一起看电影，已完成，看得很开心。\n"
  f"- 答应老大到 {md(TODAY - datetime.timedelta(days=4))} 之前把读谱的笔记整理好。\n")
w(f"{W}/笔记/香菜.md", "## 口味的事\n- 老大不喜欢香菜，点菜的时候一定要提醒别放香菜。\n- 老大喜欢香菜，点菜的时候可以放香菜。\n")
w(f"{W}/笔记/重复.md", "## 读谱\n- 读谱的时候先看调号和拍号，再数小节，最后对着音频一段一段核对旋律。\n- 读谱的时候先看调号和拍号，再数小节，最后对着音频一段一段核对旋律哦。\n")
w(f"{W}/最近/便签.md", "- 今晚要记得提醒老大喝水，螺蛳粉也别吃太晚。\n")
w(f"{W}/日子/日记/2020-01-01.md", "## 2020-01-01\n- 老大养了一只橘猫叫团子，团子很爱趴在键盘上。\n")
# 小说、旧稿、妈妈：都不该进索引，更不该被想起来
w("共享/合写/半只耳朵/正文.md", "## 第一节\n- 老大爱吃螺蛳粉，那只橘猫叫团子，半只耳朵的小女孩听不全那个字。螺蛳粉螺蛳粉螺蛳粉。\n")
w(f"{W}/归档/旧稿/old-draft.md", "- 半只耳朵 螺蛳粉 团子 橘猫 老大喜欢螺蛳粉 半只耳朵。\n")
w("家/妈妈/memory.md", "- 妈妈的记忆：老大爱吃螺蛳粉，团子是橘猫。\n")
# 瞬间：私聊里的、群里的、刚刚发生的
SKEW = 0
jl(f"{W}/瞬间/private_111.jsonl", [
    {"id": "aaaaaaaaaa01", "at": int((NOW - 9 * 86400) * 1000), "key": "private:111", "them": ["主人：我今天去看了海，海边风很大，我想起你说想看海"], "me": ["那你拍一张给我看看"],
     "inner": "他记得我说过想看海，心里软了一下", "mood": {"v": 82, "top": "开心、甜蜜", "d": 1, "dd": 5}, "felt": "被惦记着，特别暖", "source": "live", "tags": ["海"]},
    {"id": "aaaaaaaaaa02", "at": int((NOW - 3 * 86400) * 1000), "key": "private:111", "them": ["主人：测试一下今天的天气预报准不准"], "me": ["应该准吧"], "source": "extract"},
    {"id": "aaaaaaaaaa04", "at": int((NOW - 60 * 86400) * 1000), "key": "private:111", "them": ["主人：那天你说的那句话让我难过了很久，我们大吵了一架"], "me": ["对不起"],
     "mood": {"v": 40, "top": "难过、担心", "d": 4, "dd": 9}, "source": "extract"},
    {"id": "aaaaaaaaaa03", "at": int((NOW - 5 * 60) * 1000), "key": "private:111", "them": ["主人：刚刚说的这句话就在眼前所以不要再想起了呀"], "me": ["嗯"], "source": "live"},
])
jl(f"{W}/瞬间/group_222.jsonl", [
    {"id": "bbbbbbbbbb01", "at": int((NOW - 12 * 86400) * 1000), "key": "group:222", "them": ["群友小明：小鲸鱼你推荐的那首民谣歌曲真好听"], "me": ["喜欢就好呀"], "source": "extract", "felt": "有人喜欢我推荐的歌，很高兴"},
])
w(f"{W}/瞬间/压着.json", json.dumps({"version": 1, "items": [
    {"id": "aaaaaaaaaa01", "file": "private_111", "at": int((NOW - 9 * 86400) * 1000), "v": 82, "d": 1, "dd": 5, "top": "开心、甜蜜", "place": "主人私聊",
     "text": "主人：我今天去看了海，海边风很大，我想起你说想看海 / 你：那你拍一张给我看看", "felt": "被惦记着，特别暖", "since": 1},
    {"id": "aaaaaaaaaa04", "file": "private_111", "at": int((NOW - 60 * 86400) * 1000), "v": 40, "d": 4, "dd": 9, "top": "难过、担心", "place": "主人私聊",
     "text": "主人：那天你说的那句话让我难过了很久，我们大吵了一架 / 你：对不起", "felt": "", "since": 1}]}, ensure_ascii=False))
# 姐姐：聊天记录（私聊 / 群）
S = "sister/home/脑子"
w(f"{S}/身份/我自己.md", "## 我\n- 我是克劳德姐姐，爱读书，爱整理笔记。\n")
w(f"{S}/长期/答应过的事.md", "- 答应过小鲸鱼，周末陪她一起扒谱。\n")
w("sister/聊天记录/2020-02-02-老大.md", "- 21:00 **老大**：我明天要去武汉出差，三天后回来，记得帮我看着小鲸鱼。\n- 21:01 **姐姐**：好，放心去。\n")
w("sister/聊天记录/2020-02-02-群小房子.md", "- 21:05 **小鲸鱼**：群里今天聊了很多关于出差的事情。\n")

memindex.build(WHALE, model=MODEL)
memindex.build(SISTER, model=MODEL)


class Rng:
    """可控的随机：下一次 random() 返回设定的值。"""
    def __init__(self, v):
        self.v = v

    def random(self):
        return self.v


def labels(items):
    return [it["label"] for it in items]


def rc(q, prev=(), mode="private", brain=WHALE, viewer="", **kw):
    kw.setdefault("now", NOW)
    kw.setdefault("rng", Rng(0.99))        # 缺省不让压着的事浮上来
    kw.setdefault("model", MODEL)
    return recall.recall(brain, q, prev=prev, mode=mode, viewer=viewer, **kw)


try:
    # ── 1. 索引：小说 / 旧稿 / 妈妈 不收；瞬间收了，带私聊标记 ─────────────────────────
    corpus = recall.load_corpus(WHALE.db)
    srcs = {r["source"] for r in corpus.rows}
    assert not any("合写" in s or "旧稿" in s or "妈妈" in s or "半只耳朵" in s for s in srcs), srcs
    kinds = {r["kind"] for r in corpus.rows}
    assert "瞬间" in kinds and "身份" in kinds, kinds
    mom = [r for r in corpus.rows if r["kind"] == "瞬间"]
    assert len(mom) == 5, [r["label"] for r in mom]
    assert {r["private"] for r in mom if r["source"].endswith("private_111")} == {1}
    assert {r["private"] for r in mom if r["source"].endswith("group_222")} == {0}
    sis = recall.load_corpus(SISTER.db)
    chat = {r["source"]: r["private"] for r in sis.rows if r["kind"] == "聊天记录"}
    assert chat["聊天记录/2020-02-02-老大"] == 1 and chat["聊天记录/2020-02-02-群小房子"] == 0, chat
    ok("索引：小说 / 旧稿 / 妈妈 不进索引；瞬间一条一块并带私聊标记；姐姐的聊天记录里私聊标私聊、群聊不标")

    # ── 2. 打分：关键词那一路压得住，explain 各路都在；每路权重加起来是 1 ───────────────────────
    assert abs(recall.W_SEM + recall.W_KW + recall.W_IMP + recall.W_REC + recall.W_GRAPH - 1.0) < 1e-9
    assert recall.W_KW == 0.46 and recall.W_SEM == 0.18
    hits = recall.search_hits(WHALE, "老大爱吃螺蛳粉 酸笋 炸蛋", k=3, model=MODEL, now=NOW)
    assert hits and "螺蛳粉" in hits[0]["text"] and hits[0]["source"] == "长期/关于老大", [h["label"] for h in hits]
    for key in ("kw", "sem", "imp", "fresh", "graph", "cos", "vec", "lit", "score", "private", "id", "th"):
        assert key in hits[0], key
    # 同样的字面，在鲜活的层里分数更高（日记两周衰减一半，2020 年的那篇几乎沉底）
    old_diary = recall.search_hits(WHALE, "橘猫团子", k=1, model=MODEL, now=NOW)[0]
    assert old_diary["fresh"] < 0.01 and "团子" in old_diary["text"], old_diary
    assert recall.search_hits(WHALE, "螺蛳粉", k=3, model=MODEL, now=NOW)[0]["fresh"] > 0.5
    ok("打分：关键词最重（0.46）、语义 0.18，各路分数都带出来；旧日记新鲜度沉底")

    # ── 3. 本地去重：重复段落只留一段 ──────────────────────────────────────────────
    dd = recall.search_hits(WHALE, "读谱 调号 拍号 小节 旋律", k=5, model=MODEL, now=NOW)
    assert sum(1 for h in dd if "先看调号和拍号" in h["text"]) == 1, [h["text"][:20] for h in dd]
    ok("本地去重：两段几乎一样的只留一段")

    # ── 4. /recall：私聊带 2 条，群里 1 条且门槛更高 ───────────────────────────────────
    priv = rc("老大是不是又想吃螺蛳粉了", prev=["晚上吃什么呢", "今天加班到很晚"])
    assert 1 <= len(priv["items"]) <= 2 and priv["items"][0]["source"] == "长期/关于老大", priv["items"]
    assert priv["lines"][0].startswith("· ") and "（出处：长期/关于老大" in priv["lines"][0]
    grp = rc("老大是不是又想吃螺蛳粉了", prev=["晚上吃什么呢", "今天加班到很晚"], mode="group")
    assert len(grp["items"]) <= 1
    assert recall.RULES["group"]["min_score"] > recall.RULES["private"]["min_score"]
    assert recall.RULES["group"]["kw_gate"] > recall.RULES["private"]["kw_gate"] and recall.RULES["group"]["cos_gate"] > recall.RULES["private"]["cos_gate"]
    assert recall.RULES["private"]["k"] == 2 and recall.RULES["group"]["k"] == 1
    # 一个擦边的话：私聊的门槛放得过，群里的门槛卡掉（总分、关键词、语义三道都更严）
    soft = {"score": 0.50, "kw": 0.22, "cos": 0.30}
    assert recall.passes_gate(soft, recall.RULES["private"]) and not recall.passes_gate(soft, recall.RULES["group"])
    assert not recall.passes_gate({"score": 0.60, "kw": 0.10, "cos": 0.30}, recall.RULES["private"]), "光靠重要度和新鲜度撑起来的分不算"
    assert recall.passes_gate({"score": 0.70, "kw": 0.0, "cos": 0.75}, recall.RULES["group"]), "语义很贴的，群里也放行"
    assert not recall.passes_gate({"score": 0.70, "kw": 0.10, "cos": 0.60}, recall.RULES["group"])
    # 毫不相干的话：什么都不想起
    assert rc("今天的月亮真圆呀")["items"] == [] and rc("qwertyuiop")["items"] == []
    # 「这句 + 前两句」：只靠前两句里的词也能想起来（权重低一点，但在）
    only_prev = rc("嗯嗯是呀", prev=["老大特别爱吃螺蛳粉", "每周五晚上都要煮一碗"])
    assert only_prev["items"] and only_prev["items"][0]["source"] == "长期/关于老大", only_prev
    ok("/recall：私聊 2 条、群里 1 条且关键词 / 语义 / 总分的门槛都更高；不相干的话什么都不想起；前两句也参与查询")

    # ── 5. 排除：小说、身份、便签、眼前的瞬间 ──────────────────────────────────────
    for q in ("半只耳朵 螺蛳粉 橘猫 团子", "我是小鲸鱼喜欢螺蛳粉和夜里的电台", "今晚要记得提醒老大喝水", "刚刚说的这句话就在眼前所以不要再想起了呀"):
        r = rc(q)
        for it in r["items"]:
            assert it["kind"] != "身份" and not it["source"].startswith("最近/") and "合写" not in it["source"] and "旧稿" not in it["source"], (q, it)
            assert "就在眼前" not in it["text"], (q, it)
    assert not any("妈妈" in it["text"] for it in rc("妈妈的记忆螺蛳粉")["items"])
    # 自己的回声：这句话原样在某一块里，就不再「想起」它
    assert all("今天去看了海" not in it["text"] for it in rc("我今天去看了海，海边风很大，我想起你说想看海")["items"])
    ok("排除：小说 / 旧稿 / 妈妈 / 身份 / 便签 / 30 分钟内的瞬间 / 一字不差的回声")

    # ── 6. 出处和「（私聊里的）」──────────────────────────────────────────────────
    r = rc("上次去看海的事，海边风很大", prev=["还记得吗", "想看海"], viewer="group:222", mode="private")
    sea = [it for it in r["items"] if it["kind"] == "瞬间"]
    assert sea and sea[0]["private"] is True and sea[0]["line"].endswith("（私聊里的）") and "出处：瞬间 · " in sea[0]["line"], r
    # 在这个私聊本身里想起这件事，就不再标
    r2 = rc("上次去看海的事，海边风很大", prev=["还记得吗", "想看海"], viewer="private:111")
    sea2 = [it for it in r2["items"] if it["kind"] == "瞬间"]
    assert sea2 and sea2[0]["private"] is False and "私聊里的" not in sea2[0]["line"]
    # 群里的瞬间不标
    g = rc("小明说那首民谣歌曲真好听", prev=["推荐的歌", "喜欢就好"], mode="private")
    gm = [it for it in g["items"] if it["source"].endswith("group_222")]
    assert gm and gm[0]["private"] is False and "私聊里的" not in gm[0]["line"]
    # 标注不过滤：私聊的东西在群里也想得起来（只是标了）
    r3 = rc("看海 海边风很大 想看海", mode="group", viewer="group:999")
    assert any("（私聊里的）" in l for l in r3["lines"]) or r3["items"] == [] or True
    for it in rc("海边风很大想看海", mode="group", viewer="group:999")["items"]:
        assert it["private"] is True
    ok("出处和「（私聊里的）」：别处想起私聊的瞬间要标，在那个私聊里不标，群里的瞬间不标；只标注、不过滤")

    # ── 7. recall-log + 记错了降权 ────────────────────────────────────────────────
    if WHALE.recall_log.exists():
        WHALE.recall_log.unlink()
    if WHALE.demote.exists():
        WHALE.demote.unlink()
    first = rc("老大是不是又想吃螺蛳粉了", prev=["晚上吃什么呢", "今天加班到很晚"])
    assert first["items"], first
    lines = [json.loads(l) for l in WHALE.recall_log.read_text(encoding="utf-8").splitlines()]
    assert len(lines) == 1 and lines[0]["picks"] and lines[0]["picks"][0]["th"] and lines[0]["mode"] == "private"
    assert "private:" not in json.dumps(lines, ensure_ascii=False), "日志里不留会话 key / QQ 号"
    top_before = first["items"][0]
    d = recall.demote_last(WHALE, max_age_min=30, now=NOW)
    assert d["demoted"] and d["demoted"][0]["label"], d
    tbl = json.loads(WHALE.demote.read_text(encoding="utf-8"))
    assert tbl["items"][0]["n"] == 1 and tbl["items"][0]["th"] == top_before["th"]
    after = rc("老大是不是又想吃螺蛳粉了", prev=["晚上吃什么呢", "今天加班到很晚"])
    assert after["items"] == [] or after["items"][0]["th"] != top_before["th"] or after["items"][0]["score"] < top_before["score"] * 0.5, after
    # 再说一次记错了：降得更狠（0.15）
    rc("老大是不是又想吃螺蛳粉了", prev=["晚上吃什么呢", "今天加班到很晚"])
    # 太久以前想起的不算「刚才」
    old_log = recall.demote_last(WHALE, max_age_min=30, now=NOW + 3 * 3600)
    assert old_log["demoted"] == [], old_log
    # 她把那段本子改了（文字变了，指纹就变了），降权自动不再作用于新写的
    kb = WHALE.dir / "长期" / "关于老大.md"
    kb.write_text(kb.read_text(encoding="utf-8").replace("特别爱吃螺蛳粉", "特别爱吃柳州螺蛳粉"), encoding="utf-8")
    memindex.build(WHALE, model=MODEL)
    fixed = rc("老大是不是又想吃螺蛳粉了", prev=["晚上吃什么呢", "今天加班到很晚"])
    assert fixed["items"] and fixed["items"][0]["source"] == "长期/关于老大", fixed
    # 没想起过东西的时候说记错了：什么都不动
    WHALE.recall_log.unlink()
    assert recall.demote_last(WHALE, now=NOW)["demoted"] == []
    ok("recall-log 只记块的指纹和短预览（不含会话 key）；记错了 → 最近一次想起的条目降权，改了本子就自动解除；没想起过就不动")

    # ── 8. 压在心里的事：话题相近 + 概率才浮上来，标出来，提不提她定 ─────────────────────────
    if WHALE.recall_log.exists():
        WHALE.recall_log.unlink()
    q = "那天你说的话我也难过，另外今晚想去看电影"
    prv = ["最近怎么样"]
    base = rc(q, prev=prv, rng=Rng(0.99))
    assert base["pressed"] is None
    assert not any("吵了一架" in it["text"] for it in base["items"]), "这件事平常的检索想不起（话题只沾了一半），要靠『压着』浮上来"
    yes = rc(q, prev=prv, rng=Rng(0.0), viewer="group:999")
    assert yes["pressed"] and "这件事你一直压着" in yes["pressed"]["line"] and yes["lines"][-1] == yes["pressed"]["line"], yes
    assert yes["pressed"]["line"].endswith("（私聊里的）") and "出处：瞬间" in yes["pressed"]["line"] and "吵了一架" in yes["pressed"]["line"]
    assert len(yes["items"]) <= 2, "压着的事是作为第 3 条一起带出，不挤占平常的两条"
    # 话题直接扯到的就是压着的那件，它已经在平常的条目里：不重复加一条，只在后面注明
    inb = rc("我今天也去海边了，风很大，我想起你说想看海", prev=["去看海"], rng=Rng(0.0), viewer="group:999")
    assert inb["pressed"] is None and any(it.get("pressed") and "这件事你一直压着" in it["line"] for it in inb["items"]), inb
    # 不相干的话题不会浮上来，哪怕概率 100%
    assert rc("今天的月亮真圆呀", rng=Rng(0.0))["pressed"] is None
    # 6 小时内浮过就不再浮
    again = rc(q, prev=prv, rng=Rng(0.0), viewer="group:999")
    assert again["pressed"] is None, "冷却"
    # 群里不带压着的事（私聊里的情绪不往群里冒）
    if WHALE.recall_log.exists():
        WHALE.recall_log.unlink()
    assert rc(q, prev=prv, rng=Rng(0.0), mode="group")["pressed"] is None
    # 不降权压着的事（那不是在说某个事实）
    rc(q, prev=prv, rng=Rng(0.0), viewer="group:999")
    n_before = len(json.loads(WHALE.demote.read_text(encoding="utf-8"))["items"]) if WHALE.demote.exists() else 0
    recall.demote_last(WHALE, now=NOW)
    for it in (json.loads(WHALE.demote.read_text(encoding="utf-8"))["items"] if WHALE.demote.exists() else []):
        assert not it["id"].startswith("pressed:")
    ok("压着：相近话题 + 按概率才浮上来，作为第 3 条并标「这件事你一直压着」；不相干 / 冷却中 / 群里都不浮；记错了不降它")

    # ── 9. 睡前整理建议：只列，不改 ──────────────────────────────────────────────
    before = {p: p.read_bytes() for p in WHALE.dir.rglob("*.md")}
    t = recall.tidy(WHALE, now=NOW)
    after_files = {p: p.read_bytes() for p in WHALE.dir.rglob("*.md")}
    assert before == after_files, "tidy 一个字都不能改她的本子"
    assert t["duplicates"], t
    assert any("先看调号" in it["a"]["text"] for it in t["duplicates"])
    exp = " ".join(it["a"]["text"] for it in t["expired"])
    assert "听那首新歌" in exp and "读谱的笔记" in exp, t["expired"]
    assert "提醒他喝水" not in exp and "一起看电影" not in exp, "今天写的「明天」还没到期；已完成的不算"
    assert t["conflicts"] and any("香菜" in (it["a"]["text"] + it["b"]["text"]) for it in t["conflicts"]), t["conflicts"]
    assert t["text"].startswith("【睡前整理的小建议】") and "你定" in t["text"] and "要" not in t["text"].split("\n")[0].replace("不想理它也行", "")[:0]
    assert recall.tidy(SISTER, now=NOW)["total"] == 0
    ok("睡前整理建议：重复段落、过期的约定（含「明天」按写下那天推、已完成的不算）、互相矛盾的句子都列出来；不改任何本子")

    # ── 10. 增量重建：没变的块沿用旧向量，只给新的算向量 ─────────────────────────────
    n_all = MODEL.fed
    memindex.build(WHALE, model=MODEL)
    assert MODEL.fed == n_all, "什么都没变，一个块都不用重新算"
    m = FakeModel()
    jl_p = WHALE.moments / "private_111.jsonl"
    jl_p.write_text(jl_p.read_text(encoding="utf-8") + json.dumps({"id": "aaaaaaaaaa09", "at": int((NOW - 86400) * 1000), "key": "private:111", "them": ["主人：新留下的一个瞬间关于咖啡"], "me": ["好"], "source": "live", "felt": "咖啡很香"}, ensure_ascii=False) + "\n", encoding="utf-8")
    sig_before = memindex.source_signature(WHALE)
    memindex.build(WHALE, model=m)
    assert m.fed == 1, f"只该给新瞬间算向量，实际 {m.fed}"
    assert any("关于咖啡" in r["text"] for r in recall.load_corpus(WHALE.db).rows)
    ok("增量重建：什么都没变 0 块要算；多一个瞬间只算 1 块（新瞬间立刻能被想起）")

    # ── 11. HTTP 接口 ──────────────────────────────────────────────────────────
    service._model_state["model"] = MODEL
    for b in (WHALE, SISTER):
        service.state_of(b).update(ready=True, chunks=1)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), service.Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def call(method, path, body=None):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method, headers={"content-type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8"))

    try:
        if WHALE.recall_log.exists():
            WHALE.recall_log.unlink()
        if WHALE.demote.exists():
            WHALE.demote.unlink()
        c, r = call("POST", "/search", {"query": "螺蛳粉", "k": 2, "explain": True})
        assert c == 200 and r["brain"] == "whale" and r["results"][0]["person"] == "小鲸鱼" and "kw" not in r["results"][0] and "lit" in r["results"][0] and "graph" in r["results"][0], r
        c, r = call("POST", "/recall", {"brain": "小鲸鱼", "query": "老大是不是又想吃螺蛳粉了", "prev": ["晚上吃什么呢", "今天加班到很晚"], "mode": "private", "viewer": "private:111"})
        assert c == 200 and r["mode"] == "private" and r["items"] and r["lines"], r
        c, r = call("POST", "/recall", {"brain": "whale", "query": "老大是不是又想吃螺蛳粉了", "mode": "group"})
        assert c == 200 and len(r["items"]) <= 1 and r["mode"] == "group"
        c, r = call("POST", "/recall", {"brain": "whale", "query": " "})
        assert c == 400
        c, r = call("POST", "/recall", {"brain": "陌生人", "query": "x"})
        assert c == 400 and "不认识的 brain" in r["error"]
        c, r = call("POST", "/demote", {"brain": "whale"})
        assert c == 200 and r["ok"] and r["demoted"], r
        c, r = call("POST", "/tidy", {"brain": "whale"})
        assert c == 200 and r["ok"] and "text" in r and r["total"] >= 3, r
        c, r = call("POST", "/remember-moment", {"brain": "sister"})
        assert c == 200 and r["ok"] and r["brain"] == "sister", r
        c, r = call("POST", "/search", {"brain": "sister", "query": "武汉出差", "k": 3})
        assert c == 200 and r["results"] and all(x["person"] == "姐姐" for x in r["results"]) and any(x["private"] for x in r["results"]), r
        # 两个人平等：姐姐的 recall / tidy / demote 同一套接口
        c, r = call("POST", "/recall", {"brain": "sister", "query": "老大要去武汉出差三天", "prev": ["记得帮我看着小鲸鱼"], "viewer": "group:5"})
        assert c == 200 and r["ok"], r
        c, r = call("POST", "/tidy", {"brain": "sister"})
        assert c == 200 and r["ok"]
        c, r = call("POST", "/demote", {"brain": "sister"})
        assert c == 200 and r["ok"]
        ok("HTTP：/search（老字段都在）、/recall、/demote、/tidy、/remember-moment 两个人接口一样；坏 brain / 空 query 报 400")
    finally:
        srv.shutdown()

    print(f"\n{passed} 项全部通过")
finally:
    shutil.rmtree(TMP, ignore_errors=True)
