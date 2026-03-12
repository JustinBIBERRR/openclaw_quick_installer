# Windows 虚机矩阵与执行 Runbook

本文件用于便携版 `openclaw-installer.exe` 的上线前环境验收。

## 1. 目标

- 在接近真实小白用户的干净环境中验证安装、配置、启动、恢复链路
- 用快照保证每次回归可重复
- 将失败结果与 evidence 脚本输出关联，形成可审计发布结论

## 2. 虚机矩阵（首批）

| VM ID | OS | 用户权限 | 特征 | 必跑 |
| --- | --- | --- | --- | --- |
| Win11Pro-Clean-Admin | Windows 11 Pro | Admin | 干净机基线 | P0 |
| Win11Home-Clean-Std | Windows 11 Home | Standard | 家庭版 + 无 Hyper-V | P0 |
| Win10Pro-Clean-Admin | Windows 10 Pro | Admin | 老版本兼容 | P0 |
| Win10Home-Clean-Std | Windows 10 Home | Standard | 家庭版权限链路 | P1 |
| Win11Pro-ChineseProfile | Windows 11 Pro | Admin | 中文用户名 | P1 |
| Win10Pro-LowResource | Windows 10 Pro | Admin | 低内存/低磁盘 | P1 |

## 3. 快照策略

每台虚机至少保留三个快照：

- `S0-clean-os`: 刚装完系统 + 基础补丁 + 浏览器
- `S1-test-tools`: 仅加入测试执行器与日志上传工具
- `S2-profile-ready-*`: 针对常用 profile 的预热快照（可选）

执行原则：

1. 每轮测试都从 `S1-test-tools` 回滚开始
2. 一个 profile 结束后立即回滚，不在同一状态串跑不相容场景
3. 出现阻断时保留故障现场快照并导出 evidence

## 4. VM 执行流程（便携版）

1) 回滚到 `S1-test-tools`  
2) 拷贝 `openclaw-installer.exe` 到虚机  
3) 在虚机执行 profile 准备脚本  
4) 手工点击流程（或半自动启动）  
5) 运行 evidence 采集与断言脚本  
6) 回传结果 JSON、日志、截图  
7) 回滚快照

参考命令（虚机内）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Prepare-TestProfile.ps1 -Profile CleanNoNode
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Run-PortableInstallerTest.ps1 -ExePath .\openclaw-installer.exe -Profile CleanNoNode
$ev = powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\assert\Collect-LatestEvidence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\assert\Assert-InstallEvidence.ps1 -EvidenceFile $ev
```

## 5. 用例映射

| 类别 | Profile | 推荐 VM |
| --- | --- | --- |
| P0 新装 | `CleanNoNode` | Win11Pro-Clean-Admin, Win10Pro-Clean-Admin |
| P0 无 winget | `NoWinget` | Win11Home-Clean-Std |
| P0 路径限制 | `ChineseInstallDir`, `PathWithSpaces` | Win11Pro-ChineseProfile |
| P1 端口占用 | `PortOccupied18789` | Win10Pro-Clean-Admin |
| P1 配置损坏恢复 | `BrokenOpenclawConfig` | Win11Pro-Clean-Admin |
| P2 非依赖证明 | `WinHomeNoHyperV` | Win10Home-Clean-Std |

## 6. 通过标准

- P0 场景全部通过，或失败已在“阻断清单”登记且版本禁止发布
- 每台 VM 至少产生一份 evidence JSON + 安装日志
- 所有失败都有错误码/提示/日志路径，不允许“黑屏失败”或“无证据失败”

## 7. 阻断判定

直接阻断上线的情况：

- 干净机无法一键完成安装到可启动状态
- 无法给出可操作错误提示（仅失败无下一步）
- 日志无法打开或 evidence 丢失
- 与基线文档冲突但未更新风险说明
