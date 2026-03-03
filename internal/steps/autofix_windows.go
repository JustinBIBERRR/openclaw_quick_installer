//go:build windows

package steps

import (
	"fmt"
	"os/exec"
	"syscall"
)

// killProcessOnPort 强制终止所有占用指定 TCP 端口的进程（仅 Windows）。
// 通过 PowerShell 的 Get-NetTCPConnection + Stop-Process 实现。
func killProcessOnPort(port int) {
	script := fmt.Sprintf(`
$conns = Get-NetTCPConnection -LocalPort %d -State Listen,Established -ErrorAction SilentlyContinue
foreach ($c in $conns) {
    $pid = $c.OwningProcess
    if ($pid -and $pid -ne 0 -and $pid -ne 4) {
        Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
    }
}`, port)
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	_ = cmd.Run()
}
