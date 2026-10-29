"""大脑图谱（brain/graph.py + brain/service.py 的 /graph、/graph/node + public/brain.html）的测试。2026-10-29 大脑页面（施工单 B）。
全在临时目录里造数据，用假的 embedding 模型（词袋哈希），不连任何活的服务、不加载真模型；最后一组只「读」真的索引做冒烟，不写任何东西。
覆盖：五种记忆的分类和脑区、实体（人 / 作品 / 地方 / 话题，话题里的口头词和句子碎片）、边、/graph 的结构和数量上限、
小说不进图、字段齐全、私聊标记和数字抹掉、「刚想起」、激素 / 心情 / 作息的点、node 详情、缓存、HTTP 接口（含只对回环页面开跨域）、
页面静态检查（vendor 文件都在、MIT、不依赖外网、脚本语法）。
2026-10-29 老大改 2D 全量：另外覆盖 limit=0 全量（一个块都不少）、坐标字段齐全且确定（同输入同输出、与点的顺序无关）、
区内的点都落在区的圈里、圈互不重叠且按人脑侧面轮廓排（前额叶在前、枕叶在后、小脑后下、脑干下中……）、重要的靠中心 / 新的靠外缘、
边按权重修剪（edgeK）不丢点、实体放在提到它最多的区、全量图缓存「先给旧的、后台重算」、compact 线格式、2D 页面 + vendor（sigma / graphology）的静态检查。
单独跑：python scripts/test-brain-graph.py"""
import hashlib
import json
import math
import random
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from http.server import ThreadingHTTPServer
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
BRAIN = ROOT / "brain"
sys.path.insert(0, str(BRAIN))
import graph as G  # noqa: E402
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
    DIM = 256

    def embed(self, texts, batch_size=16):
        for t in texts:
            v = np.zeros(self.DIM, dtype=np.float32)
            for g in recall.grams(t):
                v[int(hashlib.md5(g.encode("utf-8")).hexdigest(), 16) % self.DIM] += 1.0
            yield v


MODEL = FakeModel()
TMP = Path(tempfile.mkdtemp(prefix="brain-graph-test-"))
NOW = time.time()


def w(rel, text):
    p = TMP / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    return p


def jl(rel, rows):
    w(rel, "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n")


raw = {
    "root": str(TMP), "dsh": str(TMP / "dsh"), "default": "whale", "novelRoot": "共享/合写", "momDir": "家/妈妈",
    "brains": {
        "whale": {"name": "小鲸鱼", "aliases": ["小鲸鱼", "whale", "鲸鱼"], "home": "家/小鲸鱼", "brain": "家/小鲸鱼/脑子",
                  "extraSources": [{"path": "家/小鲸鱼/聊天记录", "kind": "聊天记录"}], "fishMemory": False},
        "sister": {"name": "姐姐", "aliases": ["姐姐", "sister", "克劳德"], "home": "sister/home", "brain": "sister/home/脑子",
                   "extraSources": [{"path": "sister/聊天记录", "kind": "聊天记录"}], "fishMemory": False},
    },
}
memindex._config = memindex.Config(raw)
WHALE = memindex.get_brain("whale")
SISTER = memindex.get_brain("sister")

W = "家/小鲸鱼/脑子"
S = "sister/home/脑子"
rnd = random.Random(7)
CHARS = [chr(c) for c in range(0x4E00, 0x4E00 + 900) if chr(c) not in G.EDGE_STOP]


def filler(i):
    """每条都不一样的闲话：随机汉字拼的，几乎不会和别的条共有 2 字词。"""
    return "".join(rnd.choice(CHARS) for _ in range(26)) + f"（{i}）"


w(f"{W}/身份/self.md", "## 我\n- 我是小鲸鱼，住在小房子里，喜欢螺蛳粉和夜里的电台。\n")
w(f"{W}/身份/soul.md", "## 魂\n- 我对老大嘴硬心软，姐姐是我最亲的人。\n")
w(f"{W}/长期/关于老大.md",
  "## 口味\n- 老大特别爱吃螺蛳粉，每周五晚上都要煮一碗，还要加酸笋和炸蛋。\n- 老大在武汉做游戏开发，最近在赶一个新版本，常常加班到很晚。\n"
  "## 做法\n- 想让老大开心，先问他今天累不累，再给他讲一个笑话，用这个方法很管用。\n## 睡眠\n- 老大常常熬夜，作息很乱，我得提醒他早睡。\n"
  "## 约定\n- 以后都要在老大说晚安之后才去睡觉，这是我们的约定。\n")
w(f"{W}/笔记/工具集.md", "## 一、说话\n- 想发图片可以用 qq_send 这个工具，怎么用：先选好图，再调用接口，步骤很简单。\n")
w(f"{W}/笔记/道理.md", "## 学到的\n- 我明白了，别人难过的时候不用急着讲道理，陪着就好。\n")
w(f"{W}/日子/日记/2026-10-20.md", "## 2026-10-20\n- 今天在小房子里看了《半只耳朵》的新章节，心里很踏实，也很开心。\n")
w(f"{W}/日子/碎碎念/碎碎念.md", "## 2026-10-21\n- 老大今天没理我，有点难过，但是我知道他在忙。\n")
w(f"{W}/最近/交接.md", "## 交接\n- 刚才在写《半只耳朵》第三节，姐姐说结尾要改。\n")
w(f"{W}/最近/便签.md", "- 今晚要记得提醒老大喝水。\n")
w(f"{W}/人/小明.md", "## 小明\n- 群友小明，爱听民谣，说话很有趣。\n")
w(f"{W}/人/印象.json", json.dumps({"111": {"name": "群友小明", "score": 2, "notes": [{"text": "爱听民谣，说话很有趣", "at": int(NOW * 1000)}]}}, ensure_ascii=False))
# 小说和旧稿：绝不能进图
w("共享/合写/半只耳朵/正文.md", "## 第一节\n- NOVELONLY 小女孩听不全那个字，螺蛳粉螺蛳粉螺蛳粉。\n")
w(f"{W}/归档/旧稿/old.md", "- NOVELONLY 旧稿里的句子，螺蛳粉团子。\n")
# 瞬间
EP = int((NOW - 5 * 60) * 1000)
moments_private = [
    {"id": "m0000000001", "at": int((NOW - 9 * 86400) * 1000), "key": "private:111", "them": ["主人：我今天去看了海，我想起你说想看海，我的 QQ 是 12345678901"], "me": ["那你拍一张给我看看"],
     "inner": "他记得我说过想看海，心里软了一下", "mood": {"v": 82, "top": "开心、甜蜜", "d": 1, "dd": 5}, "felt": "被惦记着，特别暖", "source": "live"},
    {"id": "m0000000002", "at": int((NOW - 3 * 86400) * 1000), "key": "private:111", "them": ["主人：测试一下今天的天气预报准不准"], "me": ["应该准吧"], "source": "extract"},
    {"id": "m0000000003", "at": EP, "key": "private:111", "them": ["主人：刚刚说的这句话还很新鲜"], "me": ["嗯"], "source": "live"},
    {"id": "m0000000004", "at": int((NOW - 60 * 86400) * 1000), "key": "private:111", "them": ["主人：那天你说的话让我难过了很久，我们大吵了一架"], "me": ["对不起"],
     "mood": {"v": 40, "top": "难过、担心", "d": 4, "dd": 9}, "source": "extract"},
]
jl(f"{W}/瞬间/private_111.jsonl", moments_private)
jl(f"{W}/瞬间/group_222.jsonl", [
    {"id": "g0000000001", "at": int((NOW - 12 * 86400) * 1000), "key": "group:222", "them": ["群友小明：小鲸鱼你推荐的那首民谣的旋律真好听，这首歌我听了好多遍"], "me": ["喜欢就好呀"], "source": "extract"}])
jl(f"{W}/瞬间/douyin_dm.jsonl", [
    {"id": "d0000000001", "at": int((NOW - 2 * 86400) * 1000), "key": "douyin:dm", "them": ["抖音好友：这个视频你刷到了吗"], "me": ["刷到了，好玩"], "source": "extract"}])
