"""
大脑图谱层：把一个人的脑子（索引里的记忆 + 身体 / 心情 / 印象 / 看过的东西）整理成「点和线」，给 3D 大脑页面用。**不调模型**。

2026-10-29 大脑页面（施工单 B）。依据：workspace/大脑方案-2026-10-29.md、大整理计划里「大脑页面」几条，
  做法参照「鱼的记忆」里 astrbot_plugin_memory_brain：五种记忆 + 实体关系图谱。
  这一层只读：读 .索引/vectors.db（用已经存好的向量找「意思很近」的邻居，不再喂模型）、recall-log、压着.json，
  以及几份状态文件（激素、心情、作息、印象、看过的）。不写任何东西。

五种记忆（按来源加简单规则分，写在 classify()）：
  事件 event      瞬间、聊天记录、交接、看过的东西、睡过的觉、心情起伏
  事实 fact       长期本子、她 remember 过的、人那一页、印象里的话、便签
  反思 reflection 日记、碎碎念、成长札记
  技能 skill      笔记（工具集）、长期本子里「怎么做 / 方法」这类
  道理 lesson     任何地方出现「以后都…… / 我明白了 / 下次别……」这类句子
  另外：身份 identity（soul / self / 我自己，每次都带着）、实体 entity（人 / 话题 / 作品 / 地方 / 激素 / 心情）。

脑区（按人脑真实的相对位置摆，坐标 x 左右 / y 上下 / z 前后，前额叶在 +z；区中心固定，区里用力导向展开）：
  身份 → 正中（内侧前额叶 / 默认模式网络）      瞬间、事件 → 海马
  事实、长期 → 颞叶                              人、印象 → 颞顶联合区
  心情、压着、情绪起伏大的瞬间 → 杏仁核          激素 → 下丘脑
  最近、便签、交接、刚想起的 → 背外侧前额叶      反思、道理 → 前额叶
  技能、工具 → 小脑；习惯、做事方法 → 基底节     看图、刷抖音、B 站 → 枕叶；听声、语音、音乐 → 颞叶听觉区
  说出去的话 → 布洛卡区；听到的话 → 韦尼克区     作息、睡眠 → 脑干 / 丘脑

边：记忆 — 它提到的实体（提到）；记忆 — 记忆：同一会话里时间相邻（相邻）、共有两个以上不常见的实体（同一件事）、
  意思很近（语义，取 top-k，跨区的门槛更高所以长线少）；想起过的 — 被想起的那几条（想起）；身份核心 — 它的各页 / 老大 / 对方（核心）。

隐私：七位以上的数字（QQ 号、群号）一律抹成「…」；私聊来源的点带 private 标记，页面上标「私聊里的」。
接口在 service.py：GET /graph?brain=&limit=&recent=&edgeK=，GET /graph/node?brain=&id=。

2026-10-29 老大：「做 3D 容易卡，改 2D，以流畅度优先，内容要全面」。所以这一层现在出的是 **2D 平面、全量** 的图：
  - limit=0 表示全部（所有记忆块 + 实体 + 身体 / 心情 / 作息的点，一个不少）；不是 0 的时候还是按名额挑（老页面、测试用）。
  - 边太多时按权重修剪：每个点只保证留下自己权重最高的 k 条边（edgeK，缺省 8，0 = 不修剪），**点一个都不丢**，有线的点修剪后还有线。
  - 坐标由这一层预先算好（compute_layout），前端不再跑布局：脑区按人脑矢状面（侧面）轮廓摆，前额叶在前（左）、
    枕叶在后（右）、小脑后下、脑干下中、颞叶下侧、海马 / 杏仁核在内侧颞叶偏中下、颞顶联合区在上后、身份核心在中央偏前；
    每区一团，区里用「向日葵螺旋」摆：重要度高的靠中心、越新越靠外缘；再按相连的点的方向在同一圈里调换位置，让有关系的点靠近。
    同输入同输出（不用随机数），算好的布局按内容缓存。
  - 实体放在「提到它最多的脑区」里（身体 / 心情 / 作息的点固定在各自的区）。
"""
import hashlib
import json
import math
import re
import threading
import time
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

import index as memindex
import recall

DEFAULT_LIMIT = 1500
MIN_LIMIT = 20
MAX_LIMIT = 4000
RECENT_RECALL_MIN = 30          # 这么近想起来的算「刚想起」
RECENCY_HALF_LIFE_DAYS = 21     # 越新越靠表层：recency = 0.5 ** (天数 / 21)
CHATLOG_SHARE = 0.30            # 聊天记录最多占这么多名额（原话太多，不压一压会把别的挤没）
REGION_SHARE = 0.38             # 一个脑区最多占这么多名额
GRAPH_CACHE_TTL = 45.0          # 秒：同一份图 45 秒内不重算（刚想起的标记每次请求另算，不受影响）
FULL_CACHE_TTL = 120.0          # 全量图建一次要几秒，缓存久一点（索引或状态文件变了照样重算）
DEFAULT_EDGE_K = 8              # 每个点至少保留自己权重最高的这么多条边；0 = 不修剪
FULL_ENTITY_BUDGET = 360        # 全量时实体最多这么多个（人 / 作品 / 地方 / 话题）

# ───────────────────────────── 脑区 ─────────────────────────────
# anchor：区中心的「锚点」，画在一个 1.6 × 1.05 的人脑侧面轮廓方框里（x 向右 = 向后，0 是前额；y 向下，0 是头顶）；
# 区的半径按点数定、再把撞在一起的区推开（见 compute_layout），所以最后的坐标是「锚点附近」，不是死的。颜色是页面画圈的色相。
REGIONS = [
    {"id": "core", "name": "身份核心", "area": "内侧前额叶 / 默认模式网络", "holds": "你是谁：soul、self、我自己", "anchor": [0.66, 0.38], "color": "#2a9d8f"},
    {"id": "hippo", "name": "海马", "area": "海马体", "holds": "发生过的事：瞬间", "anchor": [0.9, 0.74], "color": "#e76f51"},
    {"id": "temporal", "name": "颞叶", "area": "颞叶皮层", "holds": "事实、长期本子、remember 过的", "anchor": [0.7, 0.93], "color": "#7a9e3f"},
    {"id": "tpj", "name": "颞顶联合区", "area": "社会脑", "holds": "人、印象、关系", "anchor": [1.1, 0.14], "color": "#c77dba"},
    {"id": "amygdala", "name": "杏仁核", "area": "边缘系统", "holds": "心情、压着的事、起伏大的瞬间", "anchor": [0.56, 0.78], "color": "#d9485f"},
    {"id": "hypo", "name": "下丘脑", "area": "下丘脑 / 垂体", "holds": "激素（困、想念、好奇……）", "anchor": [0.64, 0.62], "color": "#e9a23b"},
    {"id": "dlpfc", "name": "背外侧前额叶", "area": "工作记忆", "holds": "最近、便签、交接、刚想起的", "anchor": [0.38, 0.12], "color": "#3d8bd9"},
    {"id": "pfc", "name": "前额叶", "area": "前额叶", "holds": "反思、道理", "anchor": [0.14, 0.4], "color": "#6c5ce7"},
    {"id": "cereb", "name": "小脑", "area": "小脑", "holds": "技能、工具、笔记", "anchor": [1.32, 0.86], "color": "#00a8a8"},
    {"id": "basal", "name": "基底节", "area": "基底节", "holds": "习惯、做事的方法", "anchor": [0.8, 0.5], "color": "#8d6e63"},
    {"id": "occipital", "name": "枕叶", "area": "视觉区", "holds": "看图、刷抖音、逛 B 站", "anchor": [1.48, 0.46], "color": "#f4a261"},
    {"id": "auditory", "name": "颞叶听觉区", "area": "听觉皮层", "holds": "听声、语音、音乐", "anchor": [1.04, 0.62], "color": "#4a90a4"},
    {"id": "broca", "name": "布洛卡区", "area": "语言表达", "holds": "你说出去的话", "anchor": [0.28, 0.68], "color": "#5b8def"},
    {"id": "wernicke", "name": "韦尼克区", "area": "语言理解", "holds": "你听到、读到的话", "anchor": [1.12, 0.4], "color": "#43aa8b"},
    {"id": "brainstem", "name": "脑干 / 丘脑", "area": "作息、睡眠", "holds": "睡醒、作息", "anchor": [1.05, 0.98], "color": "#8e9aaf"},
]
REGION_BY_ID = {r["id"]: r for r in REGIONS}

# 记忆类型：id、中文名、页面上用的颜色（图例）
TYPES = [
    {"id": "event", "label": "事件", "color": "#e8833a"},
    {"id": "fact", "label": "事实", "color": "#5a9e3c"},
    {"id": "reflection", "label": "反思", "color": "#7b61c9"},
    {"id": "skill", "label": "技能", "color": "#1f9aa8"},
    {"id": "lesson", "label": "道理", "color": "#c9a227"},
    {"id": "identity", "label": "身份", "color": "#d6455d"},
    {"id": "entity", "label": "实体", "color": "#4f6fd8"},
]
TYPE_LABEL = {t["id"]: t["label"] for t in TYPES}

# 情绪：feiyu-mood 的七种。颜色给「按情绪上色」用；没有情绪的点是中性灰。
EMOTIONS = [
    {"id": "happy", "label": "开心", "color": "#f2b01e", "valence": 1},
    {"id": "sweet", "label": "甜蜜", "color": "#ef7fa8", "valence": 1},
    {"id": "calm", "label": "踏实", "color": "#5bb98c", "valence": 0.6},
    {"id": "heartache", "label": "心疼", "color": "#c2476b", "valence": -0.6},
    {"id": "worry", "label": "担心", "color": "#8a6fd1", "valence": -0.6},
    {"id": "sad", "label": "难过", "color": "#4b7bd8", "valence": -1},
    {"id": "jealous", "label": "吃醋", "color": "#d1702f", "valence": -0.5},
]
EMOTION_VALENCE = {e["id"]: e["valence"] for e in EMOTIONS}
MOOD_CN = {"开心": "happy", "踏实": "calm", "甜蜜": "sweet", "心疼": "heartache", "担心": "worry", "难过": "sad", "吃醋": "jealous",
           "平静": "calm", "安心": "calm", "高兴": "happy", "伤心": "sad"}
EMOTION_WORDS = {
    "happy": r"开心|高兴|快乐|哈哈|太好了|美滋滋|兴奋|好玩|有趣|庆祝|得意|耶",
    "sweet": r"甜|暖|被惦记|软了|喜欢你|爱你|心动|抱抱|摸摸|贴贴|想你|惦记",
    "calm": r"踏实|平静|安心|放松|安稳|舒服|惬意|自在",
    "heartache": r"心疼|心酸|揪着|舍不得|疼惜",
    "worry": r"担心|焦虑|害怕|紧张|不安|怕|慌|忐忑",
    "sad": r"难过|伤心|哭|委屈|失落|孤单|想哭|遗憾|低落|沮丧",
    "jealous": r"吃醋|嫉妒|酸了|羡慕",
}
EMOTION_RES = {k: re.compile(v) for k, v in EMOTION_WORDS.items()}

