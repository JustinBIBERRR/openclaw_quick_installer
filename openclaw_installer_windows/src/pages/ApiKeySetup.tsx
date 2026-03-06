import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff, Loader, CheckCircle, AlertCircle } from "lucide-react";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import type { AppManifest, ApiProvider, ApiProviderConfig, CliCapabilities, CommandResult } from "../types";

interface Props {
  manifest: AppManifest | null;
  cliCaps: CliCapabilities | null;
  onDone: (provider: string, keyConfigured: boolean) => void;
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

type ValidateState = "idle" | "validating" | "ok" | "warn" | "error";

export default function ApiKeySetup({ manifest, cliCaps, onDone }: Props) {
  const [provider, setProvider] = useState<ApiProvider>("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [validateState, setValidateState] = useState<ValidateState>("idle");
  const [validateMsg, setValidateMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const pConfig = PROVIDERS.find((p) => p.id === provider)!;

  const keyValid =
    apiKey.length > 10 &&
    (pConfig.keyPrefix === "" || apiKey.startsWith(pConfig.keyPrefix));

  const effectiveBaseUrl = baseUrl || pConfig.defaultBaseUrl;
  const baseUrlValid =
    provider !== "custom" ||
    (() => {
      try {
        const u = new URL(effectiveBaseUrl);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    })();

  async function validate() {
    if (!keyValid || !baseUrlValid) return;
    setValidateState("validating");
    setValidateMsg("正在验证连通性...");

    if (!isTauri) {
      await new Promise((r) => setTimeout(r, 1000));
      setValidateState("ok");
      setValidateMsg("[预览] 模拟验证通过（实际环境将发起真实 API 连通性检测）");
      return;
    }

    try {
      const result = await invoke<{ status: string; message: string }>(
        "validate_api_key",
        { provider, apiKey, baseUrl: effectiveBaseUrl }
      );
      if (result.status === "ok") {
        setValidateState("ok");
        setValidateMsg(result.message || "验证通过");
      } else if (result.status === "warn") {
        setValidateState("warn");
        setValidateMsg(result.message || "Key 可能有问题，但可继续");
      } else {
        setValidateState("error");
        setValidateMsg(result.message || "验证失败");
      }
    } catch (e: unknown) {
      setValidateState("warn");
      setValidateMsg("网络连接超时，可跳过验证继续");
    }
  }

  async function save(skip = false) {
    setSaving(true);
    setSaveError(null);
    try {
      if (isTauri) {
        // 优先使用官方 onboarding，低版本才回退到最小配置写入。
        if (!skip && cliCaps?.has_onboarding) {
          const onboardingResult = await invoke<CommandResult>("run_onboarding", {
            apiKey,
            provider,
          });
          if (!onboardingResult.success) {
            setSaveError(onboardingResult.message);
            setSaving(false);
            return;
          }
        } else {
          const result = await invoke<CommandResult>("save_api_key", {
            installDir: manifest?.install_dir || "C:\\OpenClaw",
            provider: skip ? "skip" : provider,
            apiKey: skip ? "" : apiKey,
            baseUrl: skip ? "" : effectiveBaseUrl,
            model: skip ? "" : pConfig.models[0] || "",
          });
          if (!result.success) {
            setSaveError(result.message);
            setSaving(false);
            return;
          }
        }
      }
      onDone(skip ? "skip" : provider, !skip);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSaveError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="h-full flex flex-col px-6 py-4 gap-4 overflow-y-auto">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">配置 AI 模型</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          选择 AI 服务商并输入 API Key，或跳过稍后在 OpenClaw 界面中配置
        </p>
      </div>

      {/* 服务商选择 */}
      <div className="grid grid-cols-2 gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => { setProvider(p.id); setValidateState("idle"); setBaseUrl(""); }}
            className={`text-left p-3 rounded-lg border text-sm transition-all
              ${provider === p.id
                ? "border-brand-400 bg-brand-400/10 text-brand-400"
                : "border-gray-700 bg-gray-900 text-gray-400 hover:border-gray-600"
              }`}
          >
            {p.name}
          </button>
        ))}
      </div>

      {/* API Key 输入 */}
      <div className="bg-gray-900 rounded-lg border border-gray-700 p-4 flex flex-col gap-3">
        {provider === "custom" && (
          <div>
            <label className="block text-xs text-gray-400 mb-1">Base URL（必填）</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://your-api-proxy.com/v1"
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-brand-400"
              style={{ userSelect: "text" }}
            />
          </div>
        )}

        <div>
          <label className="block text-xs text-gray-400 mb-1">
            API Key
            {pConfig.keyPrefix && (
              <span className="text-gray-600 ml-1">（应以 {pConfig.keyPrefix} 开头）</span>
            )}
          </label>
          <div className="relative">
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setValidateState("idle"); }}
              placeholder={pConfig.placeholder}
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 pr-10 text-sm text-gray-200 outline-none focus:border-brand-400 font-mono"
              style={{ userSelect: "text" }}
            />
            <button
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
            >
              {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          {apiKey && !keyValid && pConfig.keyPrefix && (
            <p className="text-xs text-yellow-500 mt-1">
              Key 格式似乎不正确，{pConfig.name} 的 Key 应以 {pConfig.keyPrefix} 开头
            </p>
          )}
          {provider === "custom" && baseUrl && !baseUrlValid && (
            <p className="text-xs text-yellow-500 mt-1">
              Base URL 格式无效，请输入 http(s) 开头的完整地址
            </p>
          )}
        </div>

        {/* 验证状态 */}
        {validateState !== "idle" && (
          <div className={`flex items-center gap-2 text-sm
            ${validateState === "ok"         ? "text-brand-400" : ""}
            ${validateState === "warn"        ? "text-yellow-400" : ""}
            ${validateState === "error"       ? "text-red-400" : ""}
            ${validateState === "validating"  ? "text-gray-400" : ""}
          `}>
            {validateState === "validating" && <Loader size={14} className="animate-spin" />}
            {validateState === "ok"          && <CheckCircle size={14} />}
            {validateState === "warn"        && <AlertCircle size={14} />}
            {validateState === "error"       && <AlertCircle size={14} />}
            <span>{validateMsg}</span>
          </div>
        )}

        <button
          onClick={validate}
          disabled={!keyValid || !baseUrlValid || validateState === "validating"}
          className="self-start px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 disabled:opacity-40
            text-gray-300 rounded border border-gray-600 transition-colors"
        >
          验证连通性
        </button>
      </div>

      <div className="flex-1" />

      {/* 底部操作 */}
      <div className="flex items-center justify-between flex-shrink-0">
        {saveError && (
          <p className="text-xs text-red-400 max-w-[60%] truncate">{saveError}</p>
        )}
        <button
          onClick={() => save(true)}
          disabled={saving}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          跳过，稍后配置
        </button>
        <button
          onClick={() => save(false)}
          disabled={saving || !keyValid || !baseUrlValid || validateState === "error"}
          className="flex items-center gap-2 px-6 py-2 bg-brand-500 hover:bg-brand-600
            disabled:bg-gray-700 disabled:text-gray-500
            text-gray-950 font-semibold text-sm rounded-lg transition-colors"
        >
          {saving && <Loader size={14} className="animate-spin" />}
          保存并继续 →
        </button>
      </div>
    </div>
  );
}
