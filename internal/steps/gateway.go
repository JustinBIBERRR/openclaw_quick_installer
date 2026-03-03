package steps

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"openclaw-manager/internal/env"
	"openclaw-manager/internal/state"
	"openclaw-manager/internal/ui"
)

// gatewayStartTimeout 首次启动等待上限
const gatewayStartTimeout = 60 * time.Second

// RunGateway 启动 Gateway，等待健康检查通过，打开浏览器，创建桌面快捷方式。
// 若 API Key 配置已被跳过，转入 handleGatewayWithoutConfig 走独立决策流程。
func RunGateway(m *state.Manifest) error {
	if m.IsDone(state.StepGatewayStarted) {
		gatewayURL := fmt.Sprintf("http://localhost:%d", m.GatewayPort)
		if isHealthy(gatewayURL, 1*time.Second) {
			ui.PrintOK(fmt.Sprintf("Gateway 已在运行 → %s", gatewayURL))
			return nil
		}
		ui.PrintInfo("Gateway 未运行，正在重新启动...")
	}

	if isConfigSkipped(m) {
		return handleGatewayWithoutConfig(m)
	}

	return doStartGateway(m)
}

// handleGatewayWithoutConfig 在用户跳过 AI 服务配置时调用。
func handleGatewayWithoutConfig(m *state.Manifest) error {
	fmt.Println()
	ui.PrintWarn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	ui.PrintWarn("Gateway 启动依赖 AI 服务配置（API Key + 模型选择）")
	ui.PrintWarn("安装时跳过了此步骤，因此 Gateway 尚无法启动。")
	ui.PrintWarn("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
	fmt.Println()

	ui.PrintOK("OpenClaw CLI 已安装")
	ui.PrintOK("基础配置（Gateway 端口、模式）已写入")
	fmt.Printf("  %s  %s\n",
		ui.StyleError.Render("✗"),
		ui.StyleWarn.Render("AI 服务未配置 → Gateway 无法启动 AI 功能"))
	fmt.Println()

	choice := ui.AskChoice("请选择后续操作", []string{
		"立即配置 API Key + 模型，配置完成后自动启动 Gateway",
		"稍后配置，先进入管理器（桌面快捷方式已创建）",
	})

	if choice == 0 {
		fmt.Println()
		ui.PrintInfo("重新进入 AI 服务配置...")
		fmt.Println()

		m.Steps[state.StepAPIKeySaved] = &state.StepRecord{Status: state.StatusPending}
		m.Steps[state.StepConfigWritten] = &state.StepRecord{Status: state.StatusPending}
		_ = m.Save()

		if err := RunAPIKey(m); err != nil {
			return fmt.Errorf("API Key 配置失败: %w", err)
		}
		if err := RunConfig(m); err != nil {
			return fmt.Errorf("配置写入失败: %w", err)
		}

		fmt.Println()
		return doStartGateway(m)
	}

	exePath, _ := os.Executable()
	if err := createDesktopShortcut(exePath, "OpenClaw Manager"); err != nil {
		ui.PrintWarn(fmt.Sprintf("桌面快捷方式创建失败（已跳过）: %v", err))
	} else {
		ui.PrintOK("桌面快捷方式已创建")
	}

	if err := m.MarkDone(state.StepGatewayStarted, map[string]string{
		"skipped_api_key": "true",
		"gateway_running": "false",
	}); err != nil {
		return err
	}

	ui.PrintSuccessNoGateway(m.ConfigFile(), m.GatewayPort)
	return nil
}

// doStartGateway 执行真正的 Gateway 启动流程。
//
// 启动策略（两阶段，自动降级）：
//
//  1. 后台启动：进程以 CREATE_NEW_PROCESS_GROUP 方式运行，stdout/stderr 直接
//     写入 gateway.log（文件句柄继承，比 DETACHED_PROCESS+shell 重定向更可靠）。
//     waitForGatewayVerbose 实时 tail 日志，检测到 "listening on" 立即返回成功；
//     检测到错误关键词立即返回失败，不等满 60s。
//
//  2. 前台诊断（仅当后台日志为空时触发）：
//     自动运行相同命令（前台、可见输出），帮用户看到实际错误，
//     并按错误类型（端口冲突、模块缺失等）自动执行修复后重试。
func doStartGateway(m *state.Manifest) error {
	shadowEnv := env.ShadowEnv(m)
	gatewayURL := fmt.Sprintf("http://localhost:%d", m.GatewayPort)
	logPath := filepath.Join(m.InstallDir, "gateway.log")

	// ── Phase 1: 启动前信息 ─────────────────────────────────────────────
	ocBin := filepath.Join(m.NPMGlobalBin(), "openclaw.cmd")
	if fileExists(ocBin) {
		ui.PrintInfo("可执行文件:  " + ocBin)
	} else {
		ui.PrintInfo("可执行文件:  openclaw  (系统 PATH)")
	}
	ui.PrintInfo(fmt.Sprintf("监听端口:    %d", m.GatewayPort))
	ui.PrintInfo("配置文件:    " + m.ConfigFile())
	ui.PrintInfo("进程日志:    " + logPath)
	fmt.Println()

	// ── Phase 2: 后台启动（文件句柄模式）──────────────────────────────────
	start := time.Now()
	if err := startGatewayBackground(m, shadowEnv, logPath); err != nil {
		return err
	}

	ui.PrintOK("Gateway 进程已创建，正在监控启动过程...")
	fmt.Println()

	// ── Phase 3: 实时监控日志 ────────────────────────────────────────────
	waitErr := waitForGatewayVerbose(gatewayURL, logPath, gatewayStartTimeout)

	if waitErr == nil {
		elapsed := time.Since(start)
		fmt.Println()
		ui.PrintOK(fmt.Sprintf("Gateway 已就绪 → %s  （耗时 %.1fs）", gatewayURL, elapsed.Seconds()))
		return finishGatewayStartup(m, gatewayURL)
	}

	// ── Phase 4: 诊断 & 自动修复 ────────────────────────────────────────
	logData, _ := os.ReadFile(logPath)
	logContent := strings.TrimSpace(string(logData))

	fmt.Println()

	if logContent == "" {
		// 后台进程完全无输出 → 自动切换前台诊断
		return runGatewayForeground(m, shadowEnv, gatewayURL, logPath)
	}

	// 日志有内容但超时/失败 → 展示日志 + 按错误自动修复
	showGatewayStartupError(logPath, m)
	return autoFixGatewayOutput(m, shadowEnv, gatewayURL, logPath, logContent)
}

// StartGateway 在管理器模式下重新启动 Gateway（与 doStartGateway 策略一致）
func StartGateway(m *state.Manifest) error {
	shadowEnv := env.ShadowEnv(m)
	gatewayURL := fmt.Sprintf("http://localhost:%d", m.GatewayPort)
	logPath := filepath.Join(m.InstallDir, "gateway.log")

	ui.PrintInfo(fmt.Sprintf("端口 %d  |  日志 → %s", m.GatewayPort, logPath))
	fmt.Println()

	if err := startGatewayBackground(m, shadowEnv, logPath); err != nil {
		return err
	}
	ui.PrintOK("Gateway 进程已创建，正在监控启动过程...")
	fmt.Println()

	start := time.Now()
	waitErr := waitForGatewayVerbose(gatewayURL, logPath, 45*time.Second)
	if waitErr == nil {
		elapsed := time.Since(start)
		fmt.Println()
		ui.PrintOK(fmt.Sprintf("Gateway 已就绪  （耗时 %.1fs）", elapsed.Seconds()))
		return nil
	}

	logData, _ := os.ReadFile(logPath)
	logContent := strings.TrimSpace(string(logData))

	fmt.Println()
	if logContent == "" {
		return runGatewayForeground(m, shadowEnv, gatewayURL, logPath)
	}

	showGatewayStartupError(logPath, m)
	return autoFixGatewayOutput(m, shadowEnv, gatewayURL, logPath, logContent)
}

// ─────────────────────────────────────────────────────────────────────────────
// 内部启动辅助
// ─────────────────────────────────────────────────────────────────────────────

// startGatewayBackground 以后台模式（文件句柄继承）启动 Gateway 进程。
//
// 关键设计：
//   - 不使用 DETACHED_PROCESS，改用 CREATE_NEW_PROCESS_GROUP|CREATE_NO_WINDOW。
//     前者会阻止标准句柄继承（导致日志为空），后者不影响文件句柄传递。
//   - cmd.Stdout/Stderr 直接指向 logFile，子进程通过 OS 句柄复制独立写入，
//     关闭父进程侧的文件描述符后子进程仍可正常写日志。
//   - cmd.Process.Release() 释放父进程对子进程的句柄引用，子进程独立运行。
func startGatewayBackground(m *state.Manifest, shadowEnv []string, logPath string) error {
	// 清空旧日志（只保留本次启动内容，方便关键词检测）
	_ = os.WriteFile(logPath, []byte{}, 0644)

	logFile, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return fmt.Errorf("日志文件创建失败: %w", err)
	}

	cmd := buildGatewayProcess(m, shadowEnv, logFile)
	if err := cmd.Start(); err != nil {
		logFile.Close()
		return fmt.Errorf("启动 Gateway 失败: %w", err)
	}

	// 关闭父进程侧的 fd；子进程已有独立副本，不受影响
	logFile.Close()
	// 释放句柄引用；进程继续运行
	_ = cmd.Process.Release()
	return nil
}

