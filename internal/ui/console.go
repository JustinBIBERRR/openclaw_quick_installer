package ui

import (
	"fmt"
	"strings"
	"time"
)

// PrintStepHeader 打印步骤标题，如 [2/5] 安装 OpenClaw CLI
func PrintStepHeader(current, total int, name string) {
	label := StyleStepHeader.Render(fmt.Sprintf(" %d/%d ", current, total))
	title := StyleBold.Render(" " + name)
	fmt.Printf("\n%s%s\n", label, title)
}

// PrintOK 打印成功行
func PrintOK(msg string) {
	fmt.Printf("  %s  %s\n", StyleSuccess.Render("✓"), msg)
}

// PrintSkip 打印跳过行
func PrintSkip(msg string) {
	fmt.Printf("  %s  %s\n", StyleSkip.Render("↷"), StyleSkip.Render(msg+" (已完成，跳过)"))
}

// PrintWarn 打印警告行
func PrintWarn(msg string) {
	fmt.Printf("  %s  %s\n", StyleWarn.Render("!"), StyleWarn.Render(msg))
}

// PrintInfo 打印信息行
func PrintInfo(msg string) {
	fmt.Printf("  %s  %s\n", StyleInfo.Render("·"), msg)
}

// PrintError 打印错误行
func PrintError(msg string) {
	fmt.Printf("\n  %s  %s\n", StyleError.Render("✗"), StyleError.Render(msg))
}

// PrintFatalError 打印安装失败终止信息
func PrintFatalError() {
	box := StyleBox.Render(
		StyleError.Render("安装中断") + "\n\n" +
			"进度已保存，下次运行将从断点继续。\n" +
			StyleDim.Render("如需重新安装，请使用 --uninstall 先卸载。"),
	)
	fmt.Println()
	fmt.Println(box)
	fmt.Println()
	fmt.Print("  按 Enter 退出...")
	fmt.Scanln()
}

// PrintSuccess 打印安装完成界面（带倒计时）
func PrintSuccess(url string) {
	content := StyleSuccess.Render("全部完成！") + "\n\n" +
		fmt.Sprintf("  Gateway 已启动 → %s\n", StyleInfo.Render(url)) +
		"  桌面快捷方式已创建\n\n" +
		"  下次双击此程序将直接进入管理界面。"

	fmt.Println()
	fmt.Println(StyleSuccessBox.Render(content))
	fmt.Println()

	for i := 5; i > 0; i-- {
		fmt.Printf("\r  正在打开浏览器，%d 秒后关闭窗口...  ", i)
		time.Sleep(time.Second)
	}
	fmt.Println()
}

// PrintSuccessNoGateway 打印安装完成界面（Gateway 待配置状态）
func PrintSuccessNoGateway(configPath string, gatewayPort int) {
	content := StyleWarn.Render("安装完成") + StyleDim.Render("（Gateway 待启动）") + "\n\n" +
		"  " + StyleSuccess.Render("✓") + "  OpenClaw CLI 已安装\n" +
		"  " + StyleSuccess.Render("✓") + "  基础配置已写入\n" +
		"  " + StyleSuccess.Render("✓") + "  桌面快捷方式已创建\n" +
		"  " + StyleError.Render("✗") + "  " + StyleWarn.Render("AI 服务未配置 → Gateway 未启动") + "\n\n" +
		"  双击「OpenClaw Manager」可随时继续配置。"

	fmt.Println()
	fmt.Println(StyleBox.Render(content))
	fmt.Println()

	fmt.Println("  " + StyleBold.Render("后续配置方法（任选一种）："))
	fmt.Println()
	fmt.Printf("  %s  双击桌面 「OpenClaw Manager」\n", StyleAccent.Render("方式一"))
	fmt.Printf("       → 在主菜单选择「配置 API Key」\n")
	fmt.Printf("       → 配置完成后选择「启动 Gateway」\n")
	fmt.Println()
	fmt.Printf("  %s  PowerShell 命令行：\n", StyleAccent.Render("方式二"))
	fmt.Println()
	fmt.Printf("    %s\n", StyleDim.Render("# 1. 配置 API Key（以 Anthropic 为例）"))
	fmt.Printf("    $env:OPENCLAW_CONFIG_PATH=\"%s\"\n", configPath)
	fmt.Printf("    openclaw models auth paste-token --provider anthropic\n")
	fmt.Println()
	fmt.Printf("    %s\n", StyleDim.Render("# 2. 启动 Gateway"))
	fmt.Printf("    openclaw gateway --port %d --auth none\n", gatewayPort)
	fmt.Println()

	fmt.Print("  按 Enter 进入管理器...")
	fmt.Scanln()
	fmt.Println()
}

// WithSpinner 在 fn 执行期间显示旋转动画
func WithSpinner(msg string, fn func() error) error {
	frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	done := make(chan error, 1)

	go func() { done <- fn() }()

	i := 0
	ticker := time.NewTicker(80 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case err := <-done:
			// 清除 Spinner 行
			fmt.Printf("\r%s\r", strings.Repeat(" ", 72))
			return err
		case <-ticker.C:
			frame := StyleAccent.Render(frames[i%len(frames)])
			fmt.Printf("\r  %s  %s", frame, msg)
			i++
		}
	}
}

