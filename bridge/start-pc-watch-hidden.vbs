' 隐藏窗口启动 pc-watch.ps1（记录前台窗口）。
' 用 wscript 启动，父进程是 GUI 子系统，不受 DSH 的 Job Object 影响。
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""E:\qq-bridge\pc-watch.ps1""", 0, False
