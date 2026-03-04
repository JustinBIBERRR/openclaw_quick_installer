import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckCircle, XCircle, AlertCircle, Loader,
  FolderOpen, ShieldCheck, ExternalLink, ChevronDown, ChevronRight,
} from "lucide-react";
import type { SysCheckItem } from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

interface Props {
  onDone: (installDir: string) => void;
}

// Browser preview fallback; real env uses %LOCALAPPDATA%\\OpenClaw from Rust
const PREVIEW_DEFAULT_DIR = "C:\\Users\\YourName\\AppData\\Local\\OpenClaw";

const CHECK_META: Record<string, { label: string; tip: string }> = {
  admin:    {
    label: "?????",
    tip:   "???????????????????? Windows Defender ?????????????",
  },
  webview2: {
    label: "Windows ???????",
    tip:   "OpenClaw ???? Edge/WebView2 ?????Windows 11 ????Windows 10 ?????????? 100MB??",
  },
  disk:     {
    label: "?????? 2GB?",
    tip:   "Node.js ??? + OpenClaw ?????? 500MB??????? 2GB ?????????",
  },
  port:     {
    label: "?? 18789 ??",
    tip:   "OpenClaw Gateway ??????????????????????????????",
  },
  path:     {
    label: "?????",
    tip:   "????????????????????????? Node.js ????????",
  },
  network:  {
    label: "?????",
    tip:   "??????? npmmirror.com ?? OpenClaw???????????????",
  },
};

