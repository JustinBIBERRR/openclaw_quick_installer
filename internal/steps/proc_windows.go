//go:build windows

package steps

import (
	"os/exec"
	"syscall"
)

func setHideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

func setDetachedProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000008, // DETACHED_PROCESS
	}
}

// setBackgroundProcess 在新进程组中以隐藏窗口方式启动进程。
// 与 setDetachedProcess 不同，它 **不使用** DETACHED_PROCESS 标志，
// 从而允许子进程正常继承文件句柄（stdout/stderr 写入日志文件），
// 同时通过 CREATE_NEW_PROCESS_GROUP 确保安装器退出后子进程继续运行。
func setBackgroundProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: 0x00000200 | 0x08000000, // CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
	}
}
