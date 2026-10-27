#!/usr/bin/env bash
# 重启 DSH + 桥接（+ 加 --edge 时连抖音专用 Edge 一起重开）。不动姐姐、语音服务。
# 2026-10-26：重启前记下她是不是在自动刷抖音，重启完接着开一轮（主人：「重启按理来说应该还是走的自动刷抖音这个流程」）。
# 步骤：等她闲 → 挂维护标记 → 停桥接和 DSH →（--edge）关专用 Edge 和 browser-host → 经 explorer 拉起 DSH（不挂在调用者的进程树下）
#       → 等抖音私信服务 started / start_failed → 拉起桥接 → 等「DSH 已就绪」「SnowLuma 已连接」→ 原来在刷就 /watch/start → 撤维护标记。
# 用法：bash scripts/restart-dsh.sh [--edge | --bridge-only]
#   --bridge-only：只重启桥接（只改了 src/ 时用），DSH 和自动刷都不动。
ROOT=/e/qq-bridge
F=~/.dsh/profiles/tauri/node_modules/dsh-douyin-browser-local/state/chat-events.jsonl
LOG=$ROOT/bridge-run.log
EDGE=0; [ "$1" = "--edge" ] && EDGE=1
if [ "$1" = "--bridge-only" ]; then
  node $ROOT/scripts/wait-fish-idle.mjs 75 900
  node $ROOT/scripts/maintenance.mjs on 10 restart
  OFF=$(stat -c %s "$LOG")
  powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ? { \$_.CommandLine -like '*src/bridge.js*' } | % { Stop-Process -Id \$_.ProcessId -Force }"
  sleep 3
  explorer.exe 'E:\qq-bridge\start-bridge-hidden.vbs'
  for i in $(seq 1 60); do tail -c +$((OFF+1)) "$LOG" | grep -q "DSH 已就绪" && { echo "bridge up"; break; }; sleep 3; done
  for i in $(seq 1 30); do tail -c +$((OFF+1)) "$LOG" | grep -q "SnowLuma 已连接" && { echo "snowluma ok"; break; }; sleep 2; done
  node $ROOT/scripts/maintenance.mjs off
  exit 0
fi

node $ROOT/scripts/wait-fish-idle.mjs 75 900
node $ROOT/scripts/maintenance.mjs on 20 restart
WATCHING=$(node $ROOT/scripts/douyin-watch.mjs running)
echo "自动刷抖音：$WATCHING"
N=$(wc -l < "$F")
OFF=$(stat -c %s "$LOG")
powershell -NoProfile -Command "Get-CimInstance Win32_Process | ? { (\$_.Name -eq 'node.exe' -and (\$_.CommandLine -like '*src/bridge.js*' -or \$_.CommandLine -like '*--port 3080*')) -or \$_.Name -like 'deepseek-harness-desktop*' } | % { Stop-Process -Id \$_.ProcessId -Force }"
sleep 3
if [ $EDGE = 1 ]; then
  powershell -NoProfile -Command "Get-CimInstance Win32_Process | ? { (\$_.Name -eq 'msedge.exe' -and \$_.CommandLine -like '*\\.dsh\\douyin-browser\\*') -or (\$_.Name -eq 'node.exe' -and \$_.CommandLine -like '*dsh-douyin-browser-local*browser-host.mjs*') } | % { Stop-Process -Id \$_.ProcessId -Force -EA SilentlyContinue }"
  sleep 2
fi
explorer.exe 'E:\DSH Tauri\deepseek-harness-desktop.exe'
for i in $(seq 1 80); do
  NEW=$(tail -n +$((N+1)) "$F" | grep -oE '"type":"service\.(started|start_failed)"' | tail -1)
  [ -n "$NEW" ] && break
  sleep 3
done
echo "douyin: ${NEW:-4 分钟没等到}"
explorer.exe 'E:\qq-bridge\start-bridge-hidden.vbs'
for i in $(seq 1 60); do tail -c +$((OFF+1)) "$LOG" | grep -q "DSH 已就绪" && { echo "bridge up"; break; }; sleep 3; done
for i in $(seq 1 30); do tail -c +$((OFF+1)) "$LOG" | grep -q "SnowLuma 已连接" && { echo "snowluma ok"; break; }; sleep 2; done
if [ "$WATCHING" = "yes" ]; then sleep 5; node $ROOT/scripts/douyin-watch.mjs start; fi
node $ROOT/scripts/maintenance.mjs off
