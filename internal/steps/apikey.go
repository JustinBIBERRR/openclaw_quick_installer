package steps

import (
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/charmbracelet/huh"

	"openclaw-manager/internal/proxy"
	"openclaw-manager/internal/state"
	"openclaw-manager/internal/ui"
)

// providerConfig 定义每个 AI 服务商的校验方式
type providerConfig struct {
	name       string
	keyPattern *regexp.Regexp
	validateFn func(key string, client *http.Client) error
}

var providers = map[string]*providerConfig{
	"anthropic": {
		name:       "Anthropic (Claude)",
		keyPattern: regexp.MustCompile(`^sk-ant-`),
		validateFn: validateAnthropic,
	},
	"openai": {
		name:       "OpenAI (GPT)",
		keyPattern: regexp.MustCompile(`^sk-[A-Za-z0-9]`),
		validateFn: validateOpenAI,
	},
	"deepseek": {
		name:       "DeepSeek",
		keyPattern: regexp.MustCompile(`^sk-`),
		validateFn: nil, // 不强制校验，网络可能受限
	},
	"custom": {
		name:       "其他 OpenAI 兼容服务",
		keyPattern: regexp.MustCompile(`.+`),
		validateFn: nil,
	},
}

// modelChoice 表示模型选择列表中的一项
type modelChoice struct {
	id    string // openclaw 模型 ID（"custom" 表示手动输入）
	label string // 展示给用户的名称
}

// providerModelChoices 每个服务商的推荐模型列表（精选常用模型）
var providerModelChoices = map[string][]modelChoice{
	"anthropic": {
		{"anthropic/claude-opus-4-6", "Claude Opus 4.6   （最新旗舰，最强能力）"},
		{"anthropic/claude-sonnet-4-20250514", "Claude Sonnet 4    （均衡首选，性价比高）"},
		{"anthropic/claude-3-7-sonnet-20250219", "Claude 3.7 Sonnet  （增强推理，复杂任务）"},
		{"anthropic/claude-3-5-haiku-20241022", "Claude 3.5 Haiku   （速度最快，成本最低）"},
		{"custom", "手动输入模型 ID"},
	},
	"openai": {
		{"openai/gpt-4o", "GPT-4o        （均衡旗舰）"},
		{"openai/gpt-4.1", "GPT-4.1       （最新版本）"},
		{"openai/gpt-4o-mini", "GPT-4o Mini   （速度快，成本低）"},
		{"openai/gpt-4-turbo", "GPT-4 Turbo   （稳定版）"},
		{"custom", "手动输入模型 ID"},
	},
	"deepseek": {
		{"deepseek/deepseek-chat", "DeepSeek V3    （均衡旗舰，性价比极高）"},
		{"deepseek/deepseek-reasoner", "DeepSeek R1    （深度推理，复杂任务）"},
		{"custom", "手动输入模型 ID"},
	},
	"custom": {
		{"custom", "手动输入模型 ID（例如：qwen/qwen-max）"},
	},
}

