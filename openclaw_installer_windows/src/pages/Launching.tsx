import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader, RefreshCw, Square, Stethoscope, Wrench } from "lucide-react";
import LogScroller from "../components/LogScroller";
import type { AppManifest, LogEntry, DoctorResult, CommandResult, CliCapabilities, OnboardingSummary } from "../types";
import { useI18n } from "../i18n/useI18n";

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

function buildGatewayRecoveryTips(
  message: string,
  code: string | null,
  backendHint: string | null,
  t: (key: string) => string
): { hint: string | null; tips: string[] } {
  const lower = `${code || ""} ${message} ${backendHint || ""}`.toLowerCase();
  const tips: string[] = [];
  let hint = backendHint;

  if (lower.includes("too many failed authentication attempts") || lower.includes("authentication attempts")) {
    hint = t("launching.recovery.authCache");
    tips.push(t("launching.recovery.tipRestart"));
    tips.push(t("launching.recovery.tipIncognito"));
  }
  if (lower.includes("no api key found") || lower.includes("auth-profiles")) {
    hint = hint || t("launching.recovery.noApiKey");
    tips.push(t("launching.recovery.tipDiagnose"));
    tips.push(t("launching.recovery.tipFix"));
  }
  if (lower.includes("gateway.mode") || lower.includes("mode local") || lower.includes("unconfigured")) {
    hint = hint || t("launching.recovery.gatewayMode");
    tips.push(t("launching.recovery.tipDoctor"));
  }
  if (lower.includes("cmd_not_found") || lower.includes("找不到 openclaw")) {
    hint = hint || t("launching.recovery.cmdNotFound");
    tips.push(t("launching.recovery.tipPath"));
  }
  if (tips.length === 0) {
    tips.push(t("launching.recovery.tipDiagnoseFirst"));
    tips.push(t("launching.recovery.tipCopyLog"));
  }

  return { hint, tips };
}

