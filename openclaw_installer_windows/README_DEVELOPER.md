# OpenClaw 一键安装器 — 开发者文档

本文档面向参与开发、构建或扩展本安装器的开发者。用户向说明请查看 [README.md](./README.md)。

## 技术栈

- **前端**: React + TypeScript + Tailwind CSS
- **后端**: Rust + Tauri
- **构建**: Vite + Tauri CLI

## 项目结构

```
src/
├── components/          # 可复用组件
│   ├── TitleBar.tsx    # 标题栏
│   ├── StepBar.tsx     # 步骤指示器
│   └── UnifiedConfigPanel.tsx  # 统一配置面板
├── pages/              # 页面组件
│   ├── SysCheck.tsx    # 系统检测页面
│   ├── Installing.tsx  # 安装页面
│   ├── OnboardingSetup.tsx  # 配置页面
│   ├── Launching.tsx   # 启动页面
│   └── Manager.tsx     # 管理页面
├── utils/              # 工具函数
└── types.ts            # 类型定义
```

## 构建与运行

```bash
# 开发模式
npm run tauri dev

# 构建发布版本
npm run tauri build
```

## 测试命令

```bash
# 前端单元测试（Vitest）
npm run test:ui

# Rust 单元测试
npm run test:rust

# PowerShell/Pester 安装脚本测试
npm run test:ps

# 一键执行全部快速回归
npm test
```

## 极端环境模拟（手工测试辅助）

```powershell
# 准备测试画像
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Prepare-TestProfile.ps1 -Profile CleanNoNode

# 执行便携版并采集证据
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Run-PortableInstallerTest.ps1 -ExePath .\openclaw-installer.exe -Profile CleanNoNode

# 断言最新证据
$ev = powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\assert\Collect-LatestEvidence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\assert\Assert-InstallEvidence.ps1 -EvidenceFile $ev

# 清理
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Reset-TestProfile.ps1 -Deep
```

## 测试边界

当前这套“Windows 极端环境测试”主要覆盖便携版 `openclaw-installer.exe` 的安装、配置、启动与恢复链路，重点验证：

- 全新干净机：无 Node、无 OpenClaw、无 `~/.openclaw`
- 缺少 `winget`、Node 版本过低、npm 全局安装失败
- 中文用户名、中文安装目录、空格路径
- 无 Git / Bash / Docker / Hyper-V 的普通 Windows 环境
- 端口 `18789` 被占用、配置损坏、恢复链路

当前明确 **不属于主链路硬依赖** 的环境项：

- Docker
- Git
- Bash
- Hyper-V

它们的测试目标是“证明不需要这些东西也能安装”，而不是依赖它们完成安装。

当前已知阻断/限制也需要被明确记录：

- `NoWinget`：当前安装脚本没有 MSI 自动降级链路，缺少 `winget` 会直接失败
- 中文路径 / 空格路径：当前实现会主动判定为不合法，不是“应当通过”的场景
- npm 全局安装权限异常：会直接阻断安装
- PATH 刷新与 `openclaw.cmd` 发现：安装后立即验证阶段仍有误判风险

更完整的基线风险说明请看：

- [docs/testing/windows-extreme-risk-baseline.md](./docs/testing/windows-extreme-risk-baseline.md)
- [docs/testing/windows-vm-matrix.md](./docs/testing/windows-vm-matrix.md)
- [tests/windows-env/README.md](./tests/windows-env/README.md)

## 手动测试命令

下面命令是给测试人员直接复制执行的最小手册。

### 1. 准备某个边界环境

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Prepare-TestProfile.ps1 -Profile CleanNoNode
```

常用 profile：

- `CleanNoNode`
- `NoWinget`
- `NodeOldVersion16`
- `NpmGlobalInstallDenied`
- `PathRefreshFailed`
- `ChineseUserProfile`
- `ChineseInstallDir`
- `PathWithSpaces`
- `PortOccupied18789`
- `BrokenOpenclawConfig`
- `NetworkRestricted`
- `WinHomeNoHyperV`

### 2. 启动手工测试辅助说明

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Start-ManualChecklist.ps1 -Profile NoWinget -ExePath .\openclaw-installer.exe
```

