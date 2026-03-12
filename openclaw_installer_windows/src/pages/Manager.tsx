import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ExternalLink, RefreshCw, Square, FolderOpen,
  Trash2, ChevronRight, Loader, FileEdit, Stethoscope, Wrench,
  AlertTriangle, X
} from "lucide-react";
import StatusDot from "../components/StatusDot";
import TitleBar from "../components/TitleBar";
import UnifiedConfigPanel from "../components/UnifiedConfigPanel";
import type { AppManifest, GatewayStatus, DoctorResult, CommandResult, CliCapabilities, CheckEnvironmentResult } from "../types";
import { useI18n } from "../i18n/useI18n";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const BTN_PRIMARY = "h-9 sm:h-10 px-3 sm:px-4 inline-flex items-center justify-center gap-1.5 sm:gap-2 bg-brand-500 hover:bg-brand-600 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 text-xs sm:text-sm font-semibold rounded-lg sm:rounded-xl transition-all hover:shadow-[0_0_16px_rgba(16,185,129,0.3)] sm:hover:shadow-[0_0_18px_rgba(16,185,129,0.35)]";
const BTN_SECONDARY = "h-9 sm:h-10 px-3 sm:px-4 inline-flex items-center justify-center gap-1.5 sm:gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-50 text-slate-200 text-xs sm:text-sm rounded-lg sm:rounded-xl transition-colors";
const BTN_DANGER = "h-9 sm:h-10 px-3 sm:px-4 inline-flex items-center justify-center gap-1.5 sm:gap-2 bg-red-900/40 hover:bg-red-800/50 border border-red-800/50 disabled:opacity-50 text-red-300 text-xs sm:text-sm rounded-lg sm:rounded-xl transition-colors";

interface Props {
  manifest: AppManifest;
  cliCaps: CliCapabilities | null;
  gatewayStatus: GatewayStatus;
  onStatusChange: (s: GatewayStatus) => void;
  onManifestChange?: (m: AppManifest) => void;
  autoOpenConfig?: boolean;
}

function buildManagerRecoveryHint(
  message: string,
  backendHint: string | null,
  t: (key: string) => string
): string | null {
  const lower = `${message} ${backendHint || ""}`.toLowerCase();
  if (lower.includes("too many failed authentication attempts") || lower.includes("authentication attempts")) {
    return t("manager.recovery.authCache");
  }
  if (lower.includes("no api key found") || lower.includes("auth-profiles")) {
    return backendHint || t("manager.recovery.noApiKey");
  }
  if (lower.includes("gateway.mode") || lower.includes("mode local") || lower.includes("unconfigured")) {
    return backendHint || t("manager.recovery.gatewayMode");
  }
  if (lower.includes("cmd_not_found") || lower.includes("找不到 openclaw")) {
    return backendHint || t("manager.recovery.cmdNotFound");
  }
  return backendHint;
}

