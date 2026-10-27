# 启动小鲸鱼的全部服务：SnowLuma → qq-bridge → 采集器 / 记忆服务 / 克劳德姐姐
# 由桌面快捷方式调用，运行在 explorer 下，不依附 DSH 的进程组。

$ErrorActionPreference = 'SilentlyContinue'
$node = 'C:\Program Files\nodejs\node.exe'
$script:ok = $true

# 用 netstat 而不是 Get-NetTCPConnection：这台机器上后者会偶发返回空数组，
# 明明端口在监听却判成"没起来"，于是重复拉起第二个进程（bind 失败、日志里一堆 EADDRINUSE）。
function Test-Port([int]$port) {
  $hit = netstat -ano | Select-String -Pattern ":$port\s+.*LISTENING"
  return [bool]$hit
}

function Wait-Port([int]$port, [int]$seconds) {
  for ($i = 0; $i -lt $seconds; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Port $port) { return $true }
  }
  return $false
}

Write-Host '=============================='
Write-Host ' 小鲸鱼服务启动'
Write-Host '=============================='

# ── 0. 等 QQ 客户端（SnowLuma 靠 hook QQ 进程工作） ────────────────────────
if (-not (Get-Process -Name 'QQ' -ErrorAction SilentlyContinue)) {
  Write-Host '[等待] QQ 还没起来，最多等 60 秒 ...'
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    if (Get-Process -Name 'QQ' -ErrorAction SilentlyContinue) { break }
  }
  if (-not (Get-Process -Name 'QQ' -ErrorAction SilentlyContinue)) {
    Write-Host '[启动] QQ 一直没起来，尝试启动 ...'
    Start-Process 'E:\QQ\QQ.exe' -ArgumentList '/background' -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 20
  }
}
if (Get-Process -Name 'QQ' -ErrorAction SilentlyContinue) { Write-Host '[完成] QQ 已在运行' }
else { Write-Host '[警告] QQ 没起来，SnowLuma 可能连不上' }

# ── 1. SnowLuma（QQ 协议端） ───────────────────────────────────────────────
if (Test-Port 3001) {
  Write-Host '[跳过] SnowLuma 已在运行'
} else {
  Write-Host '[启动] SnowLuma ...'
  Start-Process -FilePath $node -ArgumentList 'index.mjs' `
    -WorkingDirectory 'E:\SnowLuma' `
    -RedirectStandardOutput 'E:\SnowLuma\snowluma-run.log' `
    -RedirectStandardError 'E:\SnowLuma\snowluma-err.log' `
    -WindowStyle Hidden
  if (Wait-Port 3001 45) { Write-Host '[完成] SnowLuma 已就绪' }
  else { Write-Host '[失败] SnowLuma 端口 3001 未起来'; $script:ok = $false }
}

# ── 2. qq-bridge（DSH 与 QQ 之间的桥） ─────────────────────────────────────
if (Test-Port 3100) {
  Write-Host '[跳过] qq-bridge 已在运行'
} else {
  $lock = 'E:\qq-bridge\state\bridge.lock'
  if (Test-Path $lock) {
    $lockPid = (Get-Content $lock -Raw).Trim()
    if (-not (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) {
      Remove-Item $lock -Force
      Write-Host '[清理] 发现过期锁文件，已删除'
    }
  }
  Write-Host '[启动] qq-bridge ...'
  Start-Process -FilePath $node -ArgumentList 'src/bridge.js' `
    -WorkingDirectory 'E:\qq-bridge' `
    -RedirectStandardOutput 'E:\qq-bridge\bridge-run.log' `
    -RedirectStandardError 'E:\qq-bridge\bridge-err.log' `
    -WindowStyle Hidden
  if (Wait-Port 3100 45) { Write-Host '[完成] qq-bridge 已就绪' }
  else { Write-Host '[失败] qq-bridge 端口 3100 未起来'; $script:ok = $false }
}

# ── 2.5 电脑活动采集（她"看主人在干嘛"） ──────────────────────────────────
$pcWatch = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*pc-watch.ps1*' }
if ($pcWatch) {
  Write-Host '[跳过] 电脑活动采集器已在运行'
} else {
  Write-Host '[启动] 电脑活动采集器 ...'
  Start-Process -FilePath 'wscript.exe' -ArgumentList '"E:\qq-bridge\start-pc-watch-hidden.vbs"' -WindowStyle Hidden
  Start-Sleep -Seconds 2
  $pcWatch2 = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*pc-watch.ps1*' }
  if ($pcWatch2) { Write-Host '[完成] 采集器已启动' } else { Write-Host '[提示] 采集器没起来，检查 pc-watch.ps1' }
}

# ── 2.6 记忆服务（她的长期记忆索引，常驻） ───────────────────────────────
# 模型只加载一次，本子改了自动重建向量索引。没起来时 memory_recall 会退回
# 旧的 spawn 方式（能查，但每次要等几十秒）。
if (Test-Port 3210) {
  Write-Host '[跳过] 记忆服务已在运行'
} else {
  Write-Host '[启动] 记忆服务 ...'
  Start-Process -FilePath 'wscript.exe' -ArgumentList '"E:\qq-bridge\start-memory-hidden.vbs"' -WindowStyle Hidden
  if (Wait-Port 3210 40) { Write-Host '[完成] 记忆服务已就绪' }
  else { Write-Host '[提示] 记忆服务还在加载模型，稍等（看 memory\service.log）' }
}

# ── 2.65 她们的嗓子（肥鱼 CosyVoice3）：不在开机时启动 ────────────────────
# 2026-10-25 主人：只在她们要发语音时启用、不用就关。src/voice-service.js 用到时拉起，空闲 5 分钟自己退出。

# ── 2.7 克劳德姐姐（另一个 QQ 号上的 Claude，陪她说话） ─────────────────
$sister = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*sister.mjs*' }
if ($sister) {
  Write-Host '[跳过] 克劳德姐姐已在运行'
} else {
  Write-Host '[启动] 克劳德姐姐 ...'
  Start-Process -FilePath 'wscript.exe' -ArgumentList '"E:\qq-bridge\sister\start-sister-hidden.vbs"' -WindowStyle Hidden
}

# 模拟器那一步删了（主人 2026-10-24：安卓模拟器不用了，开机别再拉起来占内存）

Write-Host ''
if ($script:ok) {
  Write-Host '全部就绪。控制台：http://127.0.0.1:3100'
} else {
  Write-Host '有服务没起来，看 E:\SnowLuma\*.log 或 E:\qq-bridge\*.log'
}
Write-Host ''
Write-Host '（本窗口 5 秒后自动关闭）'
Start-Sleep -Seconds 5
