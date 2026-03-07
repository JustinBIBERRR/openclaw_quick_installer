# OpenClaw 一键安装器

OpenClaw 一键安装器是一个基于 Tauri 的桌面应用程序，用于简化 OpenClaw CLI 工具的安装、配置和管理流程。

## 项目概述

本安装器提供了完整的 OpenClaw 环境搭建解决方案，包括：
- 系统环境检测
- OpenClaw CLI 自动安装
- API 密钥配置
- 飞书机器人配置
- Gateway 服务管理

## 应用流程架构

### 主要视图模式

应用包含三个主要视图：

1. **Loading（加载中）**: 应用启动时的初始化状态
2. **Wizard（安装向导）**: 首次安装或配置不完整时的引导流程
3. **Manager（管理界面）**: 安装完成后的日常管理界面

### 流程决策逻辑

#### 首次进入流程
当用户首次启动应用时，系统会按照以下固定流程引导用户：

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
对于已有部分配置的用户，系统会智能检测配置缺失部分，直接跳转到对应步骤：

- **已完成安装**: 如果检测到 `manifest.phase === "complete"`，直接进入 Manager 界面
- **安装中断**: 如果检测到 `manifest.phase === "installing"`，跳转到步骤2继续安装
- **配置就绪**: 如果检测到已有可用的 OpenClaw 配置，直接进入 Manager 界面
- **其他情况**: 从步骤1开始重新检测

## 详细步骤说明

### 步骤1: 系统预检 (SysCheck)

**目的**: 验证系统环境是否满足安装要求

**检测项目**:
- **OpenClaw 本地配置**: 检查是否已安装 OpenClaw 且配置可用
  - 如果检测到就绪配置，可直接跳转到 Manager
- **管理员权限**: 验证是否具有管理员权限
  - 权限不足时提供一键提权功能
- **内存状态**: 检查系统内存是否充足（推荐 ≥8GB）

**完成条件**: 所有检测项通过，用户选择安装目录

**跳转逻辑**:
- 检测到就绪配置 → 直接进入 Manager
- 检测通过 → 进入步骤2
- 检测失败 → 提供修复建议或手动跳过

### 步骤2: 安装 OpenClaw (Installing)

**目的**: 自动下载并安装 OpenClaw CLI 及其依赖

**安装内容**:
- Node.js 运行环境（如未安装）
- OpenClaw CLI 工具
- 必要的系统依赖

**进度显示**: 实时显示安装日志和进度

**完成条件**: OpenClaw CLI 成功安装并可执行

### 步骤3: 综合配置 (OnboardingSetup)

**目的**: 配置 OpenClaw 的核心参数

**配置项目**:
- **API 提供商配置**:
  - 支持 Anthropic、OpenAI、DeepSeek、自定义提供商
  - API 密钥验证
  - 模型选择
- **飞书机器人配置**（可选）:
  - App ID 和 App Secret
  - 连接测试

**配置模式**:
- **向导模式**: 首次配置时的逐步引导
- **管理模式**: 后续修改配置时的快速编辑

**完成条件**: 至少完成 API 配置或选择跳过

### 步骤4: 启动 Gateway (Launching)

**目的**: 启动 OpenClaw Gateway 服务并验证运行状态

**启动流程**:
1. 应用配置到 OpenClaw
2. 启动 Gateway 服务
3. 验证服务可用性
4. 检测端口占用和服务状态

**完成条件**: Gateway 服务成功启动并响应

## 配置检测机制

### 智能路由逻辑

应用启动时会执行以下检测序列：

```typescript
// 1. 读取本地 manifest 状态
const manifest = await invoke<AppManifest | null>("get_app_state");

// 2. 根据 manifest 状态决定路由
if (manifest && manifest.phase === "complete") {
    // 已完成安装，进入管理界面
    setView("manager");
} else if (manifest && manifest.phase === "installing") {
    // 安装中断，继续安装流程
    setView("wizard");
    setWizardStep("installing");
} else {
    // 首次安装或配置不完整，从系统检测开始
    setView("wizard");
    setWizardStep("syscheck");
}
```

### CLI 能力探测

系统会异步检测 OpenClaw CLI 的功能支持情况：

```typescript
interface CliCapabilities {
    version: string | null;           // CLI 版本
    has_onboarding: boolean;         // 是否支持 onboarding 命令
    has_doctor: boolean;             // 是否支持 doctor 诊断
    has_gateway: boolean;            // 是否支持 gateway 服务
    has_dashboard: boolean;          // 是否支持 dashboard
    onboarding_flags: string[];      // onboarding 支持的参数
    doctor_flags: string[];          // doctor 支持的参数  
    gateway_flags: string[];         // gateway 支持的参数
}
```

## 状态管理

### AppManifest 状态

```typescript
interface AppManifest {
    version: string;                 // 安装器版本
    phase: AppPhase;                // 当前阶段状态
    install_dir: string;            // 安装目录
    gateway_port: number;           // Gateway 端口
    gateway_pid: number | null;     // Gateway 进程ID
    api_provider: string;           // API 提供商
    api_key_configured: boolean;    // API 密钥是否已配置
    api_key_verified: boolean;      // API 密钥是否已验证
    steps_done: string[];           // 已完成的步骤
    last_error: string | null;      // 最后的错误信息
}
```

### 阶段状态定义

```typescript
type AppPhase = 
    | "fresh"        // 全新安装
    | "installing"   // 安装中
    | "complete"     // 安装完成
    | "failed";      // 安装失败
```

## 错误处理和恢复

### 超时处理
- 启动检测超时（5秒）：允许用户手动进入向导
- CLI 能力探测超时（15秒）：不阻塞主流程，后台继续尝试

### 错误恢复
- 安装中断：保存进度状态，重启后可继续
- 配置丢失：重新检测并引导用户补充
- 服务异常：提供诊断工具和修复建议

## 开发和构建

### 技术栈
- **前端**: React + TypeScript + Tailwind CSS
- **后端**: Rust + Tauri
- **构建**: Vite + Tauri CLI

### 项目结构
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

### 构建命令
```bash
# 开发模式
npm run tauri dev

# 构建发布版本
npm run tauri build
```

## 用户体验设计

### 设计原则
1. **渐进式引导**: 复杂配置分步骤完成，降低用户认知负担
2. **智能检测**: 自动识别已有配置，避免重复操作
3. **容错设计**: 提供跳过选项和错误恢复机制
4. **实时反馈**: 安装和配置过程提供详细进度和日志

### 交互特性
- **一键提权**: 自动请求管理员权限
- **配置验证**: 实时验证 API 密钥有效性
- **服务监控**: 实时显示 Gateway 服务状态
- **日志查看**: 提供详细的操作日志和错误信息

## 故障排除

### 常见问题
1. **权限不足**: 使用一键提权功能或手动以管理员身份运行
2. **网络问题**: 检查防火墙设置和网络连接
3. **端口冲突**: Gateway 默认使用 18789 端口，如有冲突会自动寻找可用端口
4. **配置丢失**: 重新运行配置向导

### 诊断工具
- **Doctor 命令**: 自动诊断 OpenClaw 环境问题
- **日志查看**: 查看详细的安装和运行日志
- **状态检测**: 实时监控各组件运行状态

## 版本历史

详见 [CHANGELOG.md](./CHANGELOG.md)

## 许可证

本项目遵循相应的开源许可证，具体信息请查看 LICENSE 文件。