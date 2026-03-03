package steps

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/huh"

	"openclaw-manager/internal/state"
	"openclaw-manager/internal/ui"
)

// feishuCredentials 持久化到 feishu.json 的凭证
type feishuCredentials struct {
	AppID     string `json:"app_id"`
	AppSecret string `json:"app_secret"`
}

// feishuTokenResp 飞书 tenant_access_token 接口响应
type feishuTokenResp struct {
	Code              int    `json:"code"`
	Msg               string `json:"msg"`
	TenantAccessToken string `json:"tenant_access_token"`
	Expire            int    `json:"expire"`
}

// feishuSendMsgReq 发送消息请求体
type feishuSendMsgReq struct {
	ReceiveID string `json:"receive_id"`
	MsgType   string `json:"msg_type"`
	Content   string `json:"content"`
}

// feishuSendMsgResp 发送消息响应（只关心 code/msg）
type feishuSendMsgResp struct {
	Code int    `json:"code"`
	Msg  string `json:"msg"`
}

// RunFeishuSetup 引导用户配置飞书通知（可跳过的可选步骤）
func RunFeishuSetup(m *state.Manifest) error {
	if m.IsDone(state.StepFeishuConfigured) {
		return nil
	}

	fmt.Println()
	fmt.Println("  " + ui.StyleBold.Render("配置飞书通知（可选）"))
	fmt.Println()
	fmt.Println("  配置后，OpenClaw 可通过飞书机器人与您通信：")
	fmt.Println("    • 接收 AI 任务通知和执行结果")
	fmt.Println("    • 通过飞书向 AI Agent 发送指令")
	fmt.Println()

	if !ui.AskConfirm("是否现在配置飞书通知？（可跳过，稍后在管理器中随时配置）") {
		ui.PrintInfo("已跳过飞书配置，可在管理器「配置飞书通知」中随时补充")
		return m.MarkDone(state.StepFeishuConfigured, map[string]string{"skipped": "true"})
	}

	// 显示创建飞书应用的指引
	showFeishuAppGuide()

	// 收集 App ID
	appID := ui.AskInput("请输入 App ID（格式：cli_xxx...）")
	appID = strings.TrimSpace(appID)
	if appID == "" {
		return fmt.Errorf("App ID 不能为空")
	}

	// 收集 App Secret（使用 huh 密码输入框，与 API Key 保持一致）
	var appSecret string
	secretForm := huh.NewForm(
		huh.NewGroup(
			huh.NewInput().
				Title("请输入 App Secret").
				Description("在飞书开放平台 → 凭证与基础信息 → App Secret").
				EchoMode(huh.EchoModePassword).
				Validate(func(v string) error {
					if strings.TrimSpace(v) == "" {
						return fmt.Errorf("App Secret 不能为空")
					}
					return nil
				}).
				Value(&appSecret),
		),
	)
	if err := secretForm.Run(); err != nil {
		if errors.Is(err, huh.ErrUserAborted) {
			ui.PrintWarn("已取消飞书配置")
			return m.MarkDone(state.StepFeishuConfigured, map[string]string{"skipped": "true"})
		}
		return fmt.Errorf("输入失败: %w", err)
	}
	appSecret = strings.TrimSpace(appSecret)

	// 验证凭证：调用飞书 tenant_access_token 接口
	ui.PrintInfo("正在连接飞书，验证凭证...")
	token, err := feishuGetTenantToken(appID, appSecret)
	if err != nil {
		return fmt.Errorf("飞书凭证验证失败: %w", err)
	}
	ui.PrintOK(fmt.Sprintf("连接成功！已获取 tenant_access_token（有效期 %d 分钟）", 7200/60))

	// 可选：发送测试消息
	if ui.AskConfirm("是否发送一条测试消息验证机器人权限？") {
		if err := runFeishuTestMessage(token); err != nil {
			// 测试消息失败不阻塞安装流程，只给出提示
			ui.PrintWarn(fmt.Sprintf("测试消息发送失败: %v", err))
			ui.PrintInfo("凭证已验证有效，可稍后在管理器中重试测试消息")
		}
	}

	// 保存凭证到 feishu.json
	if err := saveFeishuCredentials(m, appID, appSecret); err != nil {
		ui.PrintWarn(fmt.Sprintf("凭证文件写入失败: %v（App ID 已记录到安装清单）", err))
	} else {
		ui.PrintOK(fmt.Sprintf("飞书凭证已保存 → %s", m.FeishuConfigFile()))
	}

	return m.MarkDone(state.StepFeishuConfigured, map[string]string{
		"app_id":      appID,
		"configured":  "true",
	})
}

