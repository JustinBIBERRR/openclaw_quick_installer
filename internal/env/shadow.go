package env

import (
	"os"
	"path/filepath"
	"strings"

	"openclaw-manager/internal/state"
)

// ShadowEnv 返回注入了内置 Node.js Runtime 路径的环境变量切片。
// 不修改任何注册表或全局系统变量，完全隔离。
// 若 manifest 中 UseSystemNode=true，则不注入私有 nodeDir，直接复用系统 PATH 中的 Node.js。
func ShadowEnv(m *state.Manifest) []string {
	npmBinDir := m.NPMGlobalBin()
	npmPrefix := m.NPMGlobalPrefix()

	sep := string(os.PathListSeparator)
	systemPath := os.Getenv("PATH")
	var newPath string
	switch {
	case m.UseSystemNode && m.UseSystemCLI:
		// 系统 Node.js + 系统 openclaw：两者都在系统 PATH 里，npmBinDir 为空不影响查找
		newPath = systemPath
	case m.UseSystemNode:
		// 系统 Node.js + 私有 openclaw：npm-global 前置以优先找到私有 .cmd
		newPath = npmBinDir + sep + systemPath
	default:
		// 私有 Node.js（内置 runtime）
		newPath = m.NodeDir() + sep + npmBinDir + sep + systemPath
	}

	// 过滤掉已有的 PATH / OPENCLAW_HOME / NPM_CONFIG_PREFIX / OPENCLAW_CONFIG_PATH，再追加我们的版本
	base := os.Environ()
	env := make([]string, 0, len(base)+6)
	for _, kv := range base {
		key := strings.SplitN(kv, "=", 2)[0]
		upper := strings.ToUpper(key)
		if upper == "PATH" || upper == "OPENCLAW_HOME" || upper == "NPM_CONFIG_PREFIX" || upper == "OPENCLAW_CONFIG_PATH" {
			continue
		}
		env = append(env, kv)
	}

	env = append(env,
		"PATH="+newPath,
		"OPENCLAW_HOME="+m.InstallDir,
		"NPM_CONFIG_PREFIX="+npmPrefix,
		// 将 openclaw 配置文件指向我们隔离目录中的文件，
		// 避免读写用户系统默认的 ~/.openclaw/openclaw.json
		"OPENCLAW_CONFIG_PATH="+m.ConfigFile(),
		// 禁用 npm 的 update-notifier，避免安装时额外输出
		"NO_UPDATE_NOTIFIER=1",
		// npm 缓存目录也隔离在我们的安装目录内
		"NPM_CONFIG_CACHE="+filepath.Join(m.InstallDir, "npm-cache"),
	)

	return env
}