// WithTimedSpinner 在 fn 执行期间显示旋转动画 + 已用时间（每秒更新一次）。
// msgFn(elapsed) 返回要显示的文字，可按需将秒数嵌入提示。
func WithTimedSpinner(msgFn func(elapsed time.Duration) string, fn func() error) error {
	frames := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	done := make(chan error, 1)
	start := time.Now()

	go func() { done <- fn() }()

	i := 0
	ticker := time.NewTicker(80 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case err := <-done:
			fmt.Printf("\r%s\r", strings.Repeat(" ", 80))
			return err
		case <-ticker.C:
			frame := StyleAccent.Render(frames[i%len(frames)])
			msg := msgFn(time.Since(start))
			fmt.Printf("\r  %s  %s", frame, msg)
			i++
		}
	}
}

// PrintDownloadProgress 显示下载进度（覆盖当前行）
func PrintDownloadProgress(downloaded, total int64, speed float64) {
	if total <= 0 {
		fmt.Printf("\r  正在下载... %s", formatBytes(downloaded))
		return
	}
	pct := float64(downloaded) / float64(total)
	width := 38
	filled := int(pct * float64(width))
	bar := StyleSuccess.Render(strings.Repeat("█", filled)) +
		StyleDim.Render(strings.Repeat("░", width-filled))
	speedStr := fmt.Sprintf("↓ %s/s", formatBytes(int64(speed)))
	fmt.Printf("\r  [%s]  %4.0f%%  %s / %s  %s  ",
		bar, pct*100, formatBytes(downloaded), formatBytes(total),
		StyleDim.Render(speedStr))
}

// PrintDownloadDone 完成下载后换行并打印完成信息
func PrintDownloadDone(total int64) {
	fmt.Printf("\r%s\r", strings.Repeat(" ", 80))
	PrintOK(fmt.Sprintf("下载完成 (%s)", formatBytes(total)))
}

// AskConfirm 询问 Y/N，返回 true 表示确认
func AskConfirm(prompt string) bool {
	fmt.Printf("\n  %s  %s [Y/n] ", StyleWarn.Render("?"), prompt)
	var input string
	fmt.Scanln(&input)
	input = strings.TrimSpace(strings.ToLower(input))
	return input == "" || input == "y" || input == "yes"
}

// AskChoice 以纯文本数字菜单方式让用户从若干选项中选一个，返回 0-based 下标。
// 不使用 TUI 组件，兼容所有 Windows 终端环境，避免方向键导致的重复渲染 bug。
func AskChoice(title string, options []string) int {
	fmt.Println()
	fmt.Printf("  %s  %s\n", StyleWarn.Render("?"), StyleBold.Render(title))
	fmt.Println()
	for i, opt := range options {
		fmt.Printf("  %s  %s\n",
			StyleAccent.Render(fmt.Sprintf("[%d]", i+1)),
			opt)
	}
	fmt.Println()
	for {
		fmt.Printf("  请输入数字 [1-%d]: ", len(options))
		var input string
		fmt.Scanln(&input)
		input = strings.TrimSpace(input)
		n := 0
		fmt.Sscanf(input, "%d", &n)
		if n >= 1 && n <= len(options) {
			fmt.Println()
			return n - 1
		}
		fmt.Printf("  无效输入，请输入 1 到 %d 之间的数字\n", len(options))
	}
}

// PrintAutoFix 打印正在执行自动修复的操作说明
func PrintAutoFix(action string) {
	fmt.Printf("  %s  %s\n", StyleAccent.Render("⚙"), StyleBold.Render("自动修复: ")+action)
}

// PrintAutoFixOK 打印自动修复成功
func PrintAutoFixOK(result string) {
	fmt.Printf("  %s  %s\n", StyleSuccess.Render("✓"), "修复成功："+result)
}

// PrintAutoFixFailed 打印自动修复失败
func PrintAutoFixFailed(reason string) {
	fmt.Printf("  %s  %s\n", StyleWarn.Render("!"), StyleWarn.Render("自动修复未能解决："+reason))
}

// PrintGuidance 打印明确的用户引导信息（有序步骤列表）
func PrintGuidance(title string, steps []string) {
	fmt.Println()
	fmt.Printf("  %s  %s\n", StyleWarn.Render("→"), StyleBold.Render(title))
	fmt.Println()
	for i, s := range steps {
		fmt.Printf("     %s  %s\n", StyleAccent.Render(fmt.Sprintf("%d.", i+1)), s)
	}
	fmt.Println()
}

// AskInput 简单文本输入
func AskInput(prompt string) string {
	fmt.Printf("\n  %s  %s: ", StyleInfo.Render("?"), prompt)
	var input string
	fmt.Scanln(&input)
	return strings.TrimSpace(input)
}

func formatBytes(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(b)/float64(div), "KMGTPE"[exp])
}