// runFeishuTestMessage 引导用户输入接收目标 ID 并发送一条测试消息
func runFeishuTestMessage(token string) error {
	fmt.Println()
	fmt.Println("  " + ui.StyleBold.Render("发送测试消息"))
	fmt.Println()
	fmt.Println("  请输入接收测试消息的目标 ID，支持以下格式：")
	fmt.Println()
	fmt.Printf("    %s  open_id  — 用户 ID（格式: ou_...）\n", ui.StyleAccent.Render("•"))
	fmt.Printf("    %s  chat_id  — 群聊 ID（格式: oc_...）\n", ui.StyleAccent.Render("•"))
	fmt.Println()
	fmt.Println("  " + ui.StyleDim.Render("提示：在飞书 PC 客户端 → 设置 → 关于飞书 → 开发者模式 → 点击用户头像可复制 open_id"))
	fmt.Println("  " + ui.StyleDim.Render("      群聊 chat_id 可在飞书开放平台 → API 调试台中获取"))
	fmt.Println()

	receiveID := ui.AskInput("目标 ID（留空跳过测试消息）")
	receiveID = strings.TrimSpace(receiveID)
	if receiveID == "" {
		ui.PrintInfo("已跳过测试消息发送")
		return nil
	}

	// 自动推断 receive_id_type
	idType := inferFeishuIDType(receiveID)
	ui.PrintInfo(fmt.Sprintf("目标类型: %s，正在发送测试消息...", idType))

	if err := feishuSendMessage(token, receiveID, idType, "🦞 OpenClaw 安装成功！这是一条来自 OpenClaw Manager 的测试消息。"); err != nil {
		return err
	}
	ui.PrintOK("测试消息已发送！请在飞书中查收")
	return nil
}

// inferFeishuIDType 根据 ID 前缀自动推断 receive_id_type
func inferFeishuIDType(id string) string {
	switch {
	case strings.HasPrefix(id, "ou_"):
		return "open_id"
	case strings.HasPrefix(id, "oc_"):
		return "chat_id"
	case strings.HasPrefix(id, "on_"):
		return "union_id"
	case strings.Contains(id, "@"):
		return "email"
	default:
		return "open_id" // 默认按 open_id 处理
	}
}

// feishuGetTenantToken 调用飞书接口获取 tenant_access_token
func feishuGetTenantToken(appID, appSecret string) (string, error) {
	payload, _ := json.Marshal(map[string]string{
		"app_id":     appID,
		"app_secret": appSecret,
	})

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Post(
		"https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
		"application/json",
		bytes.NewReader(payload),
	)
	if err != nil {
		return "", fmt.Errorf("网络请求失败: %w", err)
	}
	defer resp.Body.Close()

	var result feishuTokenResp
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("响应解析失败: %w", err)
	}
	if result.Code != 0 {
		return "", fmt.Errorf("飞书 API 错误 (code=%d): %s", result.Code, result.Msg)
	}
	return result.TenantAccessToken, nil
}

// feishuSendMessage 通过飞书 IM API 发送一条文本消息
func feishuSendMessage(token, receiveID, receiveIDType, text string) error {
	contentJSON, _ := json.Marshal(map[string]string{"text": text})
	body, _ := json.Marshal(feishuSendMsgReq{
		ReceiveID: receiveID,
		MsgType:   "text",
		Content:   string(contentJSON),
	})

	url := fmt.Sprintf("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=%s", receiveIDType)
	client := &http.Client{Timeout: 15 * time.Second}

	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json; charset=utf-8")

	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("网络请求失败: %w", err)
	}
	defer resp.Body.Close()

	var result feishuSendMsgResp
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("响应解析失败: %w", err)
	}
	if result.Code != 0 {
		return fmt.Errorf("飞书 API 错误 (code=%d): %s — %s",
			result.Code, result.Msg, feishuMsgErrorHint(result.Code))
	}
	return nil
}

