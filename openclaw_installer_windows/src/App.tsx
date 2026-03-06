import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import type { AppManifest, WizardStep, LogEntry, GatewayStatus, CheckEnvironmentResult, CliCapabilities } from "./types";
import SysCheck from "./pages/SysCheck";
import Installing from "./pages/Installing";
import ApiKeySetup from "./pages/ApiKeySetup";
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
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatus>("checking");
  const [cliCaps, setCliCaps] = useState<CliCapabilities | null>(null);

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

    // 智能检测环境 + CLI 能力探测
    Promise.all([
      invoke<CheckEnvironmentResult>("check_environment"),
      invoke<CliCapabilities>("detect_cli_capabilities").catch(() => null),
    ])
      .then(async ([env, caps]) => {
        if (caps) setCliCaps(caps);
        if (env.manifest_complete && env.manifest) {
          setManifest(env.manifest);
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
          setWizardStep("launching");
          setView("wizard");
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
          setWizardStep("apikey");
          setView("wizard");
          return;
        }
        const m = env.manifest ?? null;
        setManifest(m);
        setView("wizard");
        if (m && m.phase === "installing") {
          setWizardStep("installing");
        } else {
          setWizardStep("syscheck");
        }
      })
      .catch(() => setView("wizard"));

    return () => {
      unlistenLog.then((f) => f());
    };
  }, []);

  const handleSysCheckDone = (installDir: string) => {
    setManifest((prev) => ({ ...(prev as AppManifest), install_dir: installDir }));
    setWizardStep("installing");
  };

  const handleInstallDone = () => {
    setWizardStep("apikey");
  };

  const handleApiKeyDone = (provider: string, keyConfigured: boolean) => {
    setManifest((prev) =>
      prev
        ? { ...prev, api_provider: provider, api_key_configured: keyConfigured }
        : prev
    );
    setWizardStep("launching");
  };

  const handleLaunchDone = (updatedManifest: AppManifest) => {
    setManifest(updatedManifest);
    setView("manager");
    setGatewayStatus("running");
  };

  const WIZARD_STEPS: WizardStep[] = ["syscheck", "installing", "apikey", "launching"];
  const STEP_LABELS = ["系统预检", "安装 OpenClaw", "配置 AI 模型", "启动 Gateway"];

  if (view === "loading") {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-950">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-brand-400 border-t-transparent rounded-full animate-spin" />
          <span className="text-gray-400 text-sm">正在加载...</span>
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
          <SysCheck onDone={handleSysCheckDone} />
        )}
        {wizardStep === "installing" && (
          <Installing
            manifest={manifest}
            logs={logs}
            addLog={addLog}
            onDone={handleInstallDone}
          />
        )}
        {wizardStep === "apikey" && (
          <ApiKeySetup
            manifest={manifest}
            cliCaps={cliCaps}
            onDone={handleApiKeyDone}
          />
        )}
        {wizardStep === "launching" && (
          <Launching
            manifest={manifest!}
            cliCaps={cliCaps}
            logs={logs}
            addLog={addLog}
            onDone={handleLaunchDone}
          />
        )}
      </div>
    </div>
  );
}
