package steps

import (
	"fmt"
	"os/exec"

	"openclaw-manager/internal/env"
	"openclaw-manager/internal/state"
	"openclaw-manager/internal/ui"
)

// RunOpenClawUpdate 更新 OpenClaw CLI 到最新版本
func RunOpenClawUpdate(m *state.Manifest) error {
	shadowEnv := env.ShadowEnv(m)
	args := []string{
		"/c", "npm", "install", "-g", npmPackage + "@latest",
		"--prefix", m.NPMGlobalPrefix(),
		"--no-audit", "--no-fund",
	}
	cmd := exec.Command("cmd", args...)
	cmd.Env = shadowEnv
	setHideWindow(cmd)

	return ui.WithSpinner("正在更新 OpenClaw CLI...", func() error {
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("npm update 失败: %w", err)
		}
		return nil
	})
}

// OpenBrowserURL 打开默认浏览器
func OpenBrowserURL(url string) {
	cmd := exec.Command("cmd", "/c", "start", url)
	setHideWindow(cmd)
	_ = cmd.Start()
}
