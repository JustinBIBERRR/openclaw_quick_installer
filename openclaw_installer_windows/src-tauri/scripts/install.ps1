# OpenClaw 安装脚本
# 参数通过环境变量传入（由 Tauri 注入）
$InstallDir  = if ($env:OPENCLAW_INSTALL_DIR) { $env:OPENCLAW_INSTALL_DIR } else { "C:\OpenClaw" }
$NodeZipPath = if ($env:NODE_ZIP_PATH)        { $env:NODE_ZIP_PATH }        else { "" }

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Log-Info  { param($msg) Write-Output "[INFO] $msg" }
function Log-OK    { param($msg) Write-Output "[OK] $msg" }
function Log-Warn  { param($msg) Write-Output "[WARN] $msg" }
function Log-Error { param($msg) Write-Output "[ERROR] $msg" }
function Log-Dim   { param($msg) Write-Output "[DIM] $msg" }

# ── 阶段 1: 环境准备 ─────────────────────────────────────────────────────

Log-Info "准备安装目录: $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\runtime" | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\npm-global" | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\data" | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null

# ── 阶段 2: 解压 Node.js ─────────────────────────────────────────────────

$RUNTIME_DIR = "$InstallDir\runtime\node"

if (Test-Path "$RUNTIME_DIR\node.exe") {
    Log-OK "Node.js 已存在，跳过解压"
} else {
    # 若 zip 不存在（portable exe 场景），则自动下载
    if (-not $NodeZipPath -or -not (Test-Path $NodeZipPath)) {
        Log-Info "Node.js 运行时未内置，正在从镜像下载（约 25MB）..."
        $NodeZipPath = "$InstallDir\node-v22-win-x64.zip"
        $NodeUrl = "https://npmmirror.com/mirrors/node/v22.11.0/node-v22.11.0-win-x64.zip"
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            $wc = New-Object System.Net.WebClient
            $wc.DownloadFile($NodeUrl, $NodeZipPath)
            Log-OK "Node.js 下载完成: $NodeZipPath"
        } catch {
            # 备用镜像 nodejs.org
            Log-Warn "主镜像下载失败，尝试 nodejs.org 备用源..."
            try {
                $FallbackUrl = "https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip"
                $wc.DownloadFile($FallbackUrl, $NodeZipPath)
                Log-OK "Node.js 下载完成（备用源）: $NodeZipPath"
            } catch {
                Log-Error "Node.js 下载失败，请检查网络后重试: $_"
                exit 1
            }
        }
    }

    Log-Info "解压 Node.js v22..."
    Write-Output "[PROGRESS:1/3] 解压 Node.js"

    try {
        Expand-Archive -Path $NodeZipPath -DestinationPath "$InstallDir\runtime" -Force
        # 重命名顶层目录为 node
        $extracted = Get-ChildItem "$InstallDir\runtime" -Directory | Where-Object { $_.Name -like "node-*" } | Select-Object -First 1
        if ($extracted) {
            Rename-Item -Path $extracted.FullName -NewName "node" -Force
        }
        Log-OK "Node.js 解压完成"
    } catch {
        Log-Error "解压失败: $_"
        exit 1
    }
}

# 验证 node.exe 可用
if (-not (Test-Path "$RUNTIME_DIR\node.exe")) {
    Log-Error "node.exe 未找到，解压可能失败"
    exit 1
}

$nodeVersion = & "$RUNTIME_DIR\node.exe" --version 2>&1
Log-OK "Node.js 版本: $nodeVersion"

# ── 阶段 3: 系统环境优化 ─────────────────────────────────────────────────

Write-Output "[PROGRESS:2/3] 优化系统环境"
Log-Info "配置系统环境..."

# 开启 Windows 长路径支持
try {
    Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
        -Name "LongPathsEnabled" -Value 1 -Type DWord -ErrorAction SilentlyContinue
    Log-OK "Windows 长路径支持已开启"
} catch {
    Log-Warn "无法修改注册表（长路径），继续安装"
}