# ───────────────────────────── 分类规则 ─────────────────────────────
LESSON_RE = re.compile(r"以后(都|就|别|不|要|只|再|得|会)|我明白了|我懂了|学到了|教训|下次(要|别|记得|不|可以|就)|不要再|别再|道理|说到底|从此|再也不|宁可|千万别|记住[:：]")
SKILL_RE = re.compile(r"怎么(做|用|弄)|用法|步骤|做法|方法|技巧|窍门|流程|命令|调用|先.{1,18}再|工具|接口|脚本")
SLEEP_RE = re.compile(r"作息|睡眠|熬夜|早睡|晚睡|失眠|午睡|打盹|入睡|睡觉")
VISUAL_RE = re.compile(r"抖音|B站|b站|bilibili|哔哩|视频|直播|截图|看图|刷到")
AUDIO_RE = re.compile(r"语音|听(了|着|到|见)?.{0,6}(歌|曲|音乐|声音)|歌词|旋律|读谱|音频|电台")
CHAT_LINE_RE = re.compile(r"^- \d{1,2}:\d{2} \*\*(.+?)\*\*[：:]", re.M)

MASK = recall.mask_digits


def clip(text, n):
    return MASK(recall.clip(text, n))


# ───────────────────────────── 2D 布局（服务端预算好） ─────────────────────────────
BOX_W, BOX_H = 1.6, 1.05        # 锚点所在的方框
CELL_AREA = 40.0                # 每个点占的面积（世界单位²）：点间距约 6~7
FILL = 0.62                     # 圈里点占的面积比例
R_MIN = {"core": 40.0}          # 区的最小半径（没写的用 R_MIN_DEFAULT）：身份核心点不多，也要有个像样的圈
R_MIN_DEFAULT = 36.0
REGION_GAP = 14.0               # 两个圈之间至少隔这么远
GOLDEN = math.pi * (3 - math.sqrt(5))
LAYOUT_ROUNDS = 24              # 换位迭代几轮
LAYOUT_BAND_MIN = 48            # 同一圈（连续的这么多个槽位）里的点可以互相换位；区越大圈越宽，换位的自由度越大
LAYOUT_BAND_FRAC = 0.15
LAYOUT_CACHE_MAX = 8
_layout_lock = threading.Lock()
_layout_cache = {}              # 内容指纹 -> 布局结果（同样的点和边不重算）


def region_radius(rid, count):
    """区的半径：圈里能放下 count 个点（每点 CELL_AREA、占满 FILL），不小于最小半径。
    点特别多的区（聊天原话有几千条）面积只按 0.75 次方长：不然一个区把整个脑子占满，人脑的轮廓就看不出来了（里面点会密一些，放大就看清）。"""
    n = max(1, count)
    if n > 200:
        n = 200 + (n - 200) ** 0.75
    return round(max(R_MIN.get(rid, R_MIN_DEFAULT), math.sqrt(n * CELL_AREA / (math.pi * FILL))), 1)


def _hash01(text, salt=""):
    """字符串 → [0,1) 的确定性小数（不用 random，同输入同输出）。"""
    return int(hashlib.md5((salt + str(text)).encode("utf-8")).hexdigest()[:8], 16) / 4294967296.0


def region_geometry(counts):
    """各区的圈：{区 id: (x, y, r)}。锚点按方框放大到「圈总面积约占方框 42%」，再把重叠的圈推开（大圈推得少），
    同时有一根很弱的弹簧把圈拉回锚点，所以整体仍是侧面轮廓。整个过程没有随机数。"""
    ids = [r["id"] for r in REGIONS]
    rad = {rid: region_radius(rid, counts.get(rid, 0)) for rid in ids}
    area = sum(math.pi * rad[i] ** 2 for i in ids)
    scale = math.sqrt(area / (0.42 * BOX_W * BOX_H))
    anchor = {i: (REGION_BY_ID[i]["anchor"][0] * scale, REGION_BY_ID[i]["anchor"][1] * scale) for i in ids}
    pos = {i: [anchor[i][0], anchor[i][1]] for i in ids}
    mass = {i: rad[i] ** 2 for i in ids}
    for it in range(800):
        moved = 0.0
        for a in range(len(ids)):
            for b in range(a + 1, len(ids)):
                ia, ib = ids[a], ids[b]
                dx, dy = pos[ib][0] - pos[ia][0], pos[ib][1] - pos[ia][1]
                d = math.hypot(dx, dy)
                need = rad[ia] + rad[ib] + REGION_GAP
                if d >= need:
                    continue
                if d < 1e-6:
                    ang = 2 * math.pi * _hash01(ia + ib)
                    dx, dy, d = math.cos(ang), math.sin(ang), 1.0
                gap = need - d
                fa = mass[ib] / (mass[ia] + mass[ib])          # 小的挪得多
                fb = 1 - fa
                ux, uy = dx / d, dy / d
                pos[ia][0] -= ux * gap * fa
                pos[ia][1] -= uy * gap * fa
                pos[ib][0] += ux * gap * fb
                pos[ib][1] += uy * gap * fb
                moved += gap
        for i in ids:
            pos[i][0] += (anchor[i][0] - pos[i][0]) * 0.004
            pos[i][1] += (anchor[i][1] - pos[i][1]) * 0.004
        if moved < 0.01 and it > 60:
            break
    minx = min(pos[i][0] - rad[i] for i in ids)
    miny = min(pos[i][1] - rad[i] for i in ids)
    return {i: (round(pos[i][0] - minx + 40, 1), round(pos[i][1] - miny + 40, 1), rad[i]) for i in ids}


def compute_layout(nodes, links):
    """给每个点算 2D 坐标。nodes：带 id / region / importance / recency 的字典列表；links：{source, target, w}。
    返回 ({点 id: (x, y)}, {区 id: (x, y, r)})。同输入同输出；点的顺序不影响结果（内部按 id 排）。
    区里的摆法：按「靠中心的程度」排队（重要度高的在前、越新越靠后），第 k 个点放在向日葵螺旋的第 k 个位置——
    半径 ∝ √(k/n) 所以疏密均匀，重要的靠中心、新的靠外缘；然后迭代几次：每个点朝着「它相连的点所在的方向」调换到同一圈里
    角度合适的位置（圈内换位，不改半径，所以重要度的内外次序不变），有关系的点就靠到一起，跨区的线也更短。"""
    ids = sorted(n["id"] for n in nodes)
    n_all = len(ids)
    by_id = {n["id"]: n for n in nodes}
    index = {nid: i for i, nid in enumerate(ids)}
    region_of = [by_id[i]["region"] for i in ids]
    counts = Counter(region_of)
    geo = region_geometry(counts)
    if n_all == 0:
        return {}, geo

    members = defaultdict(list)
    for i, rid in enumerate(region_of):
        members[rid].append(i)
    # 靠中心的程度 kappa：越小越靠中心
    kappa = np.zeros(n_all)
    for i, nid in enumerate(ids):
        n = by_id[nid]
        k = 0.62 * (1.0 - float(n.get("importance") or 0.0)) + 0.38 * float(n.get("recency") or 0.0)
        if n.get("type") == "identity":
            k = -1.0 if n.get("isSelf") else -0.5
        kappa[i] = k + 0.03 * (_hash01(nid, "k") - 0.5)

    # 槽位：每个点开始时占着「自己下标」这个槽位；槽位的圈心 / 半径 / 角度存在同下标的数组里
    cx = np.zeros(n_all)
    cy = np.zeros(n_all)
    slot_rho = np.zeros(n_all)
    slot_theta = np.zeros(n_all)
    region_slots = {}                              # 区 -> 槽位下标数组（按半径从内到外）
    for rid, mem in members.items():
        x0, y0, r = geo[rid]
        n = len(mem)
        order = sorted(mem, key=lambda i: (kappa[i], i))
        phi = 2 * math.pi * _hash01(rid, "phi")
        for k, i in enumerate(order):
            cx[i], cy[i] = x0, y0
            slot_rho[i] = 0.9 * r * math.sqrt((k + 0.5) / n) if n > 1 else 0.0
            slot_theta[i] = (phi + k * GOLDEN) % (2 * math.pi)
        if by_id[ids[order[0]]].get("isSelf"):
            slot_rho[order[0]] = 0.0                 # 她自己（身份核心的中心点）钉在圈的正中，不参与换位
            order = order[1:]
        region_slots[rid] = np.array(order, dtype=int)
    occ = np.arange(n_all)                         # occ[槽位] = 占着它的点

    # 边（双向），邻居多的点话语权小一点
    pairs = [(index[l["source"]], index[l["target"]], float(l.get("w") or 0.5)) for l in links if l["source"] in index and l["target"] in index]
    if pairs:
        ea = np.array([p[0] for p in pairs], dtype=int)
        eb = np.array([p[1] for p in pairs], dtype=int)
        ew = np.array([p[2] for p in pairs])
        deg = np.bincount(np.concatenate([ea, eb]), minlength=n_all).astype(float)
        src = np.concatenate([ea, eb])
        dst = np.concatenate([eb, ea])
        wt = np.concatenate([ew, ew]) / np.sqrt(np.maximum(deg[dst], 1.0))
    else:
        src = dst = np.zeros(0, dtype=int)
        wt = np.zeros(0)

    for _round in range(LAYOUT_ROUNDS):
        slot_of_node = np.empty(n_all, dtype=int)
        slot_of_node[occ] = np.arange(n_all)
        px = cx + slot_rho * np.cos(slot_theta)           # 槽位的位置
        py = cy + slot_rho * np.sin(slot_theta)
        node_x = px[slot_of_node]
        node_y = py[slot_of_node]
        want = slot_theta[slot_of_node].copy()
        if len(src):
            dx = node_x[dst] - cx[slot_of_node][src]
            dy = node_y[dst] - cy[slot_of_node][src]
            dist = np.hypot(dx, dy)
            good = dist > 1e-6
            safe = np.where(good, dist, 1.0)
            ux = np.where(good, dx / safe, 0.0) * wt
            uy = np.where(good, dy / safe, 0.0) * wt
            vx = np.bincount(src, weights=ux, minlength=n_all)
            vy = np.bincount(src, weights=uy, minlength=n_all)
            has = np.hypot(vx, vy) > 1e-9
            want = np.where(has, np.arctan2(vy, vx) % (2 * math.pi), want)
        # 每个区、每一圈（连续的 band 个槽位）里：点按想去的角度排，槽位按自己的角度排，一一对上
        new_occ = occ.copy()
        for slots in region_slots.values():
            band = max(LAYOUT_BAND_MIN, int(len(slots) * LAYOUT_BAND_FRAC))
            for s0 in range(0, len(slots), band):
                band_slots = slots[s0:s0 + band]
                band_nodes = occ[band_slots]
                s_order = band_slots[np.lexsort((band_slots, slot_theta[band_slots]))]
                n_order = band_nodes[np.lexsort((band_nodes, want[band_nodes]))]
                new_occ[s_order] = n_order
        if np.array_equal(new_occ, occ):
            break
        occ = new_occ
    slot_of_node = np.empty(n_all, dtype=int)
    slot_of_node[occ] = np.arange(n_all)
    out = {}
    for i, nid in enumerate(ids):
        s = slot_of_node[i]
        r = geo[region_of[i]][2]
        jx = (_hash01(nid, "x") - 0.5) * 0.05 * r
        jy = (_hash01(nid, "y") - 0.5) * 0.05 * r
        out[nid] = (round(float(cx[s] + slot_rho[s] * math.cos(slot_theta[s]) + jx), 1),
                    round(float(cy[s] + slot_rho[s] * math.sin(slot_theta[s]) + jy), 1))
    return out, geo


