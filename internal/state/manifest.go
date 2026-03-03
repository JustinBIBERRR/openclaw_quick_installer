package state

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	SchemaVersion = 1
	AppDirName    = "OpenClaw"
	ManifestFile  = "install_manifest.json"

	PhaseInstalling  = "installing"
	PhaseComplete    = "complete"
	PhaseFailed      = "failed"
	PhaseUninstalled = "uninstalled"

	StepRuntimeDownloaded  = "runtime_downloaded"
	StepCLIInstalled       = "cli_installed"
	StepAPIKeySaved        = "api_key_saved"
	StepConfigWritten      = "config_written"
	StepGatewayStarted     = "gateway_started"
	StepFeishuConfigured   = "feishu_configured"

	StatusDone    = "done"
	StatusPending = "pending"
)

// StepRecord 单步骤的执行记录
type StepRecord struct {
	Status      string            `json:"status"`
	CompletedAt string            `json:"completed_at,omitempty"`
	Meta        map[string]string `json:"meta,omitempty"`
}

// Manifest 安装状态清单（持久化到磁盘）
type Manifest struct {
	SchemaVersion int                    `json:"schema_version"`
	AppVersion    string                 `json:"app_version"`
	Phase         string                 `json:"phase"`
	InstallDir    string                 `json:"install_dir"`
	NodeVersion   string                 `json:"node_version"`
	GatewayPort   int                    `json:"gateway_port"`
	UseSystemNode bool                   `json:"use_system_node,omitempty"`
	UseSystemCLI  bool                   `json:"use_system_cli,omitempty"`
	Steps         map[string]*StepRecord `json:"steps"`
}

// NewManifest 创建全新的安装清单
func NewManifest(appVersion string) *Manifest {
	installDir, _ := defaultInstallDir()
	return &Manifest{
		SchemaVersion: SchemaVersion,
		AppVersion:    appVersion,
		Phase:         PhaseInstalling,
		InstallDir:    installDir,
		NodeVersion:   "20.18.0",
		GatewayPort:   18789,
		Steps: map[string]*StepRecord{
			StepRuntimeDownloaded: {Status: StatusPending},
			StepCLIInstalled:      {Status: StatusPending},
			StepAPIKeySaved:       {Status: StatusPending},
			StepConfigWritten:     {Status: StatusPending},
			StepGatewayStarted:    {Status: StatusPending},
			StepFeishuConfigured:  {Status: StatusPending},
		},
	}
}

// LoadManifest 从磁盘加载清单，如不存在返回 os.ErrNotExist
func LoadManifest() (*Manifest, error) {
	path, err := manifestPath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("清单文件损坏: %w", err)
	}

	// schema 迁移：当前仅支持 v1
	if m.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf("清单版本不兼容 (got %d, want %d)，建议重新安装", m.SchemaVersion, SchemaVersion)
	}

	// 确保 Steps map 不为 nil（兼容旧清单）
	if m.Steps == nil {
		m.Steps = make(map[string]*StepRecord)
	}
	for _, key := range []string{StepRuntimeDownloaded, StepCLIInstalled, StepAPIKeySaved, StepConfigWritten, StepGatewayStarted, StepFeishuConfigured} {
		if _, ok := m.Steps[key]; !ok {
			m.Steps[key] = &StepRecord{Status: StatusPending}
		}
	}

	return &m, nil
}

// Save 将清单写入磁盘（原子写：先写临时文件再重命名）
func (m *Manifest) Save() error {
	path, err := manifestPath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err != nil {
		return err
	}

	return os.Rename(tmp, path)
}

// MarkDone 将指定步骤标记为完成，并附加元数据
func (m *Manifest) MarkDone(step string, meta ...map[string]string) error {
	r := &StepRecord{
		Status:      StatusDone,
		CompletedAt: time.Now().UTC().Format(time.RFC3339),
	}
	if len(meta) > 0 {
		r.Meta = meta[0]
	}
	m.Steps[step] = r
	return m.Save()
}

// IsDone 检查指定步骤是否已完成
func (m *Manifest) IsDone(step string) bool {
	r, ok := m.Steps[step]
	return ok && r.Status == StatusDone
}

// NodeDir 返回内置 Node.js 的目录路径
func (m *Manifest) NodeDir() string {
	return filepath.Join(m.InstallDir, "runtime", "node")
}

// NPMGlobalBin 返回 npm 全局可执行文件目录。
// Windows 上，npm global install 将 .cmd 脚本写入 prefix 根目录（非 bin/ 子目录），
// 因此直接返回 prefix 根即可。Unix 系统的 bin/ 约定仅在交叉编译/CI 场景下有意义，
// 但本工具的运行时目标仅为 Windows，保持一致即可。
func (m *Manifest) NPMGlobalBin() string {
	return filepath.Join(m.InstallDir, "npm-global")
}

// NPMGlobalPrefix 返回 npm 全局前缀目录
func (m *Manifest) NPMGlobalPrefix() string {
	return filepath.Join(m.InstallDir, "npm-global")
}

// ConfigFile 返回 openclaw.json 路径
func (m *Manifest) ConfigFile() string {
	return filepath.Join(m.InstallDir, "openclaw.json")
}

// FeishuConfigFile 返回飞书凭证文件路径
func (m *Manifest) FeishuConfigFile() string {
	return filepath.Join(m.InstallDir, "feishu.json")
}

// ManifestFilePath 返回清单文件的完整路径
func (m *Manifest) ManifestFilePath() string {
	p, _ := manifestPath()
	return p
}

func defaultInstallDir() (string, error) {
	appData, err := os.UserConfigDir()
	if err != nil {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		appData = filepath.Join(home, "AppData", "Roaming")
	}
	return filepath.Join(appData, AppDirName), nil
}

func manifestPath() (string, error) {
	dir, err := defaultInstallDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, ManifestFile), nil
}
