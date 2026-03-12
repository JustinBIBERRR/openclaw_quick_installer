# Windows 边界环境模拟脚本

## 快速开始

1) 准备 profile：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Prepare-TestProfile.ps1 -Profile CleanNoNode
```

2) 执行便携版测试并收集证据：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Run-PortableInstallerTest.ps1 -ExePath .\openclaw-installer.exe -Profile CleanNoNode
```

若需要额外采集前后截图，并自动套用 `tests/windows-env/automation/plans/<Profile>.json`：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Run-PortableInstallerTest.ps1 -ExePath .\openclaw-installer.exe -Profile CleanNoNode -CaptureScreenshot
```

3) 断言最新证据：

```powershell
$ev = powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\assert\Collect-LatestEvidence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\assert\Assert-InstallEvidence.ps1 -EvidenceFile $ev
```

4) 清理模拟环境：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Reset-TestProfile.ps1 -Deep
```

## 手工测试模式

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Start-ManualChecklist.ps1 -Profile NoWinget -ExePath .\openclaw-installer.exe
```

该命令会准备环境并输出手工测试步骤与证据收集命令。
