# OpenClaw 安装脚本（简化版：winget/msi 安装 Node，npm 全局装 openclaw）
# 参数通过环境变量传入（由 Tauri 注入）
$InstallDir = if ($env:OPENCLAW_INSTALL_DIR) { $env:OPENCLAW_INSTALL_DIR } else { "C:\OpenClaw" }

# 不使用 Set-StrictMode，避免 $null 属性访问崩溃
$ErrorActionPreference = "Continue"

function Log-Info  { param($msg) Write-Output "[INFO] $msg" }
function Log-OK    { param($msg) Write-Output "[OK] $msg" }
function Log-Warn  { param($msg) Write-Output "[WARN] $msg" }
function Log-Error { param($msg) Write-Output "[ERROR] $msg" }
function Log-Dim   { param($msg) Write-Output "[DIM] $msg" }

# #region agent log
$_dbgLog = "d:\CODE\openclawInstaller\openclaw_installer_windows\.cursor\debug.log"
function Dbg { param($loc,$msg,$data) try { $ts=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); $j=@{location=$loc;message=$msg;data=$data;timestamp=$ts;runId='ps-install';hypothesisId='PS'}|ConvertTo-Json -Compress; Add-Content -Path $_dbgLog -Value $j -Encoding utf8 } catch {} }
Dbg "install.ps1:start" "script started" @{InstallDir=$InstallDir}
# #endregion

# ── 阶段 0: 准备安装目录 ───────────────────────────────────────────────────

Write-Output "[PROGRESS:0/4] 准备安装目录"
Log-Info "准备安装目录: $InstallDir"
try {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    New-Item -ItemType Directory -Force -Path "$InstallDir\data" | Out-Null
    New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
    Log-OK "安装目录已就绪: $InstallDir"
    Dbg "install.ps1:dirs" "directories created OK" @{dir=$InstallDir}
} catch {
    Dbg "install.ps1:dirs-fail" "directory creation FAILED" @{error=$_.ToString()}
    Log-Error "创建目录失败: $_"
    exit 1
}

# 配置 OpenClaw 数据目录（供后续 openclaw 命令读取）
$env:OPENCLAW_CONFIG_PATH = "$InstallDir\data\openclaw.json"
$env:OPENCLAW_HOME = "$InstallDir\data"

# ── 阶段 1: 检测 / 安装 Node.js ─────────────────────────────────────────────

Write-Output "[PROGRESS:1/4] 检测 Node.js 运行时"
Log-Info "正在检测 Node.js..."

function Refresh-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")
}

$nodeOk = $false
$nodeVersion = ""

try {
    $sysNode = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($sysNode) {
        $verOut = & $sysNode.Source --version 2>&1
        if ($verOut -match "v(\d+)\.") {
            $major = [int]$Matches[1]
            if ($major -ge 18) {
                $nodeVersion = $verOut.Trim()
                Log-OK "检测到系统 Node.js $nodeVersion，跳过安装"
                $nodeOk = $true
                Dbg "install.ps1:sys-node" "system node OK" @{version=$nodeVersion}
            } else {
                Log-Warn "系统 Node.js 版本 $verOut 过低（需 >= v18），将安装 LTS"
            }
        }
    } else {
        Log-Info "未检测到 Node.js，将自动安装"
    }
} catch {
    Dbg "install.ps1:sys-node-err" "system node check failed" @{error=$_.ToString()}
    Log-Info "Node.js 检测出错，将自动安装"
}

