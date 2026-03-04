import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { CheckCircle, XCircle, AlertCircle, Loader, FolderOpen, ShieldCheck, ExternalLink } from "lucide-react";
import type { SysCheckItem } from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

interface Props {
  onDone: (installDir: string) => void;
}

const DEFAULT_INSTALL_DIR = "C:\\OpenClaw";

// ???????????????????
const CHECK_META: Record<string, { label: string; tip: string }> = {
  admin:    { label: "?????",         tip: "????????????????????????????" },
  webview2: { label: "Windows ???????", tip: "OpenClaw ???? Edge/WebView2 ???Windows 11 ????Windows 10 ?????" },
  disk:     { label: "???? (? 2GB)",   tip: "Node.js ???? OpenClaw ????? 500MB????? 2GB ??" },
  port:     { label: "?? 18789 ??",     tip: "OpenClaw Gateway ????????????????????????" },
  path:     { label: "??????",         tip: "??????????????????? Node.js ??????" },
  network:  { label: "?????",           tip: "???? npmmirror.com ?? OpenClaw???????" },
};

export default function SysCheck({ onDone }: Props) {
  const [checks, setChecks] = useState<SysCheckItem[]>(
    Object.entries(CHECK_META).map(([key, m]) => ({
      key, label: m.label, status: "checking", detail: "???..."
    }))
  );
  const [installDir, setInstallDir] = useState(DEFAULT_INSTALL_DIR);
  const [done, setDone] = useState(false);
  const [adminFailed, setAdminFailed] = useState(false);
  const [webview2Missing, setWebview2Missing] = useState(false);
  const [relaunching, setRelaunching] = useState(false);

  const updateCheck = (key: string, update: Partial<SysCheckItem>) => {
    setChecks((prev) => prev.map((c) => (c.key === key ? { ...c, ...update } : c)));
  };

  useEffect(() => { runChecks(DEFAULT_INSTALL_DIR); }, []);

  async function runChecks(dir: string) {
    setDone(false);
    setAdminFailed(false);
    setWebview2Missing(false);
    setChecks((prev) => prev.map((c) => ({ ...c, status: "checking", detail: "???..." })));

    if (!isTauri) {
      // ???????
      setTimeout(() => {
        setChecks((prev) => prev.map((c) => ({ ...c, status: "ok", detail: "??????????" })));
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
        detail: r.admin ? "????????" : "?????????",
      });
      updateCheck("webview2", {
        status: r.webview2 ? "ok" : "warn",
        detail: r.webview2
          ? "??? (Edge/WebView2)"
          : "??????????????????",
      });
      updateCheck("disk", {
        status: r.disk_gb >= 2 ? "ok" : "warn",
        detail: `????: ${r.disk_gb.toFixed(1)} GB${r.disk_gb < 2 ? "????? 2GB?" : ""}`,
      });
      updateCheck("port", {
        status: "ok",
        detail: r.port === 18789 ? "?? 18789 ??" : `18789 ??????????? ${r.port}`,
      });

      if (!r.path_valid && r.suggested_dir) {
        setInstallDir(r.suggested_dir);
        // ??????????????
      }
      updateCheck("path", {
        status: r.path_valid ? "ok" : "warn",
        detail: r.path_valid ? `????: ${dir}` : r.path_issue,
      });

      updateCheck("network", {
        status: r.network_ok ? "ok" : "warn",
        detail: r.network_ok
          ? "??? npmmirror.com??????"
          : "?????????????????????",
      });

      setAdminFailed(!r.admin);
      setWebview2Missing(!r.webview2);
      setDone(true);
    } catch {
      setChecks((prev) => prev.map((c) =>
        c.status === "checking" ? { ...c, status: "warn", detail: "????????????" } : c
      ));
      setDone(true);
    }
  }

  async function handleRelaunchAsAdmin() {
    setRelaunching(true);
    try {
      await invoke("relaunch_as_admin");
      // UAC ????????????????????????
      setTimeout(() => {
        invoke("open_url", { url: "about:blank" }).catch(() => {});
      }, 1000);
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
    <div className="h-full flex flex-col px-6 py-4 gap-3 overflow-y-auto">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">????</h2>
        <p className="text-sm text-gray-400 mt-0.5">????????????</p>
      </div>

      {/* ?? ?????????? ?? */}
      {adminFailed && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <ShieldCheck size={18} className="text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-300">???????????</p>
              <p className="text-xs text-red-400/80 mt-1">
                ????????????????????????????? Windows Defender ????
              </p>
            </div>
          </div>
          <div className="bg-gray-900/60 rounded-md p-3 text-xs text-gray-300 space-y-1.5">
            <p className="font-medium text-gray-200 mb-2">???????????</p>
            <p>? ?????</p>
            <p>? ???????????<span className="text-yellow-300 font-medium">????</span></p>
            <p>? ???<span className="text-yellow-300 font-medium">????????</span>?</p>
            <p>? ???? UAC ?????????</p>
          </div>
          <button
            onClick={handleRelaunchAsAdmin}
            disabled={relaunching}
            className="flex items-center justify-center gap-2 py-2 bg-red-600 hover:bg-red-500
              disabled:bg-gray-700 disabled:text-gray-500
              text-white text-sm font-medium rounded-lg transition-colors"
          >
            {relaunching
              ? <><Loader size={13} className="animate-spin" /> ??????...</>
              : <><ShieldCheck size={13} /> ????????????</>
            }
          </button>
        </div>
      )}

      {/* ?? WebView2 ???? ?? */}
      {webview2Missing && (
        <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-lg p-3 flex items-start gap-3">
          <AlertCircle size={15} className="text-yellow-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-yellow-300/90">
            <p className="font-medium mb-1">???? Windows ??????? (WebView2)</p>
            <p className="text-yellow-400/70 mb-2">
              OpenClaw ???????????Windows 11 ????Windows 10 ??????? 100MB???????
            </p>
            <button
              onClick={() => invoke("open_url", { url: "https://go.microsoft.com/fwlink/p/?LinkId=2124703" })}
              className="flex items-center gap-1.5 text-yellow-300 hover:text-yellow-200 underline underline-offset-2"
            >
              <ExternalLink size={11} />
              ???? WebView2 ???????
            </button>
          </div>
        </div>
      )}

      {/* ?? ???? ?? */}
      <div className="bg-gray-900 rounded-lg border border-gray-700 p-3">
        <label className="block text-xs text-gray-400 mb-1.5 flex items-center gap-1.5">
          ????
          <span className="text-gray-600 text-[10px]">??? C:\OpenClaw????????</span>
        </label>
        <div className="flex gap-2">
          <div className="flex-1 flex items-center gap-2 bg-gray-800 rounded border border-gray-600 px-3 py-1.5">
            <FolderOpen size={13} className="text-gray-500 flex-shrink-0" />
            <input
              type="text"
              value={installDir}
              onChange={(e) => setInstallDir(e.target.value)}
              className="flex-1 bg-transparent text-sm text-gray-200 outline-none font-mono"
              style={{ userSelect: "text" }}
            />
          </div>
          {installDir !== DEFAULT_INSTALL_DIR && (
            <button
              onClick={() => { setInstallDir(DEFAULT_INSTALL_DIR); runChecks(DEFAULT_INSTALL_DIR); }}
              className="px-3 text-xs bg-gray-800 hover:bg-gray-700 rounded border border-gray-600 text-gray-400 transition-colors whitespace-nowrap"
            >
              ????
            </button>
          )}
          <button
            onClick={() => runChecks(installDir)}
            className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded border border-gray-600 text-gray-300 transition-colors whitespace-nowrap"
          >
            ????
          </button>
        </div>
        <p className="text-[10px] text-gray-600 mt-1">?????????????????</p>
      </div>

      {/* ?? ???? ?? */}
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
              {/* ????????????? */}
              {c.status !== "checking" && (
                <div className="text-[10px] text-gray-600 mt-0.5">
                  {CHECK_META[c.key]?.tip}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ?? ???? ?? */}
      {done && (
        <div className="flex items-center justify-between flex-shrink-0">
          {adminFailed ? (
            <p className="text-xs text-red-400">??????????????????</p>
          ) : checks.some((c) => c.status === "warn") ? (
            <p className="text-xs text-yellow-500">????????????</p>
          ) : (
            <p className="text-xs text-gray-500">?????? ?</p>
          )}
          <button
            disabled={!canProceed}
            onClick={() => onDone(installDir)}
            className="px-6 py-2 bg-brand-500 hover:bg-brand-600
              disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed
              text-gray-950 font-semibold text-sm rounded-lg transition-colors"
          >
            ???? ?
          </button>
        </div>
      )}
    </div>
  );
}
