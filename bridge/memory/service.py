"""
记忆服务：常驻进程，模型只加载一次，本子改了自动重建索引。

为什么要有它：
  1. 以前 memory_recall 每次调用都 spawn 一个 python，光是加载 embedding 模型就要
     40 秒 —— 她"想起来一件事"比人翻日记还慢。
  2. 索引是静态的：改完 soul.md / memory.md 必须手动跑 `python index.py build`，
     否则她按意思翻本子翻到的是旧版本，而且没有任何提示。

这个进程做两件事：把模型揣在内存里；每 5 秒看一眼本子的 (mtime, size)，
变了就在后台重建索引。她永远查到的是最新的。

接口（只监听 127.0.0.1）：
  GET  /health   → {"ok":true,"ready":bool,"chunks":n,"building":bool,"error":"..."}
  POST /search   → {"query":"...","k":5,"person":"小鲸鱼"|null}
  POST /rebuild  → 强制重建
  GET  /stats    → 各人/各类的块数

用法：
  python service.py            # 前台跑（调试用）
  由 start-memory-hidden.vbs 隐藏启动
"""
import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import index as memindex  # noqa: E402

PORT = int(os.environ.get("MEMORY_PORT", "3210"))
WATCH_INTERVAL = 5.0

_build_lock = threading.Lock()
_state = {
    "model": None,
    "ready": False,
    "building": False,
    "error": "",
    "chunks": 0,
    "built_at": 0.0,
    "signature": "",
}


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


def source_signature():
    """本子的指纹：路径 + 修改时间 + 大小。任何一本被改都会变。"""
    items = []
    # 和 index.iter_sources 用同一份清单（含根目录本子和碎碎念），不然改了那两处不会触发重建
    for _person, _kind, md in memindex.iter_sources():
        try:
            st = md.stat()
        except OSError:
            continue
        items.append(f"{memindex.source_rel(md)}:{st.st_mtime_ns}:{st.st_size}")
    return "|".join(items)


def ensure_model():
    if _state["model"] is None:
        from fastembed import TextEmbedding
        log("加载 embedding 模型…")
        _state["model"] = TextEmbedding(memindex.MODEL)
        log("模型就绪")
    return _state["model"]


def rebuild(force=False):
    """重建索引。返回 True 表示索引可用（新建成功或本来就没变）。"""
    if not _build_lock.acquire(blocking=force):
        # 已经在建了，交给那个线程
        return _state["ready"]
    try:
        _state["building"] = True
        sig = source_signature()
        if not force and _state["ready"] and sig == _state["signature"]:
            return True
        model = ensure_model()
        n = memindex.build(model=model)
        _state.update(
            ready=True,
            chunks=int(n or 0),
            built_at=time.time(),
            signature=sig,
            error="",
        )
        log(f"索引已更新：{n} 块")
        return True
    except Exception as exc:  # noqa: BLE001 - 任何异常都不能让服务退出
        _state["error"] = f"{type(exc).__name__}: {exc}"
        log(f"重建失败：{_state['error']}")
        traceback.print_exc()
        return False
    finally:
        _state["building"] = False
        _build_lock.release()


def watch_loop():
    while True:
        time.sleep(WATCH_INTERVAL)
        try:
            if source_signature() != _state["signature"]:
                log("检测到本子有改动，重建索引…")
                rebuild()
        except Exception as exc:  # noqa: BLE001
            log(f"watch 出错：{exc}")


def do_search(query, k, person):
    if not _state["ready"]:
        return None
    model = _state["model"]
    hits = memindex.search(query, k=k, person=person, model=model)
    return [
        {
            "score": round(float(score), 4),
            "person": person_name,
            "label": label,
            "text": body,
            "ageDays": age_days,
        }
        for score, person_name, label, body, age_days in hits
    ]


def stats():
    import sqlite3

    if not memindex.DB.exists():
        return {"ok": False, "error": "还没有索引"}
    conn = sqlite3.connect(memindex.DB, timeout=10)
    try:
        total = conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
        by_person = {
            p: n for p, n in conn.execute("SELECT person, COUNT(*) FROM chunks GROUP BY person")
        }
        by_kind = {
            f"{p}/{k}": n
            for p, k, n in conn.execute("SELECT person, kind, COUNT(*) FROM chunks GROUP BY person, kind")
        }
    finally:
        conn.close()
    return {"ok": True, "total": total, "byPerson": by_person, "byKind": by_kind}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # 静音默认访问日志
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
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

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/health":
            self._send({
                "ok": True,
                "ready": _state["ready"],
                "building": _state["building"],
                "chunks": _state["chunks"],
                "builtAt": int(_state["built_at"]),
                "error": _state["error"],
            })
        elif path == "/stats":
            self._send(stats())
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        body = self._read_json()
        if path == "/search":
            query = str(body.get("query") or "").strip()
            if not query:
                self._send({"ok": False, "error": "query 不能为空"}, 400)
                return
            try:
                k = max(1, min(10, int(body.get("k") or 5)))
            except (TypeError, ValueError):
                k = 5
            person = body.get("person") or None
            if not _state["ready"]:
                self._send({"ok": False, "error": "索引还没就绪", "building": _state["building"]}, 503)
                return
            try:
                results = do_search(query, k, person)
            except Exception as exc:  # noqa: BLE001
                log(f"检索失败：{exc}")
                self._send({"ok": False, "error": f"{type(exc).__name__}: {exc}"}, 500)
                return
            self._send({"ok": True, "results": results})
        elif path == "/rebuild":
            ok = rebuild(force=True)
            self._send({"ok": ok, "chunks": _state["chunks"], "error": _state["error"]})
        else:
            self._send({"ok": False, "error": "not found"}, 404)


def main():
    setup_stdio()
    # 先让 HTTP 起来（health 立刻可答），模型在后台慢慢加载。
    threading.Thread(target=rebuild, kwargs={"force": True}, daemon=True, name="build").start()
    threading.Thread(target=watch_loop, daemon=True, name="watch").start()
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
