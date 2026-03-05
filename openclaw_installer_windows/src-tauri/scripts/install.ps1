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

# #region agent log
$_dbgLog = "d:\CODE\openclawInstaller\openclaw_installer_windows\.cursor\debug.log"
function Dbg { param($loc,$msg,$data) try { $ts=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $j=@{location=$loc;message=$msg;data=$data;timestamp=$ts;runId='ps-install';hypothesisId='PS'}|ConvertTo-Json -Compress; Add-Content -Path $_dbgLog -Value $j -Encoding utf8 } catch {} }
Dbg "install.ps1:start" "script started" @{InstallDir=$InstallDir;NodeZipPath=$NodeZipPath;NodeZipExists=($NodeZipPath -and (Test-Path $NodeZipPath))}
# #endregion

# ── 阶段 1: 环境准备 ─────────────────────────────────────────────────────

Log-Info "准备安装目录: $InstallDir"
try {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    New-Item -ItemType Directory -Force -Path "$InstallDir\runtime" | Out-Null
    New-Item -ItemType Directory -Force -Path "$InstallDir\npm-global" | Out-Null
    New-Item -ItemType Directory -Force -Path "$InstallDir\data" | Out-Null
    New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
    # #region agent log
    Dbg "install.ps1:dirs" "directories created OK" @{dir=$InstallDir}
    # #endregion
} catch {
    # #region agent log
    Dbg "install.ps1:dirs-fail" "directory creation FAILED" @{error=$_.ToString()}
    # #endregion
    Log-Error "创建目录失败: $_"
    exit 1
}

# ── 阶段 2: 解压 Node.js ─────────────────────────────────────────────────

$RUNTIME_DIR = "$InstallDir\runtime\node"