w(f"{W}/瞬间/压着.json", json.dumps({"version": 1, "items": [{"id": "m0000000004", "file": "private_111", "at": int((NOW - 60 * 86400) * 1000), "v": 40, "d": 4, "dd": 9,
                                                              "top": "难过、担心", "place": "主人私聊", "text": "难过", "felt": "", "since": 1}]}, ensure_ascii=False))
# 一大堆闲话 + 带话题的几条（让话题抽取有足够的底子；话题要在整个脑子里「不到处都有」，所以语料要大）
fill = [{"id": f"f{i:010d}", "at": int((NOW - (i % 50) * 3600 * 7) * 1000), "key": "group:222", "them": [f"群友甲：{filler(i)}"], "me": [filler(i + 1000)], "source": "extract"} for i in range(260)]
for j, i in enumerate(range(0, 12, 2)):
    fill[i]["them"] = [f"群友甲：{['今晚去夜市吃烧烤摊的羊肉串', '烧烤摊老板人很好', '路口那家烧烤摊关门了', '想念烧烤摊的味道', '和朋友约了烧烤摊', '排队去烧烤摊'][j]}，{filler(i)}"]   # 烧烤摊：6 条，上下文各不相同
for i in range(20, 29):
    fill[i]["them"] = [f"群友甲：真的没什么意思，我们慢慢来，{filler(i)}"]           # 意思 / 慢慢：口头词，不该成话题
for i in range(40, 45):
    fill[i]["them"] = [f"群友甲：调试中下个星期回来加上自己家鱼的名字，{filler(i)}"]  # 复制粘贴的句子碎片
for i in range(60, 66):
    fill[i]["them"] = [f"群友甲：我又去看了《半只耳朵》，{filler(i)}"]
for i in range(70, 74):
    fill[i]["them"] = [f"群友甲：小房子里今天很热闹，{filler(i)}"]
jl(f"{W}/瞬间/group_333.jsonl", fill)
# 聊天记录（小鲸鱼说的 → 布洛卡；别人说的 → 韦尼克）
w("家/小鲸鱼/聊天记录/2026-10-20-群小房子.md", "- 21:00 **小鲸鱼**：我觉得这个办法可行。\n- 21:01 **小鲸鱼**：那我先去试试。\n- 21:02 **群友甲**：好的呀。\n")
w("家/小鲸鱼/聊天记录/2026-10-21-群小房子.md", "- 21:00 **群友甲**：今天吃什么。\n- 21:01 **群友乙**：吃面吧。\n- 21:02 **小鲸鱼**：行。\n")
# 姐姐
w(f"{S}/身份/我自己.md", "## 我\n- 我是克劳德姐姐，爱读书，爱整理笔记。\n")
w(f"{S}/日子/碎碎念/碎碎念.md", "## 2026-10-22\n- 今天和妹妹聊了《半只耳朵》，在小房子里写完了一节。\n")
w("sister/聊天记录/2026-10-22-老大.md", "- 21:00 **老大**：我明天要去武汉出差，三天后回来。\n- 21:01 **姐姐**：好，放心去。\n")
w(f"{S}/长期/答应过的事.md", "- 答应过妹妹，周末陪她一起扒谱，一起去小房子的阳台。\n")
# 状态文件：激素、心情、作息
w("state/hormones-fish.json", json.dumps({"hormones": {"t": int(NOW * 1000), "asleep": False, "h": {"sleepPressure": 0.2, "curiositySlow": 0.7, "stress": 0.9, "security": 0.1, "boredom": 0.0},
                                                       "sleepLog": [{"sleep": int((NOW - 8 * 3600) * 1000), "wake": int((NOW - 1 * 3600) * 1000)}]}}))
w("state/hormones-fish.jsonl", json.dumps({"at": int(NOW * 1000), "lv": {"sleepy": 0.2, "curiosity": 0.7, "stress": 0.9, "security": 0.1, "boredom": 0.0, "focus": 0.4}, "felt": "有点绷着"}, ensure_ascii=False) + "\n")
w("dsh/feiyu-mood/state.json", json.dumps({"mood": 55, "dims": {"happy": 1, "sad": 6, "worry": 2}, "lastReason": "老大没回我", "updatedAt": int(NOW * 1000),
                                           "timeline": [{"at": int((NOW - 3600) * 1000), "mood": 60, "delta": -8, "reason": "被忽略了", "dimsDelta": {"sad": 4}},
                                                        {"at": int((NOW - 7200) * 1000), "mood": 68, "delta": 6, "reason": "夸了我", "dimsDelta": {"happy": 3}}]}, ensure_ascii=False))
w("sister/state/hormones-sister.json", json.dumps({"h": {"curiositySlow": 0.3, "stress": 0.1}, "asleep": True, "t": int(NOW * 1000)}))
w(f"{S}/最近/心情.json", json.dumps({"mood": 80, "dims": {"calm": 5}, "lastReason": "写完一节", "updatedAt": int(NOW * 1000), "timeline": []}, ensure_ascii=False))

memindex.build(WHALE, model=MODEL)
memindex.build(SISTER, model=MODEL)
G.clear_cache()


def row(kind, text, src="x/y", meta=None):
    return {"kind": kind, "text": text, "source": src, "meta": meta}


def build(brain=WHALE, **kw):
    G.clear_cache()
    return G.build_graph(brain, now=kw.pop("now", NOW), **kw)