// RunAPIKey 引导用户选择服务商、选择模型、输入并验证 API Key
func RunAPIKey(m *state.Manifest) error {
	if m.IsDone(state.StepAPIKeySaved) {
		return nil
	}

	var providerID string
	var modelID string
	var apiKey string
	var baseURL string // 仅 custom 服务商使用

	// 第一步：选择服务商（含跳过选项）
	providerIdx := ui.AskChoice("选择 AI 服务商", []string{
		"Anthropic（Claude 系列）",
		"OpenAI（GPT 系列）",
		"DeepSeek（国内访问友好，性价比高）",
		"其他 OpenAI 兼容服务",
		"稍后手动配置（跳过此步骤）",
	})
	switch providerIdx {
	case 0:
		providerID = "anthropic"
	case 1:
		providerID = "openai"
	case 2:
		providerID = "deepseek"
	case 3:
		providerID = "custom"
	default:
		providerID = "skip"
	}

	// 用户选择跳过：记录标记后直接返回
	if providerID == "skip" {
		ui.PrintWarn("已跳过 API Key 配置，安装完成后在管理器中选择「配置 API Key」")
		m.Steps["_api_key_tmp"] = &state.StepRecord{
			Status: "tmp",
			Meta:   map[string]string{"key": "", "provider": "skip", "base_url": "", "model": ""},
		}
		return m.MarkDone(state.StepAPIKeySaved, map[string]string{"provider": "skip"})
	}

	cfg := providers[providerID]

	// 第二步：选择模型
	choices := providerModelChoices[providerID]
	if len(choices) == 0 {
		choices = []modelChoice{{"custom", "手动输入模型 ID"}}
	}
	labels := make([]string, len(choices))
	for i, c := range choices {
		labels[i] = c.label
	}
	modelIdx := ui.AskChoice("选择默认模型", labels)
	selected := choices[modelIdx]

	if selected.id == "custom" {
		fmt.Printf("  %s  请输入模型 ID: ", ui.StyleInfo.Render("?"))
		fmt.Scanln(&modelID)
		modelID = strings.TrimSpace(modelID)
		if modelID == "" {
			modelID = choices[0].id // 回退到第一个推荐模型
		}
	} else {
		modelID = selected.id
	}
	ui.PrintOK(fmt.Sprintf("已选模型: %s", modelID))

	// 第三步：Base URL 处理
	// DeepSeek 自动填入官方地址；完全自定义服务由用户输入
	switch providerID {
	case "deepseek":
		baseURL = "https://api.deepseek.com/v1"
		ui.PrintOK("Base URL 已自动配置: " + baseURL)
	case "custom":
		baseURLForm := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title("请输入服务 Base URL").
					Description("例如: https://api.example.com/v1").
					Placeholder("https://").
					Value(&baseURL),
			),
		)
		if err := baseURLForm.Run(); err != nil {
			return err
		}
	}

	// 第四步：输入并验证 Key（最多重试 3 次）
	const maxRetries = 3
	for attempt := 1; attempt <= maxRetries; attempt++ {
		keyForm := huh.NewForm(
			huh.NewGroup(
				huh.NewInput().
					Title(fmt.Sprintf("请输入 %s API Key", cfg.name)).
					Description(getKeyHint(providerID)).
					EchoMode(huh.EchoModePassword).
					Validate(func(v string) error {
						v = strings.TrimSpace(v)
						if v == "" {
							return fmt.Errorf("API Key 不能为空")
						}
						if !cfg.keyPattern.MatchString(v) {
							return fmt.Errorf("Key 格式不符，请检查是否完整复制")
						}
						return nil
					}).
					Value(&apiKey),
			),
		)
		if err := keyForm.Run(); err != nil {
			if errors.Is(err, huh.ErrUserAborted) {
				return fmt.Errorf("用户取消操作")
			}
			return err
		}
		apiKey = strings.TrimSpace(apiKey)

		// 提示识别结果
		ui.PrintOK(fmt.Sprintf("已识别为 %s Key", cfg.name))

		// 跳过自定义服务的网络校验
		if providerID == "custom" || cfg.validateFn == nil {
			break
		}

		// HTTP 连通性校验
		ui.PrintInfo("正在验证 Key 连通性...")
		client := proxy.NewHTTPClient(10 * time.Second)
		err := cfg.validateFn(apiKey, client)
		if err == nil {
			ui.PrintOK("验证通过")
			break
		}

		// 按错误类型分支处理
		switch classifyValidationError(err) {
		case errClassInvalidKey:
			if attempt < maxRetries {
				ui.PrintError(fmt.Sprintf("API Key 无效（第 %d/%d 次），请重新输入", attempt, maxRetries))
				apiKey = ""
				continue
			}
			// 第三次仍失败：询问是否跳过
			if ui.AskConfirm("连续验证失败，是否跳过验证直接继续？") {
				ui.PrintWarn("已跳过验证，API Key 将保存但未经确认")
				goto saveKey
			}
			return fmt.Errorf("API Key 验证失败，安装终止")

		case errClassNetwork:
			ui.PrintWarn(fmt.Sprintf("网络连接失败: %v", err))
			if ui.AskConfirm("是否跳过验证，直接保存 Key 继续安装？") {
				ui.PrintWarn("已跳过验证（建议检查代理设置）")
				goto saveKey
			}
			return fmt.Errorf("网络验证失败，安装终止")

		default:
			ui.PrintWarn(fmt.Sprintf("验证时发生未知错误: %v", err))
			goto saveKey
		}
	}

