import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckCircle, XCircle, AlertCircle, Loader,
  ShieldCheck, ExternalLink,
} from "lucide-react";
import type { SysCheckItem } from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  onDone: (installDir: string) => void;
}

const CHECK_META: Record<string, { label: string; tip: string }> = {
  admin: {
    label: "管理员权限",
    tip: "安装器需要管理员权限以安装 Node.js 和 OpenClaw CLI。",
  },
  webview2: {
    label: "Windows 系统浏览器内核",
    tip: "OpenClaw 界面依赖 Edge/WebView2 渲染。Windows 11 已内置，Windows 10 可能需要额外安装。",
  },
  disk: {
    label: "磁盘空间（需 2GB）",
    tip: "Node.js + OpenClaw 约需 500MB，建议至少预留 2GB。",
  },
  port: {
    label: "端口 18789 可用",
    tip: "OpenClaw Gateway 默认监听此端口。若被占用会自动切换。",
  },
  network: {
    label: "网络连通性",
    tip: "安装时需要访问 npmmirror.com 下载 OpenClaw，国内直连速度较快。",
  },
};

export default function SysCheck({ onDone }: Props) {
  const [checks, setChecks] = useState<SysCheckItem[]>(
    Object.entries(CHECK_META).map(([key, m]) => ({
      key, label: m.label, status: "checking", detail: "检测中..."
    }))
  );
  const [installDir, setInstallDir] = useState("");
  const [done, setDone] = useState(false);
  const [adminFailed, setAdminFailed] = useState(false);
  const [webview2Missing, setWebview2Missing] = useState(false);
  const [relaunching, setRelaunching] = useState(false);

  const updateCheck = (key: string, update: Partial<SysCheckItem>) => {
    setChecks((prev) => prev.map((c) => (c.key === key ? { ...c, ...update } : c)));
  };

  useEffect(() => {
    async function init() {
      if (!isTauri) {
        const fallback = "C:\\OpenClaw";
        setInstallDir(fallback);
        runChecks(fallback);
        return;
      }
      try {
        const dir = await invoke<string>("get_default_install_dir");
        setInstallDir(dir);
        runChecks(dir);
      } catch {
        const fallback = "C:\\OpenClaw";
        setInstallDir(fallback);
        runChecks(fallback);
      }
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runChecks(dir: string) {
    setDone(false);
    setAdminFailed(false);
    setWebview2Missing(false);
    setChecks((prev) => prev.map((c) => ({ ...c, status: "checking", detail: "检测中..." })));

    if (!isTauri) {
      setTimeout(() => {
        setChecks((prev) => prev.map((c) => ({ ...c, status: "ok", detail: "检测通过（预览模式）" })));
        setDone(true);
      }, 800);
      return;
    }

    try {
      const r = await invoke<{
        admin: boolean; webview2: boolean; disk_gb: number;
        port: number; path_valid: boolean; path_issue: string;
        network_ok: boolean; suggested_dir: string;
      }>("run_syscheck", { installDir: dir });

      updateCheck("admin", {
        status: r.admin ? "ok" : "error",
        detail: r.admin ? "已获取管理员权限" : "未以管理员身份运行",
      });
      updateCheck("webview2", {
        status: r.webview2 ? "ok" : "warn",
        detail: r.webview2
          ? "已安装 (Edge/WebView2)"
          : "未检测到，安装完成后界面可能无法显示",
      });
      updateCheck("disk", {
        status: r.disk_gb >= 2 ? "ok" : "warn",
        detail: `可用空间: ${r.disk_gb.toFixed(1)} GB${r.disk_gb < 2 ? "，建议至少 2GB" : ""}`,
      });
      updateCheck("port", {
        status: "ok",
        detail: r.port === 18789
          ? "端口 18789 空闲"
          : `18789 已被占用，将使用端口 ${r.port}`,
      });
      updateCheck("network", {
        status: r.network_ok ? "ok" : "warn",
        detail: r.network_ok
          ? "可访问 npmmirror.com，下载速度良好"
          : "网络受限，安装可能较慢，请检查网络后继续",
      });

      setAdminFailed(!r.admin);
      setWebview2Missing(!r.webview2);
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
    try {
      await invoke("relaunch_as_admin");
      if (isTauri) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      }
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

  const canProceed = done && !adminFailed;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-shrink-0 px-6 pt-4 pb-2 flex flex-col gap-2">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">系统预检</h2>
          <p className="text-sm text-gray-400 mt-0.5">正在检测安装环境，全部通过后即可开始安装</p>
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
          </div>
        )}

        {webview2Missing && (
          <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-lg p-2.5 flex items-start gap-2">
            <AlertCircle size={14} className="text-yellow-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-yellow-300/90">
              <p className="font-medium">需要安装 Windows 系统浏览器内核 (WebView2)</p>
              <button
                onClick={() => invoke("open_url", { url: "https://go.microsoft.com/fwlink/p/?LinkId=2124703" })}
                className="flex items-center gap-1 mt-1 text-yellow-300 hover:text-yellow-200 underline underline-offset-2"
              >
                <ExternalLink size={11} />
                点击下载 WebView2 运行时（微软官方）
              </button>
            </div>
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
          {adminFailed ? (
            <p className="text-xs text-red-400">请先以管理员身份重新运行安装器</p>
          ) : checks.some((c) => c.status === "warn") ? (
            <p className="text-xs text-yellow-500">存在警告项，建议处理后再继续</p>
          ) : (
            <p className="text-xs text-gray-500">所有检测通过 ✓</p>
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