# 将安装目录加入 Windows Defender 排除列表（防止 node.exe 被误删）
try {
    Add-MpPreference -ExclusionPath $InstallDir -ErrorAction SilentlyContinue
    Log-OK "已将安装目录加入 Defender 排除列表"
} catch {
    Log-Warn "无法配置 Defender 排除项（可忽略）"
}

# 进程级 PATH 注入（不污染系统环境变量）
$env:PATH = "$RUNTIME_DIR;$InstallDir\npm-global\bin;$env:PATH"
$env:NPM_CONFIG_PREFIX = "$InstallDir\npm-global"
$env:OPENCLAW_CONFIG_PATH = "$InstallDir\data\openclaw.json"

# 配置 npm 镜像（国内加速）
Log-Info "配置 npm 镜像（npmmirror）..."
& "$RUNTIME_DIR\npm.cmd" config set registry https://registry.npmmirror.com --prefix "$InstallDir\npm-global" 2>&1 | ForEach-Object { Log-Dim $_ }
& "$RUNTIME_DIR\npm.cmd" config set strict-ssl false --prefix "$InstallDir\npm-global" 2>&1 | Out-Null
Log-OK "npm 镜像配置完成"

# ── 阶段 4: 安装 OpenClaw CLI ────────────────────────────────────────────

Write-Output "[PROGRESS:3/3] 安装 OpenClaw CLI"
Log-Info "正在安装 openclaw（约 1-3 分钟）..."
Log-Dim "来源: registry.npmmirror.com"

$npmArgs = @(
    "install", "-g", "openclaw",
    "--prefix", "$InstallDir\npm-global",
    "--registry", "https://registry.npmmirror.com",
    "--no-audit", "--no-fund"
)

try {
    $proc = Start-Process -FilePath "$RUNTIME_DIR\npm.cmd" `
        -ArgumentList $npmArgs `
        -NoNewWindow -PassThru -Wait `
        -RedirectStandardOutput "$InstallDir\logs\npm-install.log" `
        -RedirectStandardError "$InstallDir\logs\npm-install-err.log"

    # 流式输出日志
    if (Test-Path "$InstallDir\logs\npm-install.log") {
        Get-Content "$InstallDir\logs\npm-install.log" | ForEach-Object {
            if ($_ -match "added \d+ package") { Log-OK $_ }
            elseif ($_ -match "warn") { Log-Warn $_ }
            else { Log-Dim $_ }
        }
    }

    if ($proc.ExitCode -ne 0) {
        # 显示错误日志
        if (Test-Path "$InstallDir\logs\npm-install-err.log") {
            Get-Content "$InstallDir\logs\npm-install-err.log" | ForEach-Object { Log-Error $_ }
        }
        Log-Error "npm install 失败（退出码 $($proc.ExitCode)）"
        exit 1
    }
} catch {
    Log-Error "npm 执行失败: $_"
    exit 1
}

# 验证安装
$ocCmd = "$InstallDir\npm-global\bin\openclaw.cmd"
if (-not (Test-Path $ocCmd)) {
    # 兼容 npm v7+ 的路径
    $ocCmd = "$InstallDir\npm-global\openclaw.cmd"
}
if (-not (Test-Path $ocCmd)) {
    Log-Error "openclaw 命令未找到，安装可能不完整"
    exit 1
}

$ocVersion = & "$RUNTIME_DIR\node.exe" "$InstallDir\npm-global\lib\node_modules\openclaw\bin\openclaw.js" --version 2>&1
Log-OK "OpenClaw 版本: $ocVersion"

# 写入安装信息
$installInfo = @{
    oc_cmd       = $ocCmd
    node_dir     = $RUNTIME_DIR
    npm_bin      = "$InstallDir\npm-global\bin"
    installed_at = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
} | ConvertTo-Json
$installInfo | Out-File "$InstallDir\install-info.json" -Encoding utf8

Log-OK "OpenClaw CLI 安装完成！"
Write-Output "[RESULT]install_ok"
