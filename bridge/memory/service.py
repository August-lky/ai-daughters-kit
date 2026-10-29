"""转发：service.py 已于 2026-10-29 搬到 E:/qq-bridge/brain/（大脑方案，一个服务、一个模型、多个 brain）。
老的启动方式（cd memory & python service.py）照旧能用，这里只把它转给 brain/service.py。
服务看守按命令行里有没有 service.py 认进程，转发之后仍然认得。"""
import runpy
from pathlib import Path

_target = Path(__file__).resolve().parent.parent / "brain" / "service.py"
runpy.run_path(str(_target), run_name="__main__")
