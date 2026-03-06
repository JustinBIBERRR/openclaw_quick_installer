import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader } from "lucide-react";
import type { ApiKeyDraft, CliCapabilities, CommandResult, OnboardingSummary } from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  draft: ApiKeyDraft | null;
  cliCaps: CliCapabilities | null;
  onDone: (summary: OnboardingSummary | null) => void;
}

type LaunchMode = "web" | "tui" | "skip";

export default function OnboardingSetup({ draft, cliCaps, onDone }: Props) {
  const [installDaemon, setInstallDaemon] = useState(true);
  const [enableChannel, setEnableChannel] = useState(true);
  const [channel, setChannel] = useState("feishu");
  const [installSkills, setInstallSkills] = useState(false);
  const [installHooks, setInstallHooks] = useState(false);
  const [launchMode, setLaunchMode] = useState<LaunchMode>("web");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [localCaps, setLocalCaps] = useState<CliCapabilities | null>(null);
  const [capsLoading, setCapsLoading] = useState(false);

  const effectiveCaps = useMemo(() => localCaps || cliCaps, [localCaps, cliCaps]);

  useEffect(() => {
    if (!isTauri || cliCaps) return;
    setCapsLoading(true);
    invoke<CliCapabilities>("detect_cli_capabilities")
      .then((caps) => {
        setLocalCaps(caps);
      })
      .catch(() => {})
      .finally(() => setCapsLoading(false));
  }, [cliCaps]);

  const normFlags = new Set((effectiveCaps?.onboarding_flags || []).map((f) => f.replace(/^--/, "").toLowerCase()));
  const hasFlag = (name: string) => normFlags.has(name.toLowerCase()) || normFlags.has(name.replace(/^--/, "").toLowerCase());

  const commandParts: string[] = ["openclaw onboard", "--non-interactive", "--accept-risk"];
  if (installDaemon) commandParts.push("--install-daemon");
  if (enableChannel) commandParts.push(`--channel ${channel}`);
  if (!installSkills) commandParts.push("--skip-skills");
  if (!installHooks) commandParts.push("--skip-hooks");
  if (launchMode === "web") commandParts.push("--ui web");
  if (launchMode === "tui") commandParts.push("--ui tui");
  if (!draft?.skipped) {
    if (draft?.provider === "anthropic") commandParts.push("--auth-choice anthropic-api-key");
    if (draft?.provider === "openai") commandParts.push("--auth-choice openai-api-key");
    if (draft?.provider === "deepseek" || draft?.provider === "custom") commandParts.push("--auth-choice custom-api-key");
  }
  const commandPreview = commandParts.join(" ");

  type ItemState = "run" | "skip" | "unsupported";
  const stateStyle: Record<ItemState, string> = {
    run: "text-green-400 border-green-500/40 bg-green-500/10",
    skip: "text-gray-400 border-gray-600 bg-gray-800/60",
    unsupported: "text-yellow-400 border-yellow-500/40 bg-yellow-500/10",
  };
  const stateLabel: Record<ItemState, string> = {
    run: "将执行",
    skip: "已跳过",
    unsupported: "版本不支持，将跳过",
  };
  const supportsInstallDaemon = hasFlag("install-daemon");
  const supportsChannel = hasFlag("channel") || hasFlag("channels");
  const supportsInstallSkills = hasFlag("install-skills");
  const supportsInstallHooks = hasFlag("install-hooks");
  const supportsUiMode = hasFlag("ui") || hasFlag("web") || hasFlag("tui");

  const daemonState: ItemState = installDaemon ? (supportsInstallDaemon ? "run" : "unsupported") : "skip";
  const channelState: ItemState = enableChannel ? (supportsChannel ? "run" : "unsupported") : "skip";
  const skillsState: ItemState = installSkills ? (supportsInstallSkills ? "run" : "unsupported") : "skip";
  const hooksState: ItemState = installHooks ? (supportsInstallHooks ? "run" : "unsupported") : "skip";
  const launchState: ItemState = launchMode === "skip" ? "skip" : (supportsUiMode ? "run" : "unsupported");
  const buildReason = (key: string, state: ItemState): string => {
    if (state === "skip") {
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
    if (key === "daemon") return "将传入 --install-daemon";
    if (key === "channel") return `将传入 --channel ${channel}`;
    if (key === "skills") return "将传入 --install-skills";
    if (key === "hooks") return "将传入 --install-hooks";
    if (key === "launch") return launchMode === "web" ? "将传入 --ui web" : "将传入 --ui tui";
    return "将按当前设置执行";
  };

  async function runOnboarding() {
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
        setHint("当前 CLI 不支持 onboard，已跳过此步骤。");
        onDone({
          command: commandPreview,
          message: "当前版本不支持 onboard，已跳过",
          hint: "请升级 OpenClaw 后再启用可选能力",
        });
        return;
      }

      const result = await invoke<CommandResult>("run_onboarding_guided", {
        apiKey: draft?.apiKey || "",
        provider: draft?.provider || "anthropic",
        baseUrl: draft?.baseUrl || null,
        model: draft?.model || null,
        installDaemon,
        channel: enableChannel ? channel : null,
        installSkills,
        installHooks,
        launchMode: launchMode === "skip" ? null : launchMode,
      });

      if (!result.success) {
        setError(result.message || "onboard 执行失败");
        setHint(result.hint || null);
        return;
      }

      if (result.hint) {
        setHint(result.hint);
      }
      onDone({
        command: result.command || commandPreview,
        message: result.message || "onboard 执行完成",
        hint: result.hint || null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="h-full flex flex-col px-6 py-4 gap-4 overflow-y-auto">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">可选能力配置</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          按顺序执行 OpenClaw onboard，可跳过任意子步骤（推荐配置已预选）
        </p>
        {capsLoading && (
          <p className="text-xs text-gray-500 mt-1">正在检测 CLI 能力...</p>
        )}
      </div>

      <div className="bg-gray-900 rounded-lg border border-gray-700 p-4 flex flex-col gap-4">
        <label className="flex items-center justify-between text-sm text-gray-200">
          <span>安装 daemon（推荐）</span>
          <input type="checkbox" checked={installDaemon} onChange={(e) => setInstallDaemon(e.target.checked)} />
        </label>

        <div className="border-t border-gray-800 pt-3">
          <label className="flex items-center justify-between text-sm text-gray-200">
            <span>配置 channel（推荐：飞书）</span>
            <input type="checkbox" checked={enableChannel} onChange={(e) => setEnableChannel(e.target.checked)} />
          </label>
          {enableChannel && (
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="mt-2 w-full bg-gray-800 border border-gray-600 rounded px-3 py-2 text-sm text-gray-200"
            >
              <option value="feishu">飞书（推荐）</option>
              <option value="none">不设置 channel</option>
            </select>
          )}
        </div>

        <label className="flex items-center justify-between text-sm text-gray-200 border-t border-gray-800 pt-3">
          <span>安装 skills（可选）</span>
          <input type="checkbox" checked={installSkills} onChange={(e) => setInstallSkills(e.target.checked)} />
        </label>

        <label className="flex items-center justify-between text-sm text-gray-200">
          <span>安装 hooks（可选）</span>
          <input type="checkbox" checked={installHooks} onChange={(e) => setInstallHooks(e.target.checked)} />
        </label>

        <div className="border-t border-gray-800 pt-3">
          <p className="text-sm text-gray-200 mb-2">启动方式</p>
          <div className="grid grid-cols-3 gap-2">
            <button
              onClick={() => setLaunchMode("web")}
              className={`text-sm rounded px-3 py-2 border ${launchMode === "web" ? "border-brand-400 text-brand-400" : "border-gray-700 text-gray-400"}`}
            >
              Web（默认）
            </button>
            <button
              onClick={() => setLaunchMode("tui")}
              className={`text-sm rounded px-3 py-2 border ${launchMode === "tui" ? "border-brand-400 text-brand-400" : "border-gray-700 text-gray-400"}`}
            >
              TUI
            </button>
            <button
              onClick={() => setLaunchMode("skip")}
              className={`text-sm rounded px-3 py-2 border ${launchMode === "skip" ? "border-brand-400 text-brand-400" : "border-gray-700 text-gray-400"}`}
            >
              跳过
            </button>
          </div>
        </div>

        <div className="border-t border-gray-800 pt-3">
          <p className="text-xs text-gray-500 mb-1">命令预览（best-effort）</p>
          <p className="text-xs text-gray-300 font-mono break-all bg-gray-800 border border-gray-700 rounded px-2 py-1.5">
            {commandPreview}
          </p>
          <p className="text-[11px] text-gray-600 mt-1">
            实际执行时将按当前 CLI 支持能力自动跳过不兼容参数。
          </p>
        </div>

        <div className="border-t border-gray-800 pt-3">
          <p className="text-xs text-gray-500 mb-2">子步骤执行状态</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {[
              { key: "daemon", label: "daemon", state: daemonState },
              { key: "channel", label: "channel", state: channelState },
              { key: "skills", label: "skills", state: skillsState },
              { key: "hooks", label: "hooks", state: hooksState },
              { key: "launch", label: launchMode === "skip" ? "启动方式" : `启动方式(${launchMode})`, state: launchState },
            ].map((item) => (
              <div key={item.label} className="text-xs border border-gray-700 rounded px-2 py-1.5 bg-gray-800/50">
                <div className="flex items-center justify-between">
                  <span className="text-gray-300">{item.label}</span>
                  <span className={`px-1.5 py-0.5 rounded border ${stateStyle[item.state]}`}>
                    {stateLabel[item.state]}
                  </span>
                </div>
                <p className="text-[11px] text-gray-500 mt-1">{buildReason(item.key, item.state)}</p>
              </div>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-red-400">{error}</p>}
        {hint && <p className="text-xs text-yellow-500">{hint}</p>}
      </div>

      <div className="flex-1" />

      <div className="flex items-center justify-between">
        <button
          onClick={() => onDone({
            command: "",
            message: "用户选择跳过可选能力配置",
            hint: null,
          })}
          disabled={running}
          className="text-sm text-gray-500 hover:text-gray-300 transition-colors"
        >
          跳过可选配置，继续
        </button>
        <button
          onClick={runOnboarding}
          disabled={running}
          className="flex items-center gap-2 px-6 py-2 bg-brand-500 hover:bg-brand-600 disabled:bg-gray-700 disabled:text-gray-500 text-gray-950 font-semibold text-sm rounded-lg transition-colors"
        >
          {running && <Loader size={14} className="animate-spin" />}
          执行 onboard 并继续 →
        </button>
      </div>
    </div>
  );
}