saveKey:
	meta := map[string]string{
		"provider": providerID,
	}
	if modelID != "" {
		meta["model"] = modelID
	}
	if baseURL != "" {
		meta["base_url"] = baseURL
	}

	// 将 API Key 写入内存（config 步骤再写文件）
	m.Steps[state.StepAPIKeySaved] = &state.StepRecord{
		Status: "pending", // MarkDone 会设置为 done
	}
	// 临时存储到 meta，供 config 步骤使用
	m.Steps["_api_key_tmp"] = &state.StepRecord{
		Status: "tmp",
		Meta: map[string]string{
			"key":      apiKey,
			"provider": providerID,
			"base_url": baseURL,
			"model":    modelID,
		},
	}

	return m.MarkDone(state.StepAPIKeySaved, meta)
}

// GetSavedAPIKey 从临时存储读取 API Key（供 config 步骤使用）
func GetSavedAPIKey(m *state.Manifest) (key, provider, baseURL, model string) {
	if r, ok := m.Steps["_api_key_tmp"]; ok && r.Meta != nil {
		return r.Meta["key"], r.Meta["provider"], r.Meta["base_url"], r.Meta["model"]
	}
	return "", "", "", ""
}

func getKeyHint(provider string) string {
	switch provider {
	case "anthropic":
		return "格式: sk-ant-api03-... (从 console.anthropic.com 获取)"
	case "openai":
		return "格式: sk-... (从 platform.openai.com 获取)"
	case "deepseek":
		return "格式: sk-... (从 platform.deepseek.com/api-keys 获取)"
	default:
		return "请输入您的 API Key"
	}
}

type errClass int

const (
	errClassInvalidKey errClass = iota
	errClassNetwork
	errClassUnknown
)

func classifyValidationError(err error) errClass {
	if err == nil {
		return errClassUnknown
	}
	msg := err.Error()
	if strings.Contains(msg, "401") || strings.Contains(msg, "invalid") || strings.Contains(msg, "unauthorized") {
		return errClassInvalidKey
	}
	if strings.Contains(msg, "timeout") || strings.Contains(msg, "connection") ||
		strings.Contains(msg, "no such host") || strings.Contains(msg, "dial") {
		return errClassNetwork
	}
	return errClassUnknown
}

func validateAnthropic(key string, client *http.Client) error {
	req, err := http.NewRequest(http.MethodGet, "https://api.anthropic.com/v1/models", nil)
	if err != nil {
		return err
	}
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connection error: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK, http.StatusForbidden, http.StatusTooManyRequests:
		return nil // Key 有效（403 = 无模型访问权限，429 = 限速，均视为有效）
	case http.StatusUnauthorized:
		return fmt.Errorf("401 unauthorized: Key 无效")
	default:
		return nil // 其他状态码不阻断
	}
}

func validateOpenAI(key string, client *http.Client) error {
	req, err := http.NewRequest(http.MethodGet, "https://api.openai.com/v1/models", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+key)

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("connection error: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK, http.StatusForbidden, http.StatusTooManyRequests:
		return nil
	case http.StatusUnauthorized:
		return fmt.Errorf("401 unauthorized: Key 无效")
	default:
		return nil
	}
}
