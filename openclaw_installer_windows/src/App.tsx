import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import type { AppManifest, WizardStep, LogEntry, GatewayStatus, CliCapabilities, OnboardingSummary } from "./types";
import type { EnvEstimate } from "./utils/estimate";
import SysCheck from "./pages/SysCheck";
import Installing from "./pages/Installing";
import OnboardingSetup from "./pages/OnboardingSetup";
import Launching from "./pages/Launching";
import Manager from "./pages/Manager";
import TitleBar from "./components/TitleBar";
import StepBar from "./components/StepBar";
import ResizeHandles from "./components/ResizeHandles";

type AppView = "loading" | "wizard" | "manager";

let logIdCounter = 0;
let cliCapsProbePromise: Promise<CliCapabilities> | null = null;

export default function App() {
  const [view, setView] = useState<AppView>("loading");
  const [wizardStep, setWizardStep] = useState<WizardStep>("syscheck");
  const [manifest, setManifest] = useState<AppManifest | null>(null);
  const [managerAutoOpenConfig, setManagerAutoOpenConfig] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>("checking");
  const [cliCaps, setCliCaps] = useState<CliCapabilities | null>(null);
  const [cliCapsLoading, setCliCapsLoading] = useState(false);
  const [envEstimate] = useState<EnvEstimate | null>(null);
  const [loadingSec, setLoadingSec] = useState(0);
  const [onboardingSummary, setOnboardingSummary] = useState<OnboardingSummary | null>(null);

  const addLog = (level: LogEntry["level"], message: string) => {
    setLogs((prev) => [
      ...prev,
      { id: logIdCounter++, level, message, timestamp: Date.now() },
    ]);
  };

  useEffect(() => {
    if (!isTauri) {
      // 浏览器开发预览模式：直接进入向导
      setView("wizard");
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

    // 启动阶段仅做轻量路由：优先读取本地 manifest，避免首屏重检测
    withTimeout(invoke<AppManifest | null>("get_app_state"), 5000)
      .then((m) => {
        setManifest(m);
        setManagerAutoOpenConfig(false);
        if (m && m.phase === "complete") {
          setView("manager");
          return;
        }
        setView("wizard");
        if (m && m.phase === "installing") {
          setWizardStep("installing");
        } else {
          setWizardStep("syscheck");
        }
      })
      .catch(() => {
        // 超时或异常时，至少让用户进入向导，不阻塞在 loading
        setView("wizard");
        setWizardStep("syscheck");
      });

    // CLI 能力探测改为后台异步，不阻塞首屏
    setCliCapsLoading(true);
    const cliDetectStartedAt = Date.now();
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/266bf96a-5673-475a-a7f1-1ee0eed8a36c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1c7103'},body:JSON.stringify({sessionId:'1c7103',runId:'post-fix-cli-v2',hypothesisId:'N1',location:'src/App.tsx:init',message:'开始 CLI 能力探测（延长超时）',data:{timeoutMs:15000},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    if (!cliCapsProbePromise) {
      cliCapsProbePromise = withTimeout(invoke<CliCapabilities>("detect_cli_capabilities"), 15000)
        .finally(() => {
          cliCapsProbePromise = null;
        });
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/266bf96a-5673-475a-a7f1-1ee0eed8a36c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1c7103'},body:JSON.stringify({sessionId:'1c7103',runId:'post-fix-cli-v3',hypothesisId:'N4',location:'src/App.tsx:init',message:'创建新的 CLI 探测任务',data:{timeoutMs:15000},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    } else {
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/266bf96a-5673-475a-a7f1-1ee0eed8a36c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1c7103'},body:JSON.stringify({sessionId:'1c7103',runId:'post-fix-cli-v3',hypothesisId:'N4',location:'src/App.tsx:init',message:'复用已有 CLI 探测任务，避免重复调用',data:{timeoutMs:15000},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
    }
    cliCapsProbePromise
      .then((caps) => {
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/266bf96a-5673-475a-a7f1-1ee0eed8a36c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1c7103'},body:JSON.stringify({sessionId:'1c7103',runId:'post-fix-cli-v2',hypothesisId:'N1',location:'src/App.tsx:init',message:'CLI 能力探测成功',data:{elapsedMs:Date.now()-cliDetectStartedAt,has_onboarding:caps.has_onboarding,flags_count:caps.onboarding_flags.length},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
        setCliCaps(caps);
      })
      .catch((err) => {
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/266bf96a-5673-475a-a7f1-1ee0eed8a36c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1c7103'},body:JSON.stringify({sessionId:'1c7103',runId:'post-fix-cli-v2',hypothesisId:'N2',location:'src/App.tsx:init',message:'CLI 能力探测失败或超时',data:{elapsedMs:Date.now()-cliDetectStartedAt,error:err instanceof Error?err.message:String(err)},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
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
    setWizardStep("installing");
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
    setWizardStep("onboarding");
  };

  const handleOnboardingDone = (summary: OnboardingSummary | null) => {
    // #region agent log
    fetch('http://127.0.0.1:7244/ingest/266bf96a-5673-475a-a7f1-1ee0eed8a36c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'1c7103'},body:JSON.stringify({sessionId:'1c7103',runId:'post-fix-cli-v2',hypothesisId:'N3',location:'src/App.tsx:handleOnboardingDone',message:'离开第3步时 CLI 状态快照',data:{cliCapsPresent:!!cliCaps,cliCapsLoading,wizardStep:'onboarding'},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    setOnboardingSummary(summary);
    setWizardStep("launching");
  };

  const handleLaunchDone = (updatedManifest: AppManifest) => {
    setManifest(updatedManifest);
    setManagerAutoOpenConfig(false);
    setView("manager");
    setGatewayStatus("running");
  };

  const WIZARD_STEPS: WizardStep[] = ["syscheck", "installing", "onboarding", "launching"];
  const STEP_LABELS = ["系统预检", "安装 OpenClaw", "综合配置", "启动 Gateway"];

  if (view === "loading") {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-gray-400 text-sm">正在初始化环境...（{loadingSec}s）</span>
          {cliCapsLoading && (
            <span className="text-gray-500 text-xs">正在检测 CLI 能力...</span>
          )}
          {loadingSec >= 12 && (
            <button
              onClick={() => {
                setView("wizard");
                setWizardStep("syscheck");
              }}
              className="px-3 py-1.5 text-xs text-gray-300 bg-gray-800 hover:bg-gray-700 rounded-md transition-colors"
            >
              等待过久？先进入安装向导
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
    <div className="h-screen flex flex-col bg-gray-950 select-none">
      <ResizeHandles />
      <TitleBar title="OpenClaw 一键安装器" />
      <div className="px-6 pt-4 pb-2">
        <StepBar
          steps={STEP_LABELS}
          current={WIZARD_STEPS.indexOf(wizardStep)}
        />
      </div>
      <div className="flex-1 overflow-hidden">
        {wizardStep === "syscheck" && (
          <SysCheck
            envEstimate={envEstimate}
            onDone={handleSysCheckDone}
            onReadyConfigDetected={handleReadyConfigDetected}
          />
        )}
        {wizardStep === "installing" && (
          <Installing
            manifest={manifest}
            envEstimate={envEstimate}
            logs={logs}
            addLog={addLog}
            onDone={handleInstallDone}
          />
        )}
        {wizardStep === "onboarding" && (
          <OnboardingSetup
            cliCaps={cliCaps}
            cliCapsLoading={cliCapsLoading}
            onDone={handleOnboardingDone}
          />
        )}
        {wizardStep === "launching" && (
          <Launching
            manifest={manifest!}
            cliCaps={cliCaps}
            onboardingSummary={onboardingSummary}
            logs={logs}
            addLog={addLog}
            onDone={handleLaunchDone}
          />
        )}
      </div>
    </div>
  );
}
