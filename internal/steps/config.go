package steps

import (
	"fmt"
	"os"
	"os/exec"
	"strings"

	"openclaw-manager/internal/env"
	"openclaw-manager/internal/state"
	"openclaw-manager/internal/ui"
)

// RunConfig 通过 openclaw 原生命令写入配置，确保格式与版本兼容。
// 使用 OPENCLAW_CONFIG_PATH（由 ShadowEnv 注入）将配置隔离在我们的安装目录。
func RunConfig(m *state.Manifest) error {
	if m.IsDone(state.StepConfigWritten) {
		return nil
	}

	shadowEnv := env.ShadowEnv(m)

	// 确保配置目录存在（openclaw config set 会写入 OPENCLAW_CONFIG_PATH 指向的文件）
	if err := os.MkdirAll(m.InstallDir, 0755); err != nil {
		return fmt.Errorf("创建配置目录失败: %w", err)
	}

	// 设置 Gateway 运行模式和端口
	if err := ocConfigSet(shadowEnv, "gateway.mode", "local"); err != nil {
		return fmt.Errorf("设置 gateway.mode 失败: %w", err)
	}
	if err := ocConfigSet(shadowEnv, "gateway.port", fmt.Sprintf("%d", m.GatewayPort)); err != nil {
		return fmt.Errorf("设置 gateway.port 失败: %w", err)
	}

	key, provider, _, model := GetSavedAPIKey(m)
	var skipped bool

	if provider == "skip" || key == "" {
		skipped = true
		ui.PrintWarn(fmt.Sprintf("已跳过 API Key，Gateway 配置已写入 → %s", m.ConfigFile()))
		ui.PrintWarn("安装完成后请在管理器中选择「配置 API Key」完成密钥设置")
	} else {
		// 通过 paste-token 命令将 API Key 写入 openclaw 的鉴权配置
		ocProvider := mapProviderID(provider)
		if err := ocPasteToken(shadowEnv, ocProvider, key); err != nil {
			return fmt.Errorf("写入 API Key 失败: %w", err)
		}
		// 设置默认模型（正确命令：openclaw models set <model>）
		if model != "" {
			if err := ocModelsSet(shadowEnv, model); err != nil {
				// 模型设置失败不阻断流程，仅提示
				ui.PrintWarn(fmt.Sprintf("默认模型设置失败（可稍后手动设置）: %v", err))
			} else {
				ui.PrintOK(fmt.Sprintf("默认模型: %s", model))
			}
		}
		ui.PrintOK(fmt.Sprintf("配置已保存 → %s", m.ConfigFile()))
	}

	// 清理内存中的临时 API Key（已写入磁盘）
	delete(m.Steps, "_api_key_tmp")

	meta := map[string]string{}
	if skipped {
		meta["skipped"] = "true"
	}
	return m.MarkDone(state.StepConfigWritten, meta)
}

// ocConfigSet 调用 `openclaw config set <key> <value>` 将配置写入 OPENCLAW_CONFIG_PATH 指定的文件
func ocConfigSet(shadowEnv []string, key, value string) error {
	cmd := exec.Command("cmd", "/c", "openclaw", "config", "set", key, value)
	cmd.Env = shadowEnv
	setHideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		return fmt.Errorf("%w: %s", err, msg)
	}
	return nil
}

// ocPasteToken 通过管道将 API Key 写入 openclaw 的 auth-profiles（非交互式）
func ocPasteToken(shadowEnv []string, provider, key string) error {
	cmd := exec.Command("cmd", "/c", "openclaw", "models", "auth", "paste-token",
		"--provider", provider)
	cmd.Env = shadowEnv
	cmd.Stdin = strings.NewReader(key + "\n")
	setHideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		return fmt.Errorf("%w: %s", err, msg)
	}
	return nil
}

// ocModelsSet 调用 `openclaw models set <model>` 设置默认模型
func ocModelsSet(shadowEnv []string, model string) error {
	cmd := exec.Command("cmd", "/c", "openclaw", "models", "set", model)
	cmd.Env = shadowEnv
	setHideWindow(cmd)
	out, err := cmd.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(string(out))
		return fmt.Errorf("%w: %s", err, msg)
	}
	return nil
}

// mapProviderID 将安装器内部 provider ID 映射为 openclaw 识别的 provider 名称
func mapProviderID(provider string) string {
	switch provider {
	case "anthropic":
		return "anthropic"
	case "openai":
		return "openai"
	case "deepseek":
		// openclaw 原生支持 deepseek provider
		return "deepseek"
	case "custom":
		// 其他 OpenAI 兼容服务，借用 openai provider 存储凭证
		return "openai"
	default:
		return provider
	}
}