def layout_for(nodes, links):
    """带缓存的 compute_layout：点（id、区、重要度、新鲜度的粗粒度）和边都一样就直接用上次的。"""
    h = hashlib.sha1()
    for n in sorted(nodes, key=lambda x: x["id"]):
        h.update(f"{n['id']}|{n['region']}|{round(float(n.get('importance') or 0), 2)}|{round(float(n.get('recency') or 0), 2)}|{n.get('isSelf', '')}\n".encode("utf-8"))
    for l in sorted(links, key=lambda x: (x["source"], x["target"], x["type"])):
        h.update(f"{l['source']}>{l['target']}:{l['type']}\n".encode("utf-8"))
    key = h.hexdigest()
    with _layout_lock:
        hit = _layout_cache.get(key)
    if hit is not None:
        return hit
    res = compute_layout(nodes, links)
    with _layout_lock:
        _layout_cache[key] = res
        while len(_layout_cache) > LAYOUT_CACHE_MAX:
            _layout_cache.pop(next(iter(_layout_cache)))
    return res


def detect_emotion(text, mood_top=None, min_hits=1):
    """文字 / 心情读数 → (情绪 id 或 None, 强度 0~1)。心情读数优先（瞬间里存的 top 是「开心、甜蜜」这种）。
    min_hits：文字里至少出现几个情绪词才算（聊天记录是一大段原话，「哈哈」到处都是，要求 2 个以上）。"""
    if mood_top:
        for w in re.split(r"[、,，\s]+", str(mood_top)):
            if w in MOOD_CN:
                return MOOD_CN[w], 0.8
    best, best_n = None, 0
    t = str(text or "")
    for k, rx in EMOTION_RES.items():
        n = len(rx.findall(t))
        if n > best_n:
            best, best_n = k, n
    if not best or best_n < min_hits:
        return None, 0.0
    return best, min(1.0, 0.35 + 0.2 * best_n)


def classify(row, brain, pressed_ids=()):
    """索引里的一块 → (类型, 脑区)。规则都在这一个函数里，一眼看全。"""
    kind = row["kind"]
    text = row["text"]
    src = str(row["source"])
    meta = row.get("meta") or {}
    if kind == "身份":
        return "identity", "core"
    if kind == "瞬间":
        stem = src.split("/")[-1]
        if meta.get("epId") in pressed_ids or meta.get("heavy"):
            return "event", "amygdala"
        if stem.startswith("douyin_") or VISUAL_RE.search(text):
            return "event", "occipital"
        if AUDIO_RE.search(text):
            return "event", "auditory"
        return "event", "hippo"
    if kind == "聊天记录":
        mine = 0
        total = 0
        for who in CHAT_LINE_RE.findall(text):
            total += 1
            if who == brain.name or who.lower() in brain.aliases:
                mine += 1
        # 她说的话为主 → 布洛卡区（表达）；别人说的为主 → 韦尼克区（理解）
        return "event", ("broca" if total and mine * 2 >= total else "wernicke")
    if kind == "最近":
        return ("event" if "交接" in src else "fact"), "dlpfc"
    if kind == "人":
        return "fact", "tpj"
    if kind == "日子":
        if LESSON_RE.search(text):
            return "lesson", "pfc"
        return "reflection", "pfc"
    if kind == "笔记":
        if LESSON_RE.search(text) and not SKILL_RE.search(text):
            return "lesson", "pfc"
        return "skill", "cereb"
    # 长期、记过的事（她 remember 的）
    if LESSON_RE.search(text):
        return "lesson", "pfc"
    if SKILL_RE.search(text):
        return "skill", "basal"
    if SLEEP_RE.search(text):
        return "fact", "brainstem"
    return "fact", "temporal"


# ───────────────────────────── 只读的状态文件 ─────────────────────────────
# 路径按人写在这里（brains.json 里没有）：激素、心情、作息、印象、看过的。读不到就当没有。
def _aux(brain):
    root = Path(brain.root)
    if brain.id == "whale":
        return {
            "who": "fish",
            "hormones": root / "state" / "hormones-fish.json",
            "hormone_log": root / "state" / "hormones-fish.jsonl",
            "mood": Path(brain.dsh) / "feiyu-mood" / "state.json",
            "impressions": [brain.dir / "人" / "印象.json"],
            "social": root / "state" / "social-v2.json",
            "watch": [root / "state" / "explore-impressions.jsonl", root / "state" / "bili-watch.jsonl"],
        }
    if brain.id == "sister":
        return {
            "who": "sister",
            "hormones": root / "sister" / "state" / "hormones-sister.json",
            "hormone_log": root / "sister" / "state" / "hormones-sister.jsonl",
            "mood": brain.dir / "最近" / "心情.json",
            "impressions": [brain.dir / "人" / "印象.json"],
            "social": None,
            "watch": [root / "state" / "bili-watch.jsonl", brain.dir / "日子" / "逛过的.jsonl"],
        }
    return {"who": brain.id, "hormones": None, "hormone_log": None, "mood": None,
            "impressions": [brain.dir / "人" / "印象.json"], "social": None, "watch": []}


def _read_json(p, default=None):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8-sig"))
    except Exception:  # noqa: BLE001
        return default


def _read_jsonl_tail(p, n=400):
    try:
        lines = Path(p).read_text(encoding="utf-8-sig").splitlines()[-n:]
    except Exception:  # noqa: BLE001
        return []
    out = []
    for ln in lines:
        try:
            out.append(json.loads(ln))
        except ValueError:
            continue
    return out


