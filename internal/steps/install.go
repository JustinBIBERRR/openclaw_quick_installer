package steps

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"openclaw-manager/internal/env"
	"openclaw-manager/internal/mirror"
	"openclaw-manager/internal/state"
	"openclaw-manager/internal/ui"
)

const npmPackage = "openclaw"

// RunOpenClawInstall 通过 npm 安装 OpenClaw CLI
func RunOpenClawInstall(m *state.Manifest) error {
	if m.IsDone(state.StepCLIInstalled) {
		return nil
	}

	if err := os.MkdirAll(m.NPMGlobalPrefix(), 0755); err != nil {
		return fmt.Errorf("创建 npm 目录失败: %w", err)
	}

	shadowEnv := env.ShadowEnv(m)

	// 并发探测最快 npm 镜像，降低国内用户下载等待时间
	ctx5s, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	registryName, registryURL := mirror.SelectNPMRegistry(ctx5s)
	cancel()

	if registryURL != "" {
		ui.PrintInfo(fmt.Sprintf("npm 镜像: %s", registryName))
	}

	// npm install -g openclaw
	// 使用 --prefix 命令行参数强制指定安装目录，优先级高于环境变量和 .npmrc，
	// 确保 .cmd 脚本写入我们隔离的 npm-global 目录而非系统全局路径。
	args := []string{
		"/c", "npm", "install", "-g", npmPackage,
		"--prefix", m.NPMGlobalPrefix(),
		"--no-audit", "--no-fund",
	}
	if registryURL != "" {
		args = append(args, "--registry", registryURL)
	}
	cmd := exec.Command("cmd", args...)
	cmd.Env = shadowEnv
	setHideWindow(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动 npm 失败: %w", err)
	}

	// 收集 npm 输出：
	// ⚠ 必须用两个并发 goroutine 分别消费 stdout/stderr，
	//    否则 npm 写满 stderr 管道缓冲（64KB）后阻塞，形成死锁。
	// 安装过程用 Spinner + 计时器给用户反馈；输出留作失败时的诊断日志。
	var (
		mu         sync.Mutex
		npmLines   []string // 全量收集，失败时展示
		addedLine  string   // 捕获 "added X packages" 行，成功时展示
	)

	var wg sync.WaitGroup
	drainPipe := func(r *bufio.Scanner) {
		defer wg.Done()
		for r.Scan() {
			line := strings.TrimSpace(r.Text())
			if line == "" {
				continue
			}
			mu.Lock()
			npmLines = append(npmLines, line)
			// 捕获安装完成的摘要行
			lower := strings.ToLower(line)
			if strings.HasPrefix(lower, "added ") && strings.Contains(lower, "package") {
				addedLine = line
			}
			mu.Unlock()
		}
	}

	wg.Add(2)
	go drainPipe(bufio.NewScanner(stdout))
	go drainPipe(bufio.NewScanner(stderr))

	// Spinner 同时显示已用秒数，让用户知道安装仍在进行
	hint := fmt.Sprintf("openclaw 约 95 MB，含 %d+ 个依赖，请耐心等待...", 57)
	installErr := ui.WithTimedSpinner(
		func(elapsed time.Duration) string {
			return fmt.Sprintf("正在安装 OpenClaw CLI  %s  %s",
				ui.StyleDim.Render(fmt.Sprintf("%ds", int(elapsed.Seconds()))),
				ui.StyleDim.Render(hint))
		},
		func() error {
			wg.Wait()
			return cmd.Wait()
		},
	)

	if installErr != nil {
		// 输出收集到的 npm 日志帮助用户排查
		fmt.Println()
		ui.PrintError("npm 安装日志：")
		mu.Lock()
		for _, l := range npmLines {
			if !isNPMNoiseLine(l) {
				fmt.Printf("  %s  %s\n", ui.StyleDim.Render("›"), ui.StyleDim.Render(l))
			}
		}
		mu.Unlock()
		return fmt.Errorf("npm install 失败: %w", installErr)
	}

	if addedLine != "" {
		ui.PrintOK(fmt.Sprintf("OpenClaw CLI 安装成功（%s）", addedLine))
	} else {
		ui.PrintOK("OpenClaw CLI 安装成功")
	}
	return m.MarkDone(state.StepCLIInstalled)
}

// isNPMNoiseLine 过滤 npm 输出中无意义的噪音行（仅用于失败诊断时的过滤）
func isNPMNoiseLine(line string) bool {
	lower := strings.ToLower(line)
	for _, prefix := range []string{"npm warn", "npm notice", "gyp verb", "gyp info"} {
		if strings.HasPrefix(lower, prefix) {
			return true
		}
	}
	return false
}
