"""转发：index.py 已于 2026-10-29 搬到 E:/qq-bridge/brain/（大脑方案，一个服务、一个模型、多个 brain）。
老的启动方式（cd memory & python index.py ...）照旧能用，这里只把命令转给 brain/index.py。"""
import runpy
from pathlib import Path

_target = Path(__file__).resolve().parent.parent / "brain" / "index.py"
runpy.run_path(str(_target), run_name="__main__")