// buildGatewayProcess 构造 Gateway 启动命令，使用文件句柄（非 shell 重定向）捕获日志。
func buildGatewayProcess(m *state.Manifest, shadowEnv []string, logFile *os.File) *exec.Cmd {
	ocExe := "openclaw"
	if ocCmdPath := filepath.Join(m.NPMGlobalBin(), "openclaw.cmd"); fileExists(ocCmdPath) {
		ocExe = ocCmdPath
	}

	cmd := exec.Command("cmd", "/c", ocExe,
		"gateway",
		"--port", fmt.Sprintf("%d", m.GatewayPort),
		"--allow-unconfigured",
		"--auth", "none",
	)
	cmd.Env = shadowEnv
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	setBackgroundProcess(cmd)
	return cmd
}

// runGatewayForeground 在后台启动日志为空时自动调用。
// 以前台模式（相同命令）启动 Gateway，将输出实时展示给用户，
// 然后根据输出内容自动执行对应修复操作。
func runGatewayForeground(m *state.Manifest, shadowEnv []string, gatewayURL, logPath string) error {
	configPath := m.ConfigFile()

	ui.PrintWarn("后台进程未产生任何日志输出，正在自动切换前台模式诊断...")
	fmt.Println()

	// 先杀掉可能残留的进程，避免端口冲突
	killProcessOnPort(m.GatewayPort)
	time.Sleep(600 * time.Millisecond)

	// 展示即将执行的命令（透明化）
	ui.PrintInfo("自动执行以下命令（前台模式，输出完全可见）：")
	fmt.Println()
	fmt.Printf("    %s\n", ui.StyleDim.Render(fmt.Sprintf(`$env:OPENCLAW_CONFIG_PATH="%s"`, configPath)))
	fmt.Printf("    %s\n", ui.StyleDim.Render(fmt.Sprintf(
		"openclaw gateway --port %d --allow-unconfigured --auth none", m.GatewayPort)))
	fmt.Println()
	fmt.Println("  " + ui.StyleDim.Render("─── 命令输出 ──────────────────────────────────────"))

	// 以后台方式（文件句柄）启动，短超时快速诊断
	if err := startGatewayBackground(m, shadowEnv, logPath); err != nil {
		return err
	}

	diagErr := waitForGatewayVerbose(gatewayURL, logPath, 20*time.Second)

	fmt.Println("  " + ui.StyleDim.Render("────────────────────────────────────────────────"))
	fmt.Println()

	if diagErr == nil {
		chatURL := gatewayURL + "/chat"
		ui.PrintOK(fmt.Sprintf("Gateway 已就绪（前台诊断成功）→ %s", chatURL))
		openBrowser(chatURL)
		return nil
	}

	logData, _ := os.ReadFile(logPath)
	logContent := strings.TrimSpace(string(logData))

	if logContent == "" {
		// 二次诊断依然无输出 → 极可能是 openclaw 可执行文件路径或权限问题
		ui.PrintWarn("命令仍未产生任何输出，可能原因：")
		fmt.Println()
		fmt.Println("    • openclaw 可执行文件路径不存在或无执行权限")
		fmt.Println("    • Node.js 运行时未正确安装（运行 node --version 验证）")
		fmt.Println("    • 系统防火墙或杀毒软件阻止了进程启动")
		fmt.Println()
		ui.PrintGuidance("建议操作", []string{
			fmt.Sprintf("PowerShell 中手动验证: $env:OPENCLAW_CONFIG_PATH=\"%s\"", configPath),
			fmt.Sprintf("openclaw gateway --port %d --allow-unconfigured --auth none", m.GatewayPort),
			"如仍无输出，尝试以管理员身份运行本安装程序",
		})
		return fmt.Errorf("Gateway 启动失败：可执行文件无输出")
	}

	// 有日志 → 展示并自动修复
	showGatewayStartupError(logPath, m)
	return autoFixGatewayOutput(m, shadowEnv, gatewayURL, logPath, logContent)
}

