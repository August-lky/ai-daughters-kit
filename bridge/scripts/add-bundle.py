"""把插件注册进 profile 的 bundle 列表。

pnpm add 只装包、不会改 dsh.profile.bundles —— 而 Cordis 只挂 bundle 列表里的东西。
漏了这一步，插件装了也是死的（设置页里根本不会出现）。
"""
import json
import shutil
import sys
from pathlib import Path

PKG = Path(r"C:\Users\admin\.dsh\profiles\tauri\package.json")
targets = sys.argv[1:]
if not targets:
    print("用法: python add-bundle.py <包名> [...]")
    sys.exit(1)

backup = PKG.with_suffix(".json.bak")
shutil.copy2(PKG, backup)
data = json.loads(PKG.read_text(encoding="utf-8"))
bundles = data.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])

added, skipped = [], []
for name in targets:
    if name in bundles:
        skipped.append(name)
    else:
        bundles.append(name)
        added.append(name)

PKG.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print("新增:", added or "（无）")
print("已存在:", skipped or "（无）")
print("当前 bundles:")
for b in bundles:
    print("  -", b)
print("备份:", backup)