def _stat_sig(paths):
    sig = []
    for p in paths:
        try:
            st = Path(p).stat()
            sig.append(f"{p}:{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            sig.append(f"{p}:-")
    return "|".join(sig)


# ───────────────────────────── 一个点 ─────────────────────────────

def _num(x, d=0.0):
    try:
        v = float(x)
        return v if math.isfinite(v) else d
    except (TypeError, ValueError):
        return d


def make_node(nid, ntype, region, *, label, summary, text, source="", at_ms=0.0, importance=0.5, private=False,
              place="", emotion=None, emotion_strength=0.0, now_ms=None, machine_time=False, skew_ms=0.0, **extra):
    """at_ms：这个点的时间（毫秒）。machine_time=True 表示它来自本机时钟（比真实时间快 skew_ms），这里扣掉再给页面。"""
    at_real = (at_ms - skew_ms) if (machine_time and at_ms) else at_ms
    age_days = max(0.0, ((now_ms if now_ms is not None else time.time() * 1000) - at_real) / 86400000.0) if at_real else None
    if ntype == "identity":
        recency = 1.0
    elif age_days is None:
        recency = 0.5
    else:
        recency = 0.5 ** (age_days / RECENCY_HALF_LIFE_DAYS)
    node = {
        "id": nid, "type": ntype, "typeLabel": TYPE_LABEL.get(ntype, ntype), "region": region,
        "label": clip(label, 26), "summary": clip(summary, 90), "text": MASK(str(text or "").strip()),
        "source": MASK(source), "at": int(at_real) if at_real else 0, "recency": round(recency, 3),
        "importance": round(max(0.0, min(1.0, importance)), 3), "private": bool(private), "place": place,
        "emotion": emotion, "valence": round(EMOTION_VALENCE.get(emotion, 0.0) * max(emotion_strength, 0.3), 2) if emotion else 0,
        "recentlyRecalled": False,
    }
    node.update(extra)
    return node


# ───────────────────────────── 收集候选的点 ─────────────────────────────

def _first_line(text):
    """块的第一句话（去掉列表符号和聊天记录的「- 14:30 **名字**：」前缀），给点当标题。"""
    for ln in str(text or "").splitlines():
        t = re.sub(r"^[-*>]\s*(\d{1,2}:\d{2}\s*\*\*.+?\*\*[：:]\s*)?", "", ln.strip())
        t = re.sub(r"^\[引用[^\]]*\]\s*", "", t).strip()
        if t:
            return t
    return ""


def is_novel_row(row, brain):
    """保险：索引本来就不收小说（index.iter_sources 排除了），但旧索引里万一混进了合写目录 / 旧稿的块，这里再拦一道。"""
    src = str(row.get("source") or "")
    if re.search(r"(^|/)(共享/合写|归档/旧稿)(/|$)", src):
        return True
    if row.get("kind") in ("聊天记录", "记过的事", "瞬间"):
        return False
    return memindex.is_novel_path(Path(brain.dir) / (src + ".md"))


def _row_node(row, brain, pressed_ids, now_ms, skew):
    ntype, region = classify(row, brain, pressed_ids)
    meta = row.get("meta") or {}
    text = row["text"]
    kind = row["kind"]
    imp = float(row["weight"]) if row.get("weight") is not None else memindex.importance_for(kind, text)
    if kind == "聊天记录":
        imp = min(imp, 0.3)            # 原话是原料，不是结论：重要度压低，别把真正提炼过的挤下去
    if meta.get("heavy"):
        imp = min(1.0, imp + 0.12)
    pressed = meta.get("epId") in pressed_ids
    if pressed:
        imp = min(1.0, imp + 0.2)
    top = ((meta.get("mood") or {}).get("top")) if meta else None
    emo, strength = detect_emotion(f"{text} {meta.get('brief', '')}", top, min_hits=2 if kind == "聊天记录" else 1)
    stem = str(row["source"]).split("/")[-1]
    place = ""
    private = bool(row.get("private"))
    if kind == "瞬间":
        place = row.get("heading") or memindex.moment_place(stem)
    elif kind == "聊天记录":
        place = "私聊" if private else "群里"
    else:
        place = str(row["source"]).split("/")[0]
    label = meta.get("brief") or _first_line(text) or row.get("heading") or ""
    ms = float(row["date_ts"] or 0) * 1000.0
    extra = {"pressed": True} if pressed else {}
    return make_node(
        row["id"], ntype, region, label=label, summary=meta.get("brief") or text, text=text,
        source=row["label"], at_ms=ms, importance=imp, private=private, place=place, emotion=emo, emotion_strength=strength,
        now_ms=now_ms, machine_time=kind in ("瞬间", "记过的事"), skew_ms=skew, origin=kind, **extra)


HORMONE_LABEL = [
    ("sleepy", "困"), ("longingOwner", "想念老大"), ("longingSister", "想念姐妹"), ("curiosity", "好奇"), ("boredom", "无聊"),
    ("stress", "压力"), ("security", "被在乎"), ("createUrge", "想写东西"), ("pride", "成就感"), ("grievance", "委屈"),
    ("guard", "拉不下脸"), ("focus", "专注"),
]
HORMONE_SPOKEN = {
    "sleepy": "困意", "longingOwner": "想念老大的劲儿", "longingSister": "想念姐妹的劲儿", "curiosity": "好奇心", "boredom": "无聊",
    "stress": "压力", "security": "被在乎的踏实感", "createUrge": "想写点东西的冲动", "pride": "成就感", "grievance": "委屈",
    "guard": "拉不下脸的戒备", "focus": "专注的程度",
}


def _hormone_nodes(brain, aux, now_ms, skew):
    """下丘脑：每种激素一个点，亮度 = 现在的高低。读 state/hormones-<who>.json（当前值）；再用日志最后一行补 guard / focus / 总的好奇。"""
    if not aux.get("hormones"):
        return [], {}
    st = _read_json(aux["hormones"], None)
    if not isinstance(st, dict):
        return [], {}
    hs = st.get("hormones") if isinstance(st.get("hormones"), dict) else st
    h = hs.get("h") if isinstance(hs, dict) and isinstance(hs.get("h"), dict) else {}
    lv = {}
    log_rows = _read_jsonl_tail(aux.get("hormone_log"), 3) if aux.get("hormone_log") else []
    if log_rows and isinstance(log_rows[-1].get("lv"), dict):
        lv = dict(log_rows[-1]["lv"])
    cur = {}
    alias = {"sleepy": "sleepPressure", "curiosity": "curiositySlow"}
    for key, _cn in HORMONE_LABEL:
        v = lv.get(key)
        if v is None:
            v = h.get(alias.get(key, key))
        if v is not None:
            cur[key] = _num(v)
    nodes = []
    asleep = bool(hs.get("asleep")) if isinstance(hs, dict) else False
    t_ms = _num(hs.get("t")) if isinstance(hs, dict) else 0.0
    felt = ""
    if log_rows:
        felt = str(log_rows[-1].get("felt") or "")
    for key, cn in HORMONE_LABEL:
        if key not in cur:
            continue
        v = cur[key]
        nodes.append(make_node(
            "hormone:" + key, "entity", "hypo", label=f"{cn} {v:.2f}", summary=f"{HORMONE_SPOKEN[key]}：{v:.2f}（0 到 1）",
            text=f"{HORMONE_SPOKEN[key]}现在是 {v:.2f}（满格是 1）。" + (f"这会儿的感受：{felt}" if felt else ""),
            source="身体 · 激素", at_ms=t_ms, importance=0.15 + 0.85 * max(0.0, min(1.0, v)), now_ms=now_ms,
            machine_time=True, skew_ms=skew, entityKind="hormone", key="hormone:" + key, value=round(v, 3)))
    return nodes, {"asleep": asleep, "felt": felt, "t": t_ms}


def _mood_nodes(brain, aux, now_ms, skew, max_timeline=30):
    """杏仁核：此刻的心情一个点，心情时间线里起伏明显的几次各一个点。"""
    if not aux.get("mood"):
        return []
    st = _read_json(aux["mood"], None)
    if not isinstance(st, dict):
        return []
    nodes = []
    dims = st.get("dims") if isinstance(st.get("dims"), dict) else {}
    top_dim = max(dims.items(), key=lambda kv: _num(kv[1]), default=(None, 0))
    emo = top_dim[0] if top_dim[0] in EMOTION_VALENCE and _num(top_dim[1]) >= 3 else None
    mood = _num(st.get("mood"), 70)
    nodes.append(make_node(
        "mood:now", "entity", "amygdala", label=f"此刻的心情 {round(mood)}", summary=st.get("lastReason") or "心情",
        text=f"心情分 {round(mood)}（基线 70）。" + (f"最近一次变化的原因：{st.get('lastReason')}" if st.get("lastReason") else ""),
        source="心情", at_ms=_num(st.get("updatedAt")), importance=0.9, emotion=emo, emotion_strength=0.7, now_ms=now_ms,
        machine_time=True, skew_ms=skew, entityKind="mood", key="mood:now"))
    tl = [e for e in (st.get("timeline") or []) if isinstance(e, dict) and e.get("reason")]
    tl = sorted(tl, key=lambda e: abs(_num(e.get("delta"))), reverse=True)[:max_timeline]
    for e in tl:
        dd = e.get("dimsDelta") if isinstance(e.get("dimsDelta"), dict) else {}
        top = max(dd.items(), key=lambda kv: abs(_num(kv[1])), default=(None, 0))
        emo2 = top[0] if top[0] in EMOTION_VALENCE and _num(top[1]) != 0 else None
        if emo2 and _num(top[1]) < 0 and emo2 in ("happy", "sweet", "calm"):
            emo2 = None
        delta = _num(e.get("delta"))
        nodes.append(make_node(
            f"mood:{int(_num(e.get('at')))}", "event", "amygdala", label=f"心情{'+' if delta >= 0 else ''}{round(delta)}：{e['reason']}",
            summary=e["reason"], text=f"心情分变到 {round(_num(e.get('mood')))}（变化 {'+' if delta >= 0 else ''}{round(delta)}）：{e['reason']}",
            source="心情 · 时间线", at_ms=_num(e.get("at")), importance=0.35 + min(0.45, abs(delta) / 10.0),
            emotion=emo2, emotion_strength=min(1.0, 0.4 + abs(_num(top[1])) / 8.0), now_ms=now_ms, machine_time=True, skew_ms=skew))
    return nodes


def _sleep_nodes(brain, aux, rhythm, now_ms, skew, max_logs=10):
    """脑干 / 丘脑：此刻醒着还是睡着，加上最近几次睡觉（睡了多久）。"""
    if not aux.get("hormones"):
        return []
    st = _read_json(aux["hormones"], None)
    hs = (st.get("hormones") if isinstance(st, dict) and isinstance(st.get("hormones"), dict) else st) or {}
    nodes = []
    asleep = bool(rhythm.get("asleep"))
    nodes.append(make_node(
        "rhythm:now", "entity", "brainstem", label="此刻：睡着" if asleep else "此刻：醒着", summary="作息", text="现在" + ("睡着" if asleep else "醒着") + "。",
        source="作息", at_ms=_num(rhythm.get("t")), importance=0.55, now_ms=now_ms, machine_time=True, skew_ms=skew, entityKind="rhythm", key="rhythm:now"))
    logs = [x for x in (hs.get("sleepLog") or []) if isinstance(x, dict) and x.get("sleep") and x.get("wake")][-max_logs:]
    for x in logs:
        s, w = _num(x["sleep"]), _num(x["wake"])
        mins = max(1, round((w - s) / 60000.0))
        dur = f"{mins // 60} 小时 {mins % 60} 分钟" if mins >= 60 else f"{mins} 分钟"
        nodes.append(make_node(
            f"sleep:{int(s)}", "event", "brainstem", label=f"睡了 {dur}", summary=f"睡了 {dur}", text=f"睡了 {dur}。",
            source="作息 · 睡眠", at_ms=w, importance=0.25 + min(0.3, mins / 600.0), now_ms=now_ms, machine_time=True, skew_ms=skew))
    return nodes


def _watch_nodes(brain, aux, now_ms, skew, cap=60):
    """枕叶：看过的视频 / 逛过的东西（B 站、随便逛）。每人最近 cap 条。"""
    out = []
    who = aux.get("who")
    for p in aux.get("watch") or []:
        for e in _read_jsonl_tail(p, 300):
            if not isinstance(e, dict):
                continue
            if e.get("who") and e["who"] != who:
                continue
            title = str(e.get("title") or "").strip()
            if not title:
                continue
            imp_txt = str(e.get("impression") or e.get("why") or "").strip()
            at = _num(e.get("at"))
            if not at:
                continue
            emo, st = detect_emotion(imp_txt)
            out.append(make_node(
                "watch:" + hashlib.sha1(f"{at}{title}".encode()).hexdigest()[:12], "event", "occipital",
                label=f"看了《{title}》", summary=imp_txt or title, text=f"看了《{title}》" + (f"（{e.get('up')}）" if e.get("up") else "") + (f"。{imp_txt}" if imp_txt else ""),
                source="看过的 · " + ("B 站" if e.get("kind") in ("bili", "video") else str(e.get("source") or "逛")), at_ms=at,
                importance=0.4 + (0.1 if imp_txt else 0), emotion=emo, emotion_strength=st, now_ms=now_ms, machine_time=True, skew_ms=skew))
    out.sort(key=lambda n: n["at"], reverse=True)
    return out[:cap]


def _person_label_ok(name):
    n = str(name or "").strip()
    return bool(n) and len(n) <= 16 and not re.search(r"\d{5,}", n) and not re.match(r"^(私聊|群)\d", n)


def _impressions(brain, aux):
    """印象 → {名字: {notes:[{text, at}], score, count}}。读 人/印象.json（{qq: {name, score, notes}}），
    小鲸鱼还读 social-v2.json 里各会话的 memberImpressions（{名字: {traits, interactionCount}}），合并同名。"""
    people = {}

    def add(name, notes, score=0, count=0):
        if not _person_label_ok(name):
            return
        d = people.setdefault(str(name).strip(), {"notes": [], "score": 0.0, "count": 0})
        d["score"] += _num(score)
        d["count"] += int(_num(count))
        seen = {n["text"] for n in d["notes"]}
        for n in notes:
            t = str(n.get("text") or "").strip()
            if t and t not in seen:
                d["notes"].append({"text": t, "at": _num(n.get("at"))})
                seen.add(t)

    for p in aux.get("impressions") or []:
        j = _read_json(p, None)
        if isinstance(j, dict):
            for _qq, v in j.items():
                if isinstance(v, dict):
                    add(v.get("name"), v.get("notes") or [], v.get("score"), len(v.get("notes") or []))
    if aux.get("social"):
        j = _read_json(aux["social"], None)
        convs = (j or {}).get("conversations") if isinstance(j, dict) else None
        for _k, st in (convs or {}).items():
            mi = st.get("memberImpressions") if isinstance(st, dict) else None
            for name, im in (mi or {}).items():
                if isinstance(im, dict):
                    add(name, [{"text": t, "at": im.get("lastSeenAt")} for t in (im.get("traits") or [])], 0, im.get("interactionCount") or 1)
    return people


def _recall_log(brain, minutes, now_ms, skew):
    """想起过什么：recall-log 里最近的。返回 (最近 N 分钟内被想起的节点 id 集合, 原始条目列表)。"""
    entries = recall._recent_log(brain, 60)  # noqa: SLF001
    cutoff = now_ms + skew - minutes * 60000.0       # 日志里的 at 是本机时钟
    recent_ids = set()
    for e in entries:
        if _num(e.get("at")) >= cutoff:
            for p in e.get("picks") or []:
                recent_ids.add(str(p.get("epId") or p.get("id") or ""))
    return recent_ids, entries


# ───────────────────────────── 实体 ─────────────────────────────
OWNER_ALIASES = ["老大", "主人", "老爹"]
PLACES = ["小房子", "阳台", "天台", "楼顶", "客厅", "卧室", "书房", "花园", "小屋", "厨房", "海边", "公园", "学校", "公司",
          "北京", "主人所在城市", "武汉", "广州", "深圳", "杭州", "成都", "重庆", "南京", "长沙", "浏阳", "西安", "苏州", "天津", "郑州", "青岛"]
WORK_RE = re.compile(r"《([^《》\n]{1,18})》")
CJK_RE = re.compile(r"[一-鿿]+")
WORD_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]{2,}")
EDGE_STOP = set("的了是在我你他她它和与就也都很不有这那么吗呢啊吧嘛哦呀们着过被把给让个又还再想去来说要会能")