// feishuMsgErrorHint 针对常见发送消息错误码给出提示
func feishuMsgErrorHint(code int) string {
	switch code {
	case 99991663:
		return "机器人不在目标会话中（请先将机器人添加到群聊）"
	case 99991672:
		return "机器人无权限向该用户发送消息（用户未开通或未添加机器人）"
	case 230001:
		return "缺少 im:message 权限（请在飞书开放平台 → 权限管理 中开启）"
	default:
		return "请检查飞书应用权限配置"
	}
}

// saveFeishuCredentials 将 App ID 和 App Secret 保存到 feishu.json
func saveFeishuCredentials(m *state.Manifest, appID, appSecret string) error {
	if err := os.MkdirAll(m.InstallDir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(feishuCredentials{
		AppID:     appID,
		AppSecret: appSecret,
	}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(m.FeishuConfigFile(), data, 0600)
}

// LoadFeishuCredentials 从 feishu.json 读取凭证（供管理器使用）
func LoadFeishuCredentials(m *state.Manifest) (appID, appSecret string, err error) {
	data, err := os.ReadFile(m.FeishuConfigFile())
	if err != nil {
		return "", "", err
	}
	var creds feishuCredentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return "", "", err
	}
	return creds.AppID, creds.AppSecret, nil
}

// IsFeishuConfigured 判断飞书是否已完成配置（非跳过状态）
func IsFeishuConfigured(m *state.Manifest) bool {
	r, ok := m.Steps[state.StepFeishuConfigured]
	if !ok || r == nil || r.Status != state.StatusDone {
		return false
	}
	return r.Meta == nil || r.Meta["skipped"] != "true"
}

// showFeishuAppGuide 打印创建飞书应用的步骤指引
func showFeishuAppGuide() {
	fmt.Println()
	fmt.Println("  " + ui.StyleBold.Render("请按以下步骤在飞书开放平台创建应用："))
	fmt.Println()

	steps := []string{
		"打开飞书开放平台：" + ui.StyleAccent.Render("https://open.feishu.cn/app"),
		"点击「创建企业自建应用」，填写应用名称（如：OpenClaw Assistant）",
		"进入应用 → 「凭证与基础信息」→ 复制 " + ui.StyleBold.Render("App ID") + " 和 " + ui.StyleBold.Render("App Secret"),
		"进入应用 → 「功能」→ 开启 " + ui.StyleBold.Render("机器人") + " 功能",
		"进入应用 → 「权限管理」→ 添加权限：\n" +
			"       " + ui.StyleDim.Render("im:message") + "（发送消息，必选）\n" +
			"       " + ui.StyleDim.Render("im:message.group_at_msg") + "（接收群聊@消息，可选）",
		"进入应用 → 「版本管理与发布」→ 创建版本并发布（需飞书管理员审批）",
	}

	for i, s := range steps {
		fmt.Printf("  %s  %s\n", ui.StyleAccent.Render(fmt.Sprintf("%d.", i+1)), s)
	}
	fmt.Println()
	fmt.Print("  准备好后按 Enter 继续...")
	fmt.Scanln()
	fmt.Println()
}

// RunFeishuTestOnly 管理器中"测试飞书连接"的入口（复用现有凭证）
func RunFeishuTestOnly(m *state.Manifest) error {
	appID, appSecret, err := LoadFeishuCredentials(m)
	if err != nil {
		return fmt.Errorf("未找到飞书凭证文件，请先完成飞书配置: %w", err)
	}

	ui.PrintInfo(fmt.Sprintf("使用已保存的 App ID: %s", appID))
	ui.PrintInfo("正在连接飞书...")

	token, err := feishuGetTenantToken(appID, appSecret)
	if err != nil {
		return fmt.Errorf("连接失败: %w", err)
	}
	ui.PrintOK("连接成功！")

	return runFeishuTestMessage(token)
}
