# 系统预检脚本（由 Rust 调用，输出 JSON 结果）
param(
    [string]$InstallDir = "C:\OpenClaw"
)

$result = @{
    admin         = $false
    webview2      = $false
    disk_gb       = 0.0
    port          = 18789
    path_valid    = $true
    path_issue    = ""
    network_ok    = $false
    suggested_dir = "C:\OpenClaw"
}

# 1. 管理员权限
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
$result.admin = $isAdmin

# 2. WebView2
$wv2 = Get-ItemProperty "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
if (-not $wv2) {
    $wv2 = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" -ErrorAction SilentlyContinue
}
$result.webview2 = ($null -ne $wv2)

# 3. 磁盘空间（取安装目录所在盘）
$drive = $InstallDir.Substring(0, 1)
try {
    $disk = Get-PSDrive $drive -ErrorAction SilentlyContinue
    if ($disk) {
        $result.disk_gb = [math]::Round($disk.Free / 1GB, 1)
    }
} catch {}

# 4. 端口可用性
$port = 18789
for ($p = 18789; $p -le 18799; $p++) {
    $used = Get-NetTCPConnection -LocalPort $p -ErrorAction SilentlyContinue
    if (-not $used) { $port = $p; break }
}
$result.port = $port

# 5. 路径合法性（无中文、无空格）
$hasNonAscii = $InstallDir -cmatch '[^\x00-\x7F]'
$hasSpace    = $InstallDir.Contains(" ")
if ($hasNonAscii) {
    $result.path_valid = $false
    $result.path_issue = "路径包含非 ASCII 字符（如中文），建议使用 C:\OpenClaw"
    $result.suggested_dir = "C:\OpenClaw"
} elseif ($hasSpace) {
    $result.path_valid = $false
    $result.path_issue = "路径包含空格，建议使用 C:\OpenClaw"
    $result.suggested_dir = "C:\OpenClaw"
} else {
    $result.path_valid = $true
    $result.path_issue = ""
    $result.suggested_dir = $InstallDir
}

# 6. 网络连通性
try {
    $resp = Invoke-WebRequest "https://registry.npmmirror.com" -TimeoutSec 5 -UseBasicParsing -Method Head
    $result.network_ok = ($resp.StatusCode -lt 500)
} catch {
    $result.network_ok = $false
}

# 输出 JSON 结果（供 Rust 解析）
Write-Output "[RESULT]$(ConvertTo-Json $result -Compress)"