if (-not $nodeOk) {
    # 尝试 winget 静默安装
    $wingetInstalled = $false
    try {
        $wingetExe = Get-Command winget -ErrorAction SilentlyContinue
        if ($wingetExe) {
            Log-Info "使用 winget 安装 Node.js LTS..."
            Write-Output "[PROGRESS:1/4] 使用 winget 安装 Node.js"
            $wingetProc = Start-Process -FilePath "winget" -ArgumentList @(
                "install", "OpenJS.NodeJS.LTS",
                "--silent", "--accept-package-agreements", "--accept-source-agreements"
            ) -Wait -PassThru -NoNewWindow
            if ($wingetProc.ExitCode -eq 0) {
                Refresh-Path
                Start-Sleep -Seconds 2
                $verOut = & node.exe --version 2>&1
                if ($verOut -match "v(\d+)\." -and [int]$Matches[1] -ge 18) {
                    $nodeVersion = $verOut.Trim()
                    Log-OK "Node.js 安装完成（winget）: $nodeVersion"
                    $wingetInstalled = $true
                    $nodeOk = $true
                    Dbg "install.ps1:winget-ok" "winget install OK" @{version=$nodeVersion}
                }
            }
            if (-not $wingetInstalled) {
                Log-Warn "winget 安装未成功（退出码 $($wingetProc.ExitCode)），尝试 msi 安装"
            }
        }
    } catch {
        Dbg "install.ps1:winget-err" "winget failed" @{error=$_.ToString()}
        Log-Info "winget 不可用，将下载 msi 安装"
    }

    # 降级：下载 msi 并静默安装
    if (-not $nodeOk) {
        Write-Output "[PROGRESS:1/4] 下载并安装 Node.js"
        Log-Info "正在下载 Node.js 安装包（约 30MB）..."
        $msiPath = "$InstallDir\logs\node-v22-x64.msi"
        $urls = @(
            "https://cdn.npmmirror.com/binaries/node/v22.11.0/node-v22.11.0-x64.msi",
            "https://nodejs.org/dist/v22.14.0/node-v22.14.0-x64.msi"
        )
        $downloaded = $false
        foreach ($url in $urls) {
            try {
                [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
                $curlExe = Join-Path $env:SystemRoot "System32\curl.exe"
                if (Test-Path $curlExe) {
                    $curlArgs = @("-sS", "-L", "--retry", "3", "--connect-timeout", "15", "--max-time", "1200", "-o", $msiPath, $url)
                    $curlProc = Start-Process -FilePath $curlExe -ArgumentList $curlArgs -NoNewWindow -PassThru -Wait
                    if ($curlProc.ExitCode -eq 0 -and (Test-Path $msiPath)) {
                        $size = (Get-Item $msiPath -ErrorAction SilentlyContinue).Length
                        if ($size -and $size -gt 1000000) {
                            $downloaded = $true
                            Log-OK "Node.js 安装包下载完成"
                            Dbg "install.ps1:msi-download-ok" "msi downloaded" @{size=$size}
                            break
                        }
                    }
                }
                if (-not $downloaded) {
                    $wc = New-Object System.Net.WebClient
                    $wc.DownloadFile($url, $msiPath)
                    if ((Test-Path $msiPath) -and (Get-Item $msiPath).Length -gt 1000000) {
                        $downloaded = $true
                        Log-OK "Node.js 安装包下载完成"
                        break
                    }
                }
            } catch {
                Log-Warn "下载失败: $url"
            }
        }
        if (-not $downloaded) {
            Log-Error "无法下载 Node.js 安装包，请检查网络或手动从 https://nodejs.org 安装后重试"
            Dbg "install.ps1:msi-download-fail" "msi download failed" @{}
            exit 1
        }
        Log-Info "正在静默安装 Node.js..."
        $msiProc = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", $msiPath, "/quiet", "/qn", "/norestart") -Wait -PassThru -NoNewWindow
        Refresh-Path
        Start-Sleep -Seconds 3
        $verOut = & node.exe --version 2>&1
        if ($verOut -match "v(\d+)\." -and [int]$Matches[1] -ge 18) {
            $nodeVersion = $verOut.Trim()
            Log-OK "Node.js 安装完成: $nodeVersion"
            $nodeOk = $true
            Dbg "install.ps1:msi-install-ok" "msi install OK" @{version=$nodeVersion}
        } else {
            Log-Error "Node.js 安装后仍无法识别，请关闭安装器后重新打开再试"
            exit 1
        }
    }
}

if (-not $nodeOk -or -not $nodeVersion) {
    Log-Error "Node.js 不可用，安装中止"
    exit 1
}

# ── 阶段 2: 安装 OpenClaw CLI（系统全局）────────────────────────────────────

Write-Output "[PROGRESS:2/4] 安装 OpenClaw CLI"
Log-Info "正在安装 openclaw（约 1-3 分钟）..."
Log-Dim "来源: registry.npmmirror.com"

$npmLogOut = "$InstallDir\logs\npm-install.log"
$npmLogErr = "$InstallDir\logs\npm-install-err.log"
try {
    $proc = Start-Process -FilePath "npm.cmd" -ArgumentList @(
        "install", "-g", "openclaw",
        "--registry", "https://registry.npmmirror.com",
        "--no-audit", "--no-fund"
    ) -NoNewWindow -PassThru -Wait -RedirectStandardOutput $npmLogOut -RedirectStandardError $npmLogErr

    if (Test-Path $npmLogOut) {
        Get-Content $npmLogOut | ForEach-Object {
            if ($_ -match "added \d+ package") { Log-OK $_ }
            elseif ($_ -match "warn") { Log-Warn $_ }
            else { Log-Dim $_ }
        }
    }

    $errContent = ""
    $outContent = ""
    if (Test-Path $npmLogErr) { $errContent = [string](Get-Content $npmLogErr -Raw) }
    if (Test-Path $npmLogOut) { $outContent = [string](Get-Content $npmLogOut -Raw) }
    $errLen = if ($errContent) { $errContent.Length } else { 0 }
    $outLen = if ($outContent) { $outContent.Length } else { 0 }
    Dbg "install.ps1:npm-install-done" "npm install finished" @{exitCode=$proc.ExitCode;stderrLen=$errLen;stdoutLen=$outLen}

    if ($proc.ExitCode -ne 0) {
        if (Test-Path $npmLogErr) {
            Get-Content $npmLogErr | ForEach-Object { Log-Error $_ }
        }
        Log-Error "npm install 失败（退出码 $($proc.ExitCode)）"
        exit 1
    }
} catch {
    Dbg "install.ps1:npm-exec-fail" "npm execution FAILED" @{error=$_.ToString()}
    Log-Error "npm 执行失败: $_"
    exit 1
}

# ── 阶段 3: 验证安装 ───────────────────────────────────────────────────────

Write-Output "[PROGRESS:3/4] 验证安装"
Refresh-Path
Log-Info "验证 OpenClaw..."
$ocVer = & openclaw --version 2>&1
if ($LASTEXITCODE -ne 0 -and -not $ocVer) {
    $ocVer = & openclaw.cmd --version 2>&1
}
if ($ocVer) {
    Log-OK "OpenClaw 版本: $($ocVer -join ' ')"
} else {
    Log-Warn "无法读取 openclaw 版本，但继续完成安装"
}

# ── 阶段 4: 写入安装信息 ───────────────────────────────────────────────────

Write-Output "[PROGRESS:4/4] 完成"
$installInfo = @{
    install_dir  = $InstallDir
    port         = 18789
    installed_at = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
} | ConvertTo-Json
$installInfo | Out-File "$InstallDir\install-info.json" -Encoding utf8

Dbg "install.ps1:complete" "install script completed successfully" @{}
Log-OK "OpenClaw 安装完成！"
Write-Output "[RESULT]install_ok"