TOPIC_GLOBAL_MAX = 0.04     # 在整个脑子的块里超过 4% 都出现的词（今天、时候、东西……）不是话题
NUM_TERM_RE = re.compile(r"(第|[一二两三四五六七八九十几每])+[一二三四五六七八九十个条次点下样句回种些起半天节首位遍]")   # 数量词：一起、一条、第二、发一条……
STOP_WORDS = set("今天 明天 昨天 时候 东西 知道 后面 前面 最后 名字 可以 图片 表情 群里 觉得 还是 然后 因为 所以 如果 就是 已经 现在 之前 这个 那个 什么 怎么 没有 我们 你们 他们 自己 还有 不是 的话 但是 而且 虽然 感觉 一些 这样 那样 这么 那么 真的 其实 应该 比较 好像 不过 刚才 一直 出来 起来 下去 过来 回来 事情 问题 小节 收尾 本子 小鲸 鲸鱼 克劳 劳德".split())
# 2026-10-29 大脑页面：话题里还混着口头词和句子碎片（「慢慢」「别人」「期回来加」），再加一批口头词，并在 _topic_terms 里加了碎片过滤
STOP_WORDS |= set("""意思 看到 看见 没看 一声 直接 喜欢 以后 句话 然后 可以 文字 别人 记得 分钟 慢慢 看看 确实 简单 大概 回应 聊天 宝宝 可爱 晚上 声音 心情 记忆
需要 一下 一点 一个 一样 不会 不能 不要 可能 开始 继续 一定 当时 突然 终于 刚刚 马上 一般 有点 比如 或者 只是 并且 而是 对方 大家 这次 那次 下次 上次 每次
当然 或许 无论 不管 反正 毕竟 原来 本来 难道 结果 同时 以及 关于 通过 进行 使用 出现 发现 提到 告诉 回复 发送 消息 内容 时间 地方 方式 方法 情况 部分 样子
一起 一直 一边 一会 一点点 好的 不好 好看 好玩 很多 很好 太多 太好 差不多 有人 没人 有点儿 的时候 那就 那你 你说 我说 他说 她说 说话 说的 想要 想起
觉得 感觉 喜欢 开心 高兴 难过 希望 应该 必须 只有 只要 除了 一些 一种 这种 那种 这些 那些 这里 那里 哪里 哪个 为什么 怎么样 怎么办 是不是 有没有 能不能
挺好 正好 具体 清楚 半天 以为 简短 完整 容易 好几 哪天 哪儿 平时 互相 偷偷 开口 出口 出门 重复 看完 听见 写进 整首 原地 一路 变化 反应 位置 原话
记录 记住 开头 分享 标题 今晚 轻松 同时""".split())
# 话题不能以这些字开头 / 结尾（方位、虚词、关联词：「面加上自」「期回来加」这种一看就是句子中间切出来的）
TOPIC_EDGE_BAD = set("上下中里外前后加回对向从到用得当然而但并及或只先才更最太没别各该此其每自家期面一二两几同另头成")
TOPIC_START_BAD = set("件首条个张位只句份段块页眼碗堆篇部场次遍口")     # 量词开头：「件事」「首歌」「条鱼」
ENGLISH_STOP = {"deep", "http", "https", "true", "false", "null", "none", "with", "that", "this", "have", "from", "will", "json", "text",
                "the", "and", "com", "www", "org", "bot", "video", "douyin", "deepseek", "gpt", "cloud", "daughters", "for", "not", "you", "are", "was", "has", "send", "one", "said", "png", "jpg", "gif", "can", "all", "but", "get", "set", "let"}


# 2026-10-29 2D 全量版：九千多块聊天原话里又冒出一批系统提示 / 口头词（QQ 的「拍一拍」「戳了戳」等）
STOP_WORDS |= set("拍一拍 戳了戳 试试 咱俩 走远 一句 一次 一天 一下子 大家好 晚安 早安 谢谢 抱歉 对不起 不好意思".split())
_STOP_AFFIX = [w for w in STOP_WORDS if len(w) >= 2]
_STOP_AFFIX_SET = frozenset(_STOP_AFFIX)
TOPIC_SAMPLE = 4000         # 找话题时最多看这么多段（超过就等距抽样）：九千多段 n-gram 要十来秒，话题是「反复出现」的词，抽样不影响


def _topic_shape_ok(w):
    """话题的「长相」：中文词不以方位 / 虚词开头结尾，也不是「口头词 + 一个字」（然后收尾、可以回）。英文词不查。"""
    if not CJK_RE.fullmatch(w):
        return "_" not in w and not re.search(r"\d", w) and w not in ENGLISH_STOP
    if w[0] in TOPIC_EDGE_BAD or w[-1] in TOPIC_EDGE_BAD or w[0] in TOPIC_START_BAD:
        return False
    # 以口头词开头或结尾（但不等于它）：只查各个长度的前缀 / 后缀，不用把几百个口头词挨个比一遍
    for k in range(2, len(w)):
        if w[:k] in _STOP_AFFIX_SET or w[-k:] in _STOP_AFFIX_SET:
            return False
    return True


def _drop_fragments(scored, texts):
    """句子碎片过滤：一个词每次出现，前面和后面都是同一个字，说明它只是一个更长的说法（或一句复制粘贴的话）中间切出来的一段，
    不是话题。多个互相重叠、总在同样几段里一起出现的词，只留得分最高的一个。"""
    out = []
    for w, c in scored:
        if CJK_RE.fullmatch(w):
            docs = [t for t in texts if w in t]
            left, right = Counter(), Counter()
            for t in docs:
                k = t.find(w)
                left[t[k - 1] if k > 0 and CJK_RE.fullmatch(t[k - 1]) else ""] += 1
                e = k + len(w)
                right[t[e] if e < len(t) and CJK_RE.fullmatch(t[e]) else ""] += 1
            nd = max(1, len(docs))
            # 两边都总是同一个字才算碎片（「吃螺蛳粉」只有左边固定，右边五花八门，是话题；整句复制粘贴的才两边都固定）
            if (left.most_common(1)[0][0] and left.most_common(1)[0][1] / nd >= 0.8) and                (right.most_common(1)[0][0] and right.most_common(1)[0][1] / nd >= 0.8):
                continue
            key = frozenset(id(t) for t in docs)
        else:
            key = None
        dup = False
        if key is not None:
            for ow, _oc, okey in out:
                if okey is not None and CJK_RE.fullmatch(ow) and (ow in w or w in ow or _overlap(ow, w) >= 2):
                    inter = len(key & okey)
                    if inter / max(1, len(key | okey)) >= 0.6:
                        dup = True
                        break
        if not dup:
            out.append((w, c, key))
    return [(w, c) for w, c, _k in out]


def _overlap(a, b):
    """两个词首尾接上的最大长度（「家鱼的名」「鱼的名字」→ 3）。"""
    best = 0
    for n in range(1, min(len(a), len(b))):
        if a[-n:] == b[:n] or b[-n:] == a[:n]:
            best = n
    return best


def _topic_terms(texts, exclude, max_terms, global_texts=None):
    """话题关键词：n-gram（2~4 字的中文词、3 位以上的英文词）统计在多少段里出现过，挑「出现过几次、但没有到处都有」的；
    再按 df × idf 排，包含关系的只留长的（「螺蛳」「蛳粉」让给「螺蛳粉」）。不调模型、不用分词词典。返回 [(词, df)]。"""
    if len(texts) > TOPIC_SAMPLE:                       # 等距抽样（确定性）：全量时九千多段，抽 4000 段找词就够
        stride = len(texts) / TOPIC_SAMPLE
        texts = [texts[int(i * stride)] for i in range(TOPIC_SAMPLE)]
    if global_texts and len(global_texts) > TOPIC_SAMPLE:
        stride = len(global_texts) / TOPIC_SAMPLE
        global_texts = [global_texts[int(i * stride)] for i in range(TOPIC_SAMPLE)]
    n = len(texts)
    if n < 6:
        return []
    df = Counter()
    for t in texts:
        terms = set()
        for seg in CJK_RE.findall(t):
            ln = len(seg)
            for size in (2, 3, 4):
                for i in range(ln - size + 1):
                    w = seg[i:i + size]
                    if w[0] in EDGE_STOP or w[-1] in EDGE_STOP:
                        continue
                    terms.add(w)
        terms.update(w.lower() for w in WORD_RE.findall(t))
        df.update(terms)
    hi = max(4, int(n * 0.12))
    cand = {w: c for w, c in df.items() if 3 <= c <= hi and not any(x in w for x in exclude)}
    # 包含关系：长词的 df 不比短词少太多，就只留长的
    keep = dict(cand)
    for w, c in cand.items():
        for size in (2, 3):
            for i in range(0, len(w) - size + 1):
                sub = w[i:i + size]
                if sub != w and sub in keep and keep[sub] <= c * 1.5:
                    keep.pop(sub, None)
    scored = sorted(keep.items(), key=lambda kv: kv[1] * math.log((n + 1) / (kv[1] + 0.5)) * (1 + 0.15 * (len(kv[0]) - 2)), reverse=True)
    scored = [(w, c) for w, c in scored if w not in ENGLISH_STOP and w not in STOP_WORDS and not NUM_TERM_RE.search(w) and _topic_shape_ok(w)]
    big = n > 1500                                       # 段数多时候选少取一点（够用，而且快）
    scored = _drop_fragments(scored[: max_terms * (3 if big else 6)], texts)
    if global_texts:
        # 局部看着稀有的词，放到整个脑子里看：到处都有的是口头的常用词，不是话题
        cut = TOPIC_GLOBAL_MAX * len(global_texts)
        out = []
        for w, c in scored[: max_terms * (3 if big else 4)]:
            g = sum(1 for t in global_texts if w in t)
            if g <= cut:
                out.append((w, c))
            if len(out) >= max_terms:
                break
        return out
    return scored[:max_terms]


