import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckCircle, XCircle, AlertCircle, Loader,
  ShieldCheck,
} from "lucide-react";
import type {
  AdminRelaunchResult,
  SysCheckItem,
  SyscheckAdminResult,
  SyscheckMemoryResult,
  SyscheckOpenclawConfigResult,
} from "../types";
import type { EnvEstimate } from "../utils/estimate";
import { getFullWizardEstimate } from "../utils/estimate";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  envEstimate: EnvEstimate | null;
  onDone: (installDir: string) => void;
  onReadyConfigDetected?: () => void;
}

const CHECK_META: Record<string, { label: string; tip: string }> = {
  openclaw_config: {
    label: "OpenClaw 本地配置",
    tip: "优先检查是否已安装且已有可用配置；若已就绪可直接进入 Manager。",
  },
  admin: {
    label: "管理员权限",
    tip: "安装器需要管理员权限以安装 Node.js 和 OpenClaw CLI。",
  },
  memory: {
    label: "内存状态",
    tip: "建议总内存 >= 8GB，内存不足时可先关闭其他占用较高应用。",
  },
};

export default function SysCheck({ envEstimate, onDone, onReadyConfigDetected }: Props) {
  const [checks, setChecks] = useState<SysCheckItem[]>(
    Object.entries(CHECK_META).map(([key, m]) => ({
      key, label: m.label, status: "checking", detail: "检测中..."
    }))
  );
  const [installDir, setInstallDir] = useState("");
  const [done, setDone] = useState(false);
  const [adminFailed, setAdminFailed] = useState(false);
  const [relaunching, setRelaunching] = useState(false);
  const [adminRelaunchMessage, setAdminRelaunchMessage] = useState("");
  const [readyConfigDetected, setReadyConfigDetected] = useState(false);

  const updateCheck = (key: string, update: Partial<SysCheckItem>) => {
    setChecks((prev) => prev.map((c) => (c.key === key ? { ...c, ...update } : c)));
  };

  useEffect(() => {
    async function init() {
      if (!isTauri) {
        const fallback = "C:\\OpenClaw";
        setInstallDir(fallback);
        runChecks();
        return;
      }
      try {
        const dir = await invoke<string>("get_default_install_dir");
        setInstallDir(dir);
        runChecks();
      } catch {
        const fallback = "C:\\OpenClaw";
        setInstallDir(fallback);
        runChecks();
      }
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runChecks() {
    setDone(false);
    setAdminFailed(false);
    setReadyConfigDetected(false);
    setChecks((prev) => prev.map((c) => ({ ...c, status: "checking", detail: "检测中..." })));

    if (!isTauri) {
      setTimeout(() => {
        setChecks((prev) => prev.map((c) => ({ ...c, status: "ok", detail: "检测通过（预览模式）" })));
        setDone(true);
      }, 800);
      return;
    }

    try {
      // Step 1: 配置检查（优先）
      const configResult = await invoke<SyscheckOpenclawConfigResult>("syscheck_openclaw_config");
      updateCheck("openclaw_config", {
        status: configResult.has_ready_config ? "ok" : "warn",
        detail: configResult.has_ready_config
          ? "检测到本地 OpenClaw 已安装且配置完整，可直接进入 Manager"
          : configResult.openclaw_installed
            ? "已安装 OpenClaw，但未检测到完整配置"
            : "未检测到 OpenClaw 安装，将继续预检并引导安装",
      });
      if (configResult.has_ready_config) {
        setReadyConfigDetected(true);
        setDone(true);
        onReadyConfigDetected?.();
        return;
      }

      // Step 2: 管理员权限检查
      const adminResult = await invoke<SyscheckAdminResult>("syscheck_admin");
      updateCheck("admin", {
        status: adminResult.admin ? "ok" : "error",
        detail: adminResult.admin ? "已获取管理员权限" : "未以管理员身份运行",
      });
      setAdminFailed(!adminResult.admin);
      if (!adminResult.admin) {
        updateCheck("memory", {
          status: "warn",
          detail: "请先通过管理员权限检查后再继续检测内存",
        });
        setDone(true);
        return;
      }

      // Step 3: 内存检查
      const memoryResult = await invoke<SyscheckMemoryResult>("syscheck_memory");
      updateCheck("memory", {
        status: memoryResult.ok ? "ok" : "warn",
        detail: `总内存 ${memoryResult.total_gb.toFixed(1)} GB，可用 ${memoryResult.available_gb.toFixed(1)} GB，建议 >= ${memoryResult.recommended_gb.toFixed(0)} GB`,
      });
      setDone(true);
    } catch {
      setChecks((prev) => prev.map((c) =>
        c.status === "checking" ? { ...c, status: "warn", detail: "检测失败，可忽略继续安装" } : c
      ));
      setDone(true);
    }
  }

  async function handleRelaunchAsAdmin() {
    setRelaunching(true);
    setAdminRelaunchMessage("");
    try {
      const relaunchResult = await invoke<AdminRelaunchResult>("relaunch_as_admin");
      if (!relaunchResult.launched) {
        setAdminRelaunchMessage(relaunchResult.message);
        setRelaunching(false);
        return;
      }
      if (isTauri && relaunchResult.close_current) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
        return;
      }
      setRelaunching(false);
    } catch {
      setRelaunching(false);
    }
  }

  const statusIcon = (status: SysCheckItem["status"]) => {
    if (status === "checking") return <Loader size={15} className="text-gray-500 animate-spin" />;
    if (status === "ok")       return <CheckCircle size={15} className="text-brand-400" />;
    if (status === "warn")     return <AlertCircle size={15} className="text-yellow-400" />;
    return <XCircle size={15} className="text-red-400" />;
  };

  const canProceed = done && !adminFailed && !readyConfigDetected;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-shrink-0 px-6 pt-4 pb-2 flex flex-col gap-2">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">系统预检</h2>
          <p className="text-sm text-gray-400 mt-0.5">
            按顺序检测本地配置、权限与内存状态，减少一次性检测造成的卡顿
            {envEstimate && (
              <span className="text-gray-500 ml-1">（预计剩余 {getFullWizardEstimate(envEstimate)}）</span>
            )}
          </p>
        </div>

        <div className="text-xs text-gray-600 flex flex-col gap-0.5">
          <span>OpenClaw 程序将通过 npm 全局安装，配置保存在 <code className="text-gray-500">%USERPROFILE%\.openclaw\</code></span>
        </div>

        {adminFailed && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-3 flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <ShieldCheck size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-red-300">需要管理员权限才能继续</p>
                <p className="text-xs text-red-400/80 mt-0.5">
                  安装需要写入系统目录、修改 PATH 等操作。
                </p>
              </div>
            </div>
            <button
              onClick={handleRelaunchAsAdmin}
              disabled={relaunching}
              className="flex items-center justify-center gap-2 py-1.5 bg-red-600 hover:bg-red-500
                disabled:bg-gray-700 disabled:text-gray-500
                text-white text-sm font-medium rounded-lg transition-colors"
            >
              {relaunching
                ? <><Loader size={13} className="animate-spin" /> 正在提权，当前窗口将自动关闭...</>
                : <><ShieldCheck size={13} /> 自动重启并以管理员身份运行</>
              }
            </button>
            {!!adminRelaunchMessage && (
              <p className="text-xs text-red-300/90">{adminRelaunchMessage}</p>
            )}
          </div>
        )}

      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-2">
        <div className="bg-gray-900 rounded-lg border border-gray-700 divide-y divide-gray-800/80">
          {checks.map((c) => (
            <div key={c.key} className="flex items-start gap-3 px-4 py-3">
              <div className="flex-shrink-0 mt-0.5">{statusIcon(c.status)}</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-200">{c.label}</div>
                <div className={`text-xs mt-0.5
                  ${c.status === "ok"       ? "text-gray-500" : ""}
                  ${c.status === "warn"     ? "text-yellow-500" : ""}
                  ${c.status === "error"    ? "text-red-400" : ""}
                  ${c.status === "checking" ? "text-gray-600" : ""}
                `}>{c.detail}</div>
                {c.status !== "checking" && (
                  <div className="text-[10px] text-gray-600 mt-0.5">
                    {CHECK_META[c.key]?.tip}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {done && (
        <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-t border-gray-800">
          {readyConfigDetected ? (
            <p className="text-xs text-brand-300">已检测到本地配置，正在进入 Manager...</p>
          ) : adminFailed ? (
            <p className="text-xs text-red-400">请先以管理员身份重新运行安装器</p>
          ) : checks.some((c) => c.status === "warn") ? (
            <p className="text-xs text-yellow-500">存在警告项，建议处理后再继续</p>
          ) : (
            <p className="text-xs text-gray-500">
              所有检测通过 ✓
              {envEstimate && (
                <span className="text-gray-600 ml-1">· 预计剩余 {getFullWizardEstimate(envEstimate)}</span>
              )}
            </p>
          )}
          <button
            disabled={!canProceed}
            onClick={() => onDone(installDir)}
            className="px-6 py-2 bg-brand-500 hover:bg-brand-600
              disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed
              text-gray-950 font-semibold text-sm rounded-lg transition-colors"
          >
            开始安装 →
          </button>
        </div>
      )}
    </div>
  );
}
