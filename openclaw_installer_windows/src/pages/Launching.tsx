import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader, RefreshCw, ExternalLink, Square, Stethoscope, Wrench, FolderOpen, Copy, CheckCircle } from "lucide-react";
import LogScroller from "../components/LogScroller";
import type { AppManifest, LogEntry, DoctorResult, CommandResult, CliCapabilities, OnboardingSummary } from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  manifest: AppManifest;
  cliCaps: CliCapabilities | null;
  onboardingSummary?: OnboardingSummary | null;
  logs: LogEntry[];
  addLog: (level: LogEntry["level"], message: string) => void;
  onDone: (manifest: AppManifest) => void;
}

type LaunchPhase = "idle" | "starting" | "done" | "failed" | "diagnosing" | "fixing";

function buildGatewayRecoveryTips(message: string, code: string | null, backendHint: string | null): { hint: string | null; tips: string[] } {
  const lower = `${code || ""} ${message} ${backendHint || ""}`.toLowerCase();
  const tips: string[] = [];
  let hint = backendHint;

  if (lower.includes("too many failed authentication attempts") || lower.includes("authentication attempts")) {
    hint = "浏览器可能缓存了旧 token。请重启 Gateway 后，用浏览器无痕模式重新打开。";
    tips.push("先点击“重新启动”重启 Gateway");
    tips.push("使用浏览器无痕模式打开 Dashboard / Chat");
  }
  if (lower.includes("no api key found") || lower.includes("auth-profiles")) {
    hint = hint || "未找到可用 API Key，请先检查模型配置或 agent 认证配置。";
    tips.push("先点击“诊断问题”查看 doctor 结论");
    tips.push("再点击“一键修复”并重新启动");
  }
  if (lower.includes("gateway.mode") || lower.includes("mode local") || lower.includes("unconfigured")) {
    hint = hint || "网关模式或配置未就绪，建议先运行诊断与修复。";
    tips.push("优先运行 doctor / doctor --fix");
  }
  if (lower.includes("cmd_not_found") || lower.includes("找不到 openclaw")) {
    hint = hint || "系统未发现 openclaw 命令。请重新打开安装器后重试。";
    tips.push("检查 PATH 与 npm prefix，必要时重新安装 CLI");
  }
  if (tips.length === 0) {
    tips.push("先点击“诊断问题”查看详细原因");
    tips.push("查看 installer 日志并复制诊断信息反馈");
  }

  return { hint, tips };
}

