' 克劳德姐姐：隐藏窗口启动 sister.mjs（跟 start-bridge-hidden.vbs 同一个办法）
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\qq-bridge\sister"
sh.Run "cmd.exe /c ""E:\qq-bridge\sister\start-sister.bat""", 0, False