### 3. 执行便携版并采集证据

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Run-PortableInstallerTest.ps1 -ExePath .\openclaw-installer.exe -Profile CleanNoNode
```

### 4. 断言最新证据

```powershell
$ev = powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\assert\Collect-LatestEvidence.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\assert\Assert-InstallEvidence.ps1 -EvidenceFile $ev
```

### 5. 清理测试环境

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Reset-TestProfile.ps1 -Deep
```

### 6. 推荐首轮必跑顺序

```powershell
# 1) 干净机新装
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Prepare-TestProfile.ps1 -Profile CleanNoNode

# 2) 无 winget 阻断
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Prepare-TestProfile.ps1 -Profile NoWinget

# 3) 中文路径限制
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Prepare-TestProfile.ps1 -Profile ChineseInstallDir

# 4) 空格路径限制
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Prepare-TestProfile.ps1 -Profile PathWithSpaces

# 5) 配置损坏恢复
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\windows-env\scripts\Prepare-TestProfile.ps1 -Profile BrokenOpenclawConfig
```

## 应用流程架构

### 主要视图模式

- **Loading（加载中）**: 应用启动时的初始化状态
- **Wizard（安装向导）**: 首次安装或配置不完整时的引导流程
- **Manager（管理界面）**: 安装完成后的日常管理界面

### 流程决策逻辑

#### 首次进入流程

```
步骤1: 系统预检 (SysCheck)
    ↓
步骤2: 安装 OpenClaw (Installing)
    ↓
步骤3: 综合配置 (OnboardingSetup)
    ↓
步骤4: 启动 Gateway (Launching)
    ↓
管理界面 (Manager)
```

#### 非首次进入流程

- **已完成安装**: `manifest.phase === "complete"` → 直接进入 Manager
- **安装中断**: `manifest.phase === "installing"` → 跳转到步骤2继续安装
- **配置就绪**: 已有可用 OpenClaw 配置 → 直接进入 Manager
- **其他情况**: 从步骤1 (SysCheck) 开始

## 配置检测机制

### 智能路由逻辑

启动时根据本地 manifest 决定初始视图与步骤：

```typescript
// 1. 读取本地 manifest 状态
const manifest = await invoke<AppManifest | null>("get_app_state");

// 2. 根据 manifest 状态决定路由
if (manifest && manifest.phase === "complete") {
    setView("manager");
} else if (manifest && manifest.phase === "installing") {
    setView("wizard");
    setWizardStep("installing");
} else {
    setView("wizard");
    setWizardStep("syscheck");
}
```

### CLI 能力探测

异步检测 OpenClaw CLI 支持的能力与参数：

```typescript
interface CliCapabilities {
    version: string | null;
    has_onboarding: boolean;
    has_doctor: boolean;
    has_gateway: boolean;
    has_dashboard: boolean;
    onboarding_flags: string[];
    doctor_flags: string[];
    gateway_flags: string[];
}
```

## 状态管理

### AppManifest

```typescript
interface AppManifest {
    version: string;
    phase: AppPhase;
    install_dir: string;
    gateway_port: number;
    gateway_pid: number | null;
    api_provider: string;
    api_key_configured: boolean;
    api_key_verified: boolean;
    steps_done: string[];
    last_error: string | null;
}
```

### AppPhase

```typescript
type AppPhase =
    | "fresh"        // 全新安装
    | "installing"   // 安装中
    | "complete"     // 安装完成
    | "failed";      // 安装失败
```

## 错误处理与恢复

### 超时

- 启动检测超时（5 秒）：允许用户手动进入向导
- CLI 能力探测超时（15 秒）：不阻塞主流程，后台继续尝试

### 恢复策略

- 安装中断：保存进度，重启后可继续
- 配置丢失：重新检测并引导补充
- 服务异常：提供诊断与修复入口

## 用户体验设计

### 设计原则

1. **渐进式引导**: 分步骤完成配置，降低认知负担
2. **智能检测**: 识别已有配置，避免重复操作
3. **容错**: 支持跳过与错误恢复
4. **实时反馈**: 安装与配置过程提供进度与日志

### 交互特性

- 一键提权、配置验证、服务监控、日志查看等见 [README.md](./README.md) 用户向描述。

## 版本历史

详见 [CHANGELOG.md](./CHANGELOG.md)。
