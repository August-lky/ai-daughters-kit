"""
记忆服务：常驻进程，一个模型，多个 brain（小鲸鱼、姐姐），各自一份 vectors.db。本子改了自动重建索引。

2026-10-29 搬家（大脑方案）：原来在 memory/service.py，只服务小鲸鱼。现在放在纯英文路径 brain/ 下，
  按 brains.json 管两个人的脑子；接口加 brain 参数，没传就是小鲸鱼，老的调用方不用改。

为什么要有它：
  1. 以前 memory_recall 每次调用都 spawn 一个 python，光是加载 embedding 模型就要
     40 秒 —— 她"想起来一件事"比人翻日记还慢。
  2. 索引是静态的：改完本子必须手动跑 `python index.py build`，否则她按意思翻本子翻到的是旧版本。

这个进程做两件事：把模型揣在内存里；每 5 秒看一眼每个 brain 本子的 (mtime, size)，
变了就在后台重建那个 brain 的索引。她永远查到的是最新的。

接口（只监听 127.0.0.1）：
  GET  /health            → {"ok":true,"ready":bool,"chunks":n,"building":bool,"error":"...","brains":{...}}
                            （ready / chunks 是缺省 brain 的，兼容老调用；各 brain 的在 brains 里）
  POST /search            → {"brain":"whale"|"sister"（缺省小鲸鱼）,"query":"...","k":5,"person":null,"explain":false}
                            打分：关键词 0.46 + 语义 0.18 + 重要度 + 新鲜度 + 同源邻居，乘降权表，本地去重（recall.py）
  POST /recall            → {"brain":...,"query":"这句","prev":["前两句…"],"mode":"private"|"group","viewer":"会话key","explain":false,"log":true}
                            按话题想起：私聊最多 2 条，群里 1 条且门槛更高；排除小说 / 身份 / 眼前的事；结果带出处，
                            私聊来源标「（私聊里的）」；压着的事相近时按概率作为第 3 条；写 .索引/recall-log.jsonl
  POST /demote            → {"brain":...,"maxAgeMin":30} 老大说「记错了」：把最近一次想起的条目写进 .索引/降权.json
  POST /tidy              → {"brain":...} 睡前整理建议：重复的段落 / 过期的约定 / 互相矛盾的句子，只列不改
  POST /remember-moment   → {"brain":...} 刚留下一个瞬间：马上重建索引（没变的块沿用旧向量，很快），让它立刻能被想起来
  POST /rebuild           → {"brain":...} 强制重建；不传就全部
  GET  /stats?brain=...   → 各类的块数
  GET  /graph?brain=whale|sister[&limit=1500|0][&edgeK=8][&compact=1][&recent=30][&recentOnly=1]   （limit=0 = 全部，坐标已算好；2026-10-29 改 2D）
                          → 3D 大脑页面用的图：{nodes, links, regions, types, emotions, generatedAt, recent}（brain/graph.py，不调模型、只读）；
                            默认最多约 1500 个点，按重要度和新鲜度挑；recent 是「多少分钟内被想起的算刚想起」；recentOnly=1 只回刚想起的 id（页面 30 秒一刷用）
  GET  /graph/node?brain=...&id=...  → 单个点的全文、出处、时间、相邻的点（2026-10-29 大脑页面）

用法：
  python service.py            # 前台跑（调试用）
  由 start-memory-hidden.vbs 隐藏启动
"""
import json
import os
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import graph as brain_graph  # noqa: E402
import index as memindex  # noqa: E402
import recall  # noqa: E402

PORT = int(os.environ.get("MEMORY_PORT", "3210"))
WATCH_INTERVAL = 5.0

_build_lock = threading.Lock()      # 一次只建一个 brain（共用一个模型，内存也省）
_model_state = {"model": None}
_states = {}                        # brain id -> 状态


def _new_state():
    return {"ready": False, "building": False, "error": "", "chunks": 0, "built_at": 0.0, "signature": ""}


def state_of(brain):
    if brain.id not in _states:
        _states[brain.id] = _new_state()
    return _states[brain.id]


