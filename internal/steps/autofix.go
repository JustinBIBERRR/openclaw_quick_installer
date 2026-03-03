package steps

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"openclaw-manager/internal/env"
	"openclaw-manager/internal/state"
	"openclaw-manager/internal/ui"
)

// AutoFixFn 自动修复函数。
// attempt 从 1 开始；每次步骤失败后递增。
// 返回 true 表示修复操作已执行，调用方应自动重试步骤；
// 返回 false 表示无法自动修复，调用方应展示用户选择菜单。
// 函数内部可直接向控制台输出进度信息。
type AutoFixFn func(m *state.Manifest, stepErr error, attempt int) bool

// ─────────────────────────────────────────────
// Gateway 自动修复
// ─────────────────────────────────────────────

// AutoFixGateway 按优先级依次尝试修复 Gateway 启动失败：
//  1. API Key 未配置 → 引导用户立即配置（内联流程，无需退出安装器）
//  2. 端口冲突 → 自动停止占用进程，释放端口
//  3. 空日志/未知崩溃 → 第一次尝试直接重试；第二次打印手动排查引导
func AutoFixGateway(m *state.Manifest, stepErr error, attempt int) bool {
	logPath := filepath.Join(m.InstallDir, "gateway.log")
	logBytes, _ := os.ReadFile(logPath)
	logStr := string(logBytes)
	lower := strings.ToLower(logStr + stepErr.Error())

	// ── Case 1: API Key 未配置（用户安装时跳过）──────────────────────────
	// handleGatewayWithoutConfig 已在 RunGateway 中拦截并处理该场景，
	// AutoFixGateway 只会在该函数返回错误后被调用（即用户选择了「立即配置」
	// 但配置过程中再次失败的情况）。此处直接提示并不重复触发决策屏。
	if isConfigSkipped(m) {
		ui.PrintGuidance("Gateway 启动仍需要完整的 API Key 配置", []string{
			"在管理器主菜单选择「配置 API Key」",
			fmt.Sprintf("或运行: $env:OPENCLAW_CONFIG_PATH=\"%s\"", m.ConfigFile()),
			"然后运行: openclaw models auth paste-token --provider anthropic",
		})
		return false
	}

	// ── Case 2: 端口冲突 ─────────────────────────────────────────────────
	portConflict := strings.Contains(lower, "eaddrinuse") ||
		strings.Contains(lower, "address already in use") ||
		strings.Contains(lower, "another gateway instance") ||
		!isPortFree(m.GatewayPort)

	if portConflict {
		ui.PrintAutoFix(fmt.Sprintf("检测到端口 %d 被占用，正在自动释放...", m.GatewayPort))

		shadowEnv := env.ShadowEnv(m)
		stopCmd := exec.Command("cmd", "/c", "openclaw", "gateway", "stop")
		stopCmd.Env = shadowEnv
		setHideWindow(stopCmd)
		_ = stopCmd.Run()

		time.Sleep(1 * time.Second)

		if !isPortFree(m.GatewayPort) {
			ui.PrintInfo("openclaw gateway stop 未完全释放端口，尝试强制终止...")
			killProcessOnPort(m.GatewayPort)
			time.Sleep(2 * time.Second)
		}

		if isPortFree(m.GatewayPort) {
			ui.PrintAutoFixOK(fmt.Sprintf("端口 %d 已释放，正在重试...", m.GatewayPort))
			return true
		}

		// 端口仍然被占用
		proc := getPortProcess(m.GatewayPort)
		ui.PrintAutoFixFailed(fmt.Sprintf("端口 %d 仍被 %s 占用", m.GatewayPort, proc))
		ui.PrintGuidance("请手动操作", []string{
			fmt.Sprintf("打开任务管理器，结束 %s 进程", proc),
			"或重启电脑后重新运行安装程序",
			fmt.Sprintf("或修改安装目录下 openclaw.json 中的 port 字段，换用其他端口"),
		})
		return false
	}

	// ── Case 3: 日志为空 / openclaw 进程启动即崩溃 ───────────────────────
	logEmpty := len(strings.TrimSpace(logStr)) == 0
	if logEmpty {
		if attempt == 1 {
			// 先检测 openclaw 是否可执行
			ocCmd := filepath.Join(m.NPMGlobalBin(), "openclaw.cmd")
			cliOK := fileExists(ocCmd)
			if !cliOK {
				// 检查系统 PATH
				_, cliOK = detectSystemCLI()
			}
			if !cliOK {
				ui.PrintAutoFix("检测到 openclaw CLI 可能未正确安装，诊断中...")
				ui.PrintGuidance("CLI 未找到，建议执行以下操作", []string{
					"返回并选择「重试」安装器将重新安装 OpenClaw CLI",
					"或手动运行: npm install -g openclaw",
				})
				return false
			}
			// CLI 存在但进程无输出，可能是瞬时问题，直接重试一次
			ui.PrintAutoFix("Gateway 进程启动后无输出，正在重试（可能是启动竞争）...")
			return true
		}

		// 第二次仍失败：打印完整的手动排查引导
		ui.PrintAutoFixFailed("Gateway 持续无法启动")
		fmt.Println()
		fmt.Printf("  请手动运行以下命令查看完整错误输出：\n")
		fmt.Println()
		fmt.Printf("    $env:OPENCLAW_CONFIG_PATH=\"%s\"\n", m.ConfigFile())
		fmt.Printf("    openclaw gateway --port %d --allow-unconfigured --auth none\n", m.GatewayPort)
		fmt.Println()
		ui.PrintGuidance("常见原因及处理方式", []string{
			"Node.js 版本不兼容（需要 v18+）: 运行 node --version 确认",
			"openclaw 版本过旧: 运行 npm install -g openclaw@latest",
			"系统防火墙/杀毒软件拦截了端口: 临时禁用后重试",
			"磁盘空间不足: 清理磁盘后重试",
		})
		return false
	}

	// ── Case 4: 日志中含具体错误关键词 ──────────────────────────────────
	if strings.Contains(lower, "cannot find module") {
		if attempt == 1 {
			ui.PrintAutoFix("检测到模块缺失，正在重新安装 OpenClaw CLI...")
			// 重置 CLI 步骤，触发重新安装
			m.Steps[state.StepCLIInstalled] = &state.StepRecord{Status: state.StatusPending}
			_ = m.Save()
			if err := RunOpenClawInstall(m); err != nil {
				ui.PrintError(fmt.Sprintf("CLI 重新安装失败: %v", err))
				return false
			}
			ui.PrintAutoFixOK("CLI 已重新安装，正在重试 Gateway...")
			return true
		}
		ui.PrintAutoFixFailed("模块缺失问题未解决")
		ui.PrintGuidance("手动修复步骤", []string{
			fmt.Sprintf("运行: npm install -g openclaw --prefix \"%s\"", m.NPMGlobalPrefix()),
			"完成后重新运行安装程序",
		})
		return false
	}

	// ── Case 5: 通用兜底 ─────────────────────────────────────────────────
	if attempt == 1 {
		ui.PrintAutoFix("正在重试 Gateway 启动...")
		return true
	}
	// attempt >= 2: 让用户决策
	ui.PrintGuidance("排查建议", []string{
		fmt.Sprintf("手动运行: $env:OPENCLAW_CONFIG_PATH=\"%s\"", m.ConfigFile()),
		fmt.Sprintf("         openclaw gateway --port %d --allow-unconfigured --auth none", m.GatewayPort),
		fmt.Sprintf("查看日志: %s", filepath.Join(m.InstallDir, "gateway.log")),
	})
	return false
}

