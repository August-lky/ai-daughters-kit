' Start the memory service (memory/service.py) fully hidden.
' Why wscript: a cmd/node/python started straight from DSH gets put in DSH's
' Job Object and dies together with it. wscript.exe is a GUI-subsystem parent,
' so the child survives DSH restarts -- same trick as start-bridge-hidden.vbs.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\qq-bridge\memory"
sh.Run "cmd.exe /c set PYTHONIOENCODING=utf-8& set PYTHONUTF8=1& python service.py > E:\qq-bridge\memory\service.log 2>&1", 0, False
