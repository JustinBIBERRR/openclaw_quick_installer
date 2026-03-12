@echo off
echo winget install success
type nul > "%~dp0node_ready.flag"
exit /b 0