// autoFixGatewayOutput 根据日志内容自动执行修复，修复成功返回 nil（调用方可视为启动成功）。
func autoFixGatewayOutput(m *state.Manifest, shadowEnv []string, gatewayURL, logPath, logContent string) error {
	lower := strings.ToLower(logContent)

	// ── 端口冲突 ──────────────────────────────────────────────────────────
	if strings.Contains(lower, "eaddrinuse") || strings.Contains(lower, "address already in use") {
		ui.PrintAutoFix(fmt.Sprintf("检测到端口 %d 被占用，正在自动终止占用进程...", m.GatewayPort))
		killProcessOnPort(m.GatewayPort)
		time.Sleep(2 * time.Second)
		if isPortFree(m.GatewayPort) {
			ui.PrintAutoFixOK(fmt.Sprintf("端口 %d 已释放，正在重新启动 Gateway...", m.GatewayPort))
			fmt.Println()
			if err := startGatewayBackground(m, shadowEnv, logPath); err != nil {
				return err
			}
			if waitErr := waitForGatewayVerbose(gatewayURL, logPath, 30*time.Second); waitErr == nil {
				chatURL := gatewayURL + "/chat"
				fmt.Println()
				ui.PrintOK(fmt.Sprintf("Gateway 已就绪 → %s", chatURL))
				openBrowser(chatURL)
				return nil
			}
			// 重试后再次失败
			ui.PrintAutoFixFailed("端口释放后 Gateway 仍未就绪，请查看上方日志")
		} else {
			proc := getPortProcess(m.GatewayPort)
			ui.PrintAutoFixFailed(fmt.Sprintf("端口 %d 仍被 %s 占用", m.GatewayPort, proc))
		}
		return fmt.Errorf("端口 %d 被占用且无法自动释放", m.GatewayPort)
	}

	// ── 模块缺失 ──────────────────────────────────────────────────────────
	if strings.Contains(lower, "cannot find module") {
		ui.PrintAutoFix("检测到 Node.js 模块缺失，正在自动重新安装 OpenClaw CLI...")
		m.Steps[state.StepCLIInstalled] = &state.StepRecord{Status: state.StatusPending}
		_ = m.Save()
		if err := RunOpenClawInstall(m); err != nil {
			ui.PrintAutoFixFailed(fmt.Sprintf("CLI 重新安装失败: %v", err))
			return fmt.Errorf("模块缺失，CLI 重装失败: %w", err)
		}
		ui.PrintAutoFixOK("CLI 已重新安装，正在重新启动 Gateway...")
		fmt.Println()
		if err := startGatewayBackground(m, shadowEnv, logPath); err != nil {
			return err
		}
		if waitErr := waitForGatewayVerbose(gatewayURL, logPath, 45*time.Second); waitErr == nil {
			chatURL := gatewayURL + "/chat"
			fmt.Println()
			ui.PrintOK(fmt.Sprintf("Gateway 已就绪 → %s", chatURL))
			openBrowser(chatURL)
			return nil
		}
		showGatewayStartupError(logPath, m)
		return fmt.Errorf("CLI 重装后 Gateway 仍未就绪")
	}

	// ── API Key 问题 ───────────────────────────────────────────────────────
	if strings.Contains(lower, "invalid api key") || strings.Contains(lower, "401") {
		ui.PrintWarn("API Key 无效或未认证，Gateway 拒绝启动")
		ui.PrintGuidance("请执行以下步骤", []string{
			fmt.Sprintf("$env:OPENCLAW_CONFIG_PATH=\"%s\"", m.ConfigFile()),
			"openclaw models auth paste-token --provider anthropic  （粘贴新的 API Key）",
			fmt.Sprintf("openclaw gateway --port %d --allow-unconfigured --auth none", m.GatewayPort),
		})
		return fmt.Errorf("API Key 无效，Gateway 启动被拒绝")
	}

	// ── 无法自动修复 ────────────────────────────────────────────────────────
	return fmt.Errorf("Gateway 启动失败，请根据上方诊断信息处理")
}