// ─────────────────────────────────────────────
// CLI 安装自动修复
// ─────────────────────────────────────────────

// AutoFixInstall 处理 npm install 失败：
//  1. 清除 npm 缓存后重试
//  2. 第二次失败时输出手动排查引导
func AutoFixInstall(m *state.Manifest, _ error, attempt int) bool {
	switch attempt {
	case 1:
		ui.PrintAutoFix("清除 npm 缓存并重试...")
		shadowEnv := env.ShadowEnv(m)
		cacheDir := filepath.Join(m.InstallDir, "npm-cache")
		cleanCmd := exec.Command("cmd", "/c", "npm", "cache", "clean", "--force",
			"--cache", cacheDir)
		cleanCmd.Env = shadowEnv
		setHideWindow(cleanCmd)
		if err := cleanCmd.Run(); err == nil {
			ui.PrintAutoFixOK("npm 缓存已清除，正在重试安装...")
		} else {
			ui.PrintInfo("缓存清理完成，正在重试安装...")
		}
		return true

	default:
		ui.PrintAutoFixFailed("npm 安装多次失败")
		ui.PrintGuidance("请检查以下可能原因", []string{
			"网络连接：尝试访问 https://registry.npmmirror.com 是否正常",
			fmt.Sprintf("磁盘空间：确保至少有 300 MB 可用（当前安装目录：%s）", m.InstallDir),
			"防火墙/代理：检查是否有规则拦截了 npm 请求",
			fmt.Sprintf("手动安装: npm install -g openclaw --prefix \"%s\"", m.NPMGlobalPrefix()),
		})
		return false
	}
}

// ─────────────────────────────────────────────
// 配置写入自动修复
// ─────────────────────────────────────────────

// AutoFixConfig 处理配置写入失败：
//  1. 直接重试一次
//  2. 第二次失败时输出手动命令
func AutoFixConfig(m *state.Manifest, _ error, attempt int) bool {
	if attempt == 1 {
		ui.PrintAutoFix("配置写入失败，正在重试...")
		return true
	}
	ui.PrintAutoFixFailed("配置写入持续失败")
	ui.PrintGuidance("手动配置步骤（PowerShell）", []string{
		fmt.Sprintf("$env:OPENCLAW_CONFIG_PATH=\"%s\"", m.ConfigFile()),
		"openclaw config set gateway.mode local",
		fmt.Sprintf("openclaw config set gateway.port %d", m.GatewayPort),
		"完成后重新运行安装程序并选择「从中断处继续」",
	})
	return false
}
