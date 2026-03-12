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
import { useI18n } from "../i18n/useI18n";
import StatusCard from "../components/StatusCard";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  envEstimate: EnvEstimate | null;
  onDone: (installDir: string) => void;
  onReadyConfigDetected?: () => void;
}

const CHECK_META: Record<string, { labelKey: string; tipKey: string }> = {
  openclaw_config: {
    labelKey: "syscheck.check.openclaw",
    tipKey: "syscheck.tip.openclaw",
  },
  admin: {
    labelKey: "syscheck.check.admin",
    tipKey: "syscheck.tip.admin",
  },
  memory: {
    labelKey: "syscheck.check.memory",
    tipKey: "syscheck.tip.memory",
  },
};

export default function SysCheck({ envEstimate, onDone, onReadyConfigDetected }: Props) {
  const { t } = useI18n();
  const [checks, setChecks] = useState<SysCheckItem[]>(
    Object.entries(CHECK_META).map(([key, m]) => ({
      key, label: t(m.labelKey), status: "checking", detail: t("syscheck.checking")
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
    setChecks((prev) =>
      prev.map((c) => ({
        ...c,
        label: t(CHECK_META[c.key]?.labelKey ?? c.key),
      }))
    );
  }, [t]);

  useEffect(() => {
    let isMounted = true; // 防止组件卸载后继续执行
    async function init() {
      if (!isTauri) {
        const fallback = "C:\\OpenClaw";
        setInstallDir(fallback);
        if (isMounted) runChecks();
        return;
      }
      try {
        const dir = await invoke<string>("get_default_install_dir");
        if (isMounted) {
          setInstallDir(dir);
          runChecks();
        }
      } catch {
        const fallback = "C:\\OpenClaw";
        if (isMounted) {
          setInstallDir(fallback);
          runChecks();
        }
      }
    }
    init();
    return () => { isMounted = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runChecks() {
    setDone(false);
    setAdminFailed(false);
    setReadyConfigDetected(false);
    setChecks((prev) => prev.map((c) => ({ ...c, status: "checking", detail: t("syscheck.checking") })));

    if (!isTauri) {
      setTimeout(() => {
        setChecks((prev) => prev.map((c) => ({ ...c, status: "ok", detail: t("syscheck.previewPassed") })));
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
          ? t("syscheck.readyConfig")
          : configResult.openclaw_installed
            ? t("syscheck.installedNoConfig")
            : t("syscheck.notInstalled"),
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
        detail: adminResult.admin ? t("syscheck.adminOk") : t("syscheck.adminRequired"),
      });
      setAdminFailed(!adminResult.admin);
      if (!adminResult.admin) {
        updateCheck("memory", {
          status: "warn",
          detail: t("syscheck.memorySkip"),
        });
        setDone(true);
        return;
      }

      // Step 3: 内存检查
      const memoryResult = await invoke<SyscheckMemoryResult>("syscheck_memory");
      updateCheck("memory", {
        status: memoryResult.ok ? "ok" : "warn",
        detail: t("syscheck.memoryDetail", {
          total: memoryResult.total_gb.toFixed(1),
          available: memoryResult.available_gb.toFixed(1),
          recommended: memoryResult.recommended_gb.toFixed(0),
        }),
      });
      setDone(true);
    } catch (error) {
      setChecks((prev) => prev.map((c) =>
        c.status === "checking" ? { ...c, status: "warn", detail: t("syscheck.failedButContinue") } : c
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
      <div className="flex-shrink-0 px-4 sm:px-6 pt-4 sm:pt-5 pb-2 sm:pb-3 flex flex-col gap-2">
        <div>
          <h2 className="text-xl sm:text-2xl font-semibold text-heading">{t("syscheck.title")}</h2>
          <p className="text-xs sm:text-sm text-muted mt-1 leading-relaxed">
            {t("syscheck.subtitle")}
            {envEstimate && (
              <span className="text-gray-500 ml-1">({getFullWizardEstimate(envEstimate)})</span>
            )}
          </p>
        </div>

        <div className="text-xs text-gray-500 flex flex-col gap-0.5">
          <span className="break-all">{t("syscheck.installHint")} <code className="text-gray-400 text-[0.7rem]">%USERPROFILE%\.openclaw\</code></span>
        </div>

        {adminFailed && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-xl sm:rounded-2xl p-3 sm:p-4 flex flex-col gap-2 sm:gap-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
            <div className="flex items-start gap-2">
              <ShieldCheck size={15} className="text-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-xs sm:text-sm font-medium text-red-300">{t("syscheck.adminCardTitle")}</p>
                <p className="text-[0.7rem] sm:text-xs text-red-400/80 mt-0.5">
                  {t("syscheck.adminCardDesc")}
                </p>
              </div>
            </div>
            <button
              onClick={handleRelaunchAsAdmin}
              disabled={relaunching}
              className="flex items-center justify-center gap-2 py-1.5 sm:py-2 bg-red-600 hover:bg-red-500
                disabled:bg-gray-700 disabled:text-gray-500
                text-white text-xs sm:text-sm font-medium rounded-lg sm:rounded-xl transition-colors"
            >
              {relaunching
                ? <><Loader size={12} className="animate-spin" /> {t("syscheck.adminRelaunching")}</>
                : <><ShieldCheck size={12} /> {t("syscheck.adminRelaunch")}</>
              }
            </button>
            {!!adminRelaunchMessage && (
              <p className="text-[0.7rem] sm:text-xs text-red-300/90">{adminRelaunchMessage}</p>
            )}
          </div>
        )}

      </div>

      <div className="flex-1 overflow-y-auto px-4 sm:px-6 pb-2 sm:pb-3">
        <div className="space-y-2 sm:space-y-3">
          {checks.map((c) => (
            <StatusCard
              key={c.key}
              title={c.label}
              description={`${c.detail}${c.status !== "checking" && CHECK_META[c.key]?.tipKey ? ` · ${t(CHECK_META[c.key].tipKey)}` : ""}`}
              icon={statusIcon(c.status)}
              tone={
                c.status === "ok"
                  ? "ok"
                  : c.status === "warn"
                    ? "warn"
                    : c.status === "error"
                      ? "error"
                      : "default"
              }
            />
          ))}
        </div>
      </div>

      {done && (
        <div className="flex-shrink-0 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 sm:gap-0 px-4 sm:px-6 py-3 sm:py-4 border-t border-white/10 bg-black/10">
          {readyConfigDetected ? (
            <p className="text-[0.7rem] sm:text-xs text-brand-300">{t("syscheck.detectedJumping")}</p>
          ) : adminFailed ? (
            <p className="text-[0.7rem] sm:text-xs text-red-400">{t("syscheck.requireAdmin")}</p>
          ) : checks.some((c) => c.status === "warn") ? (
            <p className="text-[0.7rem] sm:text-xs text-yellow-500">{t("syscheck.warnExists")}</p>
          ) : (
            <p className="text-[0.7rem] sm:text-xs text-gray-500">
              {t("syscheck.allPassed")}
              {envEstimate && (
                <span className="text-gray-600 ml-1">· {t("syscheck.estimateRemaining", { time: getFullWizardEstimate(envEstimate) })}</span>
              )}
            </p>
          )}
          <button
            disabled={!canProceed}
            onClick={() => onDone(installDir)}
            className="px-5 sm:px-7 h-9 sm:h-11 bg-brand-500 hover:bg-brand-600 w-full sm:w-auto
              disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed
              text-gray-950 font-semibold text-xs sm:text-sm rounded-lg sm:rounded-xl transition-colors"
          >
            {t("syscheck.startInstall")}
          </button>
        </div>
      )}
    </div>
  );
}