export default function SysCheck({ onDone }: Props) {
  const [checks, setChecks] = useState<SysCheckItem[]>(
    Object.entries(CHECK_META).map(([key, m]) => ({
      key, label: m.label, status: "checking", detail: "???..."
    }))
  );
  const [installDir, setInstallDir] = useState("");
  const [defaultDir, setDefaultDir] = useState(PREVIEW_DEFAULT_DIR);
  const [done, setDone] = useState(false);
  const [adminFailed, setAdminFailed] = useState(false);
  const [webview2Missing, setWebview2Missing] = useState(false);
  const [relaunching, setRelaunching] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const updateCheck = (key: string, update: Partial<SysCheckItem>) => {
    setChecks((prev) => prev.map((c) => (c.key === key ? { ...c, ...update } : c)));
  };

  useEffect(() => {
    async function init() {
      // #region agent log
      fetch('http://127.0.0.1:7244/ingest/45c66ef1-757e-4e07-980b-ef06c6e8c939',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'SysCheck.tsx:init',message:'init called',data:{isTauri,hasTauriGlobal:'__TAURI__' in window,windowKeys:Object.keys(window).filter(k=>k.includes('TAURI'))},timestamp:Date.now(),hypothesisId:'A'})}).catch(()=>{});
      // #endregion
      if (!isTauri) {
        setInstallDir(PREVIEW_DEFAULT_DIR);
        setDefaultDir(PREVIEW_DEFAULT_DIR);
        runChecks(PREVIEW_DEFAULT_DIR);
        return;
      }
      try {
        const dir = await invoke<string>("get_default_install_dir");
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/45c66ef1-757e-4e07-980b-ef06c6e8c939',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'SysCheck.tsx:invoke-result',message:'invoke get_default_install_dir result',data:{dir},timestamp:Date.now(),hypothesisId:'B'})}).catch(()=>{});
        // #endregion
        setInstallDir(dir);
        setDefaultDir(dir);
        runChecks(dir);
      } catch(err) {
        // #region agent log
        fetch('http://127.0.0.1:7244/ingest/45c66ef1-757e-4e07-980b-ef06c6e8c939',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'SysCheck.tsx:invoke-catch',message:'invoke get_default_install_dir FAILED',data:{err:String(err)},timestamp:Date.now(),hypothesisId:'C'})}).catch(()=>{});
        // #endregion
        setInstallDir(PREVIEW_DEFAULT_DIR);
        setDefaultDir(PREVIEW_DEFAULT_DIR);
        runChecks(PREVIEW_DEFAULT_DIR);
      }
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runChecks(dir: string) {
    setDone(false);
    setAdminFailed(false);
    setWebview2Missing(false);
    setChecks((prev) => prev.map((c) => ({ ...c, status: "checking", detail: "???..." })));

    if (!isTauri) {
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
        detail: `????: ${r.disk_gb.toFixed(1)} GB${r.disk_gb < 2 ? "????? 2GB" : ""}`,
      });
      updateCheck("port", {
        status: "ok",
        detail: r.port === 18789
          ? "?? 18789 ??"
          : `18789 ?????????? ${r.port}`,
      });

      if (!r.path_valid && r.suggested_dir) {
        setInstallDir(r.suggested_dir);
      }
      updateCheck("path", {
        status: r.path_valid ? "ok" : "warn",
        detail: r.path_valid ? `????: ${dir}` : r.path_issue,
      });

      updateCheck("network", {
        status: r.network_ok ? "ok" : "warn",
        detail: r.network_ok
          ? "??? npmmirror.com???????"
          : "????????????????????",
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
        <p className="text-sm text-gray-400 mt-0.5">????????????????????</p>
      </div>

      {adminFailed && (
        <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-4 flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <ShieldCheck size={18} className="text-red-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-red-300">???????????</p>
              <p className="text-xs text-red-400/80 mt-1">
                ??????????????????????? Windows Defender ?????
              </p>
            </div>
          </div>
          <div className="bg-gray-900/60 rounded-md p-3 text-xs text-gray-300 space-y-1.5">
            <p className="font-medium text-gray-200 mb-2">???????????</p>
            <p>? ??????</p>
            <p>? ????? exe?<span className="text-yellow-300 font-medium">????</span></p>
            <p>? ??<span className="text-yellow-300 font-medium">??????????</span></p>
            <p>? ?? UAC ????????</p>
          </div>
          <button
            onClick={handleRelaunchAsAdmin}
            disabled={relaunching}
            className="flex items-center justify-center gap-2 py-2 bg-red-600 hover:bg-red-500
              disabled:bg-gray-700 disabled:text-gray-500
              text-white text-sm font-medium rounded-lg transition-colors"
          >
            {relaunching
              ? <><Loader size={13} className="animate-spin" /> ????...</>
              : <><ShieldCheck size={13} /> ?????????????</>
            }
          </button>
        </div>
      )}

      {webview2Missing && (
        <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-lg p-3 flex items-start gap-3">
          <AlertCircle size={15} className="text-yellow-400 mt-0.5 flex-shrink-0" />
          <div className="text-xs text-yellow-300/90">
            <p className="font-medium mb-1">???? Windows ??????? (WebView2)</p>
            <p className="text-yellow-400/70 mb-2">
              OpenClaw ??????????Windows 11 ????Windows 10 ??????? 100MB???????????????
            </p>
            <button
              onClick={() => invoke("open_url", { url: "https://go.microsoft.com/fwlink/p/?LinkId=2124703" })}
              className="flex items-center gap-1.5 text-yellow-300 hover:text-yellow-200 underline underline-offset-2"
            >
              <ExternalLink size={11} />
              ???? WebView2 ?????????
            </button>
          </div>
        </div>
      )}

      {installDir && (
        <div className="bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
          <div className="flex items-start gap-3 px-4 py-3">
            <FolderOpen size={15} className="text-gray-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-sm text-gray-300 mb-0.5">
                Node.js ???? OpenClaw ???????
              </div>
              <div className="font-mono text-brand-400 text-sm break-all">{installDir}</div>
              <div className="text-[11px] text-gray-600 mt-1.5 space-y-0.5">
                <p>? ???????????????????</p>
                <p>? ???? exe ???????</p>
                <p>? OpenClaw ??????????? <span className="text-gray-500 font-mono">%USERPROFILE%\.openclaw</span> ?</p>
              </div>
            </div>
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-gray-600 hover:text-gray-400
                whitespace-nowrap transition-colors flex-shrink-0 mt-0.5"
            >
              {showAdvanced ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              ??
            </button>
          </div>

          {showAdvanced && (
            <div className="border-t border-gray-800 px-4 py-3 bg-gray-800/40">
              <p className="text-[11px] text-yellow-500/80 mb-2">
                ? ???????????????????????????? Node.js ???????
              </p>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={installDir}
                  onChange={(e) => setInstallDir(e.target.value)}
                  className="flex-1 bg-gray-800 border border-gray-600 rounded px-3 py-1.5
                    text-sm text-gray-200 font-mono outline-none
                    focus:border-brand-400 transition-colors"
                  style={{ userSelect: "text" }}
                />
                {installDir !== defaultDir && (
                  <button
                    onClick={() => { setInstallDir(defaultDir); runChecks(defaultDir); }}
                    className="px-3 text-xs bg-gray-700 hover:bg-gray-600 rounded border border-gray-600
                      text-gray-400 transition-colors whitespace-nowrap"
                  >
                    ????
                  </button>
                )}
                <button
                  onClick={() => runChecks(installDir)}
                  className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 rounded border border-gray-600
                    text-gray-300 transition-colors whitespace-nowrap"
                >
                  ????
                </button>
              </div>
            </div>
          )}
        </div>
      )}

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

      {done && (
        <div className="flex items-center justify-between flex-shrink-0">
          {adminFailed ? (
            <p className="text-xs text-red-400">???????????????</p>
          ) : checks.some((c) => c.status === "warn") ? (
            <p className="text-xs text-yellow-500">??????????????</p>
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
