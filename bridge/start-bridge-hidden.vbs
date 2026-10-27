' 以「完全隐藏窗口」的方式启动 qq-bridge。
' 为什么需要：从 DSH 里用 Invoke-CimMethod Win32_Process Create 直接起 cmd.exe，
' Windows 会给它分配一个控制台窗口，而 node 在前台阻塞 —— 桌面上就永远挂着一个黑框。
' 这里用 WScript.Shell.Run 的窗口样式 0（隐藏），cmd / node 都继承隐藏控制台。
' 注意：父进程是 wscript.exe（GUI 子系统），不受 DSH 的 Job Object 影响，DSH 退出后 bridge 仍在。
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\qq-bridge"
sh.Run "cmd.exe /c ""E:\qq-bridge\restart-bridge.bat""", 0, False