export default function Manager({ manifest, cliCaps, gatewayStatus, onStatusChange, onManifestChange, autoOpenConfig = false }: Props) {
  const { t } = useI18n();
  const [initialChecking, setInitialChecking] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastErrorHint, setLastErrorHint] = useState<string | null>(null);
  const [doctorResult, setDoctorResult] = useState<DoctorResult | null>(null);
  const [showDoctorPanel, setShowDoctorPanel] = useState(false);
  const [openingChat, setOpeningChat] = useState(false);
  const [chatLocked, setChatLocked] = useState(false);
  const [showConfigPanel, setShowConfigPanel] = useState(false);

  const port = manifest.gateway_port || 18789;
  const chatUrl = `http://localhost:${port}/chat`;

  useEffect(() => {
    let cancelled = false;
    async function bootstrapManager() {
      setInitialChecking(true);
      try {
        const env = await invoke<CheckEnvironmentResult>("check_environment");
        if (!cancelled && env.manifest && onManifestChange) {
          onManifestChange(env.manifest);
        }
      } catch {
        // ignore first-screen probe failures
      } finally {
        if (!cancelled) {
          setInitialChecking(false);
        }
      }
    }
    bootstrapManager();
    return () => {
      cancelled = true;
    };
  }, [onManifestChange]);

  // 定期轮询 Gateway 状态
  useEffect(() => {
    if (initialChecking) return;
    checkStatus();
    const timer = setInterval(checkStatus, 5000);
    return () => clearInterval(timer);
  }, [port, initialChecking]);

  useEffect(() => {
    if (autoOpenConfig && !manifest.api_key_configured) {
      setShowConfigPanel(true);
    }
  }, [autoOpenConfig, manifest.api_key_configured]);

  async function checkStatus() {
    try {
      const s = await invoke<string>("get_gateway_status", {
        installDir: manifest.install_dir,
        port,
      });
      onStatusChange(s === "running" ? "running" : "stopped");
    } catch {
      onStatusChange("stopped");
    }
  }

  async function doAction(action: string) {
    setActionLoading(action);
    setLastError(null);
    setLastErrorHint(null);
    
    try {
      if (action === "start") {
        await ensureGatewayRunning();
      } else if (action === "stop" || action === "force_stop") {
        await invoke("kill_gateway_process", { installDir: manifest.install_dir, port });
        onStatusChange("stopped");
      } else if (action === "restart") {
        onStatusChange("starting");
        await invoke("kill_gateway_process", { installDir: manifest.install_dir, port });
        await new Promise((r) => setTimeout(r, 1500));
        const result = await invoke<CommandResult>("start_gateway_bg", { installDir: manifest.install_dir, port });
        if (!result.success) {
          setLastError(result.message);
          setLastErrorHint(buildManagerRecoveryHint(result.message, result.hint, t));
          onStatusChange("stopped");
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
        checkStatus();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      console.error(e);
      checkStatus();
    } finally {
      setActionLoading(null);
    }
  }

  async function ensureGatewayRunning(): Promise<boolean> {
    onStatusChange("starting");
    const result = await invoke<CommandResult>("start_gateway_bg", {
      installDir: manifest.install_dir,
      port,
    });
    if (!result.success) {
      setLastError(result.message);
      setLastErrorHint(buildManagerRecoveryHint(result.message, result.hint, t));
      onStatusChange("stopped");
      return false;
    }

    await new Promise((r) => setTimeout(r, 3000));
    const status = await invoke<string>("get_gateway_status", { installDir: manifest.install_dir, port });
    if (status === "running") {
      onStatusChange("running");
      return true;
    }

    let retries = 3;
    while (retries > 0) {
      await new Promise((r) => setTimeout(r, 2000));
      const s = await invoke<string>("get_gateway_status", { installDir: manifest.install_dir, port });
      if (s === "running") {
        onStatusChange("running");
        return true;
      }
      retries--;
    }

    setLastError(t("manager.errorStartFailed"));
    setLastErrorHint(t("manager.errorStartHint"));
    onStatusChange("stopped");
    return false;
  }

  async function runDiagnose() {
    if (!cliCaps?.has_doctor) {
      setLastError(t("manager.errorNoDoctor"));
      setLastErrorHint(t("manager.errorUpgradeHint"));
      return;
    }
    setActionLoading("diagnose");
    setShowDoctorPanel(true);
    try {
      const result = await invoke<DoctorResult>("run_doctor");
      setDoctorResult(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(t("manager.errorDiagnose", { msg }));
    } finally {
      setActionLoading(null);
    }
  }

  async function runFix() {
    if (!cliCaps?.has_doctor) {
      setLastError(t("manager.errorNoDoctorFix"));
      setLastErrorHint(t("manager.errorUpgradeHint"));
      return;
    }
    setActionLoading("fix");
    try {
      const result = await invoke<CommandResult>("run_doctor_fix");
      if (result.success) {
        setLastError(null);
        setDoctorResult(null);
        // 修复后重新诊断
        const newResult = await invoke<DoctorResult>("run_doctor");
        setDoctorResult(newResult);
      } else {
        setLastError(t("manager.errorFixFailed", { msg: result.message }));
        setLastErrorHint(result.hint || null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(t("manager.errorFixFailed", { msg }));
    } finally {
      setActionLoading(null);
    }
  }

  async function openLogDirectory() {
    try {
      const logDir = await invoke<string>("get_log_directory");
      await invoke("open_folder", { path: logDir });
    } catch (e) {
      console.error("打开日志目录失败:", e);
    }
  }

  async function openRuntimeLogDirectory() {
    try {
      await invoke("open_folder", { path: `${manifest.install_dir}\\logs` });
    } catch (e) {
      console.error("打开运行日志目录失败:", e);
    }
  }

  async function openChat() {
    if (openingChat || chatLocked) return;
    setOpeningChat(true);
    setChatLocked(true);
    try {
      const result = await invoke<CommandResult>("run_dashboard");
      if (!result.success) {
        setLastError(result.message);
        setLastErrorHint(buildManagerRecoveryHint(result.message, result.hint || null, t));
        // dashboard 失败时兜底
        await invoke("open_url", { url: chatUrl });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      setLastErrorHint(buildManagerRecoveryHint(msg, null, t));
    } finally {
      setOpeningChat(false);
      setTimeout(() => setChatLocked(false), 8000);
    }
  }

  async function startAndOpenChat() {
    if (actionLoading !== null || openingChat || chatLocked) return;
    setActionLoading("start_open");
    setLastError(null);
    setLastErrorHint(null);
    try {
      const started = await ensureGatewayRunning();
      if (started) {
        await openChat();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      setLastErrorHint(buildManagerRecoveryHint(msg, null, t));
      onStatusChange("stopped");
    } finally {
      setActionLoading(null);
    }
  }

  async function refreshManifestState() {
    if (!onManifestChange) return;
    try {
      const env = await invoke<{ manifest: AppManifest | null }>("check_environment");
      if (env.manifest) {
        onManifestChange(env.manifest);
      }
    } catch {
      // ignore refresh failures
    }
  }

  const providerLabel: Record<string, string> = {
    anthropic: "Anthropic Claude",
    openai: "OpenAI GPT",
    deepseek: "DeepSeek",
    custom: "Custom API",
    skip: t("manager.notConfigured"),
  };

  const gatewayStatusLabel: Record<GatewayStatus, string> = {
    running: t("manager.status.running"),
    stopped: t("manager.status.stopped"),
    checking: t("manager.status.checking"),
    starting: t("manager.status.starting"),
  };

  const configMissing = !manifest.api_key_configured;

  if (initialChecking) {
    return (
      <div className="h-screen flex flex-col" style={{ background: "#060B14" }}>
        <TitleBar title={t("app.title.manager")} />
        <div className="flex-1 flex items-center justify-center px-4 sm:px-6">
          <div className="flex flex-col items-center gap-2 sm:gap-3">
            <Loader size={20} className="animate-spin text-brand-400 sm:w-6 sm:h-6" />
            <p className="text-xs sm:text-sm text-slate-300">{t("manager.initialCheckingTitle")}</p>
            <p className="text-[0.7rem] sm:text-xs text-slate-500">{t("manager.initialCheckingDesc")}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col" style={{ background: "#060B14" }}>
      <TitleBar title={t("app.title.manager")} />

      <div className="flex-1 overflow-y-auto px-3 sm:px-6 py-3 sm:py-6">
        <div className="w-full max-w-6xl mx-auto flex flex-col gap-3 sm:gap-4">
          <div className="glass-surface radius-standard p-4 sm:p-6 shadow-[0_12px_36px_rgba(0,0,0,0.24)] sm:shadow-[0_20px_50px_rgba(0,0,0,0.28)]">
            <div className="flex flex-col sm:flex-row items-start justify-between gap-3 sm:gap-4">
              <div className="flex-1 min-w-0">
                <p className="text-[0.7rem] sm:text-xs uppercase tracking-wide text-slate-500">{t("manager.workspaceOverview")}</p>
                <h2 className="text-lg sm:text-xl font-semibold text-slate-100 mt-0.5 sm:mt-1">{t("manager.title")}</h2>
                <p className="text-xs sm:text-sm text-slate-400 mt-0.5 sm:mt-1">
                  {configMissing ? t("manager.subtitleNeedConfig") : t("manager.subtitleReady")}
                </p>
              </div>
              <span className={`px-2.5 sm:px-3 py-1 sm:py-1.5 text-[0.7rem] sm:text-xs rounded-full border flex-shrink-0 ${
                gatewayStatus === "running"
                  ? "border-emerald-400/40 text-emerald-200 bg-emerald-500/15"
                  : gatewayStatus === "starting"
                    ? "border-amber-400/40 text-amber-200 bg-amber-500/15"
                    : "border-slate-700 text-slate-300 bg-slate-800/70"
              }`}>
                Gateway {gatewayStatusLabel[gatewayStatus]}
              </span>
            </div>
            <div className="mt-3 sm:mt-4 grid grid-cols-1 md:grid-cols-3 gap-2 sm:gap-3">
              <div className="rounded-lg sm:rounded-xl border border-slate-800 bg-slate-900/70 p-2.5 sm:p-3.5">
                <p className="text-[0.7rem] sm:text-xs text-slate-500">{t("manager.chatAddress")}</p>
                <p className="text-xs sm:text-sm text-slate-200 font-mono mt-0.5 sm:mt-1 break-all">{chatUrl}</p>
              </div>
              <div className="rounded-lg sm:rounded-xl border border-slate-800 bg-slate-900/70 p-2.5 sm:p-3.5">
                <p className="text-[0.7rem] sm:text-xs text-slate-500">{t("manager.apiState")}</p>
                <p className={`text-xs sm:text-sm mt-0.5 sm:mt-1 ${configMissing ? "text-yellow-400" : "text-slate-200"}`}>
                  {configMissing ? t("manager.configMissingSuggested") : t("manager.configured")}
                </p>
              </div>
              <div className="rounded-lg sm:rounded-xl border border-slate-800 bg-slate-900/70 p-2.5 sm:p-3.5">
                <p className="text-[0.7rem] sm:text-xs text-slate-500">{t("manager.installDir")}</p>
                <p className="text-xs sm:text-sm text-slate-300 mt-0.5 sm:mt-1 truncate">{manifest.install_dir}</p>
              </div>
            </div>
            <div className="mt-3 sm:mt-4 flex flex-wrap gap-2">
              <button
                onClick={() => setShowConfigPanel(true)}
              className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 sm:py-2.5 text-xs sm:text-sm rounded-lg sm:rounded-xl transition-all
                ${configMissing
                  ? "bg-brand-500/15 hover:bg-brand-500/20 border border-brand-400/60 text-brand-200 shadow-[0_0_0_1px_rgba(16,185,129,0.25)]"
                  : "bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200"
                }`}
              >
                <FileEdit size={13} className="sm:w-[14px] sm:h-[14px]" />
              {configMissing ? t("manager.quickConfig") : t("manager.quickConfig")}
              </button>
              <button
                onClick={runDiagnose}
                disabled={actionLoading !== null || !cliCaps?.has_doctor}
              className={BTN_SECONDARY}
              >
                <Stethoscope size={13} className="sm:w-[14px] sm:h-[14px]" />
                {t("manager.runDiagnose")}
              </button>
            </div>
          </div>

        {/* 状态卡片 */}
          <div className="glass-surface radius-standard p-4 sm:p-6 shadow-[0_12px_28px_rgba(0,0,0,0.22)] sm:shadow-[0_16px_36px_rgba(0,0,0,0.24)]">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-0 mb-3 sm:mb-4">
            <div>
                <h3 className="text-base sm:text-lg font-semibold text-slate-100">{t("manager.gatewayStatusTitle")}</h3>
                <p className="text-[0.7rem] sm:text-xs text-slate-500 mt-0.5 sm:mt-1 break-all">{t("manager.defaultEntry", { url: chatUrl })}</p>
            </div>
            <StatusDot status={gatewayStatus} />
          </div>

            <div className="grid grid-cols-2 gap-2 sm:gap-3 mb-4 sm:mb-5 text-xs sm:text-sm">
              <div className="bg-slate-900/70 border border-slate-800 rounded-lg sm:rounded-xl p-2.5 sm:p-3.5">
                <p className="text-[0.7rem] sm:text-xs text-slate-500 mb-0.5 sm:mb-1">{t("manager.listenPort")}</p>
              <p className="text-slate-200 font-mono text-xs sm:text-sm">{port}</p>
            </div>
              <div className="bg-slate-900/70 border border-slate-800 rounded-lg sm:rounded-xl p-2.5 sm:p-3.5">
                <p className="text-[0.7rem] sm:text-xs text-slate-500 mb-0.5 sm:mb-1">{t("manager.aiService")}</p>
              <p className="text-slate-200 text-xs sm:text-sm truncate">
                {manifest.api_key_configured
                  ? providerLabel[manifest.api_provider] || manifest.api_provider
                  : <span className="text-yellow-500">{t("manager.notConfigured")}</span>}
              </p>
            </div>
          </div>

          {/* 主操作按钮 */}
            <div className="flex gap-2">
            {gatewayStatus === "running" ? (
              <>
                <button
                  onClick={openChat}
                  disabled={openingChat || chatLocked}
                    className={`${BTN_PRIMARY} flex-1`}
                >
                  {openingChat ? <Loader size={14} className="animate-spin sm:w-[15px] sm:h-[15px]" /> : <ExternalLink size={14} className="sm:w-[15px] sm:h-[15px]" />}
                  {openingChat ? `${t("common.loading")}` : chatLocked ? "..." : t("manager.openChat")}
                </button>
                <button
                  onClick={() => doAction("restart")}
                  disabled={actionLoading !== null}
                  title={t("manager.restart")}
                    className={`${BTN_SECONDARY} w-10 sm:w-11 px-0`}
                >
                  <RefreshCw size={20} className={`w-5 h-5 sm:w-[22px] sm:h-[22px] ${actionLoading === "restart" ? "animate-spin" : ""}`} />
                </button>
                <button
                  onClick={() => doAction("stop")}
                  disabled={actionLoading !== null}
                  title={t("manager.stop")}
                    className={`${BTN_SECONDARY} w-10 sm:w-11 px-0`}
                >
                  <Square size={20} className="w-5 h-5 sm:w-[22px] sm:h-[22px]" />
                </button>
              </>
            ) : gatewayStatus === "starting" ? (
              <div className="flex gap-2 w-full">
                <div className="flex-1 flex items-center justify-center gap-1.5 sm:gap-2 py-2 sm:py-2.5 bg-slate-800 text-slate-400 text-xs sm:text-sm rounded-lg sm:rounded-xl border border-slate-700">
                  <RefreshCw size={20} className="animate-spin w-5 h-5 sm:w-[22px] sm:h-[22px]" />
                  {t("manager.status.starting")}...
                </div>
                <button
                  onClick={() => doAction("force_stop")}
                  disabled={actionLoading !== null}
                    className={BTN_DANGER}
                >
                  <Square size={20} className="w-5 h-5 sm:w-[22px] sm:h-[22px]" />
                  {t("manager.stop")}
                </button>
              </div>
            ) : (
              <button
                onClick={startAndOpenChat}
                disabled={actionLoading !== null || openingChat || chatLocked}
                className={`${BTN_PRIMARY} w-full`}
              >
                {actionLoading === "start_open" || openingChat ? <Loader size={14} className="animate-spin sm:w-[15px] sm:h-[15px]" /> : <ExternalLink size={14} className="sm:w-[15px] sm:h-[15px]" />}
                {actionLoading === "start_open" || openingChat ? `${t("manager.status.starting")}...` : t("manager.startAndOpen")}
              </button>
            )}
          </div>
        </div>

        {/* 错误提示卡片 */}
        {lastError && (
            <div className="bg-red-900/20 border border-red-800/50 rounded-xl sm:rounded-2xl p-3 sm:p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-start gap-2 sm:gap-3 flex-1 min-w-0">
                <AlertTriangle size={16} className="text-red-400 flex-shrink-0 mt-0.5 sm:w-[18px] sm:h-[18px]" />
                <div className="flex-1 min-w-0">
                  <p className="text-xs sm:text-sm text-red-400 break-words">{lastError}</p>
                  {lastErrorHint && (
                    <p className="text-[0.7rem] sm:text-xs text-red-300/70 mt-0.5 sm:mt-1">{lastErrorHint}</p>
                  )}
                </div>
              </div>
              <button
                onClick={() => { setLastError(null); setLastErrorHint(null); }}
                className="text-red-400/50 hover:text-red-400 transition-colors flex-shrink-0"
              >
                <X size={14} className="sm:w-4 sm:h-4" />
              </button>
            </div>
            <div className="flex gap-1.5 sm:gap-2 mt-2 sm:mt-3 pl-5 sm:pl-7">
              <button
                onClick={runDiagnose}
                disabled={actionLoading !== null || !cliCaps?.has_doctor}
                className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 bg-yellow-900/40 hover:bg-yellow-800/50 text-yellow-400 text-[0.7rem] sm:text-xs rounded-md sm:rounded-lg transition-colors disabled:opacity-50"
              >
                <Stethoscope size={11} className="sm:w-3 sm:h-3" />
                {t("manager.runDiagnose")}
              </button>
              <button
                onClick={runFix}
                disabled={actionLoading !== null || !cliCaps?.has_doctor}
                className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 bg-yellow-900/40 hover:bg-yellow-800/50 text-yellow-400 text-[0.7rem] sm:text-xs rounded-md sm:rounded-lg transition-colors disabled:opacity-50"
              >
                <Wrench size={11} className="sm:w-3 sm:h-3" />
                {t("manager.runFix")}
              </button>
            </div>
          </div>
        )}

        {/* 诊断结果面板 */}
          {showDoctorPanel && (
            <div className="bg-slate-900/80 rounded-xl sm:rounded-2xl border border-slate-800 p-3 sm:p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
            <div className="flex items-center justify-between mb-2 sm:mb-3">
              <h4 className="text-xs sm:text-sm font-medium text-slate-200 flex items-center gap-1.5 sm:gap-2">
                <Stethoscope size={14} className="text-yellow-400 sm:w-4 sm:h-4" />
                {t("manager.diagnoseResult")}
              </h4>
              <button
                onClick={() => { setShowDoctorPanel(false); setDoctorResult(null); }}
                className="text-slate-500 hover:text-slate-300 transition-colors"
              >
                <X size={14} className="sm:w-4 sm:h-4" />
              </button>
            </div>
            
            {actionLoading === "diagnose" ? (
              <div className="flex items-center gap-1.5 sm:gap-2 text-slate-400 text-xs sm:text-sm">
                <Loader size={13} className="animate-spin sm:w-[14px] sm:h-[14px]" />
                {t("manager.diagnosing")}
              </div>
            ) : doctorResult ? (
              <div className="space-y-1.5 sm:space-y-2">
                <div className={`text-xs sm:text-sm ${doctorResult.passed ? "text-green-400" : "text-yellow-400"}`}>
                  {doctorResult.summary}
                </div>
                {doctorResult.issues.length > 0 && (
                  <ul className="text-[0.7rem] sm:text-xs space-y-0.5 sm:space-y-1 pl-1.5 sm:pl-2 border-l-2 border-slate-700">
                    {doctorResult.issues.map((issue, i) => (
                      <li key={i} className={`pl-1.5 sm:pl-2 break-words ${issue.severity === "error" ? "text-red-400" : "text-yellow-500"}`}>
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-1.5 sm:gap-2 mt-2 sm:mt-3">
                  <button
                    onClick={runFix}
                    disabled={actionLoading !== null || doctorResult.passed}
                    className="flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 bg-yellow-900/40 hover:bg-yellow-800/50 text-yellow-400 text-[0.7rem] sm:text-xs rounded-md sm:rounded-lg transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "fix" ? <Loader size={11} className="animate-spin sm:w-3 sm:h-3" /> : <Wrench size={11} className="sm:w-3 sm:h-3" />}
                    {actionLoading === "fix" ? `${t("manager.runFix")}...` : t("manager.runFixNow")}
                  </button>
                  <button
                    onClick={runDiagnose}
                    disabled={actionLoading !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-slate-300 text-xs rounded-lg transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={12} />
                    {t("manager.rediagnose")}
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-500">{t("manager.clickDiagnose")}</p>
            )}
          </div>
        )}

        {/* 快捷操作列表 */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <ActionGroup
              title={t("manager.group.common")}
              hint={t("manager.group.commonHint")}
              highlight={configMissing}
              recommendedLabel={t("manager.recommended")}
            >
              <ActionRow
                icon={<FileEdit size={16} className="text-brand-400" />}
                label={t("manager.action.configFull")}
                desc={configMissing ? t("manager.action.configFullDescMissing") : t("manager.action.configFullDescReady")}
                onClick={() => setShowConfigPanel(true)}
              />
              <ActionRow
                icon={<FileEdit size={16} />}
                label={t("manager.action.configApi")}
                desc={manifest.api_key_configured ? t("manager.action.configApiDescReady") : t("manager.action.configApiDescMissing")}
                onClick={async () => {
                  try {
                    await invoke("open_config_file");
                  } catch (e) {
                    console.error("打开配置文件失败:", e);
                  }
                }}
              />
              <ActionRow
                icon={<FolderOpen size={16} />}
                label={t("manager.action.installDir")}
                desc={manifest.install_dir}
                onClick={async () => {
                  try {
                    await invoke("open_folder", { path: manifest.install_dir });
                  } catch (e) {
                    console.error("打开目录失败:", e);
                  }
                }}
              />
            </ActionGroup>

            <ActionGroup title={t("manager.group.maintenance")} hint={t("manager.group.maintenanceHint")}>
              <ActionRow
                icon={<Stethoscope size={16} className="text-yellow-400" />}
                label={t("manager.action.diagFix")}
                desc={t("manager.action.diagFixDesc")}
                loading={actionLoading === "diagnose"}
                onClick={runDiagnose}
              />
              <ActionRow
                icon={<FolderOpen size={16} className="text-blue-400" />}
                label={t("manager.action.installerLogs")}
                desc="%USERPROFILE%\\.openclaw\\installer-logs"
                onClick={openLogDirectory}
              />
              <ActionRow
                icon={<FolderOpen size={16} className="text-blue-400" />}
                label={t("manager.action.runtimeLogs")}
                desc="<install_dir>\\logs"
                onClick={openRuntimeLogDirectory}
              />
            </ActionGroup>

            <ActionGroup title={t("manager.group.danger")} hint={t("manager.group.dangerHint")}>
              <ActionRow
                danger
                icon={<Trash2 size={16} className="text-red-400" />}
                label={<span className="text-red-400">{t("manager.action.uninstall")}</span>}
                desc={t("manager.action.uninstallDesc")}
                loading={actionLoading === "uninstall"}
                onClick={async () => {
                  if (!confirm(t("manager.uninstallConfirm"))) return;
                  setActionLoading("uninstall");
                  try {
                    await invoke("kill_gateway_process", { installDir: manifest.install_dir, port });
                    await invoke("uninstall", { installDir: manifest.install_dir });
                    alert(t("manager.uninstallDone"));
                    if (isTauri) {
                      const { getCurrentWindow } = await import("@tauri-apps/api/window");
                      await getCurrentWindow().close();
                    }
                  } catch (e) {
                    alert(t("manager.uninstallFailed", { error: String(e) }));
                  } finally {
                    setActionLoading(null);
                  }
                }}
              />
            </ActionGroup>
          </div>

        {/* 版本信息 */}
          <p className="text-center text-xs text-slate-700">
              OpenClaw Manager v{manifest.version} · {t("success.installDir")}: {manifest.install_dir}
        </p>
        </div>
      </div>

      {showConfigPanel && (
        <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-5xl h-[88vh] bg-slate-950 border border-slate-800 rounded-2xl p-5 flex flex-col overflow-hidden shadow-2xl">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-base font-semibold text-slate-100">{t("manager.configModalTitle")}</h3>
              <button
                onClick={() => setShowConfigPanel(false)}
                className="w-8 h-8 rounded-lg bg-slate-900 border border-slate-700 text-slate-500 hover:text-slate-300 hover:border-slate-600 transition-colors flex items-center justify-center"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex-1 min-h-0">
              <UnifiedConfigPanel
                cliCaps={cliCaps}
                mode="manager"
                onCancel={() => setShowConfigPanel(false)}
                onDone={async (summary) => {
                  await refreshManifestState();
                  setShowConfigPanel(false);
                  if (summary?.hint) {
                    setLastErrorHint(summary.hint);
                  }
                  if (summary?.message) {
                    setLastError(null);
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionRow({
  icon,
  label,
  desc,
  loading,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  desc: string;
  loading?: boolean;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className={`w-full flex items-center gap-3 px-4 py-4 transition-colors text-left disabled:opacity-50 rounded-xl
        ${danger ? "hover:bg-red-900/20" : "hover:bg-slate-800/70"}
      `}
    >
      <span className="w-8 h-8 rounded-lg bg-slate-800 border border-slate-700 text-slate-300 flex items-center justify-center flex-shrink-0">
        {loading ? <Loader size={16} className="animate-spin" /> : icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-slate-100">{label}</div>
        <div className="text-xs text-slate-500 mt-1 truncate">{desc}</div>
      </div>
      <ChevronRight size={14} className="text-slate-600 flex-shrink-0" />
    </button>
  );
}

function ActionGroup({
  title,
  hint,
  highlight = false,
  recommendedLabel = "Recommended",
  children,
}: {
  title: string;
  hint: string;
  highlight?: boolean;
  recommendedLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-2xl overflow-hidden transition-all duration-200
        ${highlight
          ? "bg-brand-500/5 border border-brand-400/40 shadow-[0_0_0_1px_rgba(16,185,129,0.2)]"
          : "bg-slate-900/80 border border-slate-800 hover:border-slate-700"
        }
      `}
    >
      <div className={`px-4 py-3 border-b ${highlight ? "border-brand-400/30" : "border-slate-800"}`}>
        <p className="text-sm font-medium text-slate-100 flex items-center gap-2">
          {title}
          {highlight && (
            <span className="text-[10px] px-2 py-0.5 rounded-full border border-brand-400/50 text-brand-300 bg-brand-500/10">
              {recommendedLabel}
            </span>
          )}
        </p>
        <p className="text-xs text-slate-500 mt-1">{hint}</p>
      </div>
      <div className="divide-y divide-slate-800">{children}</div>
    </div>
  );
}
