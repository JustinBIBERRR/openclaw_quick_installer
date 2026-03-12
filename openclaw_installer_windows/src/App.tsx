import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import type { AppManifest, DisplayStep, LogEntry, GatewayStatus, CliCapabilities, OnboardingSummary, InstallationSummary, CommandResult } from "./types";
import type { EnvEstimate } from "./utils/estimate";
import Welcome from "./pages/Welcome";
import SysCheck from "./pages/SysCheck";
import Installing from "./pages/Installing";
import OnboardingSetup from "./pages/OnboardingSetup";
import Launching from "./pages/Launching";
import Success from "./pages/Success";
import Manager from "./pages/Manager";
import TitleBar from "./components/TitleBar";
import ResizeHandles from "./components/ResizeHandles";
import { useI18n } from "./i18n/useI18n";
import WizardFrame from "./components/WizardFrame";

type AppView = "loading" | "wizard" | "manager";
type CleanupFlowState = "pending" | "launching" | "launched" | "verifying" | "verified";

interface CleanupVerificationResult {
  user_profile: string;
  openclaw_dir: string;
  npm_openclaw_cmd: string;
  openclaw_dir_exists: boolean;
  openclaw_cmd_found_in_path: boolean;
  npm_openclaw_cmd_exists: boolean;
}

let logIdCounter = 0;
let cliCapsProbePromise: Promise<CliCapabilities> | null = null;

