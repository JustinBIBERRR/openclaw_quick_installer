import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader, RefreshCw, ExternalLink, FolderSearch, Terminal, Lightbulb } from "lucide-react";
import LogScroller from "../components/LogScroller";
import type { AppManifest, LogEntry, CommandResult } from "../types";
import type { EnvEstimate } from "../utils/estimate";
import { getInstallStepEstimate } from "../utils/estimate";
import { mapInstallCatchFailure, mapInstallFailure } from "../utils/installFailure";
import { useI18n } from "../i18n/useI18n";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const FUN_FACT_COUNT = 8;
const FUN_FACT_INTERVAL_MS = 6000;

const SUBSTEP_KEYS: Record<string, string> = {
  detectingNode: "installing.substep.detectingNode",
  installingNode: "installing.substep.installingNode",
  nodeReady: "installing.substep.nodeReady",
  connectingNpm: "installing.substep.connectingNpm",
  downloadingCli: "installing.substep.downloadingCli",
  installingCli: "installing.substep.installingCli",
  cliReady: "installing.substep.cliReady",
  verifyingInstall: "installing.substep.verifyingInstall",
  writingConfig: "installing.substep.writingConfig",
  allDone: "installing.substep.allDone",
};

interface Props {
  manifest: AppManifest | null;
  envEstimate: EnvEstimate | null;
  logs: LogEntry[];
  addLog: (level: LogEntry["level"], message: string) => void;
  onDone: () => void;
}

type InstallPhase = "idle" | "running" | "done" | "failed" | "manual_download";

function useFunFactRotation(active: boolean, t: (key: string) => string) {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * FUN_FACT_COUNT));
  const [fade, setFade] = useState(true);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setIndex((prev) => (prev + 1) % FUN_FACT_COUNT);
        setFade(true);
      }, 400);
    }, FUN_FACT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [active]);

  return { text: t(`installing.funFact.${index}`), fade };
}

