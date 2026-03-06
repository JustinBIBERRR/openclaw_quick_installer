$ErrorActionPreference = "Continue"

$ResultFile = $env:OPENCLAW_RESULT_FILE
$InstallDir = if ($env:OPENCLAW_INSTALL_DIR) { $env:OPENCLAW_INSTALL_DIR } else { "$env:USERPROFILE\OpenClaw" }

# ── 日志工具 ──────────────────────────────────────────────────────────────────
$_logDir  = "$InstallDir\logs"
$_logFile = "$_logDir\install-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
$_t0      = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function Write-Log {
    param([string]$Level, [string]$Msg)
    $ts  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $elapsed = [math]::Round(($ts - $_t0) / 1000, 1)
    $line = "[{0:s}Z +{1}s] [{2}] {3}" -f [datetime]::UtcNow, $elapsed, $Level.ToUpper(), $Msg
    try {
        if (-not (Test-Path $_logDir)) { New-Item -ItemType Directory -Force -Path $_logDir | Out-Null }
        Add-Content -Path $_logFile -Value $line -Encoding utf8
    } catch {}
    switch ($Level.ToLower()) {
        "ok"    { Write-Host "[OK]    $Msg" -ForegroundColor Green }
        "warn"  { Write-Host "[WARN]  $Msg" -ForegroundColor Yellow }
        "error" { Write-Host "[ERROR] $Msg" -ForegroundColor Red }
        "step"  { Write-Host "`n=== $Msg ===" -ForegroundColor Cyan }
        default { Write-Host "[INFO]  $Msg" }
    }
}

function Step {
    param($n, $msg)
    Write-Log "step" "[$n] $msg"
}

function LogOk   { param($msg) Write-Log "ok"    $msg }
function LogInfo { param($msg) Write-Log "info"  $msg }
function LogWarn { param($msg) Write-Log "warn"  $msg }

function Fail {
    param($msg)
    Write-Log "error" $msg
    if ($ResultFile) {
        [System.IO.File]::WriteAllText($ResultFile, "error:$msg", [System.Text.Encoding]::ASCII)
    }
    Write-Host ""
    Write-Host "安装失败，窗口将在 10 秒后关闭。如需查看完整日志请前往：" -ForegroundColor Yellow
    Write-Host "  $_logFile" -ForegroundColor Gray
    Start-Sleep -Seconds 10
    exit 1
}

function Update-Path {
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("PATH", "User")
}

# ── 启动记录 ──────────────────────────────────────────────────────────────────
Write-Log "info" "OpenClaw 安装脚本启动 | InstallDir=$InstallDir | ResultFile=$ResultFile"

try {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    New-Item -ItemType Directory -Force -Path $_logDir   | Out-Null
} catch {
    Fail "创建安装目录失败: $_"
}

# ── 阶段 1: 检测 Node.js ──────────────────────────────────────────────────────
Step "1/3" "检测 Node.js 运行时"
$_t1 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$nodeReady = $false
try {
    $nodeVersion = & node --version 2>&1
    if ($LASTEXITCODE -eq 0 -and $nodeVersion -match "v(\d+)\." -and [int]$Matches[1] -ge 18) {
        $nodeReady = $true
        Write-Log "info" "已有 Node.js: $nodeVersion"
        LogOk "检测到 Node.js: $nodeVersion"
    } else {
        Write-Log "info" "node --version 输出: $nodeVersion（版本不足或未安装）"
    }
} catch {
    Write-Log "info" "node 检测异常: $_"
}

if (-not $nodeReady) {
    LogInfo "未检测到 Node.js 18+，尝试使用 winget 安装 Node.js LTS..."
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
    $wingetNodeExit = $LASTEXITCODE
    Write-Log "info" "winget install Node.js 退出码: $wingetNodeExit | 耗时: $([math]::Round(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$_t1)/1000,1))s"
    if ($wingetNodeExit -ne 0) {
        Fail "Node.js 安装失败（winget 退出码 $wingetNodeExit），请手动安装 Node.js 18+ 后重试"
    }
    Update-Path
    $nodeVersion = & node --version 2>&1
    Write-Log "info" "安装后 node 版本: $nodeVersion"
    LogOk "Node.js 安装完成: $nodeVersion"
}