export default function App() {
  const { t } = useI18n();
  const [view, setView] = useState<AppView>("loading");
  const [displayStep, setDisplayStep] = useState<DisplayStep>("welcome");
  const [manifest, setManifest] = useState<AppManifest | null>(null);
  const [isInitializing, setIsInitializing] = useState(true);
  const [managerAutoOpenConfig, setManagerAutoOpenConfig] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>("checking");
  const [cliCaps, setCliCaps] = useState<CliCapabilities | null>(null);
  const [cliCapsLoading, setCliCapsLoading] = useState(false);
  const [envEstimate] = useState<EnvEstimate | null>(null);
  const [loadingSec, setLoadingSec] = useState(0);
  const [onboardingSummary, setOnboardingSummary] = useState<OnboardingSummary | null>(null);
  const [installationSummary, setInstallationSummary] = useState<InstallationSummary | null>(null);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [cleanupConfirmOpen, setCleanupConfirmOpen] = useState(false);
  const [cleanupConfirmText, setCleanupConfirmText] = useState("");
  const [cleanupFlow, setCleanupFlow] = useState<CleanupFlowState>("pending");
  const [cleanupVerifyResult, setCleanupVerifyResult] = useState<CleanupVerificationResult | null>(null);
  const [cleanupError, setCleanupError] = useState<string | null>(null);

  const cleanupKeyword = "DELETE";
  const scopeOpenclawDir = "%USERPROFILE%\\.openclaw";
  const scopeNpmCmd = "%APPDATA%\\npm\\openclaw.cmd";

  const buildCleanupReportText = (result: CleanupVerificationResult) => {
    return [
      "=== OpenClaw Cleanup Verification Report ===",
      `Generated At: ${new Date().toISOString()}`,
      `User Profile: ${result.user_profile}`,
      `OpenClaw Dir: ${result.openclaw_dir}`,
      `OpenClaw Dir Exists: ${result.openclaw_dir_exists ? "YES" : "NO"}`,
      `NPM openclaw.cmd: ${result.npm_openclaw_cmd}`,
      `NPM openclaw.cmd Exists: ${result.npm_openclaw_cmd_exists ? "YES" : "NO"}`,
      `openclaw Found In PATH: ${result.openclaw_cmd_found_in_path ? "YES" : "NO"}`,
    ].join("\n");
  };

  const addLog = (level: LogEntry["level"], message: string) => {
    setLogs((prev) => [
      ...prev,
      { id: logIdCounter++, level, message, timestamp: Date.now() },
    ]);
  };

  useEffect(() => {
    if (!isTauri) {
      // 浏览器开发预览模式：立即显示界面
      setView("wizard");
      setDisplayStep("welcome");
      setIsInitializing(false);
      return;
    }

    // 监听后端推送的安装日志
    const unlistenLog = listen<{ level: string; message: string }>(
      "install-log",
      (event) => {
        const level = (event.payload.level as LogEntry["level"]) || "info";
        addLog(level, event.payload.message);
      }
    );

    const withTimeout = async <T,>(promise: Promise<T>, ms: number): Promise<T> => {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), ms)
        ),
      ]);
    };

    // 立即显示 UI，然后在后台异步加载状态
    setView("wizard");
    setDisplayStep("welcome");
    setIsInitializing(false);
    
    // 异步加载应用状态，不阻塞 UI
    (async () => {
      try {
        const m = await withTimeout(invoke<AppManifest | null>("get_app_state"), 5000);
        
        setManifest(m);
        setManagerAutoOpenConfig(false);
        
        // 如果是完成状态且有manifest，可以提示用户直接进入manager
        if (m && m.phase === "complete") {
          // 不立即跳转，而是在欢迎页显示"继续上次安装"选项
          // 用户可以选择继续或重新开始
        }
      } catch (error) {
        // 错误时保持在欢迎页，用户可以正常开始安装流程
      }
    })();

    // CLI 能力探测改为后台异步，不阻塞首屏
    setCliCapsLoading(true);
    if (!cliCapsProbePromise) {
      cliCapsProbePromise = withTimeout(invoke<CliCapabilities>("detect_cli_capabilities"), 15000)
        .finally(() => {
          cliCapsProbePromise = null;
        });
    }
    cliCapsProbePromise
      .then((caps) => {
        setCliCaps(caps);
      })
      .catch((err) => {
        console.error("CLI capabilities detection failed:", err);
        setCliCaps(null);
      })
      .finally(() => {
        setCliCapsLoading(false);
      });

    return () => {
      unlistenLog.then((f) => f());
    };
  }, []);


  useEffect(() => {
    if (view !== "loading") return;
    const timer = setInterval(() => setLoadingSec((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [view]);

  const handleSysCheckDone = (installDir: string) => {
    setManifest((prev) => ({
      ...(prev ?? {
        version: "1.0.0",
        phase: "fresh",
        install_dir: installDir,
        gateway_port: 18789,
        gateway_pid: null,
        api_provider: "",
        api_key_configured: false,
        api_key_verified: false,
        steps_done: [],
        last_error: null,
      }),
      install_dir: installDir,
    }));
    setDisplayStep("installing");
  };

  const handleReadyConfigDetected = async () => {
    const fallbackInstallDir = await invoke<string>("get_default_install_dir")
      .catch(() => "C:\\OpenClaw");
    setManifest((prev) => prev ?? {
      version: "1.0.0",
      phase: "complete",
      install_dir: fallbackInstallDir,
      gateway_port: 18789,
      gateway_pid: null,
      api_provider: "",
      api_key_configured: true,
      api_key_verified: false,
      steps_done: [],
      last_error: null,
    });
    setManagerAutoOpenConfig(false);
    setView("manager");
  };

  const handleInstallDone = () => {
    setDisplayStep("onboarding");
  };

  const handleOnboardingDone = (summary: OnboardingSummary | null) => {
    setOnboardingSummary(summary);
    setDisplayStep("launching");
  };

  const handleLaunchDone = (updatedManifest: AppManifest) => {
    setManifest(updatedManifest);
    
    // 创建安装摘要用于成功页
    const summary: InstallationSummary = {
      installDir: updatedManifest.install_dir,
      gatewayPort: updatedManifest.gateway_port || 18789,
      gatewayUrl: `http://localhost:${updatedManifest.gateway_port || 18789}/chat`,
      apiProvider: updatedManifest.api_provider,
      apiConfigured: updatedManifest.api_key_configured,
      onboardingSummary,
    };
    setInstallationSummary(summary);
    setGatewayStatus("running");
    
    // 进入成功页而不是直接进入 Manager
    setDisplayStep("success");
  };

  const handleSuccessDone = () => {
    setManagerAutoOpenConfig(false);
    setView("manager");
  };

  const handleOpenChatFromSuccess = async () => {
    if (!isTauri || !manifest) return;
    
    try {
      const result = await invoke<CommandResult>("run_dashboard");
      if (!result.success) {
        // 如果 dashboard 失败，回退到直接打开 URL
        const chatUrl = `http://localhost:${manifest.gateway_port || 18789}/chat`;
        await invoke("open_url", { url: chatUrl });
      }
    } catch (e) {
      console.error("Failed to open chat:", e);
    }
  };

  const handleWelcomeDone = () => {
    setDisplayStep("syscheck");
  };

  const handleCleanupRequest = () => {
    setCleanupConfirmOpen(true);
    setCleanupConfirmText("");
    setCleanupFlow("pending");
    setCleanupVerifyResult(null);
    setCleanupError(null);
    addLog("warn", t("welcome.cleanupConfirmDesc"));
  };

  const handleWelcomeCleanup = async () => {
    if (!isTauri || cleanupBusy) return;
    setCleanupBusy(true);
    setCleanupFlow("launching");
    setCleanupError(null);
    addLog("info", t("welcome.cleanupRunning"));
    try {
      await invoke("open_cleanup_powershell");
      addLog("ok", t("welcome.cleanupDone"));
      setCleanupFlow("launched");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addLog("error", t("welcome.cleanupFailed", { error: msg }));
      setCleanupError(msg);
      setCleanupFlow("pending");
    } finally {
      setCleanupBusy(false);
    }
  };

  const handleCleanupVerify = async () => {
    if (!isTauri || cleanupBusy) return;
    setCleanupBusy(true);
    setCleanupFlow("verifying");
    setCleanupError(null);
    addLog("info", t("welcome.cleanupVerifying"));
    try {
      const result = await invoke<CleanupVerificationResult>("verify_cleanup_state");
      setCleanupVerifyResult(result);
      setCleanupFlow("verified");
      const cleaned =
        !result.openclaw_dir_exists &&
        !result.openclaw_cmd_found_in_path &&
        !result.npm_openclaw_cmd_exists;
      addLog("info", `${t("welcome.cleanupScopeFile1", { path: result.openclaw_dir })}`);
      addLog("info", `${t("welcome.cleanupScopeFile2", { path: result.npm_openclaw_cmd })}`);
      addLog(cleaned ? "ok" : "warn", cleaned ? t("welcome.cleanupResultOk") : t("welcome.cleanupResultWarn"));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      setCleanupError(msg);
      addLog("error", t("welcome.cleanupFailed", { error: msg }));
      setCleanupFlow("launched");
    } finally {
      setCleanupBusy(false);
    }
  };

  const handleCopyCleanupReport = async () => {
    if (!cleanupVerifyResult) return;
    try {
      const text = buildCleanupReportText(cleanupVerifyResult);
      await navigator.clipboard.writeText(text);
      addLog("ok", t("welcome.cleanupCopyOk"));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      addLog("error", t("welcome.cleanupCopyFailed", { error: msg }));
    }
  };

  
  // 获取当前显示步骤在步骤条中的索引（排除欢迎页和成功页）
  const getStepBarIndex = (step: DisplayStep): number => {
    const wizardSteps = ["syscheck", "installing", "onboarding", "launching"];
    const index = wizardSteps.indexOf(step as any);
    return index >= 0 ? index : 0;
  };
  
  const getStepBarLabels = (): string[] => {
    return [t("step.syscheck"), t("step.installing"), t("step.onboarding"), t("step.launching")];
  };

  if (view === "loading" || isInitializing) {
    return (
      <div className="h-screen flex items-center justify-center bg-space-black">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-accent-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-white/80 text-sm">{t("loading.scanning", { seconds: loadingSec })}</span>
          {cliCapsLoading && (
            <span className="text-white/60 text-xs">{t("loading.detectingCli")}</span>
          )}
          {loadingSec >= 3 && (
            <span className="text-accent-primary text-xs">{t("loading.willReady")}</span>
          )}
          {loadingSec >= 6 && (
            <button
              onClick={() => {
                setView("wizard");
                setDisplayStep("welcome");
                setIsInitializing(false);
              }}
              className="px-4 py-2 text-sm text-white bg-accent-primary/20 hover:bg-accent-primary/30 rounded-md transition-colors"
            >
              {t("loading.enterWizard")}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (view === "manager") {
    return (
      <Manager
        manifest={manifest!}
        cliCaps={cliCaps}
        gatewayStatus={gatewayStatus}
        onStatusChange={setGatewayStatus}
        onManifestChange={setManifest}
        autoOpenConfig={managerAutoOpenConfig}
      />
    );
  }

  return (
    <div className="h-screen flex flex-col select-none" style={{ background: '#060B14' }}>
      <ResizeHandles />
      <TitleBar title={t("app.title.installer")} />
      
      <WizardFrame
        showSteps={displayStep !== "welcome" && displayStep !== "success"}
        steps={getStepBarLabels()}
        current={getStepBarIndex(displayStep)}
      >
          {displayStep === "welcome" && (
            <Welcome onNext={handleWelcomeDone} onCleanup={handleCleanupRequest} cleanupBusy={cleanupBusy} />
          )}
          {displayStep === "syscheck" && (
            <SysCheck
              envEstimate={envEstimate}
              onDone={handleSysCheckDone}
              onReadyConfigDetected={handleReadyConfigDetected}
            />
          )}
          {displayStep === "installing" && (
            <Installing
              manifest={manifest}
              envEstimate={envEstimate}
              logs={logs}
              addLog={addLog}
              onDone={handleInstallDone}
            />
          )}
          {displayStep === "onboarding" && (
            <OnboardingSetup
              cliCaps={cliCaps}
              cliCapsLoading={cliCapsLoading}
              onDone={handleOnboardingDone}
            />
          )}
          {displayStep === "launching" && (
            <Launching
              manifest={manifest!}
              cliCaps={cliCaps}
              onboardingSummary={onboardingSummary}
              logs={logs}
              addLog={addLog}
              onDone={handleLaunchDone}
            />
          )}
          {displayStep === "success" && (
            <Success
              installationSummary={installationSummary}
              onOpenManager={handleSuccessDone}
              onOpenChat={handleOpenChatFromSuccess}
            />
          )}
      </WizardFrame>
      {displayStep === "welcome" && cleanupConfirmOpen && (
        <div className="absolute inset-0 z-50 bg-black/60 flex items-center justify-center px-6">
          <div className="w-full max-w-2xl rounded-xl border border-red-400/30 bg-[#0f1624] p-6 text-white">
            <h3 className="text-xl font-semibold mb-2">{t("welcome.cleanupConfirmTitle")}</h3>
            <p className="text-sm text-white/75 mb-4">{t("welcome.cleanupConfirmDesc")}</p>
            <p className="text-sm font-medium mb-2">{t("welcome.cleanupScopeTitle")}</p>
            <ul className="text-sm text-white/80 space-y-1 mb-4">
              <li>- {t("welcome.cleanupScopeFile1", { path: scopeOpenclawDir })}</li>
              <li>- {t("welcome.cleanupScopeFile2", { path: scopeNpmCmd })}</li>
              <li>- {t("welcome.cleanupScopeCmd")}</li>
              <li>- {t("welcome.cleanupScopeEnv")}</li>
            </ul>
            <p className="text-xs text-white/60 mb-3">{t("welcome.cleanupVerifyHint")}</p>

            <div className="mb-4">
              <label className="block text-xs text-white/60 mb-1">
                {t("welcome.cleanupKeywordHint", { keyword: cleanupKeyword })}
              </label>
              <input
                value={cleanupConfirmText}
                onChange={(e) => setCleanupConfirmText(e.target.value)}
                placeholder={cleanupKeyword}
                className="w-full rounded-md bg-white/5 border border-white/15 px-3 py-2 text-sm outline-none focus:border-red-300/60"
              />
            </div>

            <div className="mb-4 text-sm space-y-1">
              <div>- {cleanupFlow === "pending" ? t("welcome.cleanupStatusPending") : "✓ " + t("welcome.cleanupStatusPending")}</div>
              <div>- {cleanupFlow === "launching" ? t("welcome.cleanupStatusLaunching") : cleanupFlow === "pending" ? t("welcome.cleanupStatusLaunching") : "✓ " + t("welcome.cleanupStatusLaunching")}</div>
              <div>- {(cleanupFlow === "launched" || cleanupFlow === "verifying" || cleanupFlow === "verified") ? "✓ " + t("welcome.cleanupStatusLaunched") : t("welcome.cleanupStatusLaunched")}</div>
              <div>- {cleanupFlow === "verified" ? "✓ " + t("welcome.cleanupStatusVerified") : t("welcome.cleanupStatusVerified")}</div>
            </div>

            {cleanupVerifyResult && (
              <div className="mb-4 text-xs text-white/75 bg-white/5 border border-white/10 rounded-md p-3 space-y-1">
                <div>{t("welcome.cleanupScopeFile1", { path: cleanupVerifyResult.openclaw_dir })}: {cleanupVerifyResult.openclaw_dir_exists ? t("welcome.cleanupVerify.exists") : t("welcome.cleanupVerify.cleaned")}</div>
                <div>{t("welcome.cleanupScopeFile2", { path: cleanupVerifyResult.npm_openclaw_cmd })}: {cleanupVerifyResult.npm_openclaw_cmd_exists ? t("welcome.cleanupVerify.exists") : t("welcome.cleanupVerify.cleaned")}</div>
                <div>{t("welcome.cleanupVerify.pathCmd")}: {cleanupVerifyResult.openclaw_cmd_found_in_path ? t("welcome.cleanupVerify.found") : t("welcome.cleanupVerify.notFound")}</div>
              </div>
            )}

            {cleanupError && (
              <div className="mb-4 text-sm text-red-300">{t("welcome.cleanupFailed", { error: cleanupError })}</div>
            )}

            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setCleanupConfirmOpen(false)}
                disabled={cleanupBusy}
                className="px-4 py-2 rounded-md border border-white/20 text-white/80 hover:bg-white/10 disabled:opacity-60"
              >
                {t("welcome.cleanupCancel")}
              </button>
              <button
                onClick={handleWelcomeCleanup}
                disabled={cleanupBusy || cleanupConfirmText.trim().toUpperCase() !== cleanupKeyword}
                className="px-4 py-2 rounded-md bg-red-500/80 text-white hover:bg-red-500 disabled:opacity-60"
              >
                {t("welcome.cleanupConfirm")}
              </button>
              <button
                onClick={handleCleanupVerify}
                disabled={cleanupBusy || cleanupFlow === "pending" || cleanupFlow === "launching"}
                className="px-4 py-2 rounded-md bg-cyan-500/80 text-black hover:bg-cyan-400 disabled:opacity-60"
              >
                {t("welcome.cleanupVerify")}
              </button>
              <button
                onClick={handleCopyCleanupReport}
                disabled={cleanupBusy || !cleanupVerifyResult}
                className="px-4 py-2 rounded-md bg-white/15 text-white hover:bg-white/25 disabled:opacity-60"
              >
                {t("welcome.cleanupCopyReport")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
