export type AppPhase =
  | "fresh"
  | "installing"
  | "complete"
  | "failed";

export type WizardStep =
  | "syscheck"
  | "installing"
  | "apikey"
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

export interface SysCheckItem {
  key: string;
  label: string;
  status: "ok" | "warn" | "error" | "checking";
  detail: string;
  fix_action?: string;
}

export type GatewayStatus = "running" | "stopped" | "checking" | "starting";

export type ApiProvider = "anthropic" | "openai" | "deepseek" | "custom";

export interface ApiProviderConfig {
  id: ApiProvider;
  name: string;
  keyPrefix: string;
  defaultBaseUrl: string;
  models: string[];
  placeholder: string;
}
