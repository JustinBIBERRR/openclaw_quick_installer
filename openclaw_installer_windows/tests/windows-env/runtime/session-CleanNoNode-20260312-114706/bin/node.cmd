@echo off
if exist "%~dp0node_ready.flag" (
  echo v22.11.0
  exit /b 0
)
if "missing"=="old16" (
  echo v16.20.0
  exit /b 0
)
echo node is not recognized as an internal or external command 1>&2
exit /b 1