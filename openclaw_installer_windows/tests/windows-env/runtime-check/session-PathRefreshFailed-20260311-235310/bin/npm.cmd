@echo off
set args=%*
echo %args% | findstr /I "config get prefix" >nul
if %errorlevel%==0 (
  echo D:\CODE\openclawInstaller\openclaw_installer_windows\tests\windows-env\runtime-check\session-PathRefreshFailed-20260311-235310\profile\CustomNpmPrefix
  exit /b 0
)
echo %args% | findstr /I "install -g openclaw@latest" >nul
if %errorlevel%==0 (
  if "prefix_mismatch"=="permission_denied" (
    echo npm ERR! code EPERM 1>&2
    exit /b 2
  )
  if "prefix_mismatch"=="network_error" (
    echo npm ERR! network request failed 1>&2
    exit /b 3
  )
  if not exist "D:\CODE\openclawInstaller\openclaw_installer_windows\tests\windows-env\runtime-check\session-PathRefreshFailed-20260311-235310\profile\CustomNpmPrefix" mkdir "D:\CODE\openclawInstaller\openclaw_installer_windows\tests\windows-env\runtime-check\session-PathRefreshFailed-20260311-235310\profile\CustomNpmPrefix"
  > "D:\CODE\openclawInstaller\openclaw_installer_windows\tests\windows-env\runtime-check\session-PathRefreshFailed-20260311-235310\profile\CustomNpmPrefix\openclaw.cmd" echo @echo off
  >> "D:\CODE\openclawInstaller\openclaw_installer_windows\tests\windows-env\runtime-check\session-PathRefreshFailed-20260311-235310\profile\CustomNpmPrefix\openclaw.cmd" echo if "%%1"=="--version" echo openclaw 9.9.9
  >> "D:\CODE\openclawInstaller\openclaw_installer_windows\tests\windows-env\runtime-check\session-PathRefreshFailed-20260311-235310\profile\CustomNpmPrefix\openclaw.cmd" echo exit /b 0
  echo added 1 package
  exit /b 0
)
echo npm stub executed
exit /b 0