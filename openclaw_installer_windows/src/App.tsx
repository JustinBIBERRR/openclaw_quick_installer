import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import type { AppManifest, WizardStep, LogEntry, GatewayStatus, CheckEnvironmentResult, CliCapabilities, OnboardingSummary } from "./types";
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

export default function App() {
  const [view, setView] = useState<AppView>("loading");
  const [wizardStep, setWizardStep] = useState<WizardStep>("syscheck");
  const [manifest, setManifest] = useState<AppManifest | null>(null);
  const [managerAutoOpenConfig, setManagerAutoOpenConfig] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>("checking");
  const [cliCaps, setCliCaps] = useState<CliCapabilities | null>(null);
  const [envEstimate, setEnvEstimate] = useState<EnvEstimate | null>(null);
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

    // 先做环境检测（带超时），避免 loading 卡死
    withTimeout(invoke<CheckEnvironmentResult>("check_environment"), 8000)
      .then(async (env) => {
        setEnvEstimate({
          node_installed: env.node_installed,
          openclaw_installed: env.openclaw_installed,
          config_exists: env.config_exists,
        });
        if (env.manifest_complete && env.manifest) {
          setManifest(env.manifest);
          setManagerAutoOpenConfig(false);
          setView("manager");
          return;
        }
        if (env.openclaw_installed && env.config_exists) {
          const m = env.manifest ?? {
            version: "1.0.0",
            phase: "fresh",
            install_dir: await invoke<string>("get_default_install_dir"),
            gateway_port: 18789,
            gateway_pid: null,
            api_provider: "",
            api_key_configured: true,
            api_key_verified: false,
            steps_done: [],
            last_error: null,
          };
          setManifest(m);
          setManagerAutoOpenConfig(false);
          // 已安装并已存在配置，直接进入 Manager（可随时修改配置并启动 Chat）
          setView("manager");
          return;
        }
        if (env.openclaw_installed && !env.config_exists) {
          const m = env.manifest ?? {
            version: "1.0.0",
            phase: "fresh",
            install_dir: await invoke<string>("get_default_install_dir"),
            gateway_port: 18789,
            gateway_pid: null,
            api_provider: "",
            api_key_configured: false,
            api_key_verified: false,
            steps_done: ["openclaw_installed"],
            last_error: null,
          };
          setManifest(m);
          // 已安装但未配置：直接进入 Manager，并自动弹出综合配置
          setManagerAutoOpenConfig(true);
          setView("manager");
          return;
        }
        const m = env.manifest ?? null;
        setManifest(m);
        setManagerAutoOpenConfig(false);
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
    withTimeout(invoke<CliCapabilities>("detect_cli_capabilities"), 5000)
      .then((caps) => setCliCaps(caps))
      .catch(() => setCliCaps(null));

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
    setManifest((prev) => ({ ...(prev as AppManifest), install_dir: installDir }));
    setWizardStep("installing");
  };

  const handleInstallDone = () => {
    setWizardStep("onboarding");
  };

  const handleOnboardingDone = (summary: OnboardingSummary | null) => {
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
          <SysCheck envEstimate={envEstimate} onDone={handleSysCheckDone} />
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
