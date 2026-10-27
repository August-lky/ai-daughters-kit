' Start 小鲸鱼's voice (E:\voice-feiyu\feiyu_tts_server.py, port 9881) fully hidden.
' Same wscript trick as start-memory-hidden.vbs: survives DSH restarts.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\voice-feiyu"
sh.Run "cmd.exe /c set PYTHONIOENCODING=utf-8& set PYTHONUTF8=1& E:\voice-feiyu\env311\Scripts\python.exe feiyu_tts_server.py > E:\voice-feiyu\service.log 2>&1", 0, False