def setup_stdio():
    """
    stdout 被重定向到文件时，Windows 上的 Python 默认用 cp1252/cp936 编码，
    一旦日志里出现中文就抛 UnicodeEncodeError —— 而它会把整个后台线程打死
    （表现是服务在跑但索引永远 ready=false）。这里显式钉成 UTF-8。
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            pass


_started_at = time.monotonic()


def log(msg):
    # 用「启动后经过多少秒」记时，不写墙钟：这台机器的系统时钟整体快了约 3 小时
    # （时区 Etc/GMT+8 且没有管理员权限改），写进日志只会误导排障。单调时钟永远对。
    line = f"[mem +{time.monotonic() - _started_at:7.1f}s] {msg}"
    try:
        print(line, flush=True)
    except Exception:  # noqa: BLE001 - 日志绝不能把线程搞死
        try:
            print(line.encode("ascii", "replace").decode("ascii"), flush=True)
        except Exception:  # noqa: BLE001
            pass


def ensure_model():
    if _model_state["model"] is None:
        from fastembed import TextEmbedding
        log("加载 embedding 模型…")
        _model_state["model"] = TextEmbedding(memindex.MODEL)
        log("模型就绪")
    return _model_state["model"]


def rebuild(brain, force=False):
    """重建这个 brain 的索引。返回 True 表示索引可用（新建成功或本来就没变）。"""
    st = state_of(brain)
    if not _build_lock.acquire(blocking=force):
        # 已经在建了，交给那个线程
        return st["ready"]
    try:
        st["building"] = True
        sig = memindex.source_signature(brain)
        if not force and st["ready"] and sig == st["signature"]:
            return True
        model = ensure_model()
        n = memindex.build(brain, model=model)
        st.update(ready=True, chunks=int(n or 0), built_at=time.time(), signature=sig, error="")
        log(f"[{brain.id}] 索引已更新：{n} 块")
        return True
    except Exception as exc:  # noqa: BLE001 - 任何异常都不能让服务退出
        st["error"] = f"{type(exc).__name__}: {exc}"
        log(f"[{brain.id}] 重建失败：{st['error']}")
        traceback.print_exc()
        return False
    finally:
        st["building"] = False
        _build_lock.release()


def build_all():
    for brain in memindex.config().brains.values():
        rebuild(brain, force=True)


def graph_warm_loop():
    """2026-10-29 大脑页面（2D 全量）：全量图要几秒才算好。服务起来一会儿后台先算一遍放进缓存，之后每隔几分钟看一眼
    （缓存失效的话 get_graph 会后台重算），页面一打开就是现成的。只读、不调模型；索引还没建好就过一会儿再试。"""
    time.sleep(25)
    while True:
        try:
            done = brain_graph.warm()
        except Exception as exc:  # noqa: BLE001
            log(f"大脑图预热失败：{exc}")
            done = False
        time.sleep(240 if done else 45)


def watch_loop():
    while True:
        time.sleep(WATCH_INTERVAL)
        for brain in memindex.config().brains.values():
            try:
                if memindex.source_signature(brain) != state_of(brain)["signature"]:
                    log(f"[{brain.id}] 检测到本子有改动，重建索引…")
                    rebuild(brain)
            except Exception as exc:  # noqa: BLE001
                log(f"[{brain.id}] watch 出错：{exc}")


def do_search(brain, query, k, person, explain=False):
    hits = recall.search_hits(brain, query, k=k, person=person, model=_model_state["model"])
    out = []
    for h in hits:
        item = {
            "score": round(float(h["score"]), 4),
            "person": h["person"],
            "label": h["label"],
            "text": h["text"],
            "ageDays": h["age_days"],
            "source": h["source"],
            "kind": h["kind"],
            "private": bool(h["private"]),
        }
        if explain:
            item.update(vec=round(h["vec"], 4), lit=round(h["lit"], 4), fresh=round(h["fresh"], 4),
                        imp=round(h["imp"], 3), graph=round(h["graph"], 3), demoted=h["demoted"])
        out.append(item)
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 静音默认访问日志
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        # 2026-10-29 大脑页面开发回退：页面不在桥接上（本地另起的静态页）时直连 /graph。只对 /graph* 的 GET、且只认回环地址
        # 的页面来源（127.0.0.1 / localhost 任意端口）；别的网站的页面读不到，所以不会把脑子漏给浏览器里的其他网页。
        origin = self.headers.get("Origin") or ""
        if self.path.startswith("/graph") and re.fullmatch(r"http://(127\.0\.0\.1|localhost)(:\d{1,5})?", origin):
            self.send_header("access-control-allow-origin", origin)
            self.send_header("vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        try:
            length = int(self.headers.get("content-length") or 0)
        except (TypeError, ValueError):
            length = 0
        if length <= 0 or length > 1_000_000:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:  # noqa: BLE001
            return {}

    def _brain(self, name):
        """没传 brain = 缺省小鲸鱼（兼容老调用）；传了认不出就报错，不悄悄用别人的脑子。"""
        b = memindex.config().resolve(name)
        if b is None:
            self._send({"ok": False, "error": f"不认识的 brain：{name}（有：{'、'.join(memindex.config().brains)}）"}, 400)
        return b

    def do_GET(self):
        parts = urlsplit(self.path)
        path = parts.path
        qs = parse_qs(parts.query)
        if path == "/health":
            cfg = memindex.config()
            d = state_of(cfg.resolve(None))
            brains = {
                bid: {k: state_of(b)[k] for k in ("ready", "building", "chunks", "error")}
                for bid, b in cfg.brains.items()
            }
            self._send({
                "ok": True,
                "ready": d["ready"],
                "building": d["building"],
                "chunks": d["chunks"],
                "builtAt": int(d["built_at"]),
                "error": d["error"],
                "brains": brains,
            })
        elif path == "/stats":
            b = self._brain((qs.get("brain") or [None])[0])
            if b is not None:
                self._send(memindex.stats(b))
        elif path == "/graph":
            # 2026-10-29 大脑页面：只读、不调模型、不写任何文件。没传 brain = 小鲸鱼；认不出报 400。
            b = self._brain((qs.get("brain") or [None])[0])
            if b is None:
                return
            if not b.db.exists():
                self._send({"ok": False, "error": "这个脑子还没有索引", "brain": b.id}, 503)
                return
            try:
                limit = int((qs.get("limit") or [brain_graph.DEFAULT_LIMIT])[0])      # 0 = 全部（2026-10-29 2D 版）
            except (TypeError, ValueError):
                limit = brain_graph.DEFAULT_LIMIT
            try:
                edge_k = int((qs.get("edgeK") or [brain_graph.DEFAULT_EDGE_K])[0])    # 每个点至少留几条最强的边，0 = 不修剪
            except (TypeError, ValueError):
                edge_k = brain_graph.DEFAULT_EDGE_K
            try:
                recent = float((qs.get("recent") or [brain_graph.RECENT_RECALL_MIN])[0])
            except (TypeError, ValueError):
                recent = brain_graph.RECENT_RECALL_MIN
            recent = max(1.0, min(24 * 60.0, recent))
            recent_only = (qs.get("recentOnly") or ["0"])[0] in ("1", "true", "yes")
            compact = (qs.get("compact") or ["0"])[0] in ("1", "true", "yes")
            try:
                self._send(brain_graph.get_graph(b, limit=limit, recent_min=recent, recent_only=recent_only, edge_k=edge_k, compact=compact))
            except Exception as exc:  # noqa: BLE001
                log(f"[{b.id}] 图谱失败：{exc}")
                traceback.print_exc()
                self._send({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)
        elif path == "/graph/node":
            b = self._brain((qs.get("brain") or [None])[0])
            if b is None:
                return
            nid = (qs.get("id") or [""])[0]
            if not nid:
                self._send({"ok": False, "error": "id 不能为空"}, 400)
                return
            try:
                node = brain_graph.node_detail(b, nid)
            except Exception as exc:  # noqa: BLE001
                log(f"[{b.id}] 取点失败：{exc}")
                self._send({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)
                return
            if node is None:
                self._send({"ok": False, "error": "没有这个点（可能图刷新过，重新点一下）", "brain": b.id}, 404)
            else:
                self._send({"ok": True, "brain": b.id, "node": node})
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        path = urlsplit(self.path).path
        body = self._read_json()
        if path == "/search":
            b = self._brain(body.get("brain"))
            if b is None:
                return
            query = str(body.get("query") or "").strip()
            if not query:
                self._send({"ok": False, "error": "query 不能为空"}, 400)
                return
            try:
                k = max(1, min(10, int(body.get("k") or 5)))
            except (TypeError, ValueError):
                k = 5
            person = body.get("person") or None
            st = state_of(b)
            if not st["ready"]:
                self._send({"ok": False, "error": "索引还没就绪", "building": st["building"], "brain": b.id}, 503)
                return
            try:
                results = do_search(b, query, k, person, bool(body.get("explain")))
            except Exception as exc:  # noqa: BLE001
                log(f"[{b.id}] 检索失败：{exc}")
                self._send({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)
                return
            self._send({"ok": True, "brain": b.id, "results": results})
        elif path == "/recall":
            b = self._brain(body.get("brain"))
            if b is None:
                return
            query = str(body.get("query") or "").strip()
            if not query:
                self._send({"ok": False, "error": "query 不能为空"}, 400)
                return
            st = state_of(b)
            if not st["ready"]:
                self._send({"ok": False, "error": "索引还没就绪", "building": st["building"], "brain": b.id}, 503)
                return
            prev = body.get("prev") or []
            if not isinstance(prev, list):
                prev = [prev]
            try:
                r = recall.recall(b, query, prev=[str(x) for x in prev][-2:], mode=body.get("mode") or "private",
                                  viewer=str(body.get("viewer") or ""), k=body.get("k"), model=_model_state["model"],
                                  explain=bool(body.get("explain")), write_log=body.get("log") is not False)
            except Exception as exc:  # noqa: BLE001
                log(f"[{b.id}] 想起失败：{exc}")
                self._send({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)
                return
            self._send({"ok": True, "brain": b.id, **r})
        elif path == "/demote":
            b = self._brain(body.get("brain"))
            if b is None:
                return
            try:
                age = max(1, min(24 * 60, int(body.get("maxAgeMin") or 30)))
            except (TypeError, ValueError):
                age = 30
            try:
                r = recall.demote_last(b, max_age_min=age, reason=str(body.get("reason") or "老大说记错了")[:60])
            except Exception as exc:  # noqa: BLE001
                log(f"[{b.id}] 降权失败：{exc}")
                self._send({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)
                return
            self._send({"ok": True, "brain": b.id, **r})
        elif path == "/tidy":
            b = self._brain(body.get("brain"))
            if b is None:
                return
            try:
                r = recall.tidy(b)    # 直接读本子，不用索引
            except Exception as exc:  # noqa: BLE001
                log(f"[{b.id}] 整理建议失败：{exc}")
                self._send({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)
                return
            self._send({"ok": True, "brain": b.id, **r})
        elif path == "/remember-moment":
            b = self._brain(body.get("brain"))
            if b is None:
                return
            # 瞬间文件一变，指纹就变；rebuild 里没变的块沿用旧向量，只给新瞬间算向量，所以很快。已经在建了就交给那个线程。
            ok = rebuild(b)
            self._send({"ok": bool(ok), "brain": b.id, "chunks": state_of(b)["chunks"]})
        elif path == "/rebuild":
            if body.get("brain"):
                b = self._brain(body.get("brain"))
                if b is None:
                    return
                ok = rebuild(b, force=True)
                self._send({"ok": ok, "brain": b.id, "chunks": state_of(b)["chunks"], "error": state_of(b)["error"]})
            else:
                res = {bid: rebuild(b, force=True) for bid, b in memindex.config().brains.items()}
                self._send({"ok": all(res.values()), "brains": {bid: {"ok": ok, "chunks": state_of(b)["chunks"]}
                                                                for (bid, b), ok in zip(memindex.config().brains.items(), res.values())}})
        else:
            self._send({"ok": False, "error": "not found"}, 404)


def main():
    setup_stdio()
    for b in memindex.config().brains.values():
        state_of(b)
    # 先让 HTTP 起来（health 立刻可答），模型在后台慢慢加载。小鲸鱼先建，姐姐接着建。
    threading.Thread(target=build_all, daemon=True, name="build").start()
    threading.Thread(target=watch_loop, daemon=True, name="watch").start()
    threading.Thread(target=graph_warm_loop, daemon=True, name="graph-warm").start()
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    log(f"listening on 127.0.0.1:{PORT}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("收到中断，退出")
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