// finishGatewayStartup 启动成功后的收尾工作（快捷方式、标记完成、打开浏览器）
func finishGatewayStartup(m *state.Manifest, gatewayURL string) error {
	exePath, _ := os.Executable()
	if err := createDesktopShortcut(exePath, "OpenClaw Manager"); err != nil {
		ui.PrintWarn(fmt.Sprintf("桌面快捷方式创建失败（已跳过）: %v", err))
	} else {
		ui.PrintOK("桌面快捷方式已创建")
	}

	if err := m.MarkDone(state.StepGatewayStarted); err != nil {
		return err
	}

	chatURL := gatewayURL + "/chat"
	openBrowser(chatURL)
	ui.PrintSuccess(chatURL)
	return nil
}

// ─────────────────────────────────────────────────────────────────────────────
// 健康检查 & 日志监控
// ─────────────────────────────────────────────────────────────────────────────

// gatewayListenKeywords 出现任意关键词即视为 Gateway 已就绪
var gatewayListenKeywords = []string{
	"listening on",
	"gateway ready",
	"server started",
	"started on port",
}

// gatewayErrorKeywords 出现任意关键词即立即判定为启动失败，无需等满超时
var gatewayErrorKeywords = []string{
	"unhandledpromiserejection",
	"error:",
	"eaddrinuse",
	"enoent",
	"cannot find module",
	"access is denied",
	"permission denied",
	"syntax error",
}

