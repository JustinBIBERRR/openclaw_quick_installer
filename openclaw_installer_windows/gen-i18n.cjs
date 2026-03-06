/**
 * gen-i18n.cjs
 * Run: node gen-i18n.cjs
 *
 * Generates TSX files with proper UTF-8 Chinese text.
 * This script is all-ASCII (Chinese via \uXXXX), so it saves correctly
 * on any platform regardless of the editor's encoding setting.
 */
const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "src");

// ---------------------------------------------------------------------------
// SysCheck.tsx
// ---------------------------------------------------------------------------
const syscheck = `import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle, XCircle, AlertCircle, Loader,
  FolderOpen, ShieldCheck, ExternalLink, FolderSearch,
} from "lucide-react";
import type { SysCheckItem } from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  onDone: (installDir: string) => void;
}

const CHECK_META: Record<string, { label: string; tip: string }> = {
  admin:    {
    label: "\u7ba1\u7406\u5458\u6743\u9650",
    tip:   "\u5b89\u88c5\u5668\u9700\u8981\u7ba1\u7406\u5458\u6743\u9650\u4ee5\u4fee\u6539\u7cfb\u7edf\u8def\u5f84\u3001\u7ed5\u8fc7 Windows Defender \u626b\u63cf\u7b49\uff0c\u786e\u4fdd\u5b89\u88c5\u987a\u5229\u5b8c\u6210\u3002",
  },
  webview2: {
    label: "Windows \u7cfb\u7edf\u6d4f\u89c8\u5668\u5185\u6838",
    tip:   "OpenClaw \u754c\u9762\u4f9d\u8d56 Edge/WebView2 \u5185\u6838\u6e32\u67d3\u3002Windows 11 \u5df2\u5185\u7f6e\uff0cWindows 10 \u53ef\u80fd\u9700\u8981\u989d\u5916\u5b89\u88c5\uff08\u7ea6 100MB\uff09\u3002",
  },
  disk:     {
    label: "\u78c1\u76d8\u7a7a\u95f4\uff08\u9700 2GB\uff09",
    tip:   "Node.js \u8fd0\u884c\u65f6 + OpenClaw \u7a0b\u5e8f\u6587\u4ef6\u7ea6\u9700 500MB\uff0c\u5efa\u8bae\u81f3\u5c11\u9884\u7559 2GB \u4ee5\u4fdd\u8bc1\u5b89\u88c5\u548c\u8fd0\u884c\u3002",
  },
  port:     {
    label: "\u7aef\u53e3 18789 \u53ef\u7528",
    tip:   "OpenClaw Gateway \u9ed8\u8ba4\u76d1\u542c\u6b64\u7aef\u53e3\u3002\u82e5\u88ab\u5360\u7528\uff0c\u5b89\u88c5\u5668\u4f1a\u81ea\u52a8\u5207\u6362\u5230\u4e0b\u4e00\u4e2a\u53ef\u7528\u7aef\u53e3\u3002",
  },
  path:     {
    label: "\u8def\u5f84\u5408\u6cd5\u6027",
    tip:   "\u5b89\u88c5\u8def\u5f84\u987b\u4e3a\u7eaf\u82f1\u6587\u5b57\u6bcd\u548c\u6570\u5b57\uff0c\u4e0d\u542b\u7a7a\u683c\u548c\u4e2d\u6587\uff0c\u5426\u5219 Node.js \u5c06\u65e0\u6cd5\u6b63\u5e38\u5de5\u4f5c\u3002",
  },
  network:  {
    label: "\u7f51\u7edc\u8fde\u901a\u6027",
    tip:   "\u5b89\u88c5\u65f6\u9700\u8981\u8bbf\u95ee npmmirror.com \u4e0b\u8f7d OpenClaw\uff0c\u56fd\u5185\u76f4\u8fde\u901f\u5ea6\u8f83\u5feb\uff0c\u65e0\u9700\u7ffb\u5899\u3002",
  },
};

export default function SysCheck({ onDone }: Props) {
  const [checks, setChecks] = useState<SysCheckItem[]>(
    Object.entries(CHECK_META).map(([key, m]) => ({
      key, label: m.label, status: "checking", detail: "\u68c0\u6d4b\u4e2d..."
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
        const fallback = "C:\\\\OpenClaw";
        setInstallDir(fallback);
        runChecks(fallback);
        return;
      }
      try {
        const dir = await invoke<string>("get_default_install_dir");
        setInstallDir(dir);
        runChecks(dir);
      } catch(err) {
        const fallback = "C:\\\\OpenClaw";
        setInstallDir(fallback);
        runChecks(fallback);
      }
    }
    init();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePickFolder() {
    if (!isTauri) return;
    try {
      const selected = await open({ directory: true, multiple: false, title: "\u9009\u62e9\u5b89\u88c5\u76ee\u5f55" });
      if (selected && typeof selected === "string") {
        setInstallDir(selected);
        runChecks(selected);
      }
    } catch {
      // user cancelled
    }
  }

  async function runChecks(dir: string) {
    setDone(false);
    setAdminFailed(false);
    setWebview2Missing(false);
    setChecks((prev) => prev.map((c) => ({ ...c, status: "checking", detail: "\u68c0\u6d4b\u4e2d..." })));

    if (!isTauri) {
      setTimeout(() => {
        setChecks((prev) => prev.map((c) => ({ ...c, status: "ok", detail: "\u68c0\u6d4b\u901a\u8fc7\uff08\u9884\u89c8\u6a21\u5f0f\uff09" })));
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
        detail: r.admin ? "\u5df2\u83b7\u53d6\u7ba1\u7406\u5458\u6743\u9650" : "\u672a\u4ee5\u7ba1\u7406\u5458\u8eab\u4efd\u8fd0\u884c",
      });
      updateCheck("webview2", {
        status: r.webview2 ? "ok" : "warn",
        detail: r.webview2
          ? "\u5df2\u5b89\u88c5 (Edge/WebView2)"
          : "\u672a\u68c0\u6d4b\u5230\uff0c\u5b89\u88c5\u5b8c\u6210\u540e\u754c\u9762\u53ef\u80fd\u65e0\u6cd5\u663e\u793a",
      });
      updateCheck("disk", {
        status: r.disk_gb >= 2 ? "ok" : "warn",
        detail: \`\u53ef\u7528\u7a7a\u95f4: \${r.disk_gb.toFixed(1)} GB\${r.disk_gb < 2 ? "\uff0c\u5efa\u8bae\u81f3\u5c11 2GB" : ""}\`,
      });
      updateCheck("port", {
        status: "ok",
        detail: r.port === 18789
          ? "\u7aef\u53e3 18789 \u7a7a\u95f2"
          : \`18789 \u5df2\u88ab\u5360\u7528\uff0c\u5c06\u4f7f\u7528\u7aef\u53e3 \${r.port}\`,
      });

      if (!r.path_valid && r.suggested_dir) {
        setInstallDir(r.suggested_dir);
      }
      updateCheck("path", {
        status: r.path_valid ? "ok" : "warn",
        detail: r.path_valid ? \`\u8def\u5f84\u5408\u6cd5: \${dir}\` : r.path_issue,
      });

      updateCheck("network", {
        status: r.network_ok ? "ok" : "warn",
        detail: r.network_ok
          ? "\u53ef\u8bbf\u95ee npmmirror.com\uff0c\u4e0b\u8f7d\u901f\u5ea6\u826f\u597d"
          : "\u7f51\u7edc\u53d7\u9650\uff0c\u5b89\u88c5\u53ef\u80fd\u8f83\u6162\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u540e\u7ee7\u7eed",
      });

      setAdminFailed(!r.admin);
      setWebview2Missing(!r.webview2);
      setDone(true);
    } catch {
      setChecks((prev) => prev.map((c) =>
        c.status === "checking" ? { ...c, status: "warn", detail: "\u68c0\u6d4b\u5931\u8d25\uff0c\u53ef\u5ffd\u7565\u7ee7\u7eed\u5b89\u88c5" } : c
      ));
      setDone(true);
    }
  }

  async function handleRelaunchAsAdmin() {
    setRelaunching(true);
    try {
      await invoke("relaunch_as_admin");
      // \u65b0\u7a97\u53e3\u5df2\u4ee5\u7ba1\u7406\u5458\u8eab\u4efd\u542f\u52a8\uff0c\u81ea\u52a8\u5173\u95ed\u5f53\u524d\u65e0\u6743\u9650\u7a97\u53e3
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
      {/* \u9876\u90e8\u56fa\u5b9a\u533a\u57df\uff1a\u6807\u9898 + \u5b89\u88c5\u76ee\u5f55 + \u8b66\u544a\u5757 */}
      <div className="flex-shrink-0 px-6 pt-4 pb-2 flex flex-col gap-2">
        <div>
          <h2 className="text-lg font-semibold text-gray-100">\u7cfb\u7edf\u9884\u68c0</h2>
          <p className="text-sm text-gray-400 mt-0.5">\u6b63\u5728\u68c0\u6d4b\u5b89\u88c5\u73af\u5883\uff0c\u5168\u90e8\u901a\u8fc7\u540e\u5373\u53ef\u5f00\u59cb\u5b89\u88c5</p>
        </div>

        {/* \u5b89\u88c5\u76ee\u5f55\uff1a\u59cb\u7ec8\u663e\u793a\uff0c\u4e0d\u88ab\u5176\u4ed6\u5185\u5bb9\u6324\u8d70 */}
        {installDir && (
          <div className="bg-gray-900 rounded-lg border border-gray-700 overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2">
              <FolderOpen size={14} className="text-gray-500 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] text-gray-500">\u5b89\u88c5\u76ee\u5f55\uff1a</div>
                <div className="font-mono text-brand-400 text-xs truncate">{installDir}</div>
              </div>
              <button
                onClick={handlePickFolder}
                className="flex items-center gap-1 px-2 py-1 text-[11px] bg-gray-700 hover:bg-gray-600
                  rounded border border-gray-600 text-gray-300 transition-colors whitespace-nowrap flex-shrink-0"
              >
                <FolderSearch size={12} />
                \u66f4\u6539
              </button>
            </div>
          </div>
        )}

        {adminFailed && (
          <div className="bg-red-900/30 border border-red-700/50 rounded-lg p-3 flex flex-col gap-2">
            <div className="flex items-start gap-2">
              <ShieldCheck size={16} className="text-red-400 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium text-red-300">\u9700\u8981\u7ba1\u7406\u5458\u6743\u9650\u624d\u80fd\u7ee7\u7eed</p>
                <p className="text-xs text-red-400/80 mt-0.5">
                  \u5b89\u88c5\u9700\u8981\u5199\u5165\u7cfb\u7edf\u76ee\u5f55\u3001\u4fee\u6539\u6ce8\u518c\u8868\u8def\u5f84\u3001\u6dfb\u52a0 Windows Defender \u6392\u9664\u89c4\u5219\u3002
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
                ? <><Loader size={13} className="animate-spin" /> \u6b63\u5728\u63d0\u6743\uff0c\u5f53\u524d\u7a97\u53e3\u5c06\u81ea\u52a8\u5173\u95ed...</>
                : <><ShieldCheck size={13} /> \u81ea\u52a8\u91cd\u542f\u5e76\u4ee5\u7ba1\u7406\u5458\u8eab\u4efd\u8fd0\u884c</>
              }
            </button>
          </div>
        )}

        {webview2Missing && (
          <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-lg p-2.5 flex items-start gap-2">
            <AlertCircle size={14} className="text-yellow-400 mt-0.5 flex-shrink-0" />
            <div className="text-xs text-yellow-300/90">
              <p className="font-medium">\u9700\u8981\u5b89\u88c5 Windows \u7cfb\u7edf\u6d4f\u89c8\u5668\u5185\u6838 (WebView2)</p>
              <button
                onClick={() => invoke("open_url", { url: "https://go.microsoft.com/fwlink/p/?LinkId=2124703" })}
                className="flex items-center gap-1 mt-1 text-yellow-300 hover:text-yellow-200 underline underline-offset-2"
              >
                <ExternalLink size={11} />
                \u70b9\u51fb\u4e0b\u8f7d WebView2 \u8fd0\u884c\u65f6\uff08\u5fae\u8f6f\u5b98\u65b9\uff09
              </button>
            </div>
          </div>
        )}
      </div>

      {/* \u53ef\u6eda\u52a8\u533a\u57df\uff1a\u68c0\u6d4b\u5217\u8868 */}
      <div className="flex-1 overflow-y-auto px-6 pb-2">
        <div className="bg-gray-900 rounded-lg border border-gray-700 divide-y divide-gray-800/80">
          {checks.map((c) => (
            <div key={c.key} className="flex items-start gap-3 px-4 py-3">
              <div className="flex-shrink-0 mt-0.5">{statusIcon(c.status)}</div>
              <div className="flex-1 min-w-0">
                <div className="text-sm text-gray-200">{c.label}</div>
                <div className={\`text-xs mt-0.5
                  \${c.status === "ok"       ? "text-gray-500" : ""}
                  \${c.status === "warn"     ? "text-yellow-500" : ""}
                  \${c.status === "error"    ? "text-red-400" : ""}
                  \${c.status === "checking" ? "text-gray-600" : ""}
                \`}>{c.detail}</div>
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

      {/* \u5e95\u90e8\u56fa\u5b9a\u533a\u57df\uff1a\u72b6\u6001 + \u64cd\u4f5c\u6309\u9215 */}
      {done && (
        <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-t border-gray-800">
          {adminFailed ? (
            <p className="text-xs text-red-400">\u8bf7\u5148\u4ee5\u7ba1\u7406\u5458\u8eab\u4efd\u91cd\u65b0\u8fd0\u884c\u5b89\u88c5\u5668</p>
          ) : checks.some((c) => c.status === "warn") ? (
            <p className="text-xs text-yellow-500">\u5b58\u5728\u8b66\u544a\u9879\uff0c\u5efa\u8bae\u5904\u7406\u540e\u518d\u7ee7\u7eed</p>
          ) : (
            <p className="text-xs text-gray-500">\u6240\u6709\u68c0\u6d4b\u901a\u8fc7 \u2713</p>
          )}
          <button
            disabled={!canProceed}
            onClick={() => onDone(installDir)}
            className="px-6 py-2 bg-brand-500 hover:bg-brand-600
              disabled:bg-gray-800 disabled:text-gray-600 disabled:cursor-not-allowed
              text-gray-950 font-semibold text-sm rounded-lg transition-colors"
          >
            \u5f00\u59cb\u5b89\u88c5 \u2192
          </button>
        </div>
      )}
    </div>
  );
}
`;

fs.writeFileSync(path.join(SRC, "pages", "SysCheck.tsx"), syscheck, "utf8");
console.log("Written: src/pages/SysCheck.tsx");
console.log("Done.");
