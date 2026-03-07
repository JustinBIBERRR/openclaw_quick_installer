export type AppPhase =
  | "fresh"
  | "installing"
  | "complete"
  | "failed";

export type WizardStep =
  | "syscheck"
  | "installing"
  | "onboarding"
  | "launching";

export type LogLevel = "info" | "ok" | "warn" | "error" | "dim";

export interface LogEntry {
  id: number;
  level: LogLevel;
  message: string;
  timestamp: number;
}

export interface AppManifest {
  version: string;
  phase: AppPhase;
  install_dir: string;
  gateway_port: number;
  gateway_pid: number | null;
  api_provider: string;
  api_key_configured: boolean;
  api_key_verified: boolean;
  steps_done: string[];
  last_error: string | null;
}

export interface CheckEnvironmentResult {
  node_installed: boolean;
  openclaw_installed: boolean;
  config_exists: boolean;
  manifest_complete: boolean;
  manifest: AppManifest | null;
}

export interface SysCheckItem {
  key: string;
  label: string;
  status: "ok" | "warn" | "error" | "checking";
  detail: string;
  fix_action?: string;
}

export type GatewayStatus = "running" | "stopped" | "checking" | "starting";

export type ApiProvider = "anthropic" | "openai" | "deepseek" | "custom";

// 结构化命令执行结果
export interface CommandResult {
  success: boolean;
  code: string;
  message: string;
  hint: string | null;
  command: string;
  exit_code: number | null;
  log_path: string | null;
  retriable: boolean;
  stdout: string | null;
  stderr: string | null;
}

export interface AdminRelaunchResult {
  launched: boolean;
  close_current: boolean;
  message: string;
}

// Doctor 诊断结果
export interface DoctorResult {
  success: boolean;
  passed: boolean;
  issues: DoctorIssue[];
  summary: string;
  log_path: string | null;
}

export interface DoctorIssue {
  code: string;
  message: string;
  severity: "error" | "warn" | "info";
  fixable: boolean;
}

// CLI 能力探测结果
export interface CliCapabilities {
  version: string | null;
  has_onboarding: boolean;
  has_doctor: boolean;
  has_gateway: boolean;
  has_dashboard: boolean;
  onboarding_flags: string[];
  doctor_flags: string[];
  gateway_flags: string[];
}

export interface ApiProviderConfig {
  id: ApiProvider;
  name: string;
  keyPrefix: string;
  defaultBaseUrl: string;
  models: string[];
  placeholder: string;
}

export interface ApiKeyDraft {
  provider: ApiProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  skipped: boolean;
  keyConfigured: boolean;
}

export interface SavedApiConfig {
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
}

export interface SavedFeishuConfig {
  app_id: string;
  app_secret: string;
}

export interface OnboardingSummary {
  command: string;
  message: string;
  hint: string | null;
}