// waitForGatewayVerbose 实时 tail 日志文件并轮询健康检查。
//
// 提前退出条件：
//   - 日志中出现 gatewayListenKeywords → 立即返回 nil（成功）
//   - 日志中出现 gatewayErrorKeywords  → 立即返回 error（失败，不等满超时）
//   - HTTP 健康检查通过               → 返回 nil（兜底）
//   - 超时                            → 返回 error
func waitForGatewayVerbose(gatewayURL, logPath string, timeout time.Duration) error {
	const tickInterval = 300 * time.Millisecond
	const statusWidth = 72

	deadline := time.Now().Add(timeout)
	frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

	var loggedLines int
	logHeaderPrinted := false
	statusLineActive := false
	tick := 0

	clearStatus := func() {
		if statusLineActive {
			fmt.Printf("\r%s\r", strings.Repeat(" ", statusWidth))
			statusLineActive = false
		}
	}

	for time.Now().Before(deadline) {
		elapsed := time.Since(deadline.Add(-timeout))

		// ── 读取新日志行 ──────────────────────────────────────────────
		if data, err := os.ReadFile(logPath); err == nil && len(data) > 0 {
			raw := strings.ReplaceAll(string(data), "\r\n", "\n")
			lines := strings.Split(raw, "\n")

			for i := loggedLines; i < len(lines); i++ {
				line := strings.TrimRight(lines[i], "\r \t")
				if line == "" {
					continue
				}
				if !logHeaderPrinted {
					clearStatus()
					fmt.Println("  " + ui.StyleDim.Render("─── Gateway 进程输出 ─────────────────────────────"))
					logHeaderPrinted = true
				}
				clearStatus()
				fmt.Printf("  %s  %s\n", ui.StyleDim.Render("▸"), line)
			}
			loggedLines = len(lines)

			// 关键词检测（全量内容）
			lower := strings.ToLower(string(data))
			for _, kw := range gatewayListenKeywords {
				if strings.Contains(lower, kw) {
					clearStatus()
					return nil // 已就绪
				}
			}
			for _, kw := range gatewayErrorKeywords {
				if strings.Contains(lower, kw) {
					clearStatus()
					return fmt.Errorf("Gateway 进程报错（关键词: %s）", kw)
				}
			}
		}

		// ── HTTP 健康检查（兜底）──────────────────────────────────────
		if isHealthy(gatewayURL, 2*time.Second) {
			clearStatus()
			return nil
		}

		// ── 计时行 ────────────────────────────────────────────────────
		secs := int(elapsed.Seconds())
		total := int(timeout.Seconds())
		frame := ui.StyleAccent.Render(frames[tick%len(frames)])
		fmt.Printf("\r  %s  等待 Gateway 响应... %ds / %ds  ", frame, secs, total)
		statusLineActive = true

		tick++
		time.Sleep(tickInterval)
	}

	clearStatus()
	return fmt.Errorf("超时 %v", timeout)
}