def _entities(brain, nodes, people, budget, other_brain, global_texts=None):
    """从选中的点的文字里抽实体。返回 (实体点列表, {点 id: [实体 id…]}, {实体 id: 提到它的点数})。"""
    texts = {n["id"]: n["text"] for n in nodes if n["type"] != "entity"}
    ent = {}       # id -> dict(node info)
    mention = defaultdict(list)    # 点 id -> [实体 id]
    df = Counter()

    def register(eid, kind, label, key, aliases, region, base_imp, extra_text=""):
        if eid in ent:
            return
        ent[eid] = {"id": eid, "kind": kind, "label": label, "key": key, "aliases": [a for a in aliases if a], "region": region,
                    "base": base_imp, "text": extra_text}

    # 老大、对方（姐姐 / 妹妹）、她自己的名字不算：身份核心就是她
    register("ent:person:owner", "person", "老大", "person:owner", OWNER_ALIASES, "tpj", 0.8, "老大：每次聊天的对象，你最在意的人。")
    peer_key = "person:sister" if brain.id == "whale" else "person:whale"
    peer_label = "姐姐" if brain.id == "whale" else "妹妹"
    peer_aliases = {a for a in getattr(other_brain, "aliases", set()) if len(a) >= 2 and a.isascii() is False}
    peer_aliases |= {peer_label, "小克"} if brain.id == "whale" else {peer_label}
    register("ent:" + peer_key, "person", peer_label, peer_key, sorted(peer_aliases, key=len, reverse=True), "tpj", 0.75, f"{peer_label}：和你一起长大的另一只。")
    for name, d in people.items():
        if name in OWNER_ALIASES or name in peer_aliases:
            continue
        eid = "ent:person:" + hashlib.sha1(name.encode()).hexdigest()[:10]
        register(eid, "person", name, "person:" + name, [name] if len(name) >= 2 else [], "tpj", min(0.9, 0.35 + 0.08 * len(d["notes"]) + 0.05 * min(5, d["count"])),
                 "；".join(n["text"] for n in d["notes"][:3]))
    # 群里常发言的人（聊天记录里 **名字**：…）
    speakers = Counter()
    for n in nodes:
        if n.get("origin") == "聊天记录":
            for who in CHAT_LINE_RE.findall(n["text"]):
                if _person_label_ok(who) and who != brain.name and who.lower() not in brain.aliases and who not in OWNER_ALIASES                         and who != peer_label and who not in peer_aliases:
                    speakers[who] += 1
    for who, c in speakers.most_common(25):
        if c >= 6:
            eid = "ent:person:" + hashlib.sha1(who.encode()).hexdigest()[:10]
            register(eid, "person", who, "person:" + who, [who] if len(who) >= 2 else [], "tpj", min(0.7, 0.25 + c / 80.0), "群里常说话的人。")
    # 作品
    works = Counter()
    for t in texts.values():
        for w in set(WORK_RE.findall(t)):
            works[w.strip()] += 1
    for w, c in works.items():
        if c >= 3 or w == "半只耳朵":
            register("ent:work:" + hashlib.sha1(w.encode()).hexdigest()[:10], "work", f"《{w}》", f"work:{w}", [f"《{w}》", w] if len(w) >= 3 else [f"《{w}》"],
                     "temporal", min(0.9, 0.4 + c / 30.0), "提到过的作品。")
    # 半只耳朵：直接被提到时也认（不带书名号）
    # 地方
    for pl in PLACES:
        c = sum(1 for t in texts.values() if pl in t)
        if c >= 2:
            register("ent:place:" + hashlib.sha1(pl.encode()).hexdigest()[:10], "place", pl, f"place:{pl}", [pl], "temporal", min(0.85, 0.35 + c / 25.0), "出现过的地方。")
    # 话题
    exclude = set(OWNER_ALIASES) | {brain.name, "姐姐", "妹妹"} | {a for a in brain.aliases if len(a) >= 2}
    exclude = {x for x in exclude if len(x) >= 2}
    names = [e["label"] for e in ent.values()] + [a for e in ent.values() for a in e["aliases"]]
    topics = _topic_terms(list(texts.values()), exclude, max(0, budget), global_texts)
    for term, c in topics:
        if any((term in nm or nm in term) for nm in names if len(nm) >= 2):
            continue                      # 已经是人名 / 作品名 / 地名的一部分，不再另算话题
        register("ent:topic:" + hashlib.sha1(term.encode()).hexdigest()[:10], "topic", term, f"topic:{term}", [term], None, min(0.8, 0.3 + c / 40.0), "常被聊到的话题。")

    # 谁提到了谁
    for nid, t in texts.items():
        for eid, e in ent.items():
            if any(a in t for a in e["aliases"]):
                mention[nid].append(eid)
                df[eid] += 1
    return ent, mention, df


# ───────────────────────────── 建图 ─────────────────────────────