export default function Installing({ manifest, envEstimate, logs, addLog, onDone }: Props) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<InstallPhase>("idle");
  const [currentStep, setCurrentStep] = useState(0);
  const [substepLabel, setSubstepLabel] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [errorHint, setErrorHint] = useState<string | null>(null);
  const [manualDownloadUrl, setManualDownloadUrl] = useState("");
  const startedRef = useRef(false);
  const installSteps = [
    t("installing.step.detectNode"),
    t("installing.step.installCli"),
    t("installing.step.verify"),
    t("installing.step.complete"),
  ];
  const totalSteps = installSteps.length;
  const basePercent = Math.max(0, Math.min(100, Math.round((currentStep / totalSteps) * 100)));
  const stepWidth = Math.round(100 / totalSteps);
  const [creep, setCreep] = useState(0);
  const creepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setCreep(0);
    if (creepTimerRef.current) clearInterval(creepTimerRef.current);
    if (phase === "running" && currentStep < totalSteps) {
      const maxCreep = Math.max(0, stepWidth - 5);
      creepTimerRef.current = setInterval(() => {
        setCreep((prev) => (prev < maxCreep ? prev + 1 : prev));
      }, 3000);
    }
    return () => { if (creepTimerRef.current) clearInterval(creepTimerRef.current); };
  }, [phase, currentStep, totalSteps, stepWidth]);

  const progressPercent = phase === "done"
    ? 100
    : Math.max(0, Math.min(100, basePercent + creep));

  const substepText = useCallback(() => {
    const i18nKey = SUBSTEP_KEYS[substepLabel];
    if (i18nKey) return t(i18nKey);
    return installSteps[Math.min(currentStep, installSteps.length - 1)] || "";
  }, [substepLabel, currentStep, t]);

  const funFact = useFunFactRotation(phase === "running", t);

  const progressHint =
    phase === "done"
      ? t("installing.allDone")
      : phase === "failed"
        ? t("installing.failedDesc")
        : phase === "manual_download"
          ? t("installing.manualRetryHint")
          : substepText();

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const unlistenProgress = listen<{ step: number; total: number; label: string }>(
      "install-progress",
      (e) => {
        setCurrentStep(e.payload.step);
        if (e.payload.label) setSubstepLabel(e.payload.label);
      }
    );

    const unlistenLog = listen<{ level: string; message: string }>(
      "install-log",
      (e) => {
        if (e.payload.level === "manual_download" && e.payload.message) {
          setManualDownloadUrl(e.payload.message);
          setPhase("manual_download");
        }
      }
    );

    startInstall();
    return () => {
      unlistenProgress.then((f) => f());
      unlistenLog.then((f) => f());
    };
  }, []);

  async function startInstall() {
    setPhase("running");
    setErrorMsg("");
    setErrorHint(null);
    addLog("info", t("installing.logStart"));

    if (!isTauri) {
      const simLabels = ["detectingNode", "nodeReady", "connectingNpm", "installingCli", "cliReady", "verifyingInstall", "writingConfig", "allDone"];
      const steps = [
        { step: 0, delay: 800,  labels: [simLabels[0], simLabels[1]], logs: ["[Preview] Node.js v22 detected, skipping install"] },
        { step: 1, delay: 2000, labels: [simLabels[2], simLabels[3], simLabels[4]], logs: ["[Preview] npm install -g openclaw", "[Preview] added 312 packages in 18s"] },
        { step: 2, delay: 800,  labels: [simLabels[5]], logs: ["[Preview] Verifying openclaw --version"] },
        { step: 3, delay: 500,  labels: [simLabels[6], simLabels[7]], logs: ["[Preview] Writing install-info.json", "[Preview] Install complete ✓"] },
      ];
      for (const s of steps) {
        setCurrentStep(s.step);
        for (let i = 0; i < s.labels.length; i++) {
          setSubstepLabel(s.labels[i]);
          await new Promise((r) => setTimeout(r, s.delay / s.labels.length));
        }
        s.logs.forEach((l) => addLog("info", l));
      }
      await new Promise((r) => setTimeout(r, 300));
      setCurrentStep(4);
      setPhase("done");
      addLog("ok", t("installing.logDone"));
      return;
    }

    try {
      const result = await invoke<CommandResult>("start_install", {
        installDir: manifest?.install_dir || "C:\\OpenClaw",
      });
      if (!result.success) {
        const msg = mapInstallFailure(result);
        setPhase("failed");
        setErrorMsg(msg);
        setErrorHint(result.hint || null);
        addLog("error", `${t("installing.logFail")}: ${msg}`);
        if (result.hint) addLog("warn", result.hint);
        return;
      }
      setCurrentStep(installSteps.length);
      setPhase("done");
      addLog("ok", t("installing.logDone"));
    } catch (e: unknown) {
      const msg = mapInstallCatchFailure(e);
      setPhase("failed");
      setErrorMsg(msg);
      setErrorHint(t("installing.retryPathHint"));
      addLog("error", `${t("installing.logFail")}: ${msg}`);
    }
  }

  return (
    <div className="h-full flex flex-col px-4 sm:px-6 py-4 sm:py-6 gap-4 sm:gap-6 overflow-y-auto">
      {/* Header */}
      <div className="text-center">
        <h2 className="text-xl sm:text-2xl font-semibold text-heading mb-1 sm:mb-2 tracking-[-0.01em]">{t("installing.title")}</h2>
        <p className="text-xs sm:text-sm text-muted leading-relaxed">
          {t("installing.subtitle", { estimate: getInstallStepEstimate(envEstimate) })}
        </p>
      </div>

      {/* Main progress area */}
      <div className="flex-1 flex flex-col max-w-4xl mx-auto w-full">
        <div className="glass-surface-darker radius-standard overflow-hidden mb-4 sm:mb-6 relative shadow-[0_12px_30px_rgba(0,0,0,0.24)] sm:shadow-[0_18px_40px_rgba(0,0,0,0.28)] flex-1 min-h-[320px]">
          <div className="h-1.5 w-full bg-white/5 relative overflow-hidden">
            <div
              className="absolute top-0 left-0 h-full accent-primary-bg shadow-[0_0_12px_rgba(0,229,255,0.6)] transition-all duration-700 ease-out"
              style={{ width: `${progressPercent}%` }}
            />
            {phase === "running" && (
              <div className="absolute top-0 left-0 h-full w-full">
                <div className="h-full bg-gradient-to-r from-transparent via-white/20 to-transparent animate-shimmer" />
              </div>
            )}
          </div>

          <div className="flex items-center justify-between px-3 sm:px-4 py-3 border-b border-white/5 bg-black/40">
            <div className="flex items-center gap-2">
              <Terminal size={14} className="accent-primary sm:w-4 sm:h-4" />
              <span className="text-[0.7rem] sm:text-xs font-mono text-white/55">PowerShell (Administrator)</span>
            </div>
            <span className="text-[0.7rem] sm:text-xs text-muted">{t("installing.logLines", { count: logs.length })}</span>
          </div>

          {isTauri && phase === "running" && (
            <div className="px-3 sm:px-4 py-2 bg-yellow-500/10 border-b border-yellow-500/20">
              <p className="text-[0.68rem] sm:text-xs text-yellow-300">{t("installing.psHint")}</p>
            </div>
          )}

          <div className="p-3 sm:p-4 h-[10.5rem] min-h-[10.5rem] max-h-[10.5rem] overflow-hidden flex flex-col">
            <LogScroller logs={logs} maxHeight="h-full min-h-0" />
          </div>

          <div className="px-3 sm:px-4 py-2.5 border-t border-white/5 bg-black/30 flex items-center justify-between">
            <div className="flex items-center gap-2 text-white/60 text-[0.68rem] sm:text-xs min-w-0">
              {phase === "running" ? <Loader size={12} className="accent-primary animate-spin flex-shrink-0" /> : null}
              <span className="truncate">{progressHint}</span>
            </div>
            <span className="text-xs sm:text-sm font-mono accent-primary">{progressPercent}%</span>
          </div>
        </div>

        {/* Fun fact carousel */}
        {phase === "running" && (
          <div className="flex items-start gap-2.5 px-1">
            <Lightbulb size={14} className="text-yellow-400/70 mt-0.5 flex-shrink-0" />
            <p
              className={`text-[0.72rem] sm:text-xs text-white/40 leading-relaxed italic transition-opacity duration-400 ${funFact.fade ? "opacity-100" : "opacity-0"}`}
            >
              {funFact.text}
            </p>
          </div>
        )}
      </div>

      {/* 手动下载引导 */}
      {phase === "manual_download" && (
        <div className="glass-surface radius-standard p-4 sm:p-6 border border-yellow-500/30 bg-yellow-500/5">
          <div className="flex items-start gap-2 sm:gap-3 mb-3 sm:mb-4">
            <FolderSearch size={18} className="text-yellow-400 mt-1 flex-shrink-0 sm:w-5 sm:h-5" />
            <div>
              <h3 className="text-base sm:text-lg font-medium text-yellow-300 mb-1 sm:mb-2">{t("installing.manualNodeTitle")}</h3>
              <p className="text-xs sm:text-sm text-yellow-400/80">
                {t("installing.manualNodeDesc")}
              </p>
            </div>
          </div>
          
          <div className="glass-surface-darker radius-small p-3 sm:p-4 mb-3 sm:mb-4 text-xs sm:text-sm text-base space-y-1.5 sm:space-y-2">
            <p className="flex items-center gap-2">
              <span className="w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-yellow-500 text-black text-[0.65rem] sm:text-xs flex items-center justify-center font-bold flex-shrink-0">1</span>
              <span className="flex-1">{t("installing.manualNodeStep1")}</span>
            </p>
            <p className="flex items-center gap-2">
              <span className="w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-yellow-500 text-black text-[0.65rem] sm:text-xs flex items-center justify-center font-bold flex-shrink-0">2</span>
              <span className="flex-1">{t("installing.manualNodeStep2")}</span>
            </p>
            <p className="flex items-center gap-2">
              <span className="w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-yellow-500 text-black text-[0.65rem] sm:text-xs flex items-center justify-center font-bold flex-shrink-0">3</span>
              <span className="flex-1">{t("installing.manualNodeStep3")}</span>
            </p>
          </div>
          
          <button
            onClick={() => {
              if (isTauri && manualDownloadUrl) {
                invoke("open_url", { url: manualDownloadUrl }).catch(() => {
                  window.open(manualDownloadUrl, "_blank");
                });
              }
            }}
            className="w-full flex items-center justify-center gap-2 py-2.5 sm:py-3 bg-yellow-500 hover:bg-yellow-400 text-black font-semibold text-xs sm:text-sm radius-small transition-colors"
          >
            <ExternalLink size={14} className="sm:w-4 sm:h-4" />
            {t("installing.openNodeDownload")}
          </button>
        </div>
      )}

      {/* 底部操作区 */}
      <div className="flex flex-col gap-3 sm:gap-4">
        {(phase === "failed" || phase === "manual_download") && (
          <div className="glass-surface radius-standard p-3 sm:p-4 border border-red-500/30 bg-red-500/5">
            <div className="flex items-start gap-2 sm:gap-3">
              <div className="w-4 h-4 sm:w-5 sm:h-5 rounded-full bg-red-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                <span className="w-1.5 h-1.5 sm:w-2 sm:h-2 rounded-full bg-red-500" />
              </div>
              <div className="flex-1">
                <p className="text-xs sm:text-sm text-red-400 font-medium">
                  {phase === "manual_download" ? t("installing.manualRetryHint") : t("installing.failed")}
                </p>
                {errorMsg && phase !== "manual_download" && (
                  <p className="text-[0.7rem] sm:text-xs text-red-300/80 mt-1">{errorMsg}</p>
                )}
                {errorHint && phase !== "manual_download" && (
                  <p className="text-[0.7rem] sm:text-xs text-yellow-400 mt-2">{errorHint}</p>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 sm:gap-0">
          {phase === "done" ? (
            <>
              <div className="flex items-center gap-2 text-accent-success order-2 sm:order-1">
                <span className="w-4 h-4 sm:w-5 sm:h-5 rounded-full accent-success-bg flex items-center justify-center">
                  <span className="text-black text-[0.7rem] sm:text-xs font-bold">✓</span>
                </span>
                <span className="text-xs sm:text-sm font-medium">{t("installing.successTag")}</span>
              </div>
              <button
                onClick={onDone}
                className="px-6 sm:px-8 h-10 sm:h-11 accent-primary-bg text-black font-semibold text-xs sm:text-sm radius-small accent-primary-glow transition-all hover:scale-[1.03] order-1 sm:order-2"
              >
                {t("installing.next")}
              </button>
            </>
          ) : (phase === "failed" || phase === "manual_download") ? (
            <>
              <div className="flex-1" />
              <button
                onClick={() => { setPhase("idle"); startedRef.current = false; startInstall(); }}
                className="flex items-center justify-center gap-2 px-5 sm:px-6 h-10 sm:h-11 glass-surface hover:bg-white/10 text-xs sm:text-sm text-base radius-small transition-colors"
              >
                <RefreshCw size={14} className="sm:w-4 sm:h-4" />
                {t("installing.retryInstall")}
              </button>
            </>
          ) : (
            <div className="flex items-center gap-3 text-muted">
              <Loader size={14} className="accent-primary animate-spin sm:w-4 sm:h-4" />
              <span className="text-xs sm:text-sm">{t("installing.inProgress")}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