# ── 阶段 2: 检测 / 安装 OpenClaw ──────────────────────────────────────────────
Step "2/3" "检测 / 安装 OpenClaw"
$_t2 = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
Update-Path

$existingOcVer = $null
$openclawAlreadyInstalled = $false
try {
    $existingOcCmd = Get-Command openclaw -ErrorAction SilentlyContinue
    if (-not $existingOcCmd) { $existingOcCmd = Get-Command openclaw.cmd -ErrorAction SilentlyContinue }
    if ($existingOcCmd) {
        $existingOcVer = & $existingOcCmd.Source --version 2>&1
        if ($LASTEXITCODE -eq 0 -and "$existingOcVer".Trim()) {
            Write-Log "info" "检测到已安装 OpenClaw: $existingOcVer | 路径: $($existingOcCmd.Source)"
            LogOk "已存在 OpenClaw，跳过安装"
            $openclawAlreadyInstalled = $true
        } else {
            $existingOcVer = $null
        }
    }
} catch {
    Write-Log "warn" "预检 openclaw --version 失败，将继续安装: $_"
    $existingOcVer = $null
}

if (-not $existingOcVer) {
    LogInfo "执行: npm install -g openclaw@latest"
    LogInfo "（安装过程约 1-2 分钟，以下为 npm 实时输出）"
    Write-Host ""
    npm install -g openclaw@latest
    $ocInstallExit = $LASTEXITCODE
    Write-Host ""
    Write-Log "info" "npm install -g openclaw@latest 退出码: $ocInstallExit | 耗时: $([math]::Round(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()-$_t2)/1000,1))s"
    if ($ocInstallExit -ne 0) {
        Fail "npm install -g openclaw@latest 失败（退出码 $ocInstallExit）"
    }
}

# ── 阶段 3: 验证 ──────────────────────────────────────────────────────────────
Step "3/3" "验证安装"
Update-Path
$ocVer = $null
$ocCmd = Get-Command openclaw -ErrorAction SilentlyContinue
if (-not $ocCmd) { $ocCmd = Get-Command openclaw.cmd -ErrorAction SilentlyContinue }
if ($ocCmd) {
    $ocVer = & $ocCmd.Source --version 2>&1
    Write-Log "info" "openclaw 路径: $($ocCmd.Source) | 版本输出: $ocVer"
} else {
    # 尝试常见路径
    $candidates = @(
        "$env:APPDATA\npm\openclaw.cmd",
        "$env:USERPROFILE\.openclaw\bin\openclaw"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) {
            $ocVer = & $c --version 2>&1
            Write-Log "info" "openclaw 候选路径: $c | 版本输出: $ocVer"
            break
        }
    }
}
if (-not $ocVer) {
    Fail "无法找到 openclaw 命令，安装可能未成功。请重新打开终端后手动运行 openclaw --version 确认"
}
LogOk "openclaw 版本: $ocVer"

# ── 写入安装信息 ──────────────────────────────────────────────────────────────
$totalSec = [math]::Round(([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $_t0) / 1000, 1)
Write-Log "info" "安装完成 | 总耗时: ${totalSec}s | 日志: $_logFile"

$installInfo = @{
    install_dir  = $InstallDir
    port         = 18789
    installed_at = (Get-Date -Format "yyyy-MM-ddTHH:mm:ss")
    log_file     = $_logFile
    total_sec    = $totalSec
    oc_version   = "$ocVer"
    existing_openclaw = $openclawAlreadyInstalled
} | ConvertTo-Json
$installInfo | Out-File "$InstallDir\install-info.json" -Encoding utf8

if ($ResultFile) {
    [System.IO.File]::WriteAllText($ResultFile, "install_ok", [System.Text.Encoding]::ASCII)
}
LogOk "安装完成！总耗时 ${totalSec}s，窗口将在 3 秒后自动关闭..."
LogInfo "完整日志已保存至: $_logFile"
Start-Sleep -Seconds 3
