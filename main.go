package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"openclaw-manager/internal/state"
	"openclaw-manager/internal/steps"
	"openclaw-manager/internal/ui"
)

// Version 由构建时 ldflags 注入
var Version = "1.0.0"

func main() {
	uninstallFlag := flag.Bool("uninstall", false, "卸载 OpenClaw 及所有相关文件")
	versionFlag := flag.Bool("version", false, "显示版本信息")
	flag.Parse()

	ui.PrintBanner(Version)

	if *versionFlag {
		fmt.Printf("  OpenClaw Manager v%s\n\n", Version)
		return
	}

	// ── Ctrl+C / SIGTERM 优雅中断 ─────────────────────────────────────────
	// 安装过程中每个步骤完成后都会写 manifest，因此直接退出不会丢失进度。
	// 下次运行时程序检测到 "installing" 态，会自动从断点继续。
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sigCh
		fmt.Println()
		fmt.Println()
		ui.PrintWarn("操作已中断。")
		ui.PrintInfo("安装进度已自动保存，重新运行程序将从断点继续。")
		fmt.Println()
		os.Exit(0)
	}()

	m, loadErr := state.LoadManifest()

	// 卸载模式
	if *uninstallFlag {
		if loadErr != nil || m == nil || m.Phase == state.PhaseUninstalled {
			ui.PrintInfo("未检测到 OpenClaw 安装，无需卸载。")
			fmt.Println()
			return
		}
		if ui.AskConfirm("确定要卸载 OpenClaw 及所有相关文件吗？") {
			state.Rollback(m)
		}
		return
	}

	// 按 manifest 状态分发
	switch {
	case loadErr != nil:
		if !errors.Is(loadErr, os.ErrNotExist) {
			ui.PrintWarn(fmt.Sprintf("清单文件异常: %v", loadErr))
			if !ui.AskConfirm("是否重新开始安装？（现有安装数据将被清理）") {
				return
			}
		}
		runInstaller(state.NewManifest(Version))

	case m.Phase == state.PhaseComplete:
		runManager(m)

	case m.Phase == state.PhaseFailed:
		runRecovery(m)

	default:
		// installing 态（上次异常退出或 Ctrl+C 中断）
		ui.PrintInfo("检测到上次安装未完成，正在从断点继续...")
		fmt.Println()
		runInstaller(m)
	}
}

// ─────────────────────────────────────────────
// 安装器模式
// ─────────────────────────────────────────────

type installStep struct {
	stepKey string            // 对应 manifest 中的 step key（空 = 不可跳过/重试）
	name    string
	fn      func(*state.Manifest) error
	autoFix steps.AutoFixFn  // 可选：自动修复函数，nil 表示无自动修复
}

var installSteps = []installStep{
	{"", "系统预检", steps.RunSysCheck, nil},
	{state.StepRuntimeDownloaded, "下载 Node.js 运行时", steps.RunRuntimeDownload, nil},
	{state.StepCLIInstalled, "安装 OpenClaw CLI", steps.RunOpenClawInstall, steps.AutoFixInstall},
	{state.StepAPIKeySaved, "配置 AI 服务", steps.RunAPIKey, nil},
	{state.StepConfigWritten, "写入配置文件", steps.RunConfig, steps.AutoFixConfig},
	{state.StepGatewayStarted, "启动本地 Gateway", steps.RunGateway, steps.AutoFixGateway},
	{state.StepFeishuConfigured, "配置飞书通知（可选）", steps.RunFeishuSetup, nil},
}

func runInstaller(m *state.Manifest) {
	total := len(installSteps)

	for i, s := range installSteps {
		if s.stepKey != "" && m.IsDone(s.stepKey) {
			ui.PrintSkip(s.name)
			continue
		}

		ui.PrintStepHeader(i+1, total, s.name)

		if err := runStepWithRetry(m, i, s); err != nil {
			m.Phase = state.PhaseFailed
			_ = m.Save()
			ui.PrintFatalError()
			os.Exit(1)
		}
	}

	m.Phase = state.PhaseComplete
	_ = m.Save()
}