export default function Launching({ manifest, cliCaps, onboardingSummary, logs, addLog, onDone }: Props) {
  const [phase, setPhase] = useState<LaunchPhase>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [doctorResult, setDoctorResult] = useState<DoctorResult | null>(null);
  const [fixResult, setFixResult] = useState<CommandResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [recoveryTips, setRecoveryTips] = useState<string[]>([]);
  const [openingChat, setOpeningChat] = useState(false);
  const [chatLocked, setChatLocked] = useState(false);
  const startedRef = useRef(false);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const unlistenLog = listen<{ level: string; message: string }>(
      "gateway-log",
      (e) => addLog((e.payload.level as LogEntry["level"]) || "info", e.payload.message)
    );

    startGateway();
    return () => {
      unlistenLog.then((f) => f());
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  useEffect(() => {
    if (phase !== "starting") return;
    if (elapsed !== 1 && elapsed !== 5 && elapsed !== 30) return;
  }, [elapsed, phase]);

  async function startGateway() {
    cancelledRef.current = false;
    setPhase("starting");
    setErrorMsg("");
    setErrorHint(null);
    setErrorCode(null);
    setLogPath(null);
    setRecoveryTips([]);
    setDoctorResult(null);
    setFixResult(null);
    setElapsed(0);
    setStopping(false);
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    addLog("info", "正在启动 Gateway...");

    if (!isTauri) {
      await new Promise((r) => setTimeout(r, 1200));
      const gwLogs = [
        "[预览] 读取 manifest.json → C:\\OpenClaw",
        "[预览] 执行: openclaw start --port 18789",
        "[预览] Gateway starting on 0.0.0.0:18789",
        "[预览] OpenClaw Gateway v1.0.3 ready",
      ];
      for (const log of gwLogs) {
        if (cancelledRef.current) break;
        await new Promise((r) => setTimeout(r, 400));
        addLog("info", log);
      }
      if (cancelledRef.current) return;
      if (timerRef.current) clearInterval(timerRef.current);
      setPhase("done");
      addLog("ok", `Gateway 已就绪 → http://localhost:18789/chat`);
      onDone({ ...manifest, gateway_port: 18789, gateway_pid: 12345 });
      return;
    }

    try {
      const result = await invoke<CommandResult>("start_gateway", {
        installDir: manifest.install_dir,
        port: manifest.gateway_port || 18789,
      });
      if (!result.success) {
        throw new Error(JSON.stringify(result));
      }
      if (timerRef.current) clearInterval(timerRef.current);
      if (cancelledRef.current) return;
      setPhase("done");
      const finalPort = manifest.gateway_port || 18789;
      addLog("ok", `Gateway 已就绪 → http://localhost:${finalPort}/chat`);
      onDone({
        ...manifest,
        phase: "complete",
        gateway_port: finalPort,
      });
    } catch (e: unknown) {
      if (timerRef.current) clearInterval(timerRef.current);
      if (cancelledRef.current) return;
      
      // 尝试解析结构化错误
      let msg = e instanceof Error ? e.message : String(e);
      let hint: string | null = null;
      let code: string | null = null;
      let logFile: string | null = null;
      
      try {
        const parsed = JSON.parse(msg) as CommandResult;
        msg = parsed.message;
        hint = parsed.hint || null;
        code = parsed.code;
        logFile = parsed.log_path || null;
      } catch {
        // 不是 JSON，保持原始消息
      }
      
      setPhase("failed");
      setErrorMsg(msg);
      const guidance = buildGatewayRecoveryTips(msg, code, hint);
      setErrorHint(guidance.hint);
      setRecoveryTips(guidance.tips);
      setErrorCode(code);
      setLogPath(logFile);
      addLog("error", `启动失败: ${msg}`);
    }
  }

  async function runDiagnose() {
    if (!cliCaps?.has_doctor) {
      setErrorMsg("当前 OpenClaw 版本不支持 doctor 诊断");
      setErrorHint("请升级 OpenClaw 后重试");
      return;
    }
    setPhase("diagnosing");
    addLog("info", "正在运行 openclaw doctor 诊断...");
    
    try {
      const result = await invoke<DoctorResult>("run_doctor");
      setDoctorResult(result);
      setLogPath(result.log_path || null);
      
      if (result.passed) {
        addLog("ok", `诊断通过: ${result.summary}`);
      } else {
        addLog("warn", `诊断发现问题: ${result.summary}`);
        for (const issue of result.issues) {
          addLog(issue.severity === "error" ? "error" : "warn", issue.message);
        }
      }
      
      setPhase("failed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("error", `诊断失败: ${msg}`);
      setPhase("failed");
    }
  }

  async function runFix() {
    if (!cliCaps?.has_doctor) {
      setErrorMsg("当前 OpenClaw 版本不支持 doctor --fix");
      setErrorHint("请升级 OpenClaw 后重试");
      return;
    }
    setPhase("fixing");
    addLog("info", "正在运行 openclaw doctor --fix 修复...");
    
    try {
      const result = await invoke<CommandResult>("run_doctor_fix");
      setFixResult(result);
      setLogPath(result.log_path || null);
      
      if (result.success) {
        addLog("ok", "修复完成，正在重新启动 Gateway...");
        await new Promise((r) => setTimeout(r, 1000));
        startGateway();
      } else {
        addLog("error", `修复失败: ${result.message}`);
        if (result.hint) {
          addLog("warn", result.hint);
        }
        setPhase("failed");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("error", `修复失败: ${msg}`);
      setPhase("failed");
    }
  }

  async function openLogDirectory() {
    try {
      const logDir = await invoke<string>("get_log_directory");
      await invoke("open_folder", { path: logDir });
    } catch (e) {
      addLog("error", `打开日志目录失败: ${e}`);
    }
  }

  async function openRuntimeLogDirectory() {
    try {
      await invoke("open_folder", { path: `${manifest.install_dir}\\logs` });
    } catch (e) {
      addLog("error", `打开运行日志目录失败: ${e}`);
    }
  }

  async function copyDiagnosticInfo() {
    const info = [
      `错误代码: ${errorCode || "未知"}`,
      `错误信息: ${errorMsg}`,
      errorHint ? `建议: ${errorHint}` : null,
      logPath ? `日志文件: ${logPath}` : null,
      doctorResult ? `诊断结果: ${doctorResult.summary}` : null,
      doctorResult?.issues.length ? `问题列表:\n${doctorResult.issues.map(i => `  - ${i.message}`).join("\n")}` : null,
    ].filter(Boolean).join("\n");
    
    try {
      await navigator.clipboard.writeText(info);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      addLog("error", "复制失败");
    }
  }

  async function handleStop() {
    setStopping(true);
    cancelledRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    addLog("warn", "正在停止 Gateway...");

    try {
      await invoke("kill_gateway_process", {
        installDir: manifest.install_dir,
        port: manifest.gateway_port || 18789,
      });
      addLog("info", "Gateway 已停止");
    } catch (e) {
      addLog("error", `停止失败: ${e}`);
    }

    setStopping(false);
    setPhase("failed");
    setErrorMsg("已手动停止 Gateway");
  }

  async function handleRetry() {
    cancelledRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    addLog("warn", "正在停止旧进程...");

    try {
      await invoke("kill_gateway_process", {
        installDir: manifest.install_dir,
        port: manifest.gateway_port || 18789,
      });
    } catch { /* ignore */ }

    await new Promise((r) => setTimeout(r, 1000));
    startGateway();
  }

  const chatUrl = `http://localhost:${manifest.gateway_port || 18789}/chat`;

  async function handleOpenChat() {
    if (openingChat || chatLocked) return;
    setOpeningChat(true);
    setChatLocked(true);
    addLog("info", "正在打开浏览器，请稍候...");
    try {
      const result = await invoke<CommandResult>("run_dashboard");
      if (!result.success) {
        addLog("warn", "dashboard 打开失败，回退到本地 chat 地址");
        await invoke("open_url", { url: chatUrl });
      }
    } finally {
      setOpeningChat(false);
      // 防止连续点击导致重复打开多个页面
      setTimeout(() => setChatLocked(false), 8000);
    }
  }

  return (
    <div className="h-full flex flex-col px-6 py-4 gap-4 overflow-y-auto">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">启动 Gateway</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          启动本地 AI 网关，成功后可点击按钮打开浏览器
        </p>
        {onboardingSummary && (
          <div className="mt-2 bg-gray-900 border border-gray-700 rounded-lg p-3">
            <p className="text-xs text-gray-400">onboard 执行摘要</p>
            <p className="text-xs text-gray-200 mt-1">{onboardingSummary.message}</p>
            {onboardingSummary.command && (
              <p className="text-[11px] text-gray-500 font-mono mt-1 break-all">
                {onboardingSummary.command}
              </p>
            )}
            {onboardingSummary.hint && (
              <p className="text-[11px] text-yellow-500 mt-1">{onboardingSummary.hint}</p>
            )}
          </div>
        )}
      </div>

      <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
        {phase === "starting" && (
          <div className="flex items-center gap-3">
            <Loader size={20} className="text-brand-400 animate-spin flex-shrink-0" />
            <div>
              <p className="text-sm text-gray-200">Gateway 启动中...</p>
              <p className="text-xs text-gray-500 mt-0.5">已等待 {elapsed}s / 最长等待 90s</p>
            </div>
          </div>
        )}
        {phase === "diagnosing" && (
          <div className="flex items-center gap-3">
            <Stethoscope size={20} className="text-yellow-400 animate-pulse flex-shrink-0" />
            <div>
              <p className="text-sm text-gray-200">正在诊断问题...</p>
              <p className="text-xs text-gray-500 mt-0.5">运行 openclaw doctor</p>
            </div>
          </div>
        )}
        {phase === "fixing" && (
          <div className="flex items-center gap-3">
            <Wrench size={20} className="text-yellow-400 animate-pulse flex-shrink-0" />
            <div>
              <p className="text-sm text-gray-200">正在修复问题...</p>
              <p className="text-xs text-gray-500 mt-0.5">运行 openclaw doctor --fix</p>
            </div>
          </div>
        )}
        {phase === "done" && (
          <div className="flex items-center gap-3">
            <span className="relative flex h-4 w-4 flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-4 w-4 bg-brand-500" />
            </span>
            <div>
              <p className="text-sm text-brand-400 font-medium">Gateway 运行中</p>
              <p className="text-xs text-gray-500 mt-0.5">{chatUrl}</p>
            </div>
          </div>
        )}
        {phase === "failed" && (
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <div className="w-4 h-4 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-red-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-red-400 font-medium">启动失败</p>
                {errorCode && (
                  <p className="text-xs text-gray-600 font-mono mt-0.5">{errorCode}</p>
                )}
                <p className="text-xs text-gray-400 mt-1 break-all">{errorMsg}</p>
                {errorHint && (
                  <p className="text-xs text-yellow-500 mt-1">{errorHint}</p>
                )}
              </div>
            </div>
            {recoveryTips.length > 0 && (
              <div className="bg-gray-800 rounded-lg p-3">
                <p className="text-xs text-gray-400 font-medium mb-1">建议操作：</p>
                <ul className="text-xs text-gray-500 space-y-1 pl-4 list-disc">
                  {recoveryTips.map((tip, i) => (
                    <li key={i}>{tip}</li>
                  ))}
                </ul>
              </div>
            )}
            
            {doctorResult && !doctorResult.passed && (
              <div className="bg-gray-800 rounded-lg p-3 space-y-2">
                <p className="text-xs text-gray-400 font-medium">诊断结果:</p>
                <p className="text-xs text-yellow-400">{doctorResult.summary}</p>
                {doctorResult.issues.length > 0 && (
                  <ul className="text-xs text-gray-500 space-y-1 pl-3">
                    {doctorResult.issues.slice(0, 5).map((issue, i) => (
                      <li key={i} className={issue.severity === "error" ? "text-red-400" : "text-yellow-500"}>
                        {issue.message}
                      </li>
                    ))}
                    {doctorResult.issues.length > 5 && (
                      <li className="text-gray-600">...还有 {doctorResult.issues.length - 5} 个问题</li>
                    )}
                  </ul>
                )}
              </div>
            )}

            {fixResult && !fixResult.success && (
              <div className="bg-gray-800 rounded-lg p-3">
                <p className="text-xs text-red-400">修复失败: {fixResult.message}</p>
                {fixResult.hint && (
                  <p className="text-xs text-yellow-500 mt-1">{fixResult.hint}</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex-1">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Gateway 日志</span>
        </div>
        <LogScroller logs={logs} maxHeight="h-full min-h-[150px]" />
      </div>

      <div className="flex flex-col gap-3 flex-shrink-0">
        {phase === "starting" && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500">正在等待 Gateway 响应...</p>
            <div className="flex gap-2">
              <button
                onClick={handleStop}
                disabled={stopping}
                className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600
                  disabled:opacity-50 text-gray-200 text-sm rounded-lg transition-colors"
              >
                <Square size={14} />
                {stopping ? "停止中..." : "停止"}
              </button>
              <button
                onClick={handleRetry}
                disabled={stopping}
                className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600
                  disabled:opacity-50 text-gray-200 text-sm rounded-lg transition-colors"
              >
                <RefreshCw size={14} />
                重试
              </button>
            </div>
          </div>
        )}
        {(phase === "diagnosing" || phase === "fixing") && (
          <div className="flex items-center justify-center">
            <p className="text-sm text-gray-500">请稍候...</p>
          </div>
        )}
        {phase === "failed" && (
          <>
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <button
                  onClick={runDiagnose}
                  disabled={!cliCaps?.has_doctor}
                  className="flex items-center gap-2 px-3 py-2 bg-yellow-900/30 hover:bg-yellow-800/40 text-yellow-400 text-sm rounded-lg transition-colors"
                >
                  <Stethoscope size={14} />
                  诊断问题
                </button>
                <button
                  onClick={runFix}
                  disabled={!cliCaps?.has_doctor}
                  className="flex items-center gap-2 px-3 py-2 bg-yellow-900/30 hover:bg-yellow-800/40 text-yellow-400 text-sm rounded-lg transition-colors"
                >
                  <Wrench size={14} />
                  一键修复
                </button>
              </div>
              <button
                onClick={handleRetry}
                className="flex items-center gap-2 px-4 py-2 bg-brand-500 hover:bg-brand-600 text-gray-950 font-semibold text-sm rounded-lg transition-colors"
              >
                <RefreshCw size={14} />
                重新启动
              </button>
            </div>
            <div className="flex items-center justify-between border-t border-gray-800 pt-3">
              <div className="flex gap-2">
                <button
                  onClick={openLogDirectory}
                  className="flex items-center gap-1.5 px-2 py-1.5 text-gray-500 hover:text-gray-300 text-xs rounded transition-colors"
                >
                  <FolderOpen size={12} />
                  查看 installer 日志
                </button>
                <button
                  onClick={openRuntimeLogDirectory}
                  className="flex items-center gap-1.5 px-2 py-1.5 text-gray-500 hover:text-gray-300 text-xs rounded transition-colors"
                >
                  <FolderOpen size={12} />
                  查看运行日志
                </button>
                <button
                  onClick={copyDiagnosticInfo}
                  className="flex items-center gap-1.5 px-2 py-1.5 text-gray-500 hover:text-gray-300 text-xs rounded transition-colors"
                >
                  {copied ? <CheckCircle size={12} className="text-green-400" /> : <Copy size={12} />}
                  {copied ? "已复制" : "复制诊断信息"}
                </button>
              </div>
              <p className="text-xs text-gray-600">
                如问题持续，请查看日志或联系支持
              </p>
            </div>
          </>
        )}
        {phase === "done" && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-brand-400">安装完成！桌面快捷方式已创建</p>
            <button
              onClick={handleOpenChat}
              disabled={openingChat || chatLocked}
              className="flex items-center gap-2 px-6 py-2 bg-brand-500 hover:bg-brand-600 disabled:bg-gray-700 disabled:text-gray-400 text-gray-950 font-semibold text-sm rounded-lg transition-colors"
            >
              {openingChat ? <Loader size={14} className="animate-spin" /> : <ExternalLink size={14} />}
              {openingChat ? "打开中..." : chatLocked ? "请稍候..." : "打开 OpenClaw"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
