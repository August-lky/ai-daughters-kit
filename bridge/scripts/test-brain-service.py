"""检索服务（brain/service.py）的接口测试——进程内测，不起真的服务：
临时监听 127.0.0.1 的随机端口，用完就关；只读已经建好的索引（先跑过 python brain/index.py build），不重建、不写任何东西。
由 scripts/test-brain-unify.mjs 调用，也可以单独跑：python scripts/test-brain-service.py"""
import json
import sys
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

BRAIN = Path(__file__).resolve().parent.parent / "brain"
sys.path.insert(0, str(BRAIN))
import service  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

for b in service.memindex.config().brains.values():
    assert b.db.exists(), f"{b.id} 还没有索引，先跑 python brain/index.py build"
    service.state_of(b).update(ready=True, chunks=1)   # 索引已经建好了，这里只测接口
service.ensure_model()

srv = ThreadingHTTPServer(("127.0.0.1", 0), service.Handler)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()


def call(method, path, body=None):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data, method=method,
                                 headers={"content-type": "application/json; charset=utf-8"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


try:
    code, h = call("GET", "/health")
    assert code == 200 and h["ready"] is True and set(h["brains"]) == {"whale", "sister"}, h

    # 老的调用方不传 brain → 小鲸鱼
    code, r = call("POST", "/search", {"query": "主人家里做什么的", "k": 3})
    assert code == 200 and r["brain"] == "whale" and r["results"] and r["results"][0]["person"] == "小鲸鱼", r
    assert all(k in r["results"][0] for k in ("score", "label", "text", "ageDays")), "老调用方用到的字段都在"

    code, r = call("POST", "/search", {"brain": "whale", "query": "初音", "k": 2, "explain": True})
    assert code == 200 and "vec" in r["results"][0] and "lit" in r["results"][0] and "fresh" in r["results"][0], r
    assert len(r["results"]) == 2

    # 别名认；姐姐只搜自己的脑子（聊天记录各编各的：姐姐的 sister/聊天记录，小鲸鱼的 家/小鲸鱼/聊天记录——2026-10-29 老大要求两人一样）
    code, r = call("POST", "/search", {"brain": "姐姐", "query": "小房子", "k": 3})
    assert code == 200 and r["brain"] == "sister" and r["results"] and all(x["person"] == "姐姐" for x in r["results"]), r
    code, r = call("POST", "/search", {"brain": "whale", "query": "小房子", "k": 10})
    assert all(x["person"] == "小鲸鱼" for x in r["results"]), "小鲸鱼的索引里只有小鲸鱼自己的东西（含她自己的聊天记录）"

    # 2026-10-29 下半：/recall 是「按话题想起」（带门槛，可能什么都想不起；log:false 不往真的 recall-log 里写）
    code, r = call("POST", "/recall", {"brain": "sister", "query": "打音游", "k": 1, "log": False})
    assert code == 200 and r["ok"] and "items" in r and "lines" in r, r

    # 不认识的 brain 报错，不悄悄用别人的脑子
    code, r = call("POST", "/search", {"brain": "陌生人", "query": "x"})
    assert code == 400 and "不认识的 brain" in r["error"], r
    code, r = call("POST", "/search", {"brain": "whale", "query": "  "})
    assert code == 400, r

    code, s = call("GET", "/stats?brain=sister")
    assert code == 200 and s["brain"] == "sister" and s["total"] > 500 and "聊天记录" in s["byKind"], s
    code, s = call("GET", "/stats")
    assert code == 200 and s["brain"] == "whale" and "记过的事" in s["byKind"], s

    # 睡前整理建议只读本子，对真的脑子也安全（/demote、/remember-moment 会写文件 / 重建，只在 test-brain-recall.py 里用临时目录测）
    code, r = call("POST", "/tidy", {"brain": "whale"})
    assert code == 200 and r["ok"] and "total" in r, r
    code, r = call("GET", "/nope")
    assert code == 404
    print("✅ 检索服务接口：缺省 brain=小鲸鱼（兼容老调用）、别名、explain、/recall、坏 brain 报错、/stats、/tidy")
finally:
    srv.shutdown()