// runStepWithRetry 执行单个安装步骤，失败时遵循以下优先级策略：
//
//  1. 调用步骤自带的 autoFix 函数，自动诊断并尝试修复（最多 2 次）
//     - 修复成功 → 自动重试步骤，无需用户介入
//     - 修复失败 → autoFix 内部已打印具体引导，进入用户选择菜单
//
//  2. 用户选择菜单：重试 / 跳过 / 中止
//     - 用户选择「重试」时重置自动修复计数，再次触发诊断流程
func runStepWithRetry(m *state.Manifest, idx int, s installStep) error {
	const maxAutoFix = 2
	autoFixCount := 0

	for {
		err := s.fn(m)
		if err == nil {
			return nil
		}

		fmt.Println()
		ui.PrintError(fmt.Sprintf("步骤 [%d/%d]「%s」出错：%v",
			idx+1, len(installSteps), s.name, err))
		fmt.Println()

		// 无 stepKey 的步骤（预检等）不支持重试/跳过，直接上报
		if s.stepKey == "" {
			return err
		}

		// ── 自动修复阶段 ──────────────────────────────────────────────
		if s.autoFix != nil && autoFixCount < maxAutoFix {
			autoFixCount++
			fixed := s.autoFix(m, err, autoFixCount)
			if fixed {
				fmt.Println()
				ui.PrintStepHeader(idx+1, len(installSteps),
					fmt.Sprintf("%s  %s", s.name, ui.StyleDim.Render("(自动重试)")))
				continue // 自动重试，不询问用户
			}
			// autoFix 返回 false：已在内部打印了引导信息，继续进入用户菜单
			fmt.Println()
		}

		// ── 用户决策菜单 ─────────────────────────────────────────────
		// 到达这里说明自动修复已用尽或不适用，交由用户决定
		choice := ui.AskChoice("请选择后续操作", []string{
			"↩  重试此步骤（将再次触发自动诊断）",
			"⏩  跳过此步骤（后续步骤可能受影响）",
			"✖  中止安装（进度已保存，下次可继续）",
		})

		switch choice {
		case 0: // 重试 —— 重置自动修复计数，重新经历完整诊断流程
			autoFixCount = 0
			fmt.Println()
			ui.PrintStepHeader(idx+1, len(installSteps), s.name+" (重试)")
		case 1: // 跳过
			ui.PrintWarn(fmt.Sprintf("已跳过「%s」，后续步骤可能存在风险", s.name))
			_ = m.MarkDone(s.stepKey, map[string]string{"skipped_on_error": "true"})
			return nil
		default: // 中止
			return fmt.Errorf("安装中止")
		}
	}
}

// ─────────────────────────────────────────────
// 管理器模式（已安装后双击进入）
// ─────────────────────────────────────────────

