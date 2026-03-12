import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertCircle, CheckCircle, Eye, EyeOff, Loader, Terminal } from "lucide-react";
import type {
  ApiProvider,
  ApiProviderConfig,
  CliCapabilities,
  CommandResult,
  OnboardingSummary,
  SavedApiConfig,
  SavedFeishuConfig,
} from "../types";
import { useI18n } from "../i18n/useI18n";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const BTN_PRIMARY = "flex items-center gap-2 px-6 py-2.5 bg-brand-500 hover:bg-brand-600 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 font-semibold text-sm rounded-xl transition-colors";
const BTN_TEXT = "text-sm text-slate-500 hover:text-slate-300 transition-colors px-2 py-1";

type LaunchMode = "web" | "tui";

function Toggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange?.(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 transition-colors duration-200 ease-in-out focus:outline-none
        ${checked
          ? disabled
            ? "bg-brand-500/50 border-brand-500/30 cursor-not-allowed"
            : "bg-brand-500 border-brand-500/80 cursor-pointer"
          : disabled
            ? "bg-slate-700/50 border-slate-700/30 cursor-not-allowed"
            : "bg-slate-700 border-slate-700 cursor-pointer"
        }`}
    >
      <span
        className={`pointer-events-none inline-block h-3.5 w-3.5 mt-px rounded-full bg-white shadow transition-transform duration-200 ease-in-out
          ${checked ? "translate-x-4" : "translate-x-0"}`}
      />
    </button>
  );
}
type ItemState = "run" | "skip" | "unsupported";
type ValidateState = "idle" | "validating" | "ok" | "error";

interface ValidateResult {
  status: string;
  message: string;
}

interface Props {
  cliCaps: CliCapabilities | null;
  cliCapsLoading?: boolean;
  mode: "wizard" | "manager";
  onDone: (summary: OnboardingSummary | null) => void;
  onCancel?: () => void;
}

const PROVIDERS: ApiProviderConfig[] = [
  {
    id: "anthropic",
    name: "Anthropic Claude",
    keyPrefix: "sk-ant-",
    defaultBaseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5"],
    placeholder: "sk-ant-api03-...",
  },
  {
    id: "openai",
    name: "OpenAI GPT",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
    placeholder: "sk-...",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    keyPrefix: "sk-",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
    placeholder: "sk-...",
  },
  {
    id: "custom",
    name: "", // use t("config.providerCustomName") when rendering
    keyPrefix: "",
    defaultBaseUrl: "",
    models: [],
    placeholder: "", // use t("config.placeholderApiKey") when rendering
  },
];

export default function UnifiedConfigPanel({ cliCaps, cliCapsLoading = false, mode, onDone, onCancel }: Props) {
  const { t } = useI18n();
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const progressPanelRef = useRef<HTMLDivElement | null>(null);

  const [provider, setProvider] = useState<ApiProvider>("anthropic");
  const [model, setModel] = useState(PROVIDERS[0].models[0] || "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [skipApiConfig, setSkipApiConfig] = useState(false);

  const [installDaemon] = useState(true);
  const [enableChannel, setEnableChannel] = useState(false);
  const [channel, setChannel] = useState("feishu");
  const [feishuAppId, setFeishuAppId] = useState("");
  const [feishuAppSecret, setFeishuAppSecret] = useState("");
  const [showFeishuSecret, setShowFeishuSecret] = useState(false);
  const [feishuValidateState, setFeishuValidateState] = useState<ValidateState>("idle");
  const [feishuValidateMsg, setFeishuValidateMsg] = useState("");
  const [installSkills, setInstallSkills] = useState(false);
  const [installHooks, setInstallHooks] = useState(false);
  const [launchMode, setLaunchMode] = useState<LaunchMode>("web");

  const [running, setRunning] = useState(false);
  const [runPhase, setRunPhase] = useState<string>("");
  const [runDetailKey, setRunDetailKey] = useState<string | null>(null);
  const [runDetailVars, setRunDetailVars] = useState<Record<string, string | number>>({});
  const [runElapsed, setRunElapsed] = useState(0);
  const visualProgress = runPhase === "done" ? 100 : Math.min(95, runElapsed * 2);
  const runTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [localCaps, setLocalCaps] = useState<CliCapabilities | null>(null);
  const [capsLoading, setCapsLoading] = useState(false);

  const [detectedConfig, setDetectedConfig] = useState<SavedApiConfig | null>(null);
  const detectedMsg = useMemo(() => {
    if (!detectedConfig) return "";
    const prov = (savedProvider: string) =>
      savedProvider === "custom" ? t("config.providerCustom") : savedProvider;
    return t("config.detectedApi", {
      provider: (["anthropic", "openai", "deepseek", "custom"] as const).includes(detectedConfig.provider as ApiProvider)
        ? prov(detectedConfig.provider)
        : t("config.providerCustom"),
    });
  }, [detectedConfig, t]);

  const pConfig = PROVIDERS.find((p) => p.id === provider)!;
  const effectiveBaseUrl = baseUrl || pConfig.defaultBaseUrl;
  const effectiveModel = model || pConfig.models[0] || "";
  const feishuEnabled = enableChannel && channel === "feishu";
  const feishuReady = !feishuEnabled || (!!feishuAppId.trim() && !!feishuAppSecret.trim());
  const keyValid =
    skipApiConfig ||
    (apiKey.length > 10 &&
      (pConfig.keyPrefix === "" || apiKey.startsWith(pConfig.keyPrefix)));
  const baseUrlValid =
    skipApiConfig ||
    provider !== "custom" ||
    (() => {
      try {
        const u = new URL(effectiveBaseUrl);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    })();

  const effectiveCaps = useMemo(() => localCaps || cliCaps, [localCaps, cliCaps]);
  const normFlags = new Set((effectiveCaps?.onboarding_flags || []).map((f) => f.replace(/^--/, "").toLowerCase()));
  const hasFlag = (name: string) => normFlags.has(name.toLowerCase()) || normFlags.has(name.replace(/^--/, "").toLowerCase());

  useEffect(() => {
    if (!isTauri) return;
    const unlisten = listen<{ phase: string; detail?: string; detail_key?: string; detail_vars?: Record<string, string | number> }>(
      "onboarding-progress",
      (e) => {
        setRunPhase(e.payload.phase);
        if (e.payload.detail_key != null) {
          setRunDetailKey(e.payload.detail_key);
          setRunDetailVars(e.payload.detail_vars ?? {});
        } else {
          setRunDetailKey(null);
          setRunDetailVars({});
        }
      }
    );
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    if (running) {
      setRunElapsed(0);
      runTimerRef.current = setInterval(() => setRunElapsed((s) => s + 1), 1000);
      requestAnimationFrame(() => {
        progressPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
      });
    } else if (runTimerRef.current) {
      clearInterval(runTimerRef.current);
      runTimerRef.current = null;
    }
    return () => { if (runTimerRef.current) clearInterval(runTimerRef.current); };
  }, [running]);

  useEffect(() => {
    if (!isTauri || cliCaps || mode === "wizard") return;
    setCapsLoading(true);
    invoke<CliCapabilities>("detect_cli_capabilities")
      .then((caps) => setLocalCaps(caps))
      .catch(() => {})
      .finally(() => setCapsLoading(false));
  }, [cliCaps, mode]);

  useEffect(() => {
    if (!isTauri) return;
    invoke<SavedApiConfig | null>("get_saved_api_config")
      .then((saved) => {
        if (!saved || !saved.api_key) return;
        const savedProvider = (["anthropic", "openai", "deepseek", "custom"] as const).includes(saved.provider as ApiProvider)
          ? (saved.provider as ApiProvider)
          : "custom";
        setProvider(savedProvider);
        setApiKey(saved.api_key);
        setBaseUrl(saved.base_url || "");
        setModel(saved.model || "");
        setDetectedConfig(saved);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!isTauri) return;
    invoke<SavedFeishuConfig | null>("get_saved_feishu_config")
      .then((saved) => {
        if (!saved) return;
        setFeishuAppId(saved.app_id || "");
        setFeishuAppSecret(saved.app_secret || "");
        if (saved.app_id || saved.app_secret) {
          setEnableChannel(true);
        }
        setFeishuValidateState("ok");
        setFeishuValidateMsg(t("config.feishuDetected"));
      })
      .catch(() => {});
  }, []);

  // 当 effectiveCaps 为 null 时（CLI 探测仍在进行），乐观假设所有能力都支持，
  // 避免在探测结果到来前误报"版本不支持"
  const cliLoading = cliCapsLoading || capsLoading;
  // daemon 是必选参数，始终传入，不受 CLI 版本能力影响
  const supportsChannel = true;
  const supportsInstallSkills = cliLoading || !effectiveCaps ? true : hasFlag("install-skills");
  const supportsInstallHooks = cliLoading || !effectiveCaps ? true : hasFlag("install-hooks");
  const supportsUiMode = true;

  const commandParts: string[] = ["openclaw onboard", "--non-interactive", "--accept-risk"];
  if (installDaemon) commandParts.push("--install-daemon");
  if (!enableChannel) commandParts.push("--skip-channels");
  if (feishuEnabled && feishuAppId.trim() && feishuAppSecret.trim()) {
    commandParts.push("--feishu-app-id ***");
    commandParts.push("--feishu-app-secret ***");
  }
  if (!installSkills) commandParts.push("--skip-skills");
  if (!installHooks) commandParts.push("--skip-hooks");
  // web/tui 为默认行为，onboard 自动处理，无需传参
  if (!skipApiConfig) {
    if (provider === "anthropic") commandParts.push("--auth-choice anthropic-api-key");
    if (provider === "openai") commandParts.push("--auth-choice openai-api-key");
    if (provider === "deepseek" || provider === "custom") commandParts.push("--auth-choice custom-api-key");
    if (apiKey) commandParts.push("--api-key ***");
  }
  const commandPreview = commandParts.join(" ");

  const stateStyle: Record<ItemState, string> = {
    run: "text-emerald-300 border-emerald-400/40 bg-emerald-500/10",
    skip: "text-slate-400 border-slate-600 bg-slate-800/60",
    unsupported: "text-yellow-400 border-yellow-500/40 bg-yellow-500/10",
  };
  const stateLabel: Record<ItemState, string> = {
    run: t("config.stateRun"),
    skip: t("config.stateSkip"),
    unsupported: t("config.stateUnsupported"),
  };

  const daemonState: ItemState = "run";
  const channelState: ItemState = enableChannel ? (supportsChannel ? "run" : "unsupported") : "skip";
  const feishuState: ItemState = feishuEnabled
    ? (feishuReady ? "run" : "skip")
    : "skip";
  const skillsState: ItemState = installSkills ? (supportsInstallSkills ? "run" : "unsupported") : "skip";
  const hooksState: ItemState = installHooks ? (supportsInstallHooks ? "run" : "unsupported") : "skip";
  const launchState: ItemState = supportsUiMode ? "run" : "unsupported";

  const buildReason = (key: string, state: ItemState): string => {
    if (state === "skip") {
      if (key === "api") return t("config.reasonSkipApi");
      if (key === "launch") return t("config.reasonSkipLaunch");
      return t("config.reasonUserDisabled");
    }
    if (state === "unsupported") {
      if (key === "channel") return t("config.reasonNoChannel");
      if (key === "skills") return t("config.reasonNoSkills");
      if (key === "hooks") return t("config.reasonNoHooks");
      if (key === "launch") return t("config.reasonNoLaunch");
      return t("config.reasonNoParam");
    }
    if (key === "api") return t("config.reasonApi");
    if (key === "daemon") return t("config.reasonDaemon");
    if (key === "channel") return t("config.reasonChannel");
    if (key === "feishu") return t("config.reasonFeishu");
    if (key === "skills") return t("config.reasonSkills");
    if (key === "hooks") return t("config.reasonHooks");
    if (key === "launch") return launchMode === "web" ? t("config.reasonLaunchWeb") : t("config.reasonLaunchTui");
    return t("config.reasonDefault");
  };

  function resetToBlank() {
    setProvider("anthropic");
    setApiKey("");
    setBaseUrl("");
    setModel("");
    setDetectedConfig(null);
    setSkipApiConfig(false);
    requestAnimationFrame(() => {
      apiKeyInputRef.current?.focus();
    });
  }

  async function runConfig() {
    if (!keyValid || !baseUrlValid || !feishuReady) {
      return;
    }
    setRunning(true);
    setRunPhase("preparing");
    setRunDetailKey(null);
    setRunDetailVars({});
    setError(null);
    setHint(null);
    try {
      if (!isTauri) {
        await new Promise((r) => setTimeout(r, 500));
        onDone({
          command: commandPreview,
          message: t("config.previewSkipped"),
          hint: null,
        });
        return;
      }
      // 注意：has_onboarding=false 可能是 CLI 探测时找不到命令（PATH 问题）而非真正不支持
      // 此处仅在确认 CLI 存在但明确不包含 onboard 命令时才跳过，避免误杀
      // 实际 run_onboarding_guided 在 Rust 端有自己的错误处理

      if (feishuEnabled) {
        const passed = await validateFeishuConnectivity();
        if (!passed) return;
      }

      const result = await invoke<CommandResult>("run_onboarding_guided", {
        apiKey: skipApiConfig ? "" : apiKey,
        provider: skipApiConfig ? "skip" : provider,
        baseUrl: skipApiConfig ? null : (effectiveBaseUrl || null),
        model: skipApiConfig ? null : (effectiveModel || null),
        installDaemon,
        channel: enableChannel ? channel : null,
        feishuAppId: feishuEnabled ? feishuAppId.trim() : null,
        feishuAppSecret: feishuEnabled ? feishuAppSecret.trim() : null,
        installSkills,
        installHooks,
        launchMode: launchMode,
      });

      if (!result.success) {
        setError(result.message || t("config.execFailed"));
        setHint(result.hint || null);
        return;
      }

      if (result.hint) {
        setHint(result.hint);
      }
      onDone({
        command: result.command || commandPreview,
        message: result.message || t("config.execDone"),
        hint: result.hint || null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  async function validateFeishuConnectivity() {
    if (!feishuEnabled) return true;
    if (!feishuAppId.trim() || !feishuAppSecret.trim()) {
      setFeishuValidateState("error");
      setFeishuValidateMsg(t("config.feishuFillFirst"));
      return false;
    }
    setFeishuValidateState("validating");
    setFeishuValidateMsg(t("config.feishuValidating"));
    try {
      const result = await invoke<ValidateResult>("validate_feishu_connectivity", {
        appId: feishuAppId.trim(),
        appSecret: feishuAppSecret.trim(),
      });
      if (result.status === "ok") {
        setFeishuValidateState("ok");
        setFeishuValidateMsg(result.message || t("config.feishuOk"));
        return true;
      }
      setFeishuValidateState("error");
      setFeishuValidateMsg(result.message || t("config.feishuFail"));
      return false;
    } catch (e) {
      setFeishuValidateState("error");
      setFeishuValidateMsg(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  const title = mode === "wizard" ? t("config.title.wizard") : t("config.title.manager");
  const subtitle = mode === "wizard" ? t("config.subtitle.wizard") : t("config.subtitle.manager");
  return (
    <div className="h-full flex flex-col">
      {/* ── Scrollable content ── */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-5 pb-2">
      {/* Wizard 模式下由 OnboardingSetup 已展示步骤标题与描述，此处仅保留提示文案；弹窗时展示完整标题与描述 */}
      <div>
        {mode === "manager" && (
          <>
            <h2 className="text-xl font-semibold text-slate-100 tracking-tight">{title}</h2>
            <p className="text-sm text-slate-400 mt-1">{subtitle}</p>
          </>
        )}
        {detectedMsg && <p className="text-xs text-brand-300 mt-2">{detectedMsg}</p>}
        {(cliCapsLoading || capsLoading) && <p className="text-xs text-slate-500 mt-1">{t("config.detectingCli")}</p>}
      </div>

      <div className="bg-gradient-to-b from-slate-900 to-slate-900/70 rounded-2xl border border-slate-800 p-5 flex flex-col gap-5 shadow-sm">
        <div className="border-b border-slate-800 pb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-slate-100">{t("config.section.api")}</p>
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <span>{t("config.skipApi")}</span>
              <Toggle checked={skipApiConfig} onChange={setSkipApiConfig} />
            </div>
          </div>

          {detectedConfig && (
            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 mb-3">
              <p className="text-xs text-slate-400">{t("config.detectedConfig")}</p>
              <div className="mt-1.5 text-xs text-slate-300 space-y-1">
                <p>Provider: {detectedConfig.provider || "-"}</p>
                <p>Base URL: {detectedConfig.base_url || t("config.default")}</p>
                <p>Model: {detectedConfig.model || t("config.notRecorded")}</p>
              </div>
              <button
                onClick={resetToBlank}
                className="mt-2 text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2 transition-colors"
              >
                {t("config.resetToBlank")}
              </button>
            </div>
          )}

          {!skipApiConfig && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      setProvider(p.id);
                      setBaseUrl("");
                      setModel(p.models[0] || "");
                    }}
                    className={`text-left p-3.5 rounded-xl border text-sm transition-all
                      ${provider === p.id
                        ? "border-brand-400 bg-brand-400/10 text-brand-300 shadow-[0_0_0_2px_rgba(16,185,129,0.08)]"
                        : "border-slate-700 bg-slate-900 text-slate-400 hover:border-slate-600 hover:text-slate-300"
                      }`}
                  >
                    {p.id === "custom" ? t("config.providerCustomName") : p.name}
                  </button>
                ))}
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">{t("config.model")}</label>
                {provider === "custom" ? (
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={t("config.modelPlaceholder")}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-brand-400 font-mono"
                    style={{ userSelect: "text" }}
                  />
                ) : (
                  <select
                    value={effectiveModel}
                    onChange={(e) => setModel(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-brand-400"
                  >
                    {(pConfig.models || []).map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                )}
              </div>

              {provider === "custom" && (
                <div>
                  <label className="block text-xs text-slate-400 mb-1">{t("config.baseUrlRequired")}</label>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder="https://your-api-proxy.com/v1"
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-brand-400"
                    style={{ userSelect: "text" }}
                  />
                  {baseUrl && !baseUrlValid && (
                    <p className="text-xs text-yellow-500 mt-1">
                      {t("config.baseUrlInvalid")}
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  API Key
                  {pConfig.keyPrefix && (
                    <span className="text-slate-600 ml-1">{t("config.apiKeyPrefix", { prefix: pConfig.keyPrefix })}</span>
                  )}
                </label>
                <div className="relative">
                  <input
                    ref={apiKeyInputRef}
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={pConfig.id === "custom" ? t("config.placeholderApiKey") : pConfig.placeholder}
                    className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 pr-10 text-sm text-slate-200 outline-none focus:border-brand-400 font-mono"
                    style={{ userSelect: "text" }}
                  />
                  <button
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                  >
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                {apiKey && !keyValid && pConfig.keyPrefix && (
                  <p className="text-xs text-yellow-500 mt-1">
                    {t("config.keyFormatInvalid", { name: pConfig.name || pConfig.id, prefix: pConfig.keyPrefix })}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3">
            <div>
              <p className="text-sm text-slate-200">{t("config.installDaemon")}</p>
              <p className="text-xs text-slate-500 mt-0.5">{t("config.installDaemonDesc")}</p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-brand-400/80">{t("config.daemonOn")}</span>
              <Toggle checked={true} disabled={true} />
            </div>
          </div>

          <div className="border-t border-slate-800 pt-3">
            <div className="flex items-center justify-between bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3">
              <div>
                <p className="text-sm text-slate-200">{t("config.channel")}</p>
                <p className="text-xs text-slate-500 mt-0.5">{t("config.channelDesc")}</p>
              </div>
              <Toggle checked={enableChannel} onChange={setEnableChannel} />
            </div>
          </div>
          {enableChannel && (
            <div className="mt-2 space-y-3">
              <select
                value={channel}
                onChange={(e) => {
                  setChannel(e.target.value);
                  setFeishuValidateState("idle");
                  setFeishuValidateMsg("");
                }}
                className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-200"
              >
                <option value="feishu">{t("config.feishuOption")}</option>
                <option value="none">{t("config.channelNone")}</option>
              </select>

              {channel === "feishu" && (
                <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 space-y-3">
                  <p className="text-xs text-slate-400">{t("config.feishuConfig")}</p>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">App ID</label>
                    <input
                      type="text"
                      value={feishuAppId}
                      onChange={(e) => {
                        setFeishuAppId(e.target.value);
                        setFeishuValidateState("idle");
                        setFeishuValidateMsg("");
                      }}
                      placeholder="cli_xxxxxxxxxxxxx"
                      className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-200 outline-none focus:border-brand-400 font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">App Secret</label>
                    <div className="relative">
                      <input
                        type={showFeishuSecret ? "text" : "password"}
                        value={feishuAppSecret}
                        onChange={(e) => {
                          setFeishuAppSecret(e.target.value);
                          setFeishuValidateState("idle");
                          setFeishuValidateMsg("");
                        }}
                        placeholder={t("config.feishuAppSecretPlaceholder")}
                        className="w-full bg-slate-800 border border-slate-700 rounded-xl px-3 py-2.5 pr-10 text-sm text-slate-200 outline-none focus:border-brand-400 font-mono"
                      />
                      <button
                        onClick={() => setShowFeishuSecret(!showFeishuSecret)}
                        className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                      >
                        {showFeishuSecret ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <button
                      onClick={validateFeishuConnectivity}
                      disabled={feishuValidateState === "validating" || !feishuAppId.trim() || !feishuAppSecret.trim()}
                      className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 rounded-lg border border-slate-700 transition-colors"
                    >
                      {feishuValidateState === "validating" ? t("config.validating") : t("config.validateFeishu")}
                    </button>
                    {feishuValidateState !== "idle" && (
                      <p className={`text-xs flex items-center gap-1.5 ${feishuValidateState === "ok" ? "text-emerald-300" : feishuValidateState === "error" ? "text-red-400" : "text-slate-400"}`}>
                        {feishuValidateState === "ok" && <CheckCircle size={13} />}
                        {feishuValidateState === "error" && <AlertCircle size={13} />}
                        {feishuValidateState === "validating" && <Loader size={13} className="animate-spin" />}
                        {feishuValidateMsg}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-slate-800 pt-3">
          <div className="flex items-center justify-between bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3">
            <div>
              <p className="text-sm text-slate-200">{t("config.installSkills")}</p>
              <p className="text-xs text-slate-500 mt-0.5">{t("config.installSkillsDesc")}</p>
            </div>
            <Toggle checked={installSkills} onChange={setInstallSkills} />
          </div>

          <div className="flex items-center justify-between bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3">
            <div>
              <p className="text-sm text-slate-200">{t("config.installHooks")}</p>
              <p className="text-xs text-slate-500 mt-0.5">{t("config.installHooksDesc")}</p>
            </div>
            <Toggle checked={installHooks} onChange={setInstallHooks} />
          </div>
        </div>

        <div className="border-t border-slate-800 pt-4">
          <p className="text-sm text-slate-200 mb-2">
            {t("config.launchMode")}
            <span className="ml-2 text-xs text-slate-500">{t("config.launchModeRequired")}</span>
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setLaunchMode("web")}
              className={`text-sm rounded-xl px-3 py-2.5 border transition-colors ${launchMode === "web" ? "border-brand-400 text-brand-300 bg-brand-500/10" : "border-slate-700 text-slate-400 hover:border-slate-600"}`}
            >
              {t("config.webDefault")}
            </button>
            <button
              onClick={() => setLaunchMode("tui")}
              className={`text-sm rounded-xl px-3 py-2.5 border transition-colors ${launchMode === "tui" ? "border-brand-400 text-brand-300 bg-brand-500/10" : "border-slate-700 text-slate-400 hover:border-slate-600"}`}
            >
              {t("config.tui")}
            </button>
          </div>
        </div>

        <div className="border-t border-slate-800 pt-4">
          <p className="text-xs text-slate-500 mb-1">{t("config.commandPreview")}</p>
          <p className="text-xs text-slate-300 font-mono break-all bg-slate-900 border border-slate-800 rounded-xl px-3 py-2">
            {commandPreview}
          </p>
          <p className="text-[11px] text-slate-600 mt-1">
            {t("config.commandPreviewHint")}
          </p>
        </div>

        <div className="border-t border-slate-800 pt-4">
          <p className="text-xs text-slate-500 mb-2">
            {t("config.substepStatus")}
            {cliLoading && <span className="ml-2 text-slate-600">{t("config.cliDetecting")}</span>}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {[
              { key: "api", label: t("config.labelApi"), state: skipApiConfig ? "skip" : "run" as ItemState },
              { key: "daemon", label: t("config.labelDaemon"), state: daemonState },
              { key: "channel", label: "channel", state: channelState },
              { key: "feishu", label: t("config.labelFeishu"), state: feishuState },
              { key: "skills", label: "skills", state: skillsState },
              { key: "hooks", label: "hooks", state: hooksState },
              { key: "launch", label: `${t("config.labelLaunch")}(${launchMode})`, state: launchState },
            ].map((item) => (
              <div key={item.label} className="text-xs border border-slate-800 rounded-xl px-3 py-2 bg-slate-900/60">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">{item.label}</span>
                  <span className={`px-1.5 py-0.5 rounded border ${stateStyle[item.state]}`}>
                    {stateLabel[item.state]}
                  </span>
                </div>
                <p className="text-[11px] text-slate-500 mt-1">{buildReason(item.key, item.state)}</p>
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {hint && <p className="text-xs text-yellow-500">{hint}</p>}
      </div>
      </div>{/* ── End scrollable content ── */}

      {/* ── Fixed footer: always visible at bottom ── */}
      {running ? (
        <div ref={progressPanelRef} className="flex-shrink-0 border border-slate-700 rounded-2xl overflow-hidden bg-slate-900/95 mt-2 shadow-[0_-4px_16px_rgba(0,0,0,0.3)]">
          {/* Progress bar with shimmer */}
          <div className="h-1.5 w-full bg-white/5 relative overflow-hidden">
            <div
              className="absolute top-0 left-0 h-full bg-brand-500 shadow-[0_0_12px_rgba(0,229,255,0.6)] transition-all duration-1000 ease-out"
              style={{ width: `${visualProgress}%` }}
            />
            <div className="absolute top-0 left-0 h-full w-full">
              <div className="h-full bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
            </div>
          </div>

          <div className="px-4 py-3 flex items-center gap-3">
            <Terminal size={14} className="text-brand-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm text-slate-200 truncate">
                {runPhase === "running"
                  ? t("config.progressRunning")
                  : runPhase === "launching"
                    ? t("config.progressLaunching")
                    : t("config.progressPreparing")}
              </p>
              {runDetailKey && (
                <p className="text-xs text-slate-500 mt-0.5 truncate">
                  {t(runDetailKey, runDetailVars as Record<string, string | number>)}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Loader size={14} className="text-brand-400 animate-spin" />
              <span className="text-xs text-slate-500 font-mono">{runElapsed}s</span>
            </div>
          </div>

          {isTauri && runPhase === "running" && (
            <div className="px-4 py-2 bg-yellow-500/10 border-t border-yellow-500/20">
              <p className="text-[0.68rem] text-yellow-300">
                {t("config.psWindowHint")}
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="flex-shrink-0 flex items-center justify-between pt-3 border-t border-slate-800/50">
          <div className="flex items-center gap-3">
            {onCancel && (
              <button
                onClick={onCancel}
                disabled={running}
                className={BTN_TEXT}
              >
                {t("config.cancel")}
              </button>
            )}
            {mode === "wizard" && (
              <button
                onClick={() => onDone({
                  command: "",
                  message: t("config.userSkippedConfig"),
                  hint: null,
                })}
                disabled={running}
                className={BTN_TEXT}
              >
                {t("config.skipAndContinue")}
              </button>
            )}
          </div>
          <button
            onClick={runConfig}
            disabled={running || !keyValid || !baseUrlValid || !feishuReady || (!skipApiConfig && !effectiveModel)}
            className={BTN_PRIMARY}
          >
            {mode === "wizard" ? t("config.runAndContinue") : t("config.saveAndApply")}
          </button>
        </div>
      )}
    </div>
  );
}