def _select(cands, limit, entity_budget):
    """按「重要度 × 新鲜度」挑出最多 limit - entity_budget 个记忆点；聊天记录、单个脑区各有名额上限。身份和身体、心情的点优先留。"""
    cap = max(MIN_LIMIT // 2, limit - entity_budget)
    chat_cap = max(1, int(cap * CHATLOG_SHARE))
    region_cap = max(3, int(cap * REGION_SHARE))
    forced = [n for n in cands if n["type"] == "identity" or n.get("entityKind") in ("hormone", "mood", "rhythm")]
    forced.sort(key=lambda n: (n["type"] != "identity", n.get("entityKind") not in ("mood", "rhythm")))   # 名额不够时先留身份，再留心情和作息，最后才是各种激素
    forced_ids = {n["id"] for n in forced}
    rest = [n for n in cands if n["id"] not in forced_ids]

    def score(n):
        return n["importance"] * (0.55 + 0.45 * n["recency"]) + (0.15 if n.get("pressed") else 0.0)

    chosen = forced[:cap]
    counts = Counter(n["region"] for n in chosen)
    chat = 0
    rest.sort(key=score, reverse=True)
    for n in rest:
        if len(chosen) >= cap:
            break
        if n.get("origin") == "聊天记录":
            if chat >= chat_cap:
                continue
        if counts[n["region"]] >= region_cap:
            continue
        chosen.append(n)
        counts[n["region"]] += 1
        if n.get("origin") == "聊天记录":
            chat += 1
    return chosen


def _modal(values, default):
    c = Counter(v for v in values if v)
    return c.most_common(1)[0][0] if c else default


def norm_limit(limit):
    """limit：None → 缺省；<= 0 → 0（全量）；其余夹在 [MIN_LIMIT, MAX_LIMIT]。"""
    if limit is None:
        return DEFAULT_LIMIT
    try:
        limit = int(limit)
    except (TypeError, ValueError):
        return DEFAULT_LIMIT
    if limit <= 0:
        return 0
    return max(MIN_LIMIT, min(MAX_LIMIT, limit))


def norm_edge_k(edge_k):
    if edge_k is None:
        return DEFAULT_EDGE_K
    try:
        return max(0, min(200, int(edge_k)))
    except (TypeError, ValueError):
        return DEFAULT_EDGE_K


LINK_TYPE_ORDER = {"core": 0, "recall": 1, "shared": 2, "mention": 3, "semantic": 4, "adjacent": 5}


def prune_links(links, k):
    """边的修剪：每个点按权重（同权重按边的类型、再按出现次序）保留自己最强的 k 条，只要有一头选中就留。
    所以：点一个不少；有线的点修剪后至少还有 k 条（或原来全部）；被很多点同时点名的「枢纽」（老大、身份核心）线也都在。k <= 0 不修剪。"""
    if k <= 0 or not links:
        return links
    per = defaultdict(list)
    for i, l in enumerate(links):
        per[l["source"]].append(i)
        per[l["target"]].append(i)
    keep = set()
    for _nid, idxs in per.items():
        if len(idxs) <= k:
            keep.update(idxs)
        else:
            idxs.sort(key=lambda i: (-links[i]["w"], LINK_TYPE_ORDER.get(links[i]["type"], 9), i))
            keep.update(idxs[:k])
    return [links[i] for i in sorted(keep)]


def build_graph(brain, limit=DEFAULT_LIMIT, now=None, recent_min=RECENT_RECALL_MIN, pre=None, edge_k=DEFAULT_EDGE_K):
    """整理一个人的图。返回 (图 dict, 全文表 {id: 点})；图里的点只带摘要，全文走 node_detail。
    limit=0 = 全量（所有记忆块和实体一个不少）；edge_k 见 prune_links。"""
    brain = brain if isinstance(brain, memindex.Brain) else memindex.get_brain(brain)
    limit = norm_limit(limit)
    full_mode = limit == 0
    edge_k = norm_edge_k(edge_k)
    now = time.time() if now is None else now
    skew = memindex.clock_skew_ms(brain)
    now_ms = now * 1000.0 - skew                    # 真实时间
    aux = _aux(brain)
    cfg = memindex.config()
    other = next((b for b in cfg.brains.values() if b.id != brain.id), None)

    rows, mat = ([], None)
    if brain.db.exists():
        rows, mat = memindex.load_vectors(brain.db)
    pressed_j = _read_json(brain.pressed, {})
    pressed_ids = {str(x.get("id")) for x in (pressed_j.get("items") or [])} if isinstance(pressed_j, dict) else set()

    cands = []
    row_pos = {}           # 点 id -> 在索引里的行号（语义邻居、相邻用）
    for i, row in enumerate(rows):
        if is_novel_row(row, brain):
            continue
        node = _row_node(row, brain, pressed_ids, now_ms, skew)
        node["_src"] = row["source"]
        cands.append(node)
        row_pos[node["id"]] = i

    hormone_nodes, rhythm = _hormone_nodes(brain, aux, now_ms, skew)
    cands += hormone_nodes
    cands += _mood_nodes(brain, aux, now_ms, skew)
    cands += _sleep_nodes(brain, aux, rhythm, now_ms, skew)
    cands += _watch_nodes(brain, aux, now_ms, skew)
    people = _impressions(brain, aux)
    for name, d in people.items():
        for note in d["notes"][:3]:
            emo, st = detect_emotion(note["text"])
            if d["score"] < 0 and not emo:
                emo, st = "worry", 0.4
            cands.append(make_node(
                "imp:" + hashlib.sha1((name + note["text"]).encode()).hexdigest()[:12], "fact", "tpj", label=f"{name}：{note['text']}", summary=note["text"],
                text=f"{name}：{note['text']}", source="印象 · " + name, at_ms=note["at"], importance=min(0.85, 0.5 + 0.05 * min(5, d["count"])),
                emotion=emo, emotion_strength=st, now_ms=now_ms, machine_time=True, skew_ms=skew, origin="印象"))

    # 名额：limit 是总数上限。实体最多 entity_budget 个，身份核心 1 个，想起过的最多 12 个，其余给记忆点
    if full_mode:
        entity_budget = max(40, min(FULL_ENTITY_BUDGET, len(cands) // 12))      # 实体数跟着记忆块数走：小脑子别给一堆话题
        recall_slots = 12
        chosen = list(cands)                    # 全量：一个不挑
    else:
        entity_budget = min(130, max(5, limit // 10))
        recall_slots = min(12, max(0, limit // 40))
        chosen = _select(cands, limit - 1 - recall_slots, entity_budget)

    # 刚被想起的：recall-log 最近 N 分钟里出现过的
    recent_ids, log_entries = _recall_log(brain, recent_min, now_ms, skew)
    ep_of_id = {}
    for rid, i in row_pos.items():
        m = rows[i].get("meta") or {}
        if m.get("epId"):
            ep_of_id[m["epId"]] = rid
    recent_node_ids = set()
    for x in recent_ids:
        if x in row_pos:
            recent_node_ids.add(x)
        elif x in ep_of_id:
            recent_node_ids.add(ep_of_id[x])
    # 想起过：最近的几次想起，在背外侧前额叶各记一个点（工作记忆里刚过手的东西），连到它们想起的那几条
    recall_nodes = []
    for e in log_entries[-recall_slots:] if recall_slots else []:
        at = _num(e.get("at"))
        picks = [p for p in (e.get("picks") or []) if p.get("id")]
        if not picks or not at:
            continue
        q = str(e.get("q") or "").strip()
        n = make_node(
            f"recall:{int(at)}", "event", "dlpfc", label=f"想起了 {len(picks)} 件事", summary=f"聊到「{q}」，想起 " + "；".join(str(p.get("preview") or "")[:24] for p in picks),
            text=f"聊到「{q}」，想起了：\n" + "\n".join("· " + str(p.get("preview") or p.get("label") or "") for p in picks), source="想起过 · recall-log",
            at_ms=at, importance=0.5, private=(e.get("mode") == "private"), place="想起", now_ms=now_ms, machine_time=True, skew_ms=skew, origin="想起")
        n["_picks"] = [str(p.get("epId") or p.get("id")) for p in picks]
        recall_nodes.append(n)
    # 只留下「想起的那几件事至少有一件在图里」的，免得飘着一个没有线的孤点
    sel_ids = {n["id"] for n in chosen}
    recall_nodes = [n for n in recall_nodes if any((p in sel_ids) or (ep_of_id.get(p) in sel_ids) for p in n["_picks"])]
    chosen += recall_nodes

    # 实体
    global_texts = [r["text"] for r in rows] if rows else None
    ent, mention, df = _entities(brain, chosen, people, entity_budget, other, global_texts)
    ent_nodes = []
    # 人、作品、地方先留；话题按「被提到的次数」排
    ent_rank = sorted(ent.values(), key=lambda e: (e["kind"] == "topic", -df[e["id"]], e["id"]))
    region_votes = defaultdict(Counter)
    node_info = {n["id"]: (n["region"], 0.25 if n.get("origin") == "聊天记录" else 1.0) for n in chosen}
    for nid, eids in mention.items():
        info = node_info.get(nid)
        if info:
            for eid in eids:
                region_votes[eid][info[0]] += info[1]       # 聊天原话是原料，票只算四分之一：不然所有实体都挤进说话 / 听话两个区
    ent_region = {eid: sorted(c.items(), key=lambda kv: (-kv[1], kv[0]))[0][0] for eid, c in region_votes.items()}
    for e in ent_rank:
        if len(ent_nodes) >= entity_budget:
            break
        if e["kind"] == "topic" and df[e["id"]] < 3:
            continue
        if e["kind"] != "person" and df[e["id"]] < 1:
            continue
        # 2026-10-29 老大：实体放在「它连得最多的区」里（提到它的点大多在哪个区就在哪个区；一个都没有就用它自己的老位置）
        region = ent_region.get(e["id"]) or e["region"] or "temporal"
        n_men = df[e["id"]]
        imp = min(1.0, e["base"] * 0.6 + 0.4 * min(1.0, n_men / 20.0))
        ent_nodes.append(make_node(
            e["id"], "entity", region, label=e["label"], summary=f"{ {'person': '人', 'topic': '话题', 'work': '作品', 'place': '地方'}[e['kind']] }：{e['label']}（被 {n_men} 处提到）",
            text=(e["text"] + "\n" if e["text"] else "") + f"在这个脑子里被 {n_men} 处提到。", source="实体", at_ms=0, importance=imp, now_ms=now_ms,
            entityKind=e["kind"], key=e["key"], mentions=n_men))
    ent_ids = {n["id"] for n in ent_nodes}
    chosen += ent_nodes

    # 身份核心：一个中心点（她自己），身份各页连到它
    ident = [n for n in chosen if n["type"] == "identity"]
    self_id = f"self:{brain.id}"
    self_node = make_node(self_id, "identity", "core", label=brain.name, summary=f"{brain.name}：身份核心", text=f"{brain.name}。身份、soul、self 都围着这一点。",
                          source="身份", importance=1.0, now_ms=now_ms, key=self_id, isSelf=True)
    chosen.append(self_node)
    nodes_by_id = {n["id"]: n for n in chosen}

    # ─ 边 ─
    links = []
    seen = set()

    def link(a, b, typ, w):
        if a == b or a not in nodes_by_id or b not in nodes_by_id:
            return
        k = (a, b) if a < b else (b, a)
        if (k, typ) in seen:
            return
        seen.add((k, typ))
        links.append({"source": a, "target": b, "type": typ, "w": round(w, 3)})

    # 提到：每个记忆点最多连 3 个实体，不常见的优先（老大这种到处都是的，别把所有线都拉到他身上）
    for nid, eids in mention.items():
        if nid not in nodes_by_id:
            continue
        el = sorted([e for e in eids if e in ent_ids], key=lambda e: df[e])[:3]
        for e in el:
            link(nid, e, "mention", 0.5)
    # 共有两个以上不常见实体（同一件事）
    by_pair = defaultdict(list)
    rare = {e for e in ent_ids if df[e] <= max(8, int(0.08 * len(chosen)))}
    for nid, eids in mention.items():
        if nid not in nodes_by_id:
            continue
        rs = sorted(set(eids) & rare)
        if len(rs) >= 2:
            for e in rs:
                by_pair[e].append(nid)
    shared_cnt = Counter()
    for e, nl in by_pair.items():
        for i in range(len(nl)):
            for j in range(i + 1, min(len(nl), i + 4)):
                a, b = nl[i], nl[j]
                if shared_cnt[a] < 2 and shared_cnt[b] < 2:
                    link(a, b, "shared", 0.6)
                    shared_cnt[a] += 1
                    shared_cnt[b] += 1
    # 同一会话里时间相邻：同一个来源里，索引里挨着的两块（聊天记录按天 / 会话一个文件，瞬间按出处一个文件）
    src_groups = defaultdict(list)
    for n in chosen:
        if n["id"] in row_pos and n.get("origin") in ("聊天记录", "瞬间"):
            src_groups[n["_src"]].append((row_pos[n["id"]], n["id"]))
    for _src, lst in src_groups.items():
        lst.sort()
        for (p1, a), (p2, b) in zip(lst, lst[1:]):
            if p2 - p1 <= 3 and abs((nodes_by_id[a]["at"] or 0) - (nodes_by_id[b]["at"] or 0)) <= 6 * 3600 * 1000:
                link(a, b, "adjacent", 0.35)
    # 意思很近（语义 top-k）：只用索引里存好的向量
    sem_ids = [n["id"] for n in chosen if n["id"] in row_pos]
    if mat is not None and len(sem_ids) > 2:
        idx = np.array([row_pos[i] for i in sem_ids])
        m = mat[idx]
        k = min(3, len(sem_ids) - 1)
        # 全量时有上万个点，整张相似度矩阵放不下（9000² × 4 字节 = 300 多 MB）：一次算 512 行，用完就丢
        for s0 in range(0, len(sem_ids), 512):
            blk = m[s0:s0 + 512] @ m.T
            for r in range(blk.shape[0]):
                blk[r, s0 + r] = -1.0
            top = np.argpartition(-blk, k - 1, axis=1)[:, :k]
            for r in range(blk.shape[0]):
                nid = sem_ids[s0 + r]
                cnt = 0
                for j in sorted(top[r], key=lambda jj: (-blk[r, jj], jj)):
                    sim = float(blk[r, j])
                    other_id = sem_ids[j]
                    same = nodes_by_id[nid]["region"] == nodes_by_id[other_id]["region"]
                    # bge-small 里「不相干」的余弦也有 0.3~0.45；同区 0.62 以上才连，跨区 0.74 以上才连，所以长线少
                    if sim >= (0.62 if same else 0.74) and cnt < 2:
                        link(nid, other_id, "semantic", sim)
                        cnt += 1
    # 想起：想起过的点连到被想起的
    for n in recall_nodes:
        for pid in n.get("_picks", []):
            tid = pid if pid in nodes_by_id else ep_of_id.get(pid)
            if tid:
                link(n["id"], tid, "recall", 0.7)
    # 身份核心：各页连到中心；中心连老大、对方、此刻的心情和作息
    for n in ident:
        link(self_id, n["id"], "core", 0.9)
    srcs = defaultdict(list)
    for n in ident:
        srcs[n.get("_src") or n["source"]].append(n["id"])
    for _s, ids in srcs.items():
        for a, b in zip(ids, ids[1:]):
            link(a, b, "core", 0.8)
    for eid in ("ent:person:owner", "ent:person:sister" if brain.id == "whale" else "ent:person:whale", "mood:now", "rhythm:now"):
        if eid in nodes_by_id:
            link(self_id, eid, "core", 0.6)

    # 边太多就修剪（点不动）
    links_total = len(links)
    links = prune_links(links, edge_k)

    # 刚想起标记
    for nid in recent_node_ids:
        if nid in nodes_by_id:
            nodes_by_id[nid]["recentlyRecalled"] = True
    for n in chosen:
        if str(n["id"]).startswith("recall:") and _num(n["at"]) >= now_ms - recent_min * 60000.0:
            n["recentlyRecalled"] = True

    # 清内部字段，整理输出
    counts = Counter(n["region"] for n in chosen)
    t_layout = time.time()
    pos, geo = layout_for(chosen, links)
    layout_ms = int((time.time() - t_layout) * 1000)
    regions = []
    for r in REGIONS:
        c = counts.get(r["id"], 0)
        gx, gy, gr = geo[r["id"]]
        regions.append({"id": r["id"], "name": r["name"], "area": r["area"], "holds": r["holds"], "center": [gx, gy], "x": gx, "y": gy, "radius": gr,
                        "color": r["color"], "count": c})
    bounds = {"minX": round(min(g[0] - g[2] for g in geo.values()), 1), "maxX": round(max(g[0] + g[2] for g in geo.values()), 1),
              "minY": round(min(g[1] - g[2] for g in geo.values()), 1), "maxY": round(max(g[1] + g[2] for g in geo.values()), 1)}
    full = {}
    out_nodes = []
    for n in chosen:
        n = dict(n)
        n.pop("_src", None)
        n.pop("_picks", None)
        n["x"], n["y"] = pos[n["id"]]
        full[n["id"]] = n
        light = {k: v for k, v in n.items() if k != "text"}
        out_nodes.append(light)
    deg = Counter()
    for l in links:
        deg[l["source"]] += 1
        deg[l["target"]] += 1
    for n in out_nodes:
        n["degree"] = deg.get(n["id"], 0)
        full[n["id"]]["degree"] = n["degree"]
    graph = {
        "ok": True, "brain": brain.id, "name": brain.name, "limit": limit, "full": full_mode, "edgeK": edge_k, "dim": 2,
        "nodes": out_nodes, "links": links, "regions": regions, "bounds": bounds,
        "types": TYPES, "emotions": EMOTIONS, "generatedAt": int(now * 1000), "skewMs": int(skew),
        "counts": {"nodes": len(out_nodes), "links": len(links), "linksBeforePrune": links_total, "layoutMs": layout_ms, "byType": dict(Counter(n["type"] for n in out_nodes)),
                   "byRegion": {k: v for k, v in counts.items()}, "indexChunks": len(rows)},
        "recent": sorted(i for i in recent_node_ids if i in nodes_by_id), "recentMin": recent_min,
        "_epOf": dict(ep_of_id),      # 下划线开头的是内部字段，get_graph 输出时去掉
    }
    return graph, full


# ───────────────────────────── 缓存 + 对外 ─────────────────────────────
_cache = {}          # (brain.id, limit, edge_k) -> {"sig", "at", "graph", "full"}
_lock = threading.Lock()


def _sig(brain, coarse=False, now=None):
    """缓存指纹：这些文件一变，图就该重算。coarse=True（全量图用）：激素 / 心情文件几分钟就写一次，按 5 分钟一格算；再加一个 30 分钟的
    时间格（新鲜度会慢慢变），这样全量图（要好几秒才能算好）不会因为激素每动一下就重算。"""
    aux = _aux(brain)
    files = [brain.db, brain.pressed]
    volatile = []
    for k in ("hormones", "mood", "social"):
        if aux.get(k):
            (volatile if (coarse and k in ("hormones", "mood")) else files).append(aux[k])
    files += list(aux.get("impressions") or []) + list(aux.get("watch") or [])
    sig = _stat_sig(files)
    if coarse:
        for p in volatile:
            try:
                sig += f"|{p}:{int(Path(p).stat().st_mtime // 300)}"
            except OSError:
                sig += f"|{p}:-"
        sig += f"|t{int((time.time() if now is None else now) // 1800)}"
    return sig


STALE_MAX_S = 6 * 3600          # 全量图旧了也先给（后台重算），旧到这个程度才让请求等着新的
MIN_BG_AGE_S = 20.0             # 后台重算之间至少隔这么久
_build_locks = {}
_bg_running = set()


def _bg_rebuild(brain, key, limit, edge_k, recent_min, sig):
    try:
        t = time.time()
        graph, full = build_graph(brain, limit=limit, now=t, recent_min=recent_min, edge_k=edge_k)
        with _lock:
            _cache[key] = {"sig": sig, "at": t, "graph": graph, "full": full}
    except Exception:  # noqa: BLE001
        pass                       # 这一轮没算成，旧的还在，下次再试
    finally:
        with _lock:
            _bg_running.discard(key)


def _entry(brain, key, limit, edge_k, recent_min, now, ttl):
    """取缓存里的图（没有 / 过期就算）。全量图（要好几秒）用「先给旧的、后台悄悄重算」：页面随时秒开。"""
    full_mode = limit == 0
    sig = _sig(brain, coarse=full_mode, now=now)
    with _lock:
        ent = _cache.get(key)
        fresh = bool(ent) and ent["sig"] == sig and (full_mode or now - ent["at"] <= ttl)
        if fresh:
            return ent
        if ent and full_mode and now - ent["at"] < STALE_MAX_S:
            if key not in _bg_running and now - ent["at"] >= MIN_BG_AGE_S:
                _bg_running.add(key)
                threading.Thread(target=_bg_rebuild, args=(brain, key, limit, edge_k, recent_min, sig), daemon=True, name="graph-rebuild").start()
            return ent
        bl = _build_locks.setdefault(key, threading.Lock())
    with bl:                       # 同一份同时来了几个请求：一个算，别的等着用
        with _lock:
            ent = _cache.get(key)
            if ent and ent["sig"] == sig and (full_mode or now - ent["at"] <= ttl):
                return ent
        graph, full = build_graph(brain, limit=limit, now=now, recent_min=recent_min, edge_k=edge_k)
        ent = {"sig": sig, "at": now, "graph": graph, "full": full}
        with _lock:
            _cache[key] = ent
        return ent


def get_graph(brain, limit=DEFAULT_LIMIT, recent_min=RECENT_RECALL_MIN, recent_only=False, now=None, ttl=None, edge_k=DEFAULT_EDGE_K, compact=False):
    """带缓存的图：结构 45 秒内不重算（索引或状态文件变了就重算）；「刚想起」的标记每次另算，所以 30 秒一刷也不重。
    compact=True：线用 [源点序号, 终点序号, 类型序号, 权重] 的数组表示（序号 = nodes 里的位置，类型名在 linkTypes 里），全量时能少三分之一的体积。
    limit=0 = 全量：缓存按指纹（索引 / 印象 / 看过的文件变了，或激素心情隔了几分钟）失效，失效后先给旧的、后台重算。"""
    brain = brain if isinstance(brain, memindex.Brain) else memindex.get_brain(brain)
    limit = norm_limit(limit)
    edge_k = norm_edge_k(edge_k)
    if ttl is None:
        ttl = GRAPH_CACHE_TTL
    now = time.time() if now is None else now
    key = (brain.id, limit, edge_k)
    ent = _entry(brain, key, limit, edge_k, recent_min, now, ttl)
    graph = ent["graph"]
    # 刚想起的标记：每次按 recall-log 重算（很便宜）
    skew = memindex.clock_skew_ms(brain)
    now_ms = now * 1000.0 - skew
    recent_ids, _entries = _recall_log(brain, recent_min, now_ms, skew)
    ids = ent.get("ids")
    if ids is None:
        ids = ent["ids"] = {n["id"] for n in graph["nodes"]}
    ep_map = graph.get("_epOf")
    if ep_map is None and recent_ids:
        ep_map = {}
        rows, _m = memindex.load_vectors(brain.db) if brain.db.exists() else ([], None)
        for r in rows:
            m = r.get("meta") or {}
            if m.get("epId"):
                ep_map[m["epId"]] = r["id"]
    hit = sorted({((ep_map or {}).get(x) or x) for x in recent_ids} & ids)
    if recent_only:
        return {"ok": True, "brain": brain.id, "recent": hit, "recentMin": recent_min, "generatedAt": int(now * 1000)}
    out = {k: v for k, v in graph.items() if not k.startswith("_")}
    out["recent"] = hit
    hit_set = set(hit)
    out["nodes"] = [dict(n, recentlyRecalled=(n["id"] in hit_set)) for n in graph["nodes"]]
    out["recentMin"] = recent_min
    out["generatedAt"] = int(now * 1000)
    if compact:
        pos = {n["id"]: i for i, n in enumerate(out["nodes"])}
        types = sorted({l["type"] for l in graph["links"]}, key=lambda t: (LINK_TYPE_ORDER.get(t, 9), t))
        tpos = {t: i for i, t in enumerate(types)}
        out["links"] = [[pos[l["source"]], pos[l["target"]], tpos[l["type"]], l["w"]] for l in graph["links"]]
        out["linkTypes"] = types
        out["compact"] = True
    return out


def warm(brain_ids=None, limit=0):
    """先把全量图算好放进缓存（服务起来后台调一次，之后页面一开就是现成的）。算不出来（索引还没建好）就返回 False，不抛错。"""
    ok_all = True
    for bid in (brain_ids or list(memindex.config().brains)):
        try:
            b = memindex.get_brain(bid)
            if not b.db.exists():
                ok_all = False
                continue
            get_graph(b, limit=limit)
        except Exception:  # noqa: BLE001
            ok_all = False
    return ok_all


def node_detail(brain, nid, now=None):
    """单个点的全文。图里没有的（被名额挤掉的）索引块也能点开。找不到返回 None。"""
    brain = brain if isinstance(brain, memindex.Brain) else memindex.get_brain(brain)
    nid = str(nid or "")
    with _lock:
        ents = [e for (bid, _l, _k), e in _cache.items() if bid == brain.id]
    node = None
    links = []
    for e in sorted(ents, key=lambda x: -x["at"]):
        node = e["full"].get(nid)
        if node:
            links = [l for l in e["graph"]["links"] if l["source"] == nid or l["target"] == nid]
            neighbors = []
            for l in links[:12]:
                oid = l["target"] if l["source"] == nid else l["source"]
                o = e["full"].get(oid)
                if o:
                    neighbors.append({"id": oid, "label": o["label"], "type": o["type"], "rel": l["type"]})
            node = dict(node, neighbors=neighbors)
            break
    if node is None and brain.db.exists():
        rows, _m = memindex.load_vectors(brain.db)
        skew = memindex.clock_skew_ms(brain)
        now = time.time() if now is None else now
        pressed_j = _read_json(brain.pressed, {})
        pressed_ids = {str(x.get("id")) for x in (pressed_j.get("items") or [])} if isinstance(pressed_j, dict) else set()
        for r in rows:
            if r["id"] == nid:
                node = _row_node(r, brain, pressed_ids, now * 1000.0 - skew, skew)
                node["_src"] = None
                node.pop("_src")
                node["neighbors"] = []
                break
    if node is None:
        return None
    node = dict(node)
    reg = REGION_BY_ID.get(node["region"], {})
    node["regionName"] = reg.get("name", "")
    node["typeLabel"] = TYPE_LABEL.get(node["type"], node["type"])
    return node


def clear_cache():
    with _lock:
        _cache.clear()
    with _layout_lock:
        _layout_cache.clear()