// ─────────────────────────────────────────────────────────────────────────────
// 其余辅助函数
// ─────────────────────────────────────────────────────────────────────────────

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func isConfigSkipped(m *state.Manifest) bool {
	r, ok := m.Steps[state.StepConfigWritten]
	if !ok || r == nil || r.Meta == nil {
		return false
	}
	return r.Meta["skipped"] == "true"
}

func showGatewayStartupError(logPath string, m *state.Manifest) {
	fmt.Println()
	ui.PrintError("─────────────── Gateway 启动失败 ───────────────")

	data, err := os.ReadFile(logPath)
	logContent := strings.TrimSpace(string(data))

	if err != nil || logContent == "" {
		ui.PrintWarn("Gateway 进程未产生任何日志输出，可能原因：")
		fmt.Println()
		if isConfigSkipped(m) {
			fmt.Println("  ✗  API Key 尚未配置（安装时已跳过）")
			fmt.Println("     → 这是 Gateway 无法启动的根本原因")
			fmt.Println()
			fmt.Println("  修复步骤（二选一）：")
			fmt.Println()
			fmt.Println("  【方式一】安装完成后，在管理器主菜单选择「配置 API Key」")
			fmt.Println()
			fmt.Println("  【方式二】手动运行以下命令（PowerShell）：")
			fmt.Printf("    openclaw models auth paste-token --provider anthropic\n")
			fmt.Println()
			fmt.Printf("  配置完成后重启 Gateway：\n")
			fmt.Printf("    $env:OPENCLAW_CONFIG_PATH=\"%s\"\n", m.ConfigFile())
			fmt.Printf("    openclaw gateway --port %d --allow-unconfigured --auth none\n", m.GatewayPort)
		} else {
			fmt.Println("  • openclaw 可执行文件未找到（CLI 安装可能失败）")
			fmt.Println("  • 端口被占用导致进程启动即崩溃")
			fmt.Println("  • 系统权限不足")
			fmt.Println()
			fmt.Println("  请手动运行以下命令查看实际错误：")
			fmt.Printf("    $env:OPENCLAW_CONFIG_PATH=\"%s\"\n", m.ConfigFile())
			fmt.Printf("    openclaw gateway --port %d --allow-unconfigured --auth none\n", m.GatewayPort)
		}
	} else {
		lines := strings.Split(strings.TrimRight(logContent, "\r\n"), "\n")
		start := 0
		if len(lines) > 30 {
			start = len(lines) - 30
			fmt.Printf("  （仅显示最后 %d 行，完整日志见 %s）\n", 30, logPath)
		}
		fmt.Println()
		for _, line := range lines[start:] {
			line = strings.TrimRight(line, "\r")
			if line != "" {
				fmt.Println("  " + line)
			}
		}
		fmt.Println()
		printGatewayDiagnostics(logContent, m)
	}

	ui.PrintError("────────────────────────────────────────────────")
	fmt.Println()
	fmt.Printf("  日志文件: %s\n", logPath)
	fmt.Printf("  手动验证命令（PowerShell）:\n")
	fmt.Printf("    $env:OPENCLAW_CONFIG_PATH=\"%s\"\n", m.ConfigFile())
	fmt.Printf("    openclaw gateway --port %d --allow-unconfigured --auth none\n\n", m.GatewayPort)
}

