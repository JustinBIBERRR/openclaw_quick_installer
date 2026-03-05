# OpenClaw Quick Installer for Windows

> 针对 Windows 用户的 OpenClaw **一键图形化安装器** —— 下载 `.exe`，双击，完成。

[![Platform: Windows](https://img.shields.io/badge/Platform-Windows%2010%2F11-blue.svg)]()
[![Built with Tauri](https://img.shields.io/badge/Built%20with-Tauri%202.0-orange.svg)](https://tauri.app)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## 👤 我是普通用户

### 只需 3 步

**第 1 步**：前往 [Releases 页面](https://github.com/JustinBIBERRR/openclaw_quick_installer/releases) 下载最新的 `OpenClaw-Installer.exe`

**第 2 步**：双击运行（如弹出 Windows 安全提示，点击"仍要运行"）

**第 3 步**：按照安装向导操作

```
① 系统预检    → 自动检测，全绿后点"开始安装"
② 安装程序    → 自动完成，约 1-3 分钟
③ 配置 AI Key → 选择服务商，填入 API Key（或跳过稍后配置）
④ 启动        → 自动打开浏览器，进入 OpenClaw 聊天界面 🎉
```

> **系统要求**：Windows 10/11 64位，2GB 以上可用磁盘空间，网络连接
>
> **无需安装**：Node.js、Python、Git、任何运行时 —— 安装器已全部内置

---

## 🛠️ 我是开发者 / 想自己编译

> 以下内容仅面向想修改代码或自行构建 exe 的开发者。普通用户无需关注。

### 技术架构

| 层 | 技术 | 说明 |
|----|------|------|
| 桌面框架 | Tauri 2.0 | Rust 后端 + 系统 WebView2，产物约 5MB |
| 前端 | React 18 + TypeScript + TailwindCSS | 安装向导 UI |
| 安装逻辑 | PowerShell 5.1+ | 系统检测、Node.js 解压、npm 安装 |
| 内置运行时 | Node.js v22 便携版（zip 内嵌） | 用户无需预装 Node |
| 打包 | NSIS | 生成标准 Windows 安装包 |

### 开发者前置条件

在编译前，你的电脑需要：

- **Node.js 18+**（[下载](https://nodejs.org)）
- **Rust stable**（[安装说明](https://rustup.rs)）
- **VS Build Tools 2022**，勾选"使用 C++ 的桌面开发"（[下载](https://visualstudio.microsoft.com/downloads/#build-tools-for-visual-studio-2022)）
- **WebView2 Runtime**（Windows 11 内置，Windows 10 需[手动安装](https://go.microsoft.com/fwlink/p/?LinkId=2124703)）

### 快速预览 UI（无需 Rust）

不想安装 Rust，只想看 UI 效果：

```bash
git clone https://github.com/JustinBIBERRR/openclaw_quick_installer.git
cd openclaw_quick_installer/openclaw_installer_windows
npm install
npm run dev
# 浏览器打开 http://localhost:1420
```

浏览器模式下所有后端操作均为 Mock，可完整走通 4 步向导。

### 准备内置 Node.js 资源

```powershell
cd openclaw_installer_windows

# 下载 Node.js v22 便携版（国内镜像）
Invoke-WebRequest `
  -Uri "https://npmmirror.com/mirrors/node/v22.11.0/node-v22.11.0-win-x64.zip" `
  -OutFile "src-tauri/resources/node-v22-win-x64.zip"
```

### 本地开发（Tauri 原生窗口）

```powershell
cd openclaw_installer_windows
npm install
npm run tauri dev   # 或 make dev
```

首次编译 Rust 约 5-10 分钟，之后热重载很快。

### 构建发布版 exe

```powershell
# NSIS 安装包（推荐）
make build
# → src-tauri/target/release/bundle/nsis/OpenClaw Installer_1.0.0_x64-setup.exe

# 单文件便携 exe
make build-portable
# → src-tauri/target/release/OpenClaw Installer.exe
```

### 项目结构

```
openclaw_installer_windows/
├── src/                    # React 前端
│   ├── App.tsx             # 主路由 + 全局状态
│   ├── pages/
│   │   ├── SysCheck.tsx    # 步骤1：系统预检
│   │   ├── Installing.tsx  # 步骤2：安装 CLI
│   │   ├── ApiKeySetup.tsx # 步骤3：配置 AI Key
│   │   ├── Launching.tsx   # 步骤4：启动 Gateway
│   │   └── Manager.tsx     # 安装后管理界面
│   └── components/         # TitleBar, StepBar, LogScroller, StatusDot
├── src-tauri/
│   ├── src/
│   │   ├── commands.rs     # 所有 Tauri 后端命令
│   │   └── lib.rs          # 应用初始化
│   ├── scripts/
│   │   ├── syscheck.ps1    # 系统预检脚本
│   │   ├── install.ps1     # 安装逻辑脚本
│   │   └── gateway.ps1     # Gateway 管理脚本
│   └── resources/
│       └── node-v22-win-x64.zip  # 内置 Node.js（需手动下载）
└── Makefile
```

---

## 常见问题

**Q：下载 exe 后 Windows Defender 报毒怎么办？**

Tauri 构建的 exe 未签名，SmartScreen 会弹出警告。点击"更多信息"→"仍要运行"即可。如需彻底消除警告需购买代码签名证书。

**Q：安装到哪个目录？**

默认 `C:\OpenClaw`，安装时可自定义（建议纯英文路径，不含空格和中文）。

**Q：如何完全卸载？**

打开安装器（或在 Manager 界面）点击"卸载 OpenClaw"，删除 `C:\OpenClaw` 目录及所有配置即可。

**Q：支持哪些 AI 服务商？**

Anthropic Claude、OpenAI GPT、DeepSeek、以及任意 OpenAI 兼容的自定义接口。

**Q：国内安装 npm 包很慢？**

安装器已自动切换 `registry.npmmirror.com` 镜像，无需手动配置。

---

## License

MIT
