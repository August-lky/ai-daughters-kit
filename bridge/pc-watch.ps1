# pc-watch.ps1 -- record the foreground window every N seconds.
# ASCII-only on purpose: powershell.exe 5.1 mis-parses UTF-8-without-BOM.
# Filtering (including Chinese keywords) happens on the MCP read side, not here.
$ErrorActionPreference = 'SilentlyContinue'

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PcWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
}
"@

$log = 'E:\qq-bridge\state\pc-activity.jsonl'
$intervalSec = 15
$maxLines = 2000

# -- clock correction ---------------------------------------------------
# The host clock runs ~180 minutes ahead of real time (timezone is Pacific
# Standard Time and the account is not admin, so it cannot be fixed at the
# OS level). Every timestamp written here MUST be real UTC: readers
# (pc_activity, bridge) parse it and convert to Asia/Shanghai. If we wrote
# the raw host clock, "now" would land 3 hours in the future and the model
# would think the owner is still at the computer at 4am.
# Measure against an HTTP Date header at startup, then re-measure every
# 30 minutes in case the clock drifts or someone finally fixes it.
$script:skewSec = 0
function Measure-Skew {
  foreach ($url in @('https://www.baidu.com', 'https://www.qq.com')) {
    try {
      $r = Invoke-WebRequest -Uri $url -Method Head -TimeoutSec 10 -UseBasicParsing
      $serverUtc = [datetime]::Parse($r.Headers['Date']).ToUniversalTime()
      $script:skewSec = [int]((Get-Date).ToUniversalTime() - $serverUtc).TotalSeconds
      return $true
    } catch { }
  }
  return $false
}
$null = Measure-Skew

# -- now playing (2026-10-24) -------------------------------------------
# Windows media session (SMTC): NetEase Cloud Music, QQ Music, Spotify, music
# sites in a browser... Only real music is kept: it must have an artist, it
# must be playing, and her own browsers (cliprofile = Douyin window, and the
# playwright profile) are skipped. Read-only; no debug port on any app.
$script:smtcOk = $false
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq "AsTask" -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $script:smtcOk = $true
} catch { }
function Await-Op($op, [type]$t) { $task = $script:asTask.MakeGenericMethod($t).Invoke($null, @($op)); if ($task.Wait(2000)) { return $task.Result }; return $null }
function Get-NowPlaying {
  if (-not $script:smtcOk) { return $null }
  try {
    $mgr = Await-Op ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    if (-not $mgr) { return $null }
    foreach ($s in $mgr.GetSessions()) {
      $app = [string]$s.SourceAppUserModelId
      if ($app -match "cliprofile|browser-profile|playwright") { continue }
      if ([string]$s.GetPlaybackInfo().PlaybackStatus -ne "Playing") { continue }
      $p = Await-Op ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      if (-not $p -or -not $p.Artist -or -not $p.Title) { continue }
      return [ordered]@{ title = [string]$p.Title; artist = [string]$p.Artist; app = $app }
    }
  } catch { }
  return $null
}

$dir = Split-Path $log -Parent
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$tick = 0
while ($true) {
  try {
    $h = [PcWin]::GetForegroundWindow()
    $sb = New-Object System.Text.StringBuilder 512
    [PcWin]::GetWindowText($h, $sb, 512) | Out-Null
    $title = $sb.ToString()
    $procId = 0
    [PcWin]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $proc = ''
    if ($procId -gt 0) {
      $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($p) { $proc = $p.ProcessName }
    }

    $nowUtc = (Get-Date).ToUniversalTime().AddSeconds(-$script:skewSec)
    $rec = [ordered]@{
      t = $nowUtc.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      p = $proc
      w = $title
    }
    if ($tick % 2 -eq 0) { $np = Get-NowPlaying; if ($np) { $rec.m = $np } }
    ($rec | ConvertTo-Json -Compress) | Add-Content -Path $log -Encoding UTF8

    $tick++
    if ($tick % 120 -eq 0) { $null = Measure-Skew }
    if ($tick % 240 -eq 0) {
      $lines = Get-Content -Path $log -ErrorAction SilentlyContinue
      if ($lines -and $lines.Count -gt $maxLines) {
        $lines | Select-Object -Last $maxLines | Set-Content -Path $log -Encoding UTF8
      }
    }
  } catch {
    # keep looping
  }
  Start-Sleep -Seconds $intervalSec
}