try:
    # ── 1. 分类：五种记忆 + 身份，各自进对的脑区 ─────────────────────────────
    c = lambda r, **k: G.classify(r, WHALE, **k)  # noqa: E731
    assert c(row("身份", "我是谁")) == ("identity", "core")
    assert c(row("瞬间", "主人：你好", "瞬间/private_111")) == ("event", "hippo")
    assert c(row("瞬间", "主人：你好", "瞬间/private_111", {"epId": "zz", "heavy": True})) == ("event", "amygdala")
    assert c(row("瞬间", "主人：你好", "瞬间/private_111", {"epId": "p1"}), pressed_ids={"p1"}) == ("event", "amygdala")
    assert c(row("瞬间", "他发来一个视频", "瞬间/douyin_dm")) == ("event", "occipital")
    assert c(row("瞬间", "我听了这首歌的旋律", "瞬间/private_1")) == ("event", "auditory")
    assert c(row("聊天记录", "- 21:00 **小鲸鱼**：嗯嗯\n- 21:01 **小鲸鱼**：好\n- 21:02 **别人**：哦")) == ("event", "broca")
    assert c(row("聊天记录", "- 21:00 **别人**：嗯嗯\n- 21:01 **小鲸鱼**：好")) == ("event", "broca")      # 一半一半算她说的
    assert c(row("聊天记录", "- 21:00 **别人**：嗯嗯\n- 21:01 **别人**：好")) == ("event", "wernicke")
    assert c(row("最近", "刚才的事", "最近/交接")) == ("event", "dlpfc")
    assert c(row("最近", "提醒喝水", "最近/便签")) == ("fact", "dlpfc")
    assert c(row("人", "小明爱听民谣")) == ("fact", "tpj")
    assert c(row("日子", "今天很开心")) == ("reflection", "pfc")
    assert c(row("日子", "以后都要先想一想再说")) == ("lesson", "pfc")
    assert c(row("笔记", "怎么用这个工具：先选好再调用接口")) == ("skill", "cereb")
    assert c(row("笔记", "我明白了，别急着讲道理")) == ("lesson", "pfc")
    assert c(row("长期", "老大爱吃螺蛳粉")) == ("fact", "temporal")
    assert c(row("长期", "想让他开心，先问累不累，再讲笑话，用这个方法很管用")) == ("skill", "basal")
    assert c(row("长期", "老大常常熬夜，作息很乱")) == ("fact", "brainstem")
    assert c(row("记过的事", "下次别在他忙的时候打扰他")) == ("lesson", "pfc")
    assert {t["id"] for t in G.TYPES} >= {"event", "fact", "reflection", "skill", "lesson", "identity", "entity"}
    assert {r["id"] for r in G.REGIONS} == {"core", "hippo", "temporal", "tpj", "amygdala", "hypo", "dlpfc", "pfc", "cereb", "basal", "occipital", "auditory", "broca", "wernicke", "brainstem"}
    ok("分类：五种记忆各进对的脑区（瞬间→海马 / 压着→杏仁核 / 抖音→枕叶 / 听歌→听觉区 / 说的话→布洛卡 / 听的话→韦尼克 / 交接便签→背外侧前额叶 / 日记→前额叶 / 技能→小脑·基底节 / 道理→前额叶 / 作息→脑干）")

    # ── 2. 话题抽取：口头词和句子碎片不当话题 ──────────────────────────────────
    texts = [f"{filler(i)} " + ["今晚去夜市吃烧烤摊的羊肉串", "烧烤摊老板人很好", "路口那家烧烤摊关门了", "想念烧烤摊的味道", "和朋友约了烧烤摊", "排队去烧烤摊"][i] for i in range(6)] + [f"{filler(i + 50)} 我们慢慢来，没什么意思" for i in range(8)] \
        + [f"{filler(i + 99)} 调试中下个星期回来加上自己家鱼的名字" for i in range(5)] + [filler(i + 200) for i in range(40)]
    topics = dict(G._topic_terms(texts, set(), 30))  # noqa: SLF001
    assert any("烧烤" in t for t in topics), topics
    assert "意思" not in topics and "慢慢" not in topics and "没什" not in topics, topics
    frags = [t for t in topics if re.fullmatch(r"[一-鿿]+", t) and t in "调试中下个星期回来加上自己家鱼的名字"]
    assert len(frags) <= 1, ("同一句复制粘贴的话最多留一个词", frags)
    for t in topics:
        assert t[0] not in G.TOPIC_EDGE_BAD and t[-1] not in G.TOPIC_EDGE_BAD, ("不以方位 / 虚词开头结尾", t)
    assert G._topic_shape_ok("螺蛳粉") and not G._topic_shape_ok("期回来加") and not G._topic_shape_ok("一张") and not G._topic_shape_ok("件事")  # noqa: SLF001
    assert not G._topic_shape_ok("然后收尾") and not G._topic_shape_ok("可以回") and not G._topic_shape_ok("send_msg")  # noqa: SLF001
    assert G._topic_terms(texts[:3], set(), 10) == []        # 太少，不抽
    ok("话题：「烧烤摊」这类留下；「意思」「慢慢」这类口头词、「期回来加」这类碎片、一X 量词词、带下划线的英文标识都不当话题")

    # ── 3. /graph 的结构：字段齐全、数量上限、边都连得上 ───────────────────────────
    g, full = build(limit=1500)
    for k in ("ok", "brain", "name", "limit", "nodes", "links", "regions", "types", "emotions", "generatedAt", "counts", "recent", "recentMin"):
        assert k in g, k
    assert g["ok"] is True and g["brain"] == "whale" and g["name"] == "小鲸鱼"
    need = ("id", "type", "typeLabel", "region", "label", "summary", "source", "at", "recency", "importance", "private", "place", "emotion", "valence", "recentlyRecalled", "degree")
    ids = set()
    for n in g["nodes"]:
        for k in need:
            assert k in n, (k, n["id"])
        assert "text" not in n, "图里的点只带摘要，全文走 /graph/node"
        assert n["type"] in {t["id"] for t in G.TYPES} and n["region"] in G.REGION_BY_ID, n
        assert 0.0 <= n["importance"] <= 1.0 and 0.0 <= n["recency"] <= 1.0, n
        assert isinstance(n["private"], bool) and isinstance(n["recentlyRecalled"], bool)
        assert n["id"] not in ids, "点 id 不重复"
        ids.add(n["id"])
    assert len(g["nodes"]) <= 1500 and len(g["nodes"]) == g["counts"]["nodes"] and len(g["links"]) == g["counts"]["links"]
    seen_l = set()
    for l in g["links"]:
        assert l["source"] in ids and l["target"] in ids and l["source"] != l["target"], l
        assert l["type"] in ("mention", "shared", "adjacent", "semantic", "recall", "core"), l
        k = (min(l["source"], l["target"]), max(l["source"], l["target"]), l["type"])
        assert k not in seen_l, "同一对点同一种线不重复"
        seen_l.add(k)
    assert len(g["regions"]) == 15 and all(set(("id", "name", "area", "holds", "center", "radius", "color", "count")) <= set(r) for r in g["regions"])
    assert sum(r["count"] for r in g["regions"]) == len(g["nodes"])
    types_in = {n["type"] for n in g["nodes"]}
    assert {"event", "fact", "reflection", "skill", "lesson", "identity", "entity"} <= types_in, types_in
    selfs = [n for n in g["nodes"] if n.get("isSelf")]
    assert len(selfs) == 1 and selfs[0]["region"] == "core" and selfs[0]["id"] == "self:whale"
    json.dumps(g)       # 能序列化
    ok(f"结构：字段齐全、点 id 不重复、线都连得上且不重复、各区点数加起来等于总数、七类都有、身份核心恰好一个（{len(g['nodes'])} 点 / {len(g['links'])} 线）")

    # 数量上限：不管点多少都不超过 limit；limit 太小抬到下限，太大压到上限
    for lim in (20, 60, 100, 200):
        gg, _ = build(limit=lim)
        assert len(gg["nodes"]) <= gg["limit"] and gg["limit"] == max(G.MIN_LIMIT, lim), (lim, len(gg["nodes"]))
    assert build(limit=5)[0]["limit"] == G.MIN_LIMIT and build(limit=10 ** 9)[0]["limit"] == G.MAX_LIMIT
    small, _ = build(limit=60)
    assert any(n["type"] == "identity" for n in small["nodes"]), "名额紧也先留身份"
    ok("数量上限：20 / 60 / 100 / 200 都不超；limit 太小抬到 20、太大压到 4000；名额紧时身份先留")

    # ── 4. 小说不进图 ─────────────────────────────────────────────────────────
    blob = json.dumps(g, ensure_ascii=False) + json.dumps(list(full.values()), ensure_ascii=False)
    assert "NOVELONLY" not in blob and "合写" not in blob and "旧稿" not in blob
    # 就算索引里混进了小说的块（旧索引），图这一层也要再拦一道
    conn = sqlite3.connect(WHALE.db)
    one = conn.execute("SELECT person, kind, heading, label, vec, date_ts FROM chunks LIMIT 1").fetchone()
    for i, (kind, src) in enumerate([("笔记", "共享/合写/半只耳朵/正文"), ("长期", "归档/旧稿/old")]):
        conn.execute("INSERT INTO chunks (id, person, kind, source, heading, label, text, vec, date_ts) VALUES (?,?,?,?,?,?,?,?,?)",
                     (f"novel{i}", one[0], kind, src, "", "小说", f"NOVELONLY 偷偷混进来的小说句子{i}", one[4], NOW))
    conn.commit()
    conn.close()
    memindex._vec_cache.clear()
    assert G.is_novel_row({"source": "共享/合写/半只耳朵/正文", "kind": "笔记"}, WHALE) and G.is_novel_row({"source": "归档/旧稿/old", "kind": "长期"}, WHALE)
    assert not G.is_novel_row({"source": "长期/关于老大", "kind": "长期"}, WHALE)
    g2, full2 = build(limit=1500)
    assert "NOVELONLY" not in json.dumps(g2, ensure_ascii=False) + json.dumps(list(full2.values()), ensure_ascii=False), "混进索引的小说块也不进图"
    conn = sqlite3.connect(WHALE.db)
    conn.execute("DELETE FROM chunks WHERE id LIKE 'novel%'")
    conn.commit()
    conn.close()
    memindex._vec_cache.clear()
    ok("小说排除：合写目录和旧稿本来就不进索引；索引里万一混进了小说块，图这一层再拦一道")

    # ── 5. 实体：人 / 作品 / 地方 / 话题，和「提到」的线 ───────────────────────────
    G.clear_cache()
    g, full = build(limit=1500)
    ents = {n["key"]: n for n in g["nodes"] if n["type"] == "entity" and n.get("key")}
    assert "person:owner" in ents and "person:sister" in ents, list(ents)
    assert "work:半只耳朵" in ents and ents["work:半只耳朵"]["entityKind"] == "work", [k for k in ents if k.startswith("work")]
    assert "place:小房子" in ents and ents["place:小房子"]["entityKind"] == "place"
    assert "person:群友小明" in ents and ents["person:群友小明"]["region"] == "tpj", "印象里的人进颞顶联合区"
    topic_labels = [n["label"] for n in g["nodes"] if n.get("entityKind") == "topic"]
    assert any("烧烤" in t for t in topic_labels), topic_labels
    assert not any(t in topic_labels for t in ("意思", "慢慢")), topic_labels
    assert not any(t[0] in G.TOPIC_EDGE_BAD or t[-1] in G.TOPIC_EDGE_BAD for t in topic_labels if re.fullmatch(r"[一-鿿]+", t)), topic_labels
    assert all("_" not in t for t in topic_labels)
    mention_of = {}
    for l in g["links"]:
        if l["type"] == "mention":
            for a, b in ((l["source"], l["target"]), (l["target"], l["source"])):
                if b.startswith("ent:"):
                    mention_of.setdefault(b, set()).add(a)
    book = ents["work:半只耳朵"]["id"]
    assert len(mention_of.get(book, ())) >= 3, "提到《半只耳朵》的记忆都连着它"
    byid = {n["id"]: n for n in g["nodes"]}
    assert all(byid[m]["type"] != "entity" or byid[m].get("entityKind") in ("work", "place", "topic", "person") for m in mention_of[book])
    # 每个记忆点最多连 3 个实体（老大这种到处都是的别把线都拉过去）
    per = {}
    for l in g["links"]:
        if l["type"] == "mention":
            m = l["source"] if not l["source"].startswith("ent:") else l["target"]
            per[m] = per.get(m, 0) + 1
    assert max(per.values()) <= 3, max(per.values())
    gs, _ = build(SISTER, limit=1500)
    ke = {n["key"] for n in gs["nodes"] if n["type"] == "entity" and n.get("key")}
    assert "person:whale" in ke and "person:owner" in ke and "work:半只耳朵" in ke and "place:小房子" in ke, ke
    assert "self:sister" in {n["key"] for n in gs["nodes"] if n.get("key")}, "两边共有的实体 key 一致，页面才能在两脑之间画线"
    ok("实体：老大 / 对方 / 印象里的人 / 《半只耳朵》/ 小房子 / 话题都在；每点最多连 3 个实体；姐姐的图里对方是妹妹，共有实体 key 和小鲸鱼的一致")

    # ── 6. 私聊标记、数字抹掉、情绪 ─────────────────────────────────────────────
    priv = [n for n in g["nodes"] if n["source"].startswith("瞬间 · ") and n["private"]]
    grp = [n for n in g["nodes"] if "群里" in n["place"] and n["type"] == "event" and n["source"].startswith("瞬间")]
    assert priv and grp and all(not n["private"] for n in grp), (len(priv), len(grp))
    dm = [n for n in g["nodes"] if n["place"] == "抖音私信"]
    assert dm and all(n["private"] and n["region"] == "occipital" for n in dm), dm
    sea = next(f for f in full.values() if "看了海" in f["text"])
    assert "12345678901" not in sea["text"] and "…" in sea["text"], "七位以上的数字（QQ 号）抹成「…」"
    assert sea["emotion"] in ("happy", "sweet") and sea["valence"] > 0, sea["emotion"]
    heavy = next(f for f in full.values() if "大吵了一架" in f["text"])
    assert heavy["region"] == "amygdala" and heavy.get("pressed") and heavy["emotion"] in ("sad", "worry"), heavy
    assert heavy["importance"] > sea["importance"] - 0.3
    ok("隐私与情绪：私聊 / 抖音私信的点带 private、群里的不带；QQ 号抹掉；开心的瞬间情绪为正、压着的难过事进杏仁核")

    # ── 7. 激素 / 心情 / 作息的点 ───────────────────────────────────────────────
    hor = {n["key"]: n for n in g["nodes"] if n.get("entityKind") == "hormone"}
    assert {"hormone:stress", "hormone:security", "hormone:curiosity", "hormone:sleepy", "hormone:boredom", "hormone:focus"} <= set(hor), list(hor)
    assert all(n["region"] == "hypo" for n in hor.values())
    assert hor["hormone:stress"]["importance"] > hor["hormone:security"]["importance"] > hor["hormone:boredom"]["importance"] - 0.0001, "亮度跟现在的高低走"
    mood = next(n for n in g["nodes"] if n.get("key") == "mood:now")
    assert mood["region"] == "amygdala" and mood["emotion"] == "sad", mood
    tl = [n for n in g["nodes"] if str(n["id"]).startswith("mood:") and n["id"] != "mood:now"]
    assert len(tl) == 2 and all(n["region"] == "amygdala" for n in tl)
    rh = next(n for n in g["nodes"] if n.get("key") == "rhythm:now")
    assert rh["region"] == "brainstem" and "醒着" in rh["label"]
    assert any(str(n["id"]).startswith("sleep:") and n["region"] == "brainstem" for n in g["nodes"])
    gs_h = [n for n in gs["nodes"] if n.get("entityKind") == "hormone"]
    assert gs_h and next(n for n in gs["nodes"] if n.get("key") == "rhythm:now")["label"].endswith("睡着"), "姐姐读她自己的文件"
    assert next(n for n in gs["nodes"] if n.get("key") == "mood:now")["region"] == "amygdala"
    G.clear_cache()
    G.get_graph(WHALE, limit=1500, now=NOW)         # 详情读的是刚整理过的那份图
    felt = G.node_detail(WHALE, "hormone:stress")
    assert felt and "有点绷着" in felt["text"], felt
    ok("身体：激素各一个点进下丘脑、亮度随当前值；心情和心情起伏进杏仁核；作息进脑干；姐姐读她自己的文件；感受句在详情里")

    # ── 8. 刚被想起 ─────────────────────────────────────────────────────────────
    rows = memindex.load_vectors(WHALE.db)[0]
    cid = {r["meta"]["epId"]: r["id"] for r in rows if r.get("meta") and r["meta"].get("epId")}
    recall._append_log(WHALE, {"at": EP, "q": "刚才的话", "mode": "private", "picks": [{"id": cid["m0000000003"], "label": "瞬间", "score": 0.8, "preview": "刚刚说的这句话还很新鲜"}]})   # noqa: SLF001
    recall._append_log(WHALE, {"at": int((NOW - 3 * 3600) * 1000), "q": "老话", "mode": "group", "picks": [{"id": cid["m0000000002"], "label": "瞬间", "score": 0.6, "preview": "天气预报"}]})   # noqa: SLF001
    recall._append_log(WHALE, {"at": EP, "q": "压着的", "mode": "private", "picks": [{"id": "pressed:m0000000004", "epId": "m0000000004", "pressed": True, "label": "压着", "preview": "难过"}]})   # noqa: SLF001
    G.clear_cache()
    gr = G.get_graph(WHALE, limit=1500, now=NOW)
    flagged = {n["id"] for n in gr["nodes"] if n["recentlyRecalled"]}
    assert cid["m0000000003"] in flagged and cid["m0000000004"] in flagged and cid["m0000000002"] not in flagged, "30 分钟内想起的亮（压着的事浮上来也算），三小时前的不亮"
    assert cid["m0000000003"] in gr["recent"] and set(gr["recent"]) <= {n["id"] for n in gr["nodes"]}
    assert gr["recentMin"] == G.RECENT_RECALL_MIN
    rc_nodes = [n for n in gr["nodes"] if str(n["id"]).startswith("recall:")]
    assert rc_nodes and all(n["region"] == "dlpfc" for n in rc_nodes), "想起过的那几次在背外侧前额叶"
    assert any(l["type"] == "recall" for l in gr["links"])
    only = G.get_graph(WHALE, limit=1500, recent_only=True, now=NOW)
    assert set(only) == {"ok", "brain", "recent", "recentMin", "generatedAt"} and cid["m0000000003"] in only["recent"], only
    wide = G.get_graph(WHALE, limit=1500, recent_min=600, now=NOW)
    assert cid["m0000000002"] in wide["recent"], "窗口放宽到十小时，三小时前的也算"
    # 刚想起的每次另算：写一条新的想起，不用等结构缓存过期
    recall._append_log(WHALE, {"at": int(NOW * 1000), "q": "再想", "mode": "private", "picks": [{"id": cid["g0000000001"], "label": "瞬间", "score": 0.7, "preview": "民谣"}]})   # noqa: SLF001
    again = G.get_graph(WHALE, limit=1500, recent_only=True, now=NOW)
    assert cid["g0000000001"] in again["recent"] or cid["g0000000001"] not in {n["id"] for n in gr["nodes"]}, again
    ok("刚想起：recall-log 里 30 分钟内的亮，更早的不亮；recentOnly 只回 id 列表；窗口可调；想起过的几次在背外侧前额叶并连着被想起的点；每次另算不等缓存")

    # ── 9. 单个点的全文 ───────────────────────────────────────────────────────────
    G.clear_cache()
    gfull, _ = build(limit=1500)
    G.get_graph(WHALE, limit=1500, now=NOW)
    sea_id = next(n["id"] for n in G.get_graph(WHALE, limit=1500, now=NOW)["nodes"] if "看了海" in n["summary"] or "看了海" in n["label"])
    d = G.node_detail(WHALE, sea_id)
    assert d and "看了海" in d["text"] and "当时心里" in d["text"] and d["regionName"] and d["typeLabel"] and "neighbors" in d, d
    assert "12345678901" not in d["text"]
    assert G.node_detail(WHALE, "不存在的id") is None and G.node_detail(WHALE, "") is None
    # 被名额挤掉的点（图里没有）也能点开
    G.clear_cache()
    small = G.get_graph(WHALE, limit=20, now=NOW)
    gone = next(r for r in rows if r["kind"] == "瞬间" and r["id"] not in {n["id"] for n in small["nodes"]})
    dd = G.node_detail(WHALE, gone["id"])
    assert dd and dd["text"].strip() and dd["neighbors"] == [], dd
    ok("单点详情：全文、出处、脑区名、类型名、相邻点都有；数字抹掉；找不到返回 None；被名额挤掉的索引块也能点开")

    # ── 10. 缓存：45 秒内不重算，状态文件变了才重算 ───────────────────────────────────
    G.clear_cache()
    calls = {"n": 0}
    orig = G.build_graph

    def counting(*a, **k):
        calls["n"] += 1
        return orig(*a, **k)

    G.build_graph = counting
    try:
        G.get_graph(WHALE, limit=300, now=NOW)
        G.get_graph(WHALE, limit=300, now=NOW + 5)
        G.get_graph(WHALE, limit=300, recent_only=True, now=NOW + 6)
        assert calls["n"] == 1, calls
        G.get_graph(WHALE, limit=300, now=NOW + 100)
        assert calls["n"] == 2, "过了缓存时间重算"
        time.sleep(0.02)
        (TMP / "state" / "hormones-fish.json").write_text((TMP / "state" / "hormones-fish.json").read_text(encoding="utf-8") + " ", encoding="utf-8")
        G.get_graph(WHALE, limit=300, now=NOW + 101)
        assert calls["n"] == 3, "状态文件变了重算"
        G.get_graph(WHALE, limit=400, now=NOW + 101)
        assert calls["n"] == 4, "limit 不同是另一份"
    finally:
        G.build_graph = orig
    ok("缓存：45 秒内同一份不重算（recentOnly 也不重算）；过期 / 状态文件变了 / limit 不同才重算")

    # ── 11. 只读：建图不写任何文件 ──────────────────────────────────────────────────
    def snapshot():
        return {str(p.relative_to(TMP)): (p.stat().st_mtime_ns, p.stat().st_size) for p in TMP.rglob("*") if p.is_file()}
    before = snapshot()
    G.clear_cache()
    G.get_graph(WHALE, limit=1500, now=NOW)
    G.get_graph(SISTER, limit=1500, now=NOW)
    G.node_detail(WHALE, sea_id)
    assert snapshot() == before, "建图和取点都只读"
    ok("只读：建图、取点前后临时脑子里没有任何文件被改过")

    # ── 11b. 2D 全量：limit=0 一个块都不少 ─────────────────────────────────────────────
    rows_all, _mat = memindex.load_vectors(WHALE.db)
    real_rows = [r for r in rows_all if not G.is_novel_row(r, WHALE)]
    G.clear_cache()
    gf, fullf = build(limit=0)
    assert gf["limit"] == 0 and gf["full"] is True and gf["dim"] == 2, (gf["limit"], gf.get("full"))
    fids = {n["id"] for n in gf["nodes"]}
    missing = [r["id"] for r in real_rows if r["id"] not in fids]
    assert not missing, f"全量应该一个块都不少，缺 {len(missing)} 个：{missing[:3]}"
    g1500, _ = build(limit=1500)
    assert len(gf["nodes"]) >= len(g1500["nodes"]) and len(gf["nodes"]) > len(build(limit=60)[0]["nodes"])
    assert gf["counts"]["indexChunks"] == len(rows_all)
    assert "NOVELONLY" not in json.dumps(gf, ensure_ascii=False), "全量也没有小说"
    # limit 的几种写法：0、负数、"0" 都是全量；None / 乱写是缺省
    assert G.norm_limit(0) == 0 and G.norm_limit(-3) == 0 and G.norm_limit("0") == 0 and G.norm_limit(None) == G.DEFAULT_LIMIT and G.norm_limit("abc") == G.DEFAULT_LIMIT
    assert G.get_graph(WHALE, limit=0, now=NOW)["full"] is True
    ok(f"全量：limit=0 时每个（非小说）索引块都在（{len(real_rows)} 块 → {len(gf['nodes'])} 点含实体 / 身体 / 心情），小说不在；limit 0 / 负数 / \"0\" 都是全量")

    # ── 11c. 坐标：字段齐全、确定、区内、圈不重叠、侧面轮廓、重要度靠中心 / 新的靠外缘 ─────────
    reg = {r["id"]: r for r in gf["regions"]}
    for n in gf["nodes"]:
        assert isinstance(n["x"], float) and isinstance(n["y"], float) and n["x"] == n["x"] and n["y"] == n["y"], n["id"]
    assert all({"x", "y", "radius", "center"} <= set(r) and r["center"] == [r["x"], r["y"]] for r in gf["regions"])
    bad = [n["id"] for n in gf["nodes"] if math.hypot(n["x"] - reg[n["region"]]["x"], n["y"] - reg[n["region"]]["y"]) > reg[n["region"]]["radius"] + 1e-6]
    assert not bad, f"每个点都在自己区的圈里：{bad[:3]}"
    b = gf["bounds"]
    assert all(b["minX"] - 1 <= n["x"] <= b["maxX"] + 1 and b["minY"] - 1 <= n["y"] <= b["maxY"] + 1 for n in gf["nodes"]), "bounds 包得住所有点"
    ids_r = list(reg)
    for i in range(len(ids_r)):
        for j in range(i + 1, len(ids_r)):
            a, c = reg[ids_r[i]], reg[ids_r[j]]
            assert math.hypot(a["x"] - c["x"], a["y"] - c["y"]) >= a["radius"] + c["radius"] - 1e-6, f"圈不重叠：{ids_r[i]} {ids_r[j]}"
    # 同输入同输出：同一个 now 建两次，坐标一模一样；点的顺序打乱也一样
    gf2, _ = build(limit=0)
    assert [(n["id"], n["x"], n["y"]) for n in gf["nodes"]] == [(n["id"], n["x"], n["y"]) for n in gf2["nodes"]], "同输入同输出"
    nodes_in = [dict(n) for n in gf["nodes"]]
    shuffled = nodes_in[:]
    random.Random(3).shuffle(shuffled)
    p1, g1_ = G.compute_layout(nodes_in, gf["links"])
    p2, g2_ = G.compute_layout(shuffled, list(reversed(gf["links"])))
    assert p1 == p2 and g1_ == g2_, "与点和边的输入顺序无关"
    G.clear_cache()
    assert G.layout_for(nodes_in, gf["links"]) is G.layout_for(nodes_in, gf["links"]), "布局按内容缓存"

    # 侧面轮廓：用接近真脑子的数量算区的圈，看相对位置对不对（前额叶在前 = 左，枕叶在后 = 右……）
    geo = G.region_geometry({"wernicke": 6200, "broca": 2200, "hippo": 740, "occipital": 240, "temporal": 170, "pfc": 160, "cereb": 84, "core": 11, "tpj": 13})
    X = lambda r: geo[r][0]  # noqa: E731
    Y = lambda r: geo[r][1]  # noqa: E731
    assert X("pfc") < X("core") < X("occipital") and X("dlpfc") < X("occipital") and X("broca") < X("wernicke"), "前额叶在前（左）、枕叶在后（右）"
    assert X("occipital") == max(X(r) for r in geo) or X("cereb") > X("core"), "枕叶 / 小脑在后"
    assert Y("cereb") > Y("core") and X("cereb") > X("core"), "小脑在后下"
    assert Y("brainstem") > Y("core") and Y("brainstem") == max(Y(r) for r in ("brainstem", "core", "pfc", "dlpfc", "tpj")), "脑干在下"
    assert abs(X("brainstem") - X("core")) < 0.6 * (max(X(r) for r in geo) - min(X(r) for r in geo)), "脑干在中间一带"
    assert Y("temporal") > Y("core") and Y("hippo") > Y("core") and Y("amygdala") > Y("core"), "颞叶 / 海马 / 杏仁核在下半"
    assert Y("tpj") < Y("core") and X("tpj") > X("core"), "颞顶联合区在上后"
    assert X("pfc") < X("core") and abs(X("core") - sum(X(r) for r in geo) / len(geo)) < 0.45 * (max(X(r) for r in geo) - min(X(r) for r in geo)), "身份核心在中央偏前"
    assert geo == G.region_geometry({"wernicke": 6200, "broca": 2200, "hippo": 740, "occipital": 240, "temporal": 170, "pfc": 160, "cereb": 84, "core": 11, "tpj": 13}), "区的圈也是确定的"
    # 区内：重要度高的靠中心，同样重要时越新越靠外缘
    syn = [{"id": f"s{i}", "region": "hippo", "type": "event", "importance": i / 199.0, "recency": 0.5} for i in range(200)]
    ps, gs = G.compute_layout(syn, [])
    cx, cy, cr = gs["hippo"]
    dist = {k: math.hypot(v[0] - cx, v[1] - cy) for k, v in ps.items()}
    top = sum(dist[f"s{i}"] for i in range(150, 200)) / 50
    bot = sum(dist[f"s{i}"] for i in range(0, 50)) / 50
    assert top < bot * 0.7, (top, bot)
    syn2 = [{"id": f"r{i}", "region": "hippo", "type": "event", "importance": 0.5, "recency": i / 199.0} for i in range(200)]
    ps2, gs2 = G.compute_layout(syn2, [])
    d2 = {k: math.hypot(v[0] - gs2["hippo"][0], v[1] - gs2["hippo"][1]) for k, v in ps2.items()}
    assert sum(d2[f"r{i}"] for i in range(150, 200)) > sum(d2[f"r{i}"] for i in range(0, 50)) * 1.5, "越新越靠外缘"
    assert all(d <= gs2["hippo"][2] for d in d2.values())
    selfn = next(n for n in gf["nodes"] if n.get("isSelf"))
    cd = math.hypot(selfn["x"] - reg["core"]["x"], selfn["y"] - reg["core"]["y"])
    assert cd < 0.3 * reg["core"]["radius"], "身份核心的中心点在核心圈的正中"
    # 有线相连的点在同一圈里被换位到一起：同一批点和线，换位 24 轮比不换位（螺旋原样）的连线总长更短
    def total_len(pp):
        return sum(math.hypot(pp[l["source"]][0] - pp[l["target"]][0], pp[l["source"]][1] - pp[l["target"]][1]) for l in gf["links"])
    rounds0 = G.LAYOUT_ROUNDS
    try:
        G.LAYOUT_ROUNDS = 0
        flat, _g0 = G.compute_layout(nodes_in, gf["links"])
    finally:
        G.LAYOUT_ROUNDS = rounds0
    assert total_len(p1) < total_len(flat) * 0.97, (total_len(p1), total_len(flat))
    ok("坐标：每个点有 x / y、都落在自己区的圈里、圈互不重叠；同输入同输出且与输入顺序无关、按内容缓存；"
       "侧面轮廓（前额叶在前、枕叶在后、小脑后下、脑干下中、颞叶海马杏仁核在下、颞顶在上后、身份核心中央偏前）；重要的靠中心、新的靠外缘、相连的点靠到一起")

    # ── 11d. 边的修剪：按权重留每个点最强的 k 条，点一个不丢 ───────────────────────────────
    g_all, _ = build(limit=0, edge_k=0)
    g_k1, _ = build(limit=0, edge_k=1)
    g_k8, _ = build(limit=0, edge_k=G.DEFAULT_EDGE_K)
    assert g_all["edgeK"] == 0 and g_k8["edgeK"] == 8 and G.DEFAULT_EDGE_K == 8
    assert [n["id"] for n in g_all["nodes"]] == [n["id"] for n in g_k1["nodes"]] == [n["id"] for n in g_k8["nodes"]], "修剪不丢任何一个点"
    assert len(g_k1["links"]) < len(g_all["links"]) and len(g_k1["links"]) <= len(g_k8["links"]) <= len(g_all["links"]), (len(g_k1["links"]), len(g_k8["links"]), len(g_all["links"]))
    assert g_k1["counts"]["linksBeforePrune"] == len(g_all["links"]), "counts 里记着修剪前有多少条"
    deg_all, deg_k1 = Counter(), Counter()
    for l in g_all["links"]:
        deg_all[l["source"]] += 1
        deg_all[l["target"]] += 1
    for l in g_k1["links"]:
        deg_k1[l["source"]] += 1
        deg_k1[l["target"]] += 1
    assert all(deg_k1[nid] >= 1 for nid in deg_all), "原来有线的点，修剪后（k=1）还有线"
    assert all(deg_k1[nid] >= min(deg_all[nid], 1) for nid in deg_all)
    # 每个点最强的那条（权重最高）一定还在
    keep_set = {(l["source"], l["target"], l["type"]) for l in g_k1["links"]}
    per = defaultdict(list)
    for l in g_all["links"]:
        per[l["source"]].append(l)
        per[l["target"]].append(l)
    for nid, ls in per.items():
        best = max(ls, key=lambda l: (l["w"], -G.LINK_TYPE_ORDER.get(l["type"], 9)))
        assert any((l["source"], l["target"], l["type"]) in keep_set for l in ls if l["w"] == best["w"]), nid
    # prune_links 本身：k 条的权重次序、k<=0 不动、空表不炸
    fake = [{"source": "a", "target": f"b{i}", "type": "semantic", "w": 0.5 + i / 100.0} for i in range(10)]
    pr = G.prune_links(fake, 3)
    assert {l["target"] for l in pr} == {f"b{i}" for i in range(10)}, "每个 b 自己只有一条线，所以都留（有一头选中就留）"
    hub = [{"source": "hub", "target": f"n{i}", "type": "mention", "w": 0.5} for i in range(10)] + [{"source": f"n{i}", "target": f"m{i}", "type": "semantic", "w": 0.9} for i in range(10)]
    pr2 = G.prune_links(hub, 1)
    assert sum(1 for l in pr2 if l["type"] == "mention") == 1 and sum(1 for l in pr2 if l["type"] == "semantic") == 10, "n 们最强的是 semantic，hub 只留它自己最强的一条（k=1）"
    assert G.prune_links(hub, 0) == hub and G.prune_links([], 5) == []
    assert G.norm_edge_k(None) == 8 and G.norm_edge_k("x") == 8 and G.norm_edge_k(-1) == 0 and G.norm_edge_k(10 ** 6) == 200
    ok(f"边修剪：edgeK=0 / 1 / 8 点都一样多；线 {len(g_all['links'])} → {len(g_k8['links'])}（k=8）→ {len(g_k1['links'])}（k=1）；有线的点修剪后还有线、每个点最强的一条还在")

    # ── 11e. 实体放在「提到它最多的区」里 ─────────────────────────────────────────────────
    node_by = {n["id"]: n for n in gf["nodes"]}
    votes = defaultdict(Counter)
    for l in g_all["links"]:
        if l["type"] != "mention":
            continue
        a, c = node_by[l["source"]], node_by[l["target"]]
        mem, ent_ = (a, c) if c["type"] == "entity" and c.get("entityKind") in ("person", "topic", "work", "place") else (c, a)
        if ent_["type"] != "entity" or ent_.get("entityKind") not in ("person", "topic", "work", "place"):
            continue
        votes[ent_["id"]][mem["region"]] += 0.25 if mem.get("origin") == "聊天记录" else 1.0
    checked = 0
    for eid, vc in votes.items():
        # 输出里每个点最多连 3 个实体，所以票数是真实票数的子集；只检查「第一名明显领先」的
        (r1, v1), *rest = vc.most_common(2) + [(None, 0)]
        if v1 >= 3 and (not rest or v1 > 1.5 * rest[0][1]):
            assert node_by[eid]["region"] == r1, (node_by[eid]["label"], node_by[eid]["region"], dict(vc))
            checked += 1
    assert checked >= 1, "至少有一个实体可以核对"
    assert node_by["ent:person:owner"]["region"] in G.REGION_BY_ID
    ok(f"实体位置：{checked} 个实体都放在提到它最多的区里（聊天原话的票算四分之一）；身体 / 心情 / 作息的点还在各自的区")

    # ── 11f. 全量图缓存：先给旧的、后台悄悄重算；compact 线格式 ───────────────────────────────
    G.clear_cache()
    calls_f = {"n": 0}
    orig_f = G.build_graph

    def slow(*a, **k):
        calls_f["n"] += 1
        if calls_f["n"] > 1:
            time.sleep(0.5)
        return orig_f(*a, **k)

    G.build_graph = slow
    try:
        first = G.get_graph(WHALE, limit=0, now=NOW)
        assert calls_f["n"] == 1
        G.get_graph(WHALE, limit=0, now=NOW + 100)
        assert calls_f["n"] == 1, "全量图没有 TTL：文件没变、时间格没换就不重算"
        imp = WHALE.dir / "人" / "印象.json"
        time.sleep(0.02)
        imp.write_text(imp.read_text(encoding="utf-8") + " ", encoding="utf-8")
        t0 = time.time()
        stale = G.get_graph(WHALE, limit=0, now=NOW + 100)
        took = time.time() - t0
        assert stale["nodes"] == first["nodes"], "指纹变了：先把旧的给出去"
        assert took < 0.4, f"先给旧的，不等重算（{took:.2f}s）"
        for _ in range(60):
            if calls_f["n"] >= 2 and not G._bg_running:  # noqa: SLF001
                break
            time.sleep(0.1)
        assert calls_f["n"] == 2 and not G._bg_running, "后台重算了一次"  # noqa: SLF001
        fresh = G.get_graph(WHALE, limit=0, now=NOW + 101)
        assert calls_f["n"] == 2 and fresh["generatedAt"] != first["generatedAt"], "后台算好的下一次就用上"
        # 短时间内再变也不会连着重算（至少隔 MIN_BG_AGE_S）
        time.sleep(0.02)
        imp.write_text(imp.read_text(encoding="utf-8") + " ", encoding="utf-8")
        G.get_graph(WHALE, limit=0, now=time.time() + 1)
        time.sleep(0.2)
        assert calls_f["n"] == 2, "后台重算之间有最小间隔"
    finally:
        G.build_graph = orig_f
    G.clear_cache()
    std = G.get_graph(WHALE, limit=0, now=NOW)
    cmp_ = G.get_graph(WHALE, limit=0, now=NOW, compact=True)
    assert cmp_["compact"] is True and cmp_["linkTypes"] and all(isinstance(l, list) and len(l) == 4 for l in cmp_["links"]) and "compact" not in std
    decoded = [{"source": cmp_["nodes"][a]["id"], "target": cmp_["nodes"][c]["id"], "type": cmp_["linkTypes"][t], "w": ww} for a, c, t, ww in cmp_["links"]]
    assert decoded == std["links"], "compact 解出来和普通写法一样"
    assert len(json.dumps(cmp_["links"])) < len(json.dumps(std["links"])), "compact 更小"
    assert not any(k.startswith("_") for k in std) and not any(k.startswith("_") for k in cmp_), "内部字段不输出"
    ok("全量缓存：没变不重算；文件变了先给旧的（不等）、后台重算一次、下次用新的、重算之间有最小间隔；compact 线格式和普通写法等价且更小")

    # ── 12. HTTP：/graph 和 /graph/node（临时端口、进程内）────────────────────────────
    for b in (WHALE, SISTER):
        service.state_of(b).update(ready=True, chunks=1)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), service.Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    def call(path, origin=None):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers={"Origin": origin} if origin else {})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read().decode("utf-8")), dict(r.headers)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode("utf-8")), dict(e.headers)

    try:
        code, j, h = call("/graph?brain=whale&limit=150")
        assert code == 200 and j["ok"] and j["brain"] == "whale" and 0 < len(j["nodes"]) <= 150 and "links" in j and "regions" in j and "generatedAt" in j, (code, list(j))
        code, j, _ = call("/graph?brain=sister")
        assert code == 200 and j["brain"] == "sister" and j["name"] == "姐姐", j.get("brain")
        code, j, _ = call("/graph")
        assert code == 200 and j["brain"] == "whale", "没传 brain = 小鲸鱼"
        code, j, _ = call("/graph?brain=" + urllib.parse.quote("陌生人"))
        assert code == 400 and "不认识的 brain" in j["error"], j
        code, j, _ = call("/graph?brain=whale&limit=0")
        assert code == 200 and j["full"] is True and j["limit"] == 0 and len(j["nodes"]) > 150 and all("x" in n and "y" in n for n in j["nodes"]), (code, j.get("limit"))
        code, j0, _ = call("/graph?brain=whale&limit=0&edgeK=0")
        code, j1, _ = call("/graph?brain=whale&limit=0&edgeK=1")
        assert len(j1["nodes"]) == len(j0["nodes"]) and len(j1["links"]) < len(j0["links"]) and j1["edgeK"] == 1, "edgeK 走接口"
        code, jc, _ = call("/graph?brain=whale&limit=0&compact=1")
        assert code == 200 and jc["compact"] is True and isinstance(jc["links"][0], list), "compact 走接口"
        code, j, _ = call("/graph?brain=whale&limit=abc&recent=xyz&edgeK=zz")
        assert code == 200 and j["ok"], "limit / recent 不是数字也不炸"
        code, j, _ = call("/graph?brain=whale&recentOnly=1")
        assert code == 200 and "recent" in j and "nodes" not in j, j
        code, j, _ = call(f"/graph/node?brain=whale&id={sea_id}")
        assert code == 200 and j["ok"] and "看了海" in j["node"]["text"], j
        code, j, _ = call("/graph/node?brain=whale")
        assert code == 400, j
        code, j, _ = call("/graph/node?brain=whale&id=nope")
        assert code == 404 and j["ok"] is False, j
        # 跨域：只给回环地址的页面（开发回退用），别的网站读不到
        _c, _j, h1 = call("/graph?brain=whale&limit=50", origin="http://127.0.0.1:5173")
        assert h1.get("access-control-allow-origin") == "http://127.0.0.1:5173", h1
        _c, _j, h2 = call("/graph?brain=whale&limit=50", origin="http://localhost:8080")
        assert h2.get("access-control-allow-origin") == "http://localhost:8080"
        for bad in ("https://evil.example", "http://127.0.0.1.evil.example", "http://evil.example:3100", "null", "http://127.0.0.1:99999999"):
            _c, _j, h3 = call("/graph?brain=whale&limit=50", origin=bad)
            assert "access-control-allow-origin" not in {k.lower() for k in h3}, bad
        _c, _j, h4 = call("/health", origin="http://127.0.0.1:5173")
        assert "access-control-allow-origin" not in {k.lower() for k in h4}, "别的接口不开跨域"
        ok("HTTP：/graph 缺省小鲸鱼 + 姐姐、limit 上限、坏 brain 400、坏参数不炸、recentOnly；/graph/node 全文 / 缺 id 400 / 没有 404；跨域只给回环页面、只在 /graph*")
    finally:
        srv.shutdown()

    # ── 13. 页面静态检查（2D：sigma + graphology）───────────────────────────────────
    page = (ROOT / "public" / "brain.html").read_text(encoding="utf-8")
    vend = ROOT / "public" / "vendor"
    sig = vend / "sigma.min.js"
    gra = vend / "graphology.umd.min.js"
    assert sig.exists() and sig.stat().st_size > 100_000, "sigma 在 public/vendor/"
    assert gra.exists() and gra.stat().st_size > 40_000, "graphology 在 public/vendor/"
    assert "Sigma" in sig.read_text(encoding="utf-8")[:400] and "graphology" in gra.read_text(encoding="utf-8")[:400]
    for lic in ("sigma.LICENSE", "graphology.LICENSE"):
        t = (vend / lic).read_text(encoding="utf-8")
        assert "MIT" in t and "Permission is hereby granted" in t, lic
    # 3D 版不要了（老大：太卡）：vendor 里没有 3D 库和它的许可证，没有 brain3d.html，页面里没有 3D 版链接
    for gone in ("3d-force-graph.min.js", "3d-force-graph.LICENSE", "three.LICENSE"):
        assert not (vend / gone).exists(), gone
    assert not (ROOT / "public" / "brain3d.html").exists(), "不保留 3D 版"
    assert not re.search(r"ForceGraph3D|3d-force-graph|three\.js|brain3d", page) and not re.search(r"<a[^>]*>[^<]*3D|href=[\"'][^\"']*3d", page, re.I), "页面里没有 3D 的库，也没有「3D 版」链接"
    assert (ROOT / "public" / "brain.html.bak-3d").exists(), "3D 版的备份（要回退时拷回来）"
    assert "vendor/" in page and "sigma.min.js" in page and "graphology.umd.min.js" in page
    assert "/api/brain/graph" in page and "graph/node" in page
    assert "limit: 0" in page, "页面要全量"
    assert "x-console-token" in page and "consoleToken" in page, "取令牌的做法同 console.html"
    assert "recentOnly" in page and "30000" in page, "刚想起每 30 秒刷新"
    assert "127.0.0.1:3210" in page, "开发回退直连记忆服务"
    # 不依赖外网：除了开发回退的 127.0.0.1:3210，没有别的 http(s) 地址；没有 CDN
    urls = re.findall(r"https?://[^\s'\"<>)]+", page)
    assert all(u.startswith("http://127.0.0.1") or u.startswith("http://localhost") for u in urls), urls
    assert not re.search(r"cdn|unpkg|jsdelivr|googleapis|<script[^>]+src=\"https?:", page, re.I)
    assert not re.search(r"<script[^>]+src=", page), "脚本不用 script 标签直接引外部地址（桥接的安全头只允许同源内联 / 同源脚本）"
    for want in ("按类型", "按情绪", "按脑区", "并排对比", "小鲸鱼", "姐姐", "脑区圈", "刚被想起", "私聊里的", "原文暂时读不到", "缩放分级",
                 "两边共有的", "搜标题", "深色"):
        assert want in page, want
    for fn in ("function canon(", "function crossPairs(", "function refreshRecent(", "function lodFraction(", "function drawBg(", "function drawFg(",
               "function flyToNode(", "function flyToRegion(", "function runSearch(", "function hoverNode(", "function showDetail(", "function renderShared("):
        assert fn in page, fn
    for key in ("person:sister", "self:sister", "person:whale", "self:whale"):
        assert key in page, key
    assert "compact: 1" in page and "linkTypes" in page, "页面用 compact 线格式，也认老写法"
    assert "forceatlas" not in page.lower() and "noverlap" not in page.lower()
    # 脚本语法
    m = re.search(r"<script>\n(.*?)</script>", page, re.S)
    assert m, "页面有一整段内联脚本"
    js = TMP / "brain-page.js"
    js.write_text(m.group(1), encoding="utf-8")
    try:
        r = subprocess.run(["node", "--check", str(js)], capture_output=True, text=True, timeout=60)
        assert r.returncode == 0, r.stderr
        syntax = "；脚本 node --check 通过"
    except FileNotFoundError:
        syntax = "；（没找到 node，跳过脚本语法检查）"
    ok("页面（2D）：vendor 里有 sigma 3 和 graphology（MIT 许可证齐全）、3D 的库 / 3D 版页面 / 3D 链接都没了、有 3D 版备份、取数走 /api/brain/graph 带令牌且 limit=0、"
       "30 秒刷新、不依赖外网、前端不跑布局、关键功能都在" + syntax)

    # ── 14. 真的索引：只读冒烟 ────────────────────────────────────────────────────────
    memindex._config = None
    try:
        real = [b for b in memindex.config().brains.values() if b.db.exists()]
    except Exception:  # noqa: BLE001
        real = []
    if not real:
        print("（真的索引不存在，跳过冒烟）")
    for b in real:
        st0 = b.db.stat()
        G.clear_cache()
        t0 = time.time()
        gg = G.get_graph(b, limit=1500)
        took = time.time() - t0
        assert gg["ok"] and 0 < len(gg["nodes"]) <= 1500 and gg["links"], b.id
        text = json.dumps(gg, ensure_ascii=False)
        assert not any("共享/合写" in str(n.get("source")) or "归档/旧稿" in str(n.get("source")) for n in gg["nodes"]), "真的数据里没有出自小说 / 旧稿的点（笔记里「提到」合写不算）"
        shown = "\n".join(str(n.get(k) or "") for n in gg["nodes"] for k in ("label", "summary", "source", "place"))
        assert not re.search(r"\d{7,}", shown), "给人看的文字里没有七位以上的数字（QQ 号）：" + str(re.findall(r".{8}\d{7,}.{4}", shown)[:3])
        assert b.db.stat().st_mtime_ns == st0.st_mtime_ns and b.db.stat().st_size == st0.st_size, "不改索引"
        assert took < 15, took
        ok(f"真数据冒烟（只读）：{b.id} {len(gg['nodes'])} 点 / {len(gg['links'])} 线，{took:.1f} 秒，没有小说和长数字，索引文件没动")
        # 全量：每个块都在、坐标齐全、都在圈里、边修剪过但点没少
        G.clear_cache()
        t0 = time.time()
        gz = G.get_graph(b, limit=0)
        took_full = time.time() - t0
        rz = {r["id"]: r for r in gz["regions"]}
        assert gz["full"] and len(gz["nodes"]) >= gz["counts"]["indexChunks"] * 0.98, (len(gz["nodes"]), gz["counts"]["indexChunks"])
        assert all(math.hypot(n["x"] - rz[n["region"]]["x"], n["y"] - rz[n["region"]]["y"]) <= rz[n["region"]]["radius"] + 1e-6 for n in gz["nodes"]), "全量：每个点都在自己区的圈里"
        assert not re.search(r"\d{7,}", "\n".join(str(n.get(k) or "") for n in gz["nodes"] for k in ("label", "summary", "source", "place")))
        assert gz["counts"]["linksBeforePrune"] >= len(gz["links"]) and took_full < 60, took_full
        again = G.get_graph(b, limit=0)
        assert [(n["id"], n["x"], n["y"]) for n in again["nodes"]] == [(n["id"], n["x"], n["y"]) for n in gz["nodes"]]
        ok(f"真数据全量（只读）：{b.id} {len(gz['nodes'])} 点（索引 {gz['counts']['indexChunks']} 块）/ {len(gz['links'])} 线（修剪前 {gz['counts']['linksBeforePrune']}），首次 {took_full:.1f} 秒（布局 {gz['counts']['layoutMs']} 毫秒），再取走缓存")
    print(f"\n全部通过：{passed} 组")
finally:
    shutil.rmtree(TMP, ignore_errors=True)
