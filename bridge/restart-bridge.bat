@echo off
cd /d E:\qq-bridge
"C:\Program Files\nodejs\node.exe" src/bridge.js >> bridge-run.log 2>> bridge-err.log
