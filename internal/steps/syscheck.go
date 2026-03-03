package steps

import (
	"context"
	"fmt"
	"net"
	"os/exec"
	"strings"
	"time"

	"openclaw-manager/internal/mirror"
	"openclaw-manager/internal/state"
	"openclaw-manager/internal/ui"
)

const minDiskMB = 300

// nodeMinMajorVersion 最低兼容的 Node.js 主版本号
const nodeMinMajorVersion = 18

// RunSysCheck 执行系统预检，不写入 manifest（预检不是可续传步骤）
func RunSysCheck(m *state.Manifest) error {
	ui.PrintInfo("正在检查运行环境...")
	fmt.Println()

	var hasError bool

	// 1. 磁盘空间
	freeMB := getFreeDiskMB(m.InstallDir)
	if freeMB < minDiskMB {
		ui.PrintError(fmt.Sprintf("磁盘空间不足：需要 %d MB，剩余 %d MB", minDiskMB, freeMB))
		hasError = true
	} else {
		ui.PrintOK(fmt.Sprintf("磁盘空间: %d MB 可用", freeMB))
	}

	// 2. 端口检测
	port, err := resolvePort(m.GatewayPort)
	if err != nil {
		ui.PrintError(fmt.Sprintf("无法找到可用端口: %v", err))
		hasError = true
	} else {
		if port != m.GatewayPort {
			ui.PrintWarn(fmt.Sprintf("端口 %d 被占用，将使用备用端口 %d", m.GatewayPort, port))
			m.GatewayPort = port
		} else {
			ui.PrintOK(fmt.Sprintf("端口 %d: 可用", port))
		}
	}

	// 3. Windows 版本检测
	osInfo := getOSVersion()
	ui.PrintOK("操作系统: " + osInfo)

	// 4. 网络连通性（并发探测镜像）
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()

	m2, latency := mirror.SelectFastest(ctx)
	if latency == 0 {
		ui.PrintWarn("网络连接较慢，建议检查代理设置（安装将继续）")
	} else {
		ui.PrintOK(fmt.Sprintf("网络连通: %s (延迟 %dms)", m2.Name, latency.Milliseconds()))
	}

	// 5. 检测系统已有 Node.js（仅在 runtime 步骤尚未完成时执行）
	if !m.IsDone(state.StepRuntimeDownloaded) {
		if nodeVer, found := detectSystemNode(); found {
			if isNodeVersionSufficient(nodeVer) {
				ui.PrintOK(fmt.Sprintf("检测到系统 Node.js v%s（>=v%d），跳过内置运行时下载", nodeVer, nodeMinMajorVersion))
				m.UseSystemNode = true
				_ = m.MarkDone(state.StepRuntimeDownloaded, map[string]string{
					"node_version": nodeVer,
					"source":       "system",
				})
			} else {
				ui.PrintWarn(fmt.Sprintf("系统 Node.js v%s 版本过低（需要 >=v%d），将下载内置版本", nodeVer, nodeMinMajorVersion))
			}
		} else {
			ui.PrintInfo(fmt.Sprintf("未检测到系统 Node.js，将自动下载内置 v%s", m.NodeVersion))
		}
	}

	// 6. 检测系统已有 openclaw CLI（仅在 CLI 步骤尚未完成时执行）
	if !m.IsDone(state.StepCLIInstalled) {
		if clawVer, found := detectSystemCLI(); found {
			ui.PrintOK(fmt.Sprintf("检测到系统 openclaw %s，跳过 CLI 安装", clawVer))
			m.UseSystemCLI = true
			_ = m.MarkDone(state.StepCLIInstalled, map[string]string{
				"version": clawVer,
				"source":  "system",
			})
		}
	}

	fmt.Println()

	if hasError {
		return fmt.Errorf("系统预检未通过，请解决以上问题后重试")
	}
	return nil
}

// detectSystemNode 尝试通过 PATH 中的 node 命令获取版本号
func detectSystemNode() (version string, found bool) {
	cmd := exec.Command("node", "--version")
	setHideWindow(cmd)
	out, err := cmd.Output()
	if err != nil {
		return "", false
	}
	ver := strings.TrimSpace(string(out))
	if strings.HasPrefix(ver, "v") {
		ver = ver[1:]
	}
	if ver == "" {
		return "", false
	}
	return ver, true
}

// isNodeVersionSufficient 检查版本号主版本是否满足最低要求
func isNodeVersionSufficient(ver string) bool {
	parts := strings.SplitN(ver, ".", 3)
	if len(parts) == 0 {
		return false
	}
	major := 0
	fmt.Sscanf(parts[0], "%d", &major)
	return major >= nodeMinMajorVersion
}

// detectSystemCLI 尝试从 PATH 中找到 openclaw CLI 并获取版本号
func detectSystemCLI() (version string, found bool) {
	// 优先尝试 openclaw --version，再尝试 openclaw version
	for _, args := range [][]string{{"--version"}, {"version"}} {
		cmd := exec.Command("openclaw", args...)
		setHideWindow(cmd)
		out, err := cmd.Output()
		if err != nil {
			continue
		}
		ver := strings.TrimSpace(string(out))
		// 去掉可能的前缀，如 "openclaw/2026.3.1 node/v22.0.0 ..."
		for _, part := range strings.Fields(ver) {
			part = strings.TrimPrefix(part, "openclaw/")
			part = strings.TrimPrefix(part, "v")
			if len(part) > 0 && (part[0] >= '0' && part[0] <= '9') {
				return part, true
			}
		}
		if ver != "" {
			return ver, true
		}
	}
	return "", false
}

// resolvePort 检测端口是否可用，自动尝试备用端口
func resolvePort(preferred int) (int, error) {
	candidates := []int{preferred, preferred + 1, preferred + 2}
	for _, port := range candidates {
		if isPortFree(port) {
			return port, nil
		}
		proc := getPortProcess(port)
		if proc != "" {
			ui.PrintWarn(fmt.Sprintf("端口 %d 已被 %s 占用", port, proc))
		}
	}
	return 0, fmt.Errorf("端口 %d/%d/%d 均被占用，请手动释放后重试",
		candidates[0], candidates[1], candidates[2])
}

func isPortFree(port int) bool {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	ln.Close()
	return true
}
