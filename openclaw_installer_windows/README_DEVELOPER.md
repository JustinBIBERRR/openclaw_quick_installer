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