func runManager(m *state.Manifest) {
	for {
		// 每次循环都重新检测状态
		running := steps.IsGatewayRunning(m)
		gatewayURL := fmt.Sprintf("http://localhost:%d", m.GatewayPort)
		gatewayPendingAPIKey := isGatewayPendingAPIKey(m)
		apiKeyConfigured := isAPIKeyConfigured(m)
		feishuConfigured := steps.IsFeishuConfigured(m)

		// ── 状态展示 ────────────────────────────────────────────────────────
		// Gateway
		var gwStatus string
		switch {
		case running:
			gwStatus = ui.StyleDim.Render("Gateway:    ") + ui.StyleSuccess.Render("● 运行中") +
				ui.StyleDim.Render(fmt.Sprintf("  %s", gatewayURL))
		case gatewayPendingAPIKey:
			gwStatus = ui.StyleDim.Render("Gateway:    ") + ui.StyleWarn.Render("● 待启动") +
				ui.StyleDim.Render("  （API Key 已跳过，请先配置）")
		default:
			gwStatus = ui.StyleDim.Render("Gateway:    ") + ui.StyleError.Render("● 未运行")
		}
		fmt.Println("  " + gwStatus)

		// API Key
		fmt.Println("  " + apiKeyStatusLine(m, apiKeyConfigured))

		// 飞书
		var feishuStatus string
		if feishuConfigured {
			feishuStatus = ui.StyleDim.Render("飞书通知:   ") + ui.StyleSuccess.Render("● 已配置")
		} else {
			feishuStatus = ui.StyleDim.Render("飞书通知:   ") + ui.StyleDim.Render("○ 未配置")
		}
		fmt.Println("  " + feishuStatus)
		fmt.Println()

		// ── 菜单构建（label + action 平行切片）──────────────────────────────
		var labels []string
		var actions []string
		addItem := func(label, action string) {
			labels = append(labels, label)
			actions = append(actions, action)
		}

		if running {
			// Gateway 已运行：提供打开/重启/停止
			addItem("打开浏览器界面", "open")
			addItem("重启 Gateway", "restart")
			addItem("停止 Gateway", "stop")
		} else {
			// Gateway 未运行
			if !apiKeyConfigured {
				// API Key 未配置时，把配置 API Key 放在第一位并加提示
				addItem("配置 API Key（建议在启动 Gateway 前完成）", "setup_apikey")
			}
			addItem("启动 Gateway", "start")
		}

		// 飞书（可选，建议 Gateway 运行后配置）
		if feishuConfigured {
			addItem("飞书通知：测试连接", "feishu_test")
			addItem("飞书通知：重新配置", "feishu_reconfig")
		} else {
			hint := "配置飞书通知（可选）"
			if !running {
				hint = "配置飞书通知（可选，建议先完成 Gateway）"
			}
			addItem(hint, "feishu_setup")
		}

		addItem("卸载 OpenClaw", "uninstall")
		addItem("退出", "exit")

		idx := ui.AskChoice("请选择操作", labels)
		choice := actions[idx]

		// ── 执行选择动作 ──────────────────────────────────────────────────
		switch choice {
		case "exit":
			return

		case "setup_apikey":
			// 配置（或重新配置）API Key → 写入配置文件
			m.Steps[state.StepAPIKeySaved] = &state.StepRecord{Status: state.StatusPending}
			m.Steps[state.StepConfigWritten] = &state.StepRecord{Status: state.StatusPending}
			_ = m.Save()
			ui.PrintStepHeader(1, 2, "配置 AI 服务")
			if err := steps.RunAPIKey(m); err != nil {
				ui.PrintError(fmt.Sprintf("配置失败: %v", err))
				break
			}
			ui.PrintStepHeader(2, 2, "写入配置文件")
			if err := steps.RunConfig(m); err != nil {
				ui.PrintError(fmt.Sprintf("写入失败: %v", err))
				break
			}
			ui.PrintOK("API Key 已配置完成")
			if running {
				ui.PrintInfo("正在重启 Gateway 以应用新配置...")
				_ = steps.StopGateway(m)
				_ = steps.StartGateway(m)
			}

		case "open":
			steps.OpenBrowserURL(gatewayURL + "/chat")
			ui.PrintOK("已在浏览器中打开 " + gatewayURL + "/chat")

		case "start":
			ui.PrintInfo("正在启动 Gateway...")
			if err := steps.StartGateway(m); err != nil {
				ui.PrintError(fmt.Sprintf("启动失败: %v", err))
			} else {
				ui.PrintOK(fmt.Sprintf("Gateway 已启动 → %s/chat", gatewayURL))
				steps.OpenBrowserURL(gatewayURL + "/chat")
			}

		case "restart":
			ui.PrintInfo("正在重启 Gateway...")
			_ = steps.StopGateway(m)
			if err := steps.StartGateway(m); err != nil {
				ui.PrintError(fmt.Sprintf("重启失败: %v", err))
			} else {
				ui.PrintOK("Gateway 已重启")
			}

		case "stop":
			ui.PrintInfo("正在停止 Gateway...")
			if err := steps.StopGateway(m); err != nil {
				ui.PrintWarn(fmt.Sprintf("停止命令返回错误: %v（可能已停止）", err))
			} else {
				ui.PrintOK("Gateway 已停止")
			}

		case "update":
			ui.PrintStepHeader(1, 1, "更新 OpenClaw CLI")
			if err := steps.RunOpenClawUpdate(m); err != nil {
				ui.PrintError(fmt.Sprintf("更新失败: %v", err))
			} else {
				ui.PrintOK("更新完成")
			}

		case "rekey":
			m.Steps[state.StepAPIKeySaved] = &state.StepRecord{Status: state.StatusPending}
			m.Steps[state.StepConfigWritten] = &state.StepRecord{Status: state.StatusPending}
			_ = m.Save()
			ui.PrintStepHeader(1, 2, "更换 API Key")
			if err := steps.RunAPIKey(m); err != nil {
				ui.PrintError(fmt.Sprintf("更换失败: %v", err))
				break
			}
			ui.PrintStepHeader(2, 2, "写入配置文件")
			if err := steps.RunConfig(m); err != nil {
				ui.PrintError(fmt.Sprintf("写入失败: %v", err))
				break
			}
			ui.PrintOK("API Key 已更换")
			if running {
				ui.PrintInfo("正在重启 Gateway 以应用新配置...")
				_ = steps.StopGateway(m)
				_ = steps.StartGateway(m)
			}

		case "feishu_setup":
			// 重置状态后重跑飞书配置步骤
			m.Steps[state.StepFeishuConfigured] = &state.StepRecord{Status: state.StatusPending}
			_ = m.Save()
			ui.PrintStepHeader(1, 1, "配置飞书通知")
			if err := steps.RunFeishuSetup(m); err != nil {
				ui.PrintError(fmt.Sprintf("配置失败: %v", err))
			}

		case "feishu_test":
			ui.PrintStepHeader(1, 1, "测试飞书连接")
			if err := steps.RunFeishuTestOnly(m); err != nil {
				ui.PrintError(fmt.Sprintf("测试失败: %v", err))
			}

		case "feishu_reconfig":
			m.Steps[state.StepFeishuConfigured] = &state.StepRecord{Status: state.StatusPending}
			_ = m.Save()
			ui.PrintStepHeader(1, 1, "重新配置飞书通知")
			if err := steps.RunFeishuSetup(m); err != nil {
				ui.PrintError(fmt.Sprintf("配置失败: %v", err))
			}

		case "uninstall":
			if ui.AskConfirm("确定要卸载 OpenClaw 及所有相关文件吗？") {
				state.Rollback(m)
				return
			}
		}

		// 执行完任意操作后暂停，等用户确认后返回菜单
		fmt.Println()
		fmt.Print("  按 Enter 返回菜单...")
		fmt.Scanln()
		fmt.Println()
	}
}