export default function Launching({ manifest, cliCaps, onboardingSummary, logs, addLog, onDone }: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<LaunchPhase>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [, setLogPath] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [, setDoctorResult] = useState<DoctorResult | null>(null);
  const [, setFixResult] = useState<CommandResult | null>(null);
  const [recoveryTips, setRecoveryTips] = useState<string[]>([]);
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
    addLog("info", t("launching.logStarting"));

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
      addLog("ok", t("launching.logReady", { url: "http://localhost:18789/chat" }));
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
      addLog("ok", t("launching.logReady", { url: `http://localhost:${finalPort}/chat` }));
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
      const guidance = buildGatewayRecoveryTips(msg, code, hint, t);
      setErrorHint(guidance.hint);
      setRecoveryTips(guidance.tips);
      setErrorCode(code);
      setLogPath(logFile);
      addLog("error", `${t("launching.logFail")}: ${msg}`);
    }
  }

  async function runDiagnose() {
    if (!cliCaps?.has_doctor) {
      setErrorMsg(t("launching.errorNoDoctor"));
      setErrorHint(t("launching.errorUpgradeHint"));
      return;
    }
    setPhase("diagnosing");
    addLog("info", t("launching.logDiagnosing"));
    
    try {
      const result = await invoke<DoctorResult>("run_doctor");
      setDoctorResult(result);
      setLogPath(result.log_path || null);
      
      if (result.passed) {
        addLog("ok", t("launching.logDiagnoseOk", { summary: result.summary }));
      } else {
        addLog("warn", t("launching.logDiagnoseWarn", { summary: result.summary }));
        for (const issue of result.issues) {
          addLog(issue.severity === "error" ? "error" : "warn", issue.message);
        }
      }
      
      setPhase("failed");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("error", t("launching.logDiagnoseFail", { msg }));
      setPhase("failed");
    }
  }

  async function runFix() {
    if (!cliCaps?.has_doctor) {
      setErrorMsg(t("launching.errorNoDoctorFix"));
      setErrorHint(t("launching.errorUpgradeHint"));
      return;
    }
    setPhase("fixing");
    addLog("info", t("launching.logFixRunning"));
    
    try {
      const result = await invoke<CommandResult>("run_doctor_fix");
      setFixResult(result);
      setLogPath(result.log_path || null);
      
      if (result.success) {
        addLog("ok", t("launching.logFixDone"));
        await new Promise((r) => setTimeout(r, 1000));
        startGateway();
      } else {
        addLog("error", t("launching.logFixFail", { msg: result.message }));
        if (result.hint) {
          addLog("warn", result.hint);
        }
        setPhase("failed");
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addLog("error", t("launching.logFixFail", { msg }));
      setPhase("failed");
    }
  }

  async function handleRetry() {
    cancelledRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    addLog("warn", t("launching.logStopping"));

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

  return (
    <div className="h-full flex flex-col px-6 py-6 gap-6 overflow-y-auto">
      {/* 全局操作遮罩：异步任务进行时防止误触 */}
      {(phase === "starting" || phase === "diagnosing" || phase === "fixing") && (
        <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm pointer-events-auto" />
      )}
      
      {/* Header */}
      <div className="text-center">
        <h2 className="text-2xl font-semibold text-heading mb-2 tracking-[-0.01em]">{t("step.launching")}</h2>
        <p className="text-sm text-muted leading-relaxed">
          {t("launching.subtitle")}
        </p>
      </div>

      {/* Onboarding summary */}
      {onboardingSummary && (
        <div className="glass-surface radius-standard p-5 max-w-2xl mx-auto w-full">
          <h3 className="text-sm font-medium text-heading mb-2">{t("launching.summaryTitle")}</h3>
          <p className="text-sm text-base mb-2">{onboardingSummary.message}</p>
          {onboardingSummary.command && (
            <p className="text-xs text-muted font-mono break-all bg-white/5 p-2 radius-small">
              {onboardingSummary.command}
            </p>
          )}
          {onboardingSummary.hint && (
            <p className="text-xs text-yellow-400 mt-2">{onboardingSummary.hint}</p>
          )}
        </div>
      )}

      {/* Main status area */}
      <div className="flex-1 flex flex-col max-w-3xl mx-auto w-full">
        <div className="glass-surface-darker radius-standard overflow-hidden mb-6 shadow-[0_18px_40px_rgba(0,0,0,0.28)]">
          {/* Status header */}
          <div className="p-7 border-b border-white/8">
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-full glass-surface flex items-center justify-center">
                {phase === "starting" && (
                  <Loader size={32} className="accent-primary animate-spin" />
                )}
                {phase === "diagnosing" && (
                  <Stethoscope size={32} className="text-yellow-400 animate-pulse" />
                )}
                {phase === "fixing" && (
                  <Wrench size={32} className="text-yellow-400 animate-pulse" />
                )}
                {phase === "done" && (
                  <div className="relative">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full accent-primary-bg opacity-60" />
                    <span className="relative inline-flex rounded-full w-8 h-8 accent-primary-bg" />
                  </div>
                )}
                {phase === "failed" && (
                  <span className="text-3xl text-red-400">✗</span>
                )}
              </div>
              
              <div>
                <h3 className="text-xl font-semibold text-heading tracking-[-0.01em]">
                  {phase === "starting" && t("launching.phase.starting")}
                  {phase === "diagnosing" && t("launching.phase.diagnosing")}
                  {phase === "fixing" && t("launching.phase.fixing")}
                  {phase === "done" && t("launching.phase.done")}
                  {phase === "failed" && t("launching.phase.failed")}
                </h3>
                <p className="text-sm text-muted mt-1">
                  {phase === "starting" && t("launching.elapsed", { seconds: elapsed })}
                  {phase === "diagnosing" && t("launching.diagnoseCmd")}
                  {phase === "fixing" && t("launching.fixCmd")}
                  {phase === "done" && chatUrl}
                  {phase === "failed" && t("launching.failedHint")}
                </p>
              </div>
            </div>
          </div>

          {/* Error details */}
          {phase === "failed" && (
            <div className="p-6 border-b border-white/5">
              <div className="glass-surface radius-small p-4 border border-red-500/30 bg-red-500/5">
                <div className="flex items-start gap-3">
                  <div className="w-5 h-5 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="w-2 h-2 rounded-full bg-red-500" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-red-400 font-medium">{t("launching.failedTitle")}</p>
                    {errorCode && (
                      <p className="text-xs text-red-300/60 font-mono mt-1">{errorCode}</p>
                    )}
                    <p className="text-xs text-red-300/80 mt-1 break-all">{errorMsg}</p>
                    {errorHint && (
                      <p className="text-xs text-yellow-400 mt-2">{errorHint}</p>
                    )}
                  </div>
                </div>
                
                {recoveryTips.length > 0 && (
                  <div className="mt-4 glass-surface-darker radius-small p-3">
                    <p className="text-xs text-yellow-300 font-medium mb-2">{t("launching.suggestions")}</p>
                    <ul className="text-xs text-yellow-400/80 space-y-1 pl-4 list-disc">
                      {recoveryTips.map((tip, i) => (
                        <li key={i}>{tip}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Log area */}
          <div className="p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full accent-primary-bg"></div>
                <span className="text-sm font-medium text-heading">{t("launching.logTitle")}</span>
              </div>
              <span className="text-xs text-muted">{t("installing.logLines", { count: logs.length })}</span>
            </div>
            <div className="h-32 overflow-y-auto">
              <LogScroller logs={logs} maxHeight="h-full" />
            </div>
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center justify-between min-h-11">
          {phase === "starting" && (
            <>
              <div className="flex items-center gap-3 text-muted">
                <Loader size={16} className="accent-primary animate-spin" />
                <span className="text-sm">{t("launching.waiting")}</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleRetry()}
                  disabled={stopping}
                  className="flex items-center gap-2 px-4 h-10 glass-surface hover:bg-white/10 text-base radius-small transition-colors disabled:opacity-50"
                >
                  <Square size={14} />
                  {stopping ? t("launching.stopping") : t("manager.stop")}
                </button>
                <button
                  onClick={handleRetry}
                  disabled={stopping}
                  className="flex items-center gap-2 px-4 h-10 glass-surface hover:bg-white/10 text-base radius-small transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={14} />
                  {t("common.retry")}
                </button>
              </div>
            </>
          )}

          {(phase === "diagnosing" || phase === "fixing") && (
            <div className="flex items-center gap-3 text-muted mx-auto">
              <Loader size={16} className="text-yellow-400 animate-spin" />
              <span className="text-sm">{t("common.loading")}</span>
            </div>
          )}

          {phase === "failed" && (
            <>
              <div className="flex gap-2">
                <button
                  onClick={runDiagnose}
                  disabled={!cliCaps?.has_doctor}
                  className="flex items-center gap-2 px-3 h-10 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 text-sm radius-small transition-colors disabled:opacity-50"
                >
                  <Stethoscope size={14} />
                  {t("manager.runDiagnose")}
                </button>
                <button
                  onClick={runFix}
                  disabled={!cliCaps?.has_doctor}
                  className="flex items-center gap-2 px-3 h-10 bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-400 text-sm radius-small transition-colors disabled:opacity-50"
                >
                  <Wrench size={14} />
                  {t("manager.runFix")}
                </button>
              </div>
              <button
                onClick={handleRetry}
                className="flex items-center gap-2 px-6 h-10 accent-primary-bg text-black font-semibold radius-small accent-primary-glow transition-all hover:scale-[1.03]"
              >
                <RefreshCw size={14} />
                {t("manager.restart")}
              </button>
            </>
          )}

          {phase === "done" && (
            <div className="flex items-center justify-center w-full">
              <button
                onClick={() => onDone(manifest)}
                className="px-8 h-11 accent-primary-bg text-black font-semibold radius-small accent-primary-glow transition-all hover:scale-[1.03]"
              >
                {t("common.next")} →
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}