func printGatewayDiagnostics(log string, m *state.Manifest) {
	lower := strings.ToLower(log)
	found := false

	type rule struct {
		trigger  string
		title    string
		solution string
	}
	rules := []rule{
		{
			"cannot find module",
			"OpenClaw CLI 模块缺失",
			"CLI 安装可能不完整，请重新运行安装程序（选择「从中断处继续」）",
		},
		{
			"enoent",
			"找不到可执行文件或路径",
			"请确认 OpenClaw CLI 已正确安装，或尝试重新安装",
		},
		{
			"eaddrinuse",
			fmt.Sprintf("端口 %d 已被占用", m.GatewayPort),
			"关闭占用该端口的程序后重试，或修改配置文件中的 port 字段",
		},
		{
			"address already in use",
			fmt.Sprintf("端口 %d 已被占用", m.GatewayPort),
			"关闭占用该端口的程序后重试",
		},
		{
			"another gateway instance",
			"Gateway 已在运行",
			"先停止现有 Gateway：openclaw gateway stop，然后重试",
		},
		{
			"invalid api key",
			"API Key 无效",
			fmt.Sprintf("在管理器中选择「配置 API Key」或编辑 %s", m.ConfigFile()),
		},
		{
			"401",
			"API 鉴权失败（401 Unauthorized）",
			"在管理器中选择「配置 API Key」，填写正确的密钥",
		},
		{
			"permission denied",
			"权限不足",
			"尝试以管理员身份运行本程序",
		},
		{
			"access is denied",
			"访问被拒绝（权限不足）",
			"尝试以管理员身份运行本程序",
		},
		{
			"syntax error",
			"配置文件 JSON 语法错误",
			fmt.Sprintf("检查 %s 是否是合法的 JSON 格式", m.ConfigFile()),
		},
	}

	fmt.Println("  ▸ 诊断建议：")
	for _, r := range rules {
		if strings.Contains(lower, r.trigger) {
			fmt.Printf("  ✗ %s\n", r.title)
			fmt.Printf("    → %s\n", r.solution)
			found = true
		}
	}

	if !found {
		fmt.Println("  未能自动识别错误原因，请将上方日志内容反馈给支持团队。")
	}
	fmt.Println()
}

// StopGateway 停止 Gateway
func StopGateway(m *state.Manifest) error {
	shadowEnv := env.ShadowEnv(m)
	ocCmd := filepath.Join(m.NPMGlobalBin(), "openclaw.cmd")
	cmd := exec.Command("cmd", "/c", ocCmd, "gateway", "stop")
	cmd.Env = shadowEnv
	setHideWindow(cmd)
	return cmd.Run()
}

// IsGatewayRunning 检查 Gateway 是否在线
func IsGatewayRunning(m *state.Manifest) bool {
	return isHealthy(fmt.Sprintf("http://localhost:%d", m.GatewayPort), 2*time.Second)
}

func isHealthy(baseURL string, timeout time.Duration) bool {
	client := &http.Client{Timeout: timeout}
	for _, path := range []string{"/health", "/api/health", "/"} {
		resp, err := client.Get(baseURL + path)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode < 500 {
				return true
			}
		}
	}
	return false
}

func openBrowser(url string) {
	cmd := exec.Command("cmd", "/c", "start", url)
	setHideWindow(cmd)
	_ = cmd.Start()
}

func createDesktopShortcut(targetExe, name string) error {
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	lnkPath := filepath.Join(home, "Desktop", name+".lnk")
	workDir := filepath.Dir(targetExe)

	script := fmt.Sprintf(
		`$ws = New-Object -ComObject WScript.Shell; `+
			`$s = $ws.CreateShortcut('%s'); `+
			`$s.TargetPath = '%s'; `+
			`$s.WorkingDirectory = '%s'; `+
			`$s.IconLocation = '%s,0'; `+
			`$s.Description = 'OpenClaw 本地 AI 网关管理器'; `+
			`$s.Save()`,
		lnkPath, targetExe, workDir, targetExe,
	)

	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	setHideWindow(cmd)
	return cmd.Run()
}