// isAPIKeyConfigured 判断 API Key 是否已有效配置（非跳过状态）
func isAPIKeyConfigured(m *state.Manifest) bool {
	r, ok := m.Steps[state.StepAPIKeySaved]
	if !ok || r == nil || r.Status != state.StatusDone {
		return false
	}
	return r.Meta == nil || r.Meta["provider"] != "skip"
}

// isAPIKeySkipped 判断 API Key 配置步骤是否在安装向导中被跳过
func isAPIKeySkipped(m *state.Manifest) bool {
	r, ok := m.Steps[state.StepAPIKeySaved]
	if !ok || r == nil || r.Meta == nil {
		return false
	}
	return r.Meta["provider"] == "skip"
}

// apiKeyStatusLine 生成 API Key 状态展示行
func apiKeyStatusLine(m *state.Manifest, configured bool) string {
	label := ui.StyleDim.Render("API Key:    ")
	if !configured {
		return label + ui.StyleWarn.Render("○ 未配置") +
			ui.StyleDim.Render("  （建议在启动 Gateway 前配置）")
	}
	r := m.Steps[state.StepAPIKeySaved]
	provider := ""
	model := ""
	if r != nil && r.Meta != nil {
		provider = r.Meta["provider"]
		model = r.Meta["model"]
	}
	providerName := map[string]string{
		"anthropic": "Anthropic",
		"openai":    "OpenAI",
		"custom":    "自定义服务",
	}[provider]
	if providerName == "" {
		providerName = provider
	}
	detail := providerName
	if model != "" {
		// 只展示模型 ID 中斜杠后的部分，避免过长
		short := model
		if idx := len(model) - 1; idx >= 0 {
			for i, c := range model {
				if c == '/' {
					short = model[i+1:]
				}
			}
		}
		detail += "  ·  " + short
	}
	return label + ui.StyleSuccess.Render("● 已配置") + ui.StyleDim.Render("  "+detail)
}

// isGatewayPendingAPIKey 判断 Gateway 是否处于"已跳过 API Key，待配置后启动"的中间态
func isGatewayPendingAPIKey(m *state.Manifest) bool {
	r, ok := m.Steps[state.StepGatewayStarted]
	if !ok || r == nil || r.Meta == nil {
		return false
	}
	return r.Meta["skipped_api_key"] == "true"
}

// ─────────────────────────────────────────────
// 失败恢复模式
// ─────────────────────────────────────────────

func runRecovery(m *state.Manifest) {
	fmt.Println("  " + ui.StyleWarn.Render("⚠ 检测到上次安装未完成"))
	fmt.Println()

	for _, s := range installSteps {
		if s.stepKey == "" {
			continue
		}
		if m.IsDone(s.stepKey) {
			fmt.Printf("  %s  %s\n", ui.StyleSuccess.Render("✓"), s.name)
		} else {
			fmt.Printf("  %s  %s\n", ui.StyleError.Render("✗"), s.name)
		}
	}
	fmt.Println()

	choice := ui.AskChoice("请选择操作", []string{
		"从中断处继续安装",
		"重新开始（清理已下载文件）",
		"退出",
	})

	switch choice {
	case 0: // 继续
		runInstaller(m)
	case 1: // 重新开始
		state.Rollback(m)
		newM := state.NewManifest(Version)
		runInstaller(newM)
	default: // 退出
		return
	}
}
