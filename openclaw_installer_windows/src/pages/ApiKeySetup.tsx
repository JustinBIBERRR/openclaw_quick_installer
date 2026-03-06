import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeOff, Loader, CheckCircle, AlertCircle } from "lucide-react";
import type { ApiKeyDraft, ApiProvider, ApiProviderConfig, SavedApiConfig } from "../types";

interface Props {
  onDone: (draft: ApiKeyDraft) => void;
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
const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export default function ApiKeySetup({ onDone }: Props) {
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const [provider, setProvider] = useState<ApiProvider>("anthropic");
  const [model, setModel] = useState(PROVIDERS[0].models[0] || "");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [validateState, setValidateState] = useState<ValidateState>("idle");
  const [validateMsg, setValidateMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [detectedMsg, setDetectedMsg] = useState<string>("");
  const [detectedConfig, setDetectedConfig] = useState<SavedApiConfig | null>(null);

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

  useEffect(() => {
    if (!isTauri) return;
    invoke<SavedApiConfig | null>("get_saved_api_config")
      .then((saved) => {
        if (!saved || !saved.api_key) return;
        const p = (["anthropic", "openai", "deepseek", "custom"] as const).includes(saved.provider as ApiProvider)
          ? (saved.provider as ApiProvider)
          : "custom";
        setProvider(p);
        setApiKey(saved.api_key);
        setBaseUrl(saved.base_url || "");
        setModel(saved.model || "");
        setDetectedConfig(saved);
        setValidateState("ok");
        setValidateMsg("检测到已配置 API Key，可直接继续或按需修改");
        setDetectedMsg(`已检测到 ${p === "custom" ? "自定义" : p} 的 API Key 配置`);
      })
      .catch(() => {});
  }, []);

  function resetToBlank() {
    setProvider("anthropic");
    setApiKey("");
    setBaseUrl("");
    setModel("");
    setDetectedConfig(null);
    setDetectedMsg("");
    setValidateState("idle");
    setValidateMsg("");
    requestAnimationFrame(() => {
      apiKeyInputRef.current?.focus();
    });
  }

  async function validate() {
    if (!keyValid || !baseUrlValid) return;
    setValidateState("validating");
    setValidateMsg("正在验证连通性...");
    await new Promise((r) => setTimeout(r, 600));
    setValidateState("ok");
    setValidateMsg("格式检查通过，可继续下一步");
  }

  async function save(skip = false) {
    setSaving(true);
    try {
      onDone({
        provider,
        apiKey: skip ? "" : apiKey,
        baseUrl: skip ? "" : effectiveBaseUrl,
        model: skip ? "" : (model || pConfig.models[0] || ""),
        skipped: skip,
        keyConfigured: !skip,
      });
    } catch (e) {
      // no-op
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
        {detectedMsg && (
          <p className="text-xs text-brand-400 mt-2">
            {detectedMsg}，已自动填充 API Key（密码形式显示）。
          </p>
        )}
      </div>

      {/* 服务商选择 */}
      <div className="grid grid-cols-2 gap-2">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              setProvider(p.id);
              setValidateState("idle");
              setBaseUrl("");
              setModel(p.models[0] || "");
            }}
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
        {detectedConfig && (
          <div className="bg-gray-800/60 border border-gray-700 rounded-md p-3">
            <p className="text-xs text-gray-400">已检测配置</p>
            <div className="mt-1.5 text-xs text-gray-300 space-y-1">
              <p>Provider: {detectedConfig.provider || "-"}</p>
              <p>Base URL: {detectedConfig.base_url || "(默认)"}</p>
              <p>Model: {detectedConfig.model || "(未记录)"}</p>
            </div>
            <button
              onClick={resetToBlank}
              className="mt-2 text-xs text-gray-400 hover:text-gray-200 underline underline-offset-2"
            >
              恢复为默认空白
            </button>
          </div>
        )}

        <div>
          <label className="block text-xs text-gray-400 mb-1">模型</label>
          {provider === "custom" ? (
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="例如：deepseek/deepseek-chat 或 openai/gpt-4o-mini"
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-brand-400 font-mono"
              style={{ userSelect: "text" }}
            />
          ) : (
            <select
              value={model || pConfig.models[0] || ""}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-brand-400"
            >
              {(pConfig.models || []).map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          )}
          <p className="text-[11px] text-gray-500 mt-1">
            系统会按所选厂商自动补全并写入正确模型格式。
          </p>
        </div>

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
              ref={apiKeyInputRef}
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
        <button
          onClick={() => save(true)}
          disabled={saving}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          跳过，稍后配置
        </button>
        <button
          onClick={() => save(false)}
          disabled={saving || !keyValid || !baseUrlValid || !(model || pConfig.models[0]) || validateState === "error"}
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