if (Test-Path "$RUNTIME_DIR\node.exe") {
    Log-OK "Node.js 已存在，跳过解压"
} else {
    # 若 zip 不存在（portable exe 场景），则自动下载
    if (-not $NodeZipPath -or -not (Test-Path $NodeZipPath)) {
        # #region agent log
        Dbg "install.ps1:download-start" "zip not found, will download" @{NodeZipPath=$NodeZipPath}
        # #endregion
        Log-Info "Node.js 运行时未内置，正在从镜像下载（约 25MB）..."
        $NodeZipPath = "$InstallDir\node-v22-win-x64.zip"

        # 多源降级：npmmirror CDN → npmmirror 镜像 → GitHub Release 自有 CDN → nodejs.org
        $urls = @(
            "https://cdn.npmmirror.com/binaries/node/v22.11.0/node-v22.11.0-win-x64.zip",
            "https://npmmirror.com/mirrors/node/v22.11.0/node-v22.11.0-win-x64.zip",
            "https://github.com/JustinBIBERRR/openclaw_quick_installer/releases/latest/download/node-v22-win-x64.zip",
            "https://nodejs.org/dist/v22.14.0/node-v22.14.0-win-x64.zip"
        )
        $ManualUrl = "https://github.com/JustinBIBERRR/openclaw_quick_installer/releases/latest"

        $downloaded = $false
        foreach ($url in $urls) {
            if ($downloaded) { break }
            Log-Info "尝试下载: $url"

            # 方法 1: curl.exe（Windows 10 自带，SChannel TLS 栈，最可靠）
            try {
                $curlExe = Join-Path $env:SystemRoot "System32\curl.exe"
                if (Test-Path $curlExe) {
                    $curlArgs = @("-sS", "-L", "--retry", "2", "--connect-timeout", "15", "--max-time", "300", "-o", $NodeZipPath, $url)
                    $curlStderr = "$InstallDir\logs\curl-stderr.log"
                    $curlProc = Start-Process -FilePath $curlExe -ArgumentList $curlArgs -NoNewWindow -PassThru -Wait -RedirectStandardError $curlStderr
                    if ($curlProc.ExitCode -eq 0 -and (Test-Path $NodeZipPath) -and (Get-Item $NodeZipPath).Length -gt 1000000) {
                        # #region agent log
                        Dbg "install.ps1:download-curl-ok" "curl download OK" @{url=$url;size=(Get-Item $NodeZipPath).Length}
                        # #endregion
                        Log-OK "Node.js 下载完成（curl）"
                        $downloaded = $true
                        continue
                    } else {
                        $curlErr = if (Test-Path $curlStderr) { (Get-Content $curlStderr -Raw).Substring(0, [Math]::Min(300, (Get-Content $curlStderr -Raw).Length)) } else { "" }
                        if ($curlErr) { Log-Warn "curl: $curlErr" }
                        if (Test-Path $NodeZipPath) { Remove-Item $NodeZipPath -Force -ErrorAction SilentlyContinue }
                        # #region agent log
                        Dbg "install.ps1:download-curl-fail" "curl failed" @{url=$url;exitCode=$curlProc.ExitCode;stderr=$curlErr}
                        # #endregion
                    }
                }
            } catch {
                # #region agent log
                Dbg "install.ps1:download-curl-err" "curl exception" @{error=$_.ToString()}
                # #endregion
            }

            # 方法 2: .NET WebClient（fallback，某些系统 TLS 可能失败）
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                $wc = New-Object System.Net.WebClient
                $wc.DownloadFile($url, $NodeZipPath)
                if ((Test-Path $NodeZipPath) -and (Get-Item $NodeZipPath).Length -gt 1000000) {
                    # #region agent log
                    Dbg "install.ps1:download-wc-ok" "WebClient download OK" @{url=$url;size=(Get-Item $NodeZipPath).Length}
                    # #endregion
                    Log-OK "Node.js 下载完成（WebClient）"
                    $downloaded = $true
                    continue
                }
            } catch {
                # #region agent log
                Dbg "install.ps1:download-wc-fail" "WebClient failed" @{url=$url;error=$_.ToString()}
                # #endregion
                Log-Warn "源不可用: $url"
            }
        }

        # 最终检查：是否有用户预先手动放好的 zip
        if (-not $downloaded -and -not (Test-Path $NodeZipPath)) {
            $altPath = "$InstallDir\node-v22-win-x64.zip"
            $altPath2 = Join-Path ([Environment]::GetFolderPath('UserProfile')) "Downloads\node-v22-win-x64.zip"
            if ((Test-Path $altPath) -and (Get-Item $altPath).Length -gt 1000000) {
                $NodeZipPath = $altPath
                $downloaded = $true
                Log-OK "发现手动放置的 Node.js: $altPath"
            } elseif ((Test-Path $altPath2) -and (Get-Item $altPath2).Length -gt 1000000) {
                $NodeZipPath = $altPath2
                $downloaded = $true
                Log-OK "发现下载目录中的 Node.js: $altPath2"
            }
        }

        if (-not $downloaded) {
            # #region agent log
            Dbg "install.ps1:download-all-fail" "ALL downloads FAILED" @{}
            # #endregion
            Log-Error "所有自动下载源均失败。"
            Log-Error "请手动下载 Node.js 运行时并放到安装目录后重试："
            Log-Error "  1. 用浏览器打开: $ManualUrl"
            Log-Error "  2. 下载 node-v22-win-x64.zip"
            Log-Error "  3. 放到: $InstallDir\"
            Log-Error "  4. 重新运行安装器"
            Write-Output "[MANUAL_DOWNLOAD]$ManualUrl"
            exit 1
        }
    } else {
        # #region agent log
        Dbg "install.ps1:zip-exists" "zip found at path" @{NodeZipPath=$NodeZipPath;size=(Get-Item $NodeZipPath).Length}
        # #endregion
    }

    Log-Info "解压 Node.js v22..."
    Write-Output "[PROGRESS:1/3] 解压 Node.js"

    try {
        Expand-Archive -Path $NodeZipPath -DestinationPath "$InstallDir\runtime" -Force
        $extracted = Get-ChildItem "$InstallDir\runtime" -Directory | Where-Object { $_.Name -like "node-*" } | Select-Object -First 1
        if ($extracted) {
            Rename-Item -Path $extracted.FullName -NewName "node" -Force
        }
        # #region agent log
        Dbg "install.ps1:extract-ok" "Node.js extracted OK" @{nodeExists=(Test-Path "$InstallDir\runtime\node\node.exe")}
        # #endregion
        Log-OK "Node.js 解压完成"
    } catch {
        # #region agent log
        Dbg "install.ps1:extract-fail" "extract FAILED" @{error=$_.ToString()}
        # #endregion
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
try {
    & "$RUNTIME_DIR\npm.cmd" config set registry https://registry.npmmirror.com --prefix "$InstallDir\npm-global" 2>&1 | ForEach-Object { Log-Dim $_ }
    & "$RUNTIME_DIR\npm.cmd" config set strict-ssl false --prefix "$InstallDir\npm-global" 2>&1 | Out-Null
    # #region agent log
    Dbg "install.ps1:npm-config-ok" "npm config done" @{}
    # #endregion
    Log-OK "npm 镜像配置完成"
} catch {
    # #region agent log
    Dbg "install.ps1:npm-config-fail" "npm config FAILED" @{error=$_.ToString()}
    # #endregion
    Log-Warn "npm 配置失败（可忽略）: $_"
}

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

    # #region agent log
    $npmExit = $proc.ExitCode
    $errContent = if (Test-Path "$InstallDir\logs\npm-install-err.log") { Get-Content "$InstallDir\logs\npm-install-err.log" -Raw } else { "" }
    $outContent = if (Test-Path "$InstallDir\logs\npm-install.log") { Get-Content "$InstallDir\logs\npm-install.log" -Raw } else { "" }
    Dbg "install.ps1:npm-install-done" "npm install finished" @{exitCode=$npmExit;stderr=$errContent.Substring(0,[Math]::Min(500,$errContent.Length));stdout=$outContent.Substring(0,[Math]::Min(500,$outContent.Length))}
    # #endregion
    if ($proc.ExitCode -ne 0) {
        if (Test-Path "$InstallDir\logs\npm-install-err.log") {
            Get-Content "$InstallDir\logs\npm-install-err.log" | ForEach-Object { Log-Error $_ }
        }
        Log-Error "npm install 失败（退出码 $($proc.ExitCode)）"
        exit 1
    }
} catch {
    # #region agent log
    Dbg "install.ps1:npm-exec-fail" "npm execution FAILED" @{error=$_.ToString()}
    # #endregion
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

# #region agent log
Dbg "install.ps1:complete" "install script completed successfully" @{}
# #endregion
Log-OK "OpenClaw CLI 安装完成！"
Write-Output "[RESULT]install_ok"
