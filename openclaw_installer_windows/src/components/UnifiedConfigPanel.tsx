import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertCircle, CheckCircle, Eye, EyeOff, Loader } from "lucide-react";
import type {
  ApiProvider,
  ApiProviderConfig,
  CliCapabilities,
  CommandResult,
  OnboardingSummary,
  SavedApiConfig,
  SavedFeishuConfig,
} from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const BTN_PRIMARY = "flex items-center gap-2 px-6 py-2.5 bg-brand-500 hover:bg-brand-600 disabled:bg-slate-700 disabled:text-slate-500 text-slate-950 font-semibold text-sm rounded-xl transition-colors";
const BTN_TEXT = "text-sm text-slate-500 hover:text-slate-300 transition-colors px-2 py-1";

type LaunchMode = "web" | "tui" | "skip";
type ItemState = "run" | "skip" | "unsupported";
type ValidateState = "idle" | "validating" | "ok" | "error";

interface ValidateResult {
  status: string;
  message: string;
}

interface Props {
  cliCaps: CliCapabilities | null;
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
    name: "自定义 API（OpenAI 兼容）",
    keyPrefix: "",
    defaultBaseUrl: "",
    models: [],
    placeholder: "输入您的 API Key",
  },
];

export default function UnifiedConfigPanel({ cliCaps, mode, onDone, onCancel }: Props) {
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);

  const [provider, setProvider] = useState<ApiProvider>("anthropic");
  const [model, setModel] = useState(PROVIDERS[0].models[0] || "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [skipApiConfig, setSkipApiConfig] = useState(false);

  const [installDaemon, setInstallDaemon] = useState(true);
  const [enableChannel, setEnableChannel] = useState(true);
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
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [localCaps, setLocalCaps] = useState<CliCapabilities | null>(null);
  const [capsLoading, setCapsLoading] = useState(false);

  const [detectedMsg, setDetectedMsg] = useState("");
  const [detectedConfig, setDetectedConfig] = useState<SavedApiConfig | null>(null);

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
    if (!isTauri || cliCaps) return;
    setCapsLoading(true);
    invoke<CliCapabilities>("detect_cli_capabilities")
      .then((caps) => setLocalCaps(caps))
      .catch(() => {})
      .finally(() => setCapsLoading(false));
  }, [cliCaps]);

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
        setDetectedMsg(`已检测到 ${savedProvider === "custom" ? "自定义" : savedProvider} 的 API 配置，已自动填充`);
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
        setFeishuValidateState("ok");
        setFeishuValidateMsg("已检测到历史飞书配置");
      })
      .catch(() => {});
  }, []);

  const supportsInstallDaemon = hasFlag("install-daemon");
  const supportsChannel = hasFlag("channel") || hasFlag("channels");
  const supportsInstallSkills = hasFlag("install-skills");
  const supportsInstallHooks = hasFlag("install-hooks");
  const supportsUiMode = hasFlag("ui") || hasFlag("web") || hasFlag("tui");

  const commandParts: string[] = ["openclaw onboard", "--non-interactive", "--accept-risk"];
  if (installDaemon) commandParts.push("--install-daemon");
  if (enableChannel) commandParts.push(`--channel ${channel}`);
  if (feishuEnabled && feishuAppId.trim() && feishuAppSecret.trim()) {
    commandParts.push("--feishu-app-id ***");
    commandParts.push("--feishu-app-secret ***");
  }
  if (!installSkills) commandParts.push("--skip-skills");
  if (!installHooks) commandParts.push("--skip-hooks");
  if (launchMode === "web") commandParts.push("--ui web");
  if (launchMode === "tui") commandParts.push("--ui tui");
  if (!skipApiConfig) {
    if (provider === "anthropic") commandParts.push("--auth-choice anthropic-api-key");
    if (provider === "openai") commandParts.push("--auth-choice openai-api-key");
    if (provider === "deepseek" || provider === "custom") commandParts.push("--auth-choice custom-api-key");
  }
  const commandPreview = commandParts.join(" ");

  const stateStyle: Record<ItemState, string> = {
    run: "text-emerald-300 border-emerald-400/40 bg-emerald-500/10",
    skip: "text-slate-400 border-slate-600 bg-slate-800/60",
    unsupported: "text-yellow-400 border-yellow-500/40 bg-yellow-500/10",
  };
  const stateLabel: Record<ItemState, string> = {
    run: "将执行",
    skip: "已跳过",
    unsupported: "版本不支持，将跳过",
  };

  const daemonState: ItemState = installDaemon ? (supportsInstallDaemon ? "run" : "unsupported") : "skip";
  const channelState: ItemState = enableChannel ? (supportsChannel ? "run" : "unsupported") : "skip";
  const feishuState: ItemState = feishuEnabled
    ? (feishuReady ? "run" : "skip")
    : "skip";
  const skillsState: ItemState = installSkills ? (supportsInstallSkills ? "run" : "unsupported") : "skip";
  const hooksState: ItemState = installHooks ? (supportsInstallHooks ? "run" : "unsupported") : "skip";
  const launchState: ItemState = launchMode === "skip" ? "skip" : (supportsUiMode ? "run" : "unsupported");

  const buildReason = (key: string, state: ItemState): string => {
    if (state === "skip") {
      if (key === "api") return "用户选择跳过 API 配置";
      if (key === "launch") return "用户选择跳过启动方式配置";
      return "用户未启用该子步骤";
    }
    if (state === "unsupported") {
      if (key === "daemon") return "缺少 --install-daemon";
      if (key === "channel") return "缺少 --channel/--channels";
      if (key === "skills") return "缺少 --install-skills";
      if (key === "hooks") return "缺少 --install-hooks";
      if (key === "launch") return "缺少 --ui/--web/--tui";
      return "当前版本缺少对应参数";
    }
    if (key === "api") return "将写入 API Key/模型配置";
    if (key === "daemon") return "将传入 --install-daemon";
    if (key === "channel") return `将传入 --channel ${channel}`;
    if (key === "feishu") return "将写入飞书 appId/appSecret 并尝试传递给 onboard";
    if (key === "skills") return "将传入 --install-skills";
    if (key === "hooks") return "将传入 --install-hooks";
    if (key === "launch") return launchMode === "web" ? "将传入 --ui web" : "将传入 --ui tui";
    return "将按当前设置执行";
  };

  function resetToBlank() {
    setProvider("anthropic");
    setApiKey("");
    setBaseUrl("");
    setModel("");
    setDetectedConfig(null);
    setDetectedMsg("");
    setSkipApiConfig(false);
    requestAnimationFrame(() => {
      apiKeyInputRef.current?.focus();
    });
  }

  async function runConfig() {
    if (!keyValid || !baseUrlValid || !feishuReady) return;
    setRunning(true);
    setError(null);
    setHint(null);
    try {
      if (!isTauri) {
        await new Promise((r) => setTimeout(r, 500));
        onDone({
          command: commandPreview,
          message: "预览模式：已跳过实际执行",
          hint: null,
        });
        return;
      }
      if (!effectiveCaps?.has_onboarding) {
        const summary = {
          command: commandPreview,
          message: "当前版本不支持 onboard，已跳过",
          hint: "请升级 OpenClaw 后再启用可选能力",
        };
        setHint(summary.hint);
        onDone(summary);
        return;
      }

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
        launchMode: launchMode === "skip" ? null : launchMode,
      });

      if (!result.success) {
        setError(result.message || "综合配置执行失败");
        setHint(result.hint || null);
        return;
      }

      if (result.hint) {
        setHint(result.hint);
      }
      onDone({
        command: result.command || commandPreview,
        message: result.message || "综合配置执行完成",
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
      setFeishuValidateMsg("请先填写飞书 appId 与 appSecret");
      return false;
    }
    setFeishuValidateState("validating");
    setFeishuValidateMsg("正在校验飞书连通性...");
    try {
      const result = await invoke<ValidateResult>("validate_feishu_connectivity", {
        appId: feishuAppId.trim(),
        appSecret: feishuAppSecret.trim(),
      });
      if (result.status === "ok") {
        setFeishuValidateState("ok");
        setFeishuValidateMsg(result.message || "飞书连通性校验通过");
        return true;
      }
      setFeishuValidateState("error");
      setFeishuValidateMsg(result.message || "飞书连通性校验失败");
      return false;
    } catch (e) {
      setFeishuValidateState("error");
      setFeishuValidateMsg(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  const title = mode === "wizard" ? "综合配置" : "综合配置（API / 技能 / 启动方式）";
  const subtitle = mode === "wizard"
    ? "将 API 配置与可选能力配置合并执行，可按需跳过"
    : "安装完成后可随时修改 API、skills、hooks、channel 与启动方式";

  return (
    <div className="h-full flex flex-col gap-5 overflow-y-auto">
      <div>
        <h2 className="text-xl font-semibold text-slate-100 tracking-tight">{title}</h2>
        <p className="text-sm text-slate-400 mt-1">{subtitle}</p>
        {detectedMsg && <p className="text-xs text-brand-300 mt-2">{detectedMsg}</p>}
        {capsLoading && <p className="text-xs text-slate-500 mt-1">正在检测 CLI 能力...</p>}
      </div>

      <div className="bg-gradient-to-b from-slate-900 to-slate-900/70 rounded-2xl border border-slate-800 p-5 flex flex-col gap-5 shadow-sm">
        <div className="border-b border-slate-800 pb-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-medium text-slate-100">API 配置</p>
            <label className="flex items-center gap-2 text-xs text-slate-400 bg-slate-900 border border-slate-700 rounded-full px-3 py-1.5">
              <input
                type="checkbox"
                checked={skipApiConfig}
                onChange={(e) => setSkipApiConfig(e.target.checked)}
              />
              跳过 API 配置
            </label>
          </div>

          {detectedConfig && (
            <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 mb-3">
              <p className="text-xs text-slate-400">已检测配置</p>
              <div className="mt-1.5 text-xs text-slate-300 space-y-1">
                <p>Provider: {detectedConfig.provider || "-"}</p>
                <p>Base URL: {detectedConfig.base_url || "(默认)"}</p>
                <p>Model: {detectedConfig.model || "(未记录)"}</p>
              </div>
              <button
                onClick={resetToBlank}
                className="mt-2 text-xs text-slate-400 hover:text-slate-200 underline underline-offset-2 transition-colors"
              >
                恢复为默认空白
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
                    {p.name}
                  </button>
                ))}
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">模型</label>
                {provider === "custom" ? (
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="例如：openai/gpt-4o-mini"
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
                  <label className="block text-xs text-slate-400 mb-1">Base URL（必填）</label>
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
                      Base URL 格式无效，请输入 http(s) 开头的完整地址
                    </p>
                  )}
                </div>
              )}

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  API Key
                  {pConfig.keyPrefix && (
                    <span className="text-slate-600 ml-1">（应以 {pConfig.keyPrefix} 开头）</span>
                  )}
                </label>
                <div className="relative">
                  <input
                    ref={apiKeyInputRef}
                    type={showKey ? "text" : "password"}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={pConfig.placeholder}
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
                    Key 格式似乎不正确，{pConfig.name} 的 Key 应以 {pConfig.keyPrefix} 开头
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        <label className="flex items-center justify-between text-sm text-slate-200 bg-slate-900/60 border border-slate-800 rounded-xl px-3 py-2.5">
          <span>安装 daemon（推荐）</span>
          <input type="checkbox" checked={installDaemon} onChange={(e) => setInstallDaemon(e.target.checked)} />
        </label>

        <div className="border-t border-slate-800 pt-4">
          <label className="flex items-center justify-between text-sm text-slate-200">
            <span>配置 channel（推荐：飞书）</span>
            <input type="checkbox" checked={enableChannel} onChange={(e) => setEnableChannel(e.target.checked)} />
          </label>
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
                <option value="feishu">飞书（推荐）</option>
                <option value="none">不设置 channel</option>
              </select>

              {channel === "feishu" && (
                <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3.5 space-y-3">
                  <p className="text-xs text-slate-400">飞书集成配置</p>
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
                        placeholder="输入飞书应用密钥"
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
                      {feishuValidateState === "validating" ? "校验中..." : "校验飞书连通性"}
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

        <label className="flex items-center justify-between text-sm text-slate-200 border-t border-slate-800 pt-4">
          <span>安装 skills（可选）</span>
          <input type="checkbox" checked={installSkills} onChange={(e) => setInstallSkills(e.target.checked)} />
        </label>

        <label className="flex items-center justify-between text-sm text-slate-200">
          <span>安装 hooks（可选）</span>
          <input type="checkbox" checked={installHooks} onChange={(e) => setInstallHooks(e.target.checked)} />
        </label>

        <div className="border-t border-slate-800 pt-4">
          <p className="text-sm text-slate-200 mb-2">启动方式</p>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => setLaunchMode("web")}
              className={`text-sm rounded-xl px-3 py-2.5 border transition-colors ${launchMode === "web" ? "border-brand-400 text-brand-300 bg-brand-500/10" : "border-slate-700 text-slate-400 hover:border-slate-600"}`}
            >
              Web（默认）
            </button>
            <button
              onClick={() => setLaunchMode("tui")}
              className={`text-sm rounded-xl px-3 py-2.5 border transition-colors ${launchMode === "tui" ? "border-brand-400 text-brand-300 bg-brand-500/10" : "border-slate-700 text-slate-400 hover:border-slate-600"}`}
            >
              TUI
            </button>
            <button
              onClick={() => setLaunchMode("skip")}
              className={`text-sm rounded-xl px-3 py-2.5 border transition-colors ${launchMode === "skip" ? "border-brand-400 text-brand-300 bg-brand-500/10" : "border-slate-700 text-slate-400 hover:border-slate-600"}`}
            >
              跳过
            </button>
          </div>
        </div>

        <div className="border-t border-slate-800 pt-4">
          <p className="text-xs text-slate-500 mb-1">命令预览（best-effort）</p>
          <p className="text-xs text-slate-300 font-mono break-all bg-slate-900 border border-slate-800 rounded-xl px-3 py-2">
            {commandPreview}
          </p>
          <p className="text-[11px] text-slate-600 mt-1">
            实际执行时将按当前 CLI 支持能力自动跳过不兼容参数。
          </p>
        </div>

        <div className="border-t border-slate-800 pt-4">
          <p className="text-xs text-slate-500 mb-2">子步骤执行状态</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {[
              { key: "api", label: "API 配置", state: skipApiConfig ? "skip" : "run" as ItemState },
              { key: "daemon", label: "daemon", state: daemonState },
              { key: "channel", label: "channel", state: channelState },
              { key: "feishu", label: "飞书凭据", state: feishuState },
              { key: "skills", label: "skills", state: skillsState },
              { key: "hooks", label: "hooks", state: hooksState },
              { key: "launch", label: launchMode === "skip" ? "启动方式" : `启动方式(${launchMode})`, state: launchState },
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

      <div className="flex-1" />

      <div className="flex items-center justify-between pt-1">
        <div className="flex items-center gap-3">
          {onCancel && (
            <button
              onClick={onCancel}
              disabled={running}
              className={BTN_TEXT}
            >
              取消
            </button>
          )}
          {mode === "wizard" && (
            <button
              onClick={() => onDone({
                command: "",
                message: "用户选择跳过综合配置",
                hint: null,
              })}
              disabled={running}
              className={BTN_TEXT}
            >
              跳过配置，继续
            </button>
          )}
        </div>
        <button
          onClick={runConfig}
          disabled={running || !keyValid || !baseUrlValid || !feishuReady || (!skipApiConfig && !effectiveModel)}
          className={BTN_PRIMARY}
        >
          {running && <Loader size={14} className="animate-spin" />}
          {mode === "wizard" ? "执行综合配置并继续 →" : "保存并应用配置"}
        </button>
      </div>
    </div>
  );
}
