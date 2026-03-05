import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader, RefreshCw, ExternalLink, FolderSearch } from "lucide-react";
import LogScroller from "../components/LogScroller";
import type { AppManifest, LogEntry } from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  manifest: AppManifest | null;
  logs: LogEntry[];
  addLog: (level: LogEntry["level"], message: string) => void;
  onDone: () => void;
}

type InstallPhase = "idle" | "running" | "done" | "failed" | "manual_download";

const INSTALL_STEPS = [
  "检测 / 下载 Node.js",
  "优化系统环境",
  "安装 OpenClaw CLI",
  "验证安装",
];

export default function Installing({ manifest, logs, addLog, onDone }: Props) {
  const [phase, setPhase] = useState<InstallPhase>("idle");
  const [currentStep, setCurrentStep] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const [manualDownloadUrl, setManualDownloadUrl] = useState("");
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const unlistenProgress = listen<{ step: number; total: number; label: string }>(
      "install-progress",
      (e) => setCurrentStep(e.payload.step)
    );

    const unlistenLog = listen<{ level: string; message: string }>(
      "install-log",
      (e) => {
        if (e.payload.level === "manual_download" && e.payload.message) {
          setManualDownloadUrl(e.payload.message);
          setPhase("manual_download");
        }
      }
    );

    startInstall();
    return () => {
      unlistenProgress.then((f) => f());
      unlistenLog.then((f) => f());
    };
  }, []);

  async function startInstall() {
    setPhase("running");
    setErrorMsg("");
    addLog("info", "开始安装流程...");

    if (!isTauri) {
      // 浏览器预览模式：模拟安装步骤
      const steps = [
        { step: 0, delay: 600,  logs: ["[预览] 解压 node-v22-win-x64.zip → C:\\OpenClaw\\runtime", "[预览] Node.js v22.11.0 OK"] },
        { step: 1, delay: 800,  logs: ["[预览] 注册表 LongPathsEnabled=1", "[预览] npm registry → https://registry.npmmirror.com", "[预览] Windows Defender 排除路径已添加"] },
        { step: 2, delay: 1200, logs: ["[预览] npm install -g openclaw", "[预览] added 312 packages in 18s", "[预览] openclaw@1.0.3 安装成功"] },
        { step: 3, delay: 400,  logs: ["[预览] 写入 manifest.json", "[预览] 安装完成 ✓"] },
      ];
      for (const s of steps) {
        await new Promise((r) => setTimeout(r, s.delay));
        setCurrentStep(s.step);
        s.logs.forEach((l) => addLog("info", l));
      }
      await new Promise((r) => setTimeout(r, 300));
      setCurrentStep(4);
      setPhase("done");
      addLog("ok", "OpenClaw CLI 安装完成！");
      return;
    }

    try {
      await invoke("start_install", {
        installDir: manifest?.install_dir || "C:\\OpenClaw",
      });
      setPhase("done");
      addLog("ok", "OpenClaw CLI 安装完成！");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setPhase("failed");
      setErrorMsg(msg);
      addLog("error", `安装失败: ${msg}`);
    }
  }

  return (
    <div className="h-full flex flex-col px-6 py-4 gap-4 overflow-y-auto">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">安装 OpenClaw</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          解压内置运行时，安装 OpenClaw CLI（约 1-3 分钟）
        </p>
      </div>

      {/* 步骤进度 */}
      <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
        <div className="flex flex-col gap-2">
          {INSTALL_STEPS.map((label, i) => {
            const done = i < currentStep;
            const active = i === currentStep && phase === "running";
            return (
              <div key={i} className="flex items-center gap-3">
                <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0
                  ${done ? "bg-brand-500" : ""}
                  ${active ? "bg-gray-800 border border-brand-400" : ""}
                  ${!done && !active ? "bg-gray-800 border border-gray-700" : ""}
                `}>
                  {done && <span className="text-white text-[10px]">✓</span>}
                  {active && <Loader size={11} className="text-brand-400 animate-spin" />}
                  {!done && !active && <span className="text-gray-600 text-[10px]">{i + 1}</span>}
                </div>
                <span className={`text-sm
                  ${done ? "text-gray-400" : ""}
                  ${active ? "text-brand-400 font-medium" : ""}
                  ${!done && !active ? "text-gray-600" : ""}
                `}>{label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 实时日志 */}
      <div className="flex-1">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">安装日志</span>
          <span className="text-xs text-gray-600">{logs.length} 行</span>
        </div>
        <LogScroller logs={logs} maxHeight="h-full min-h-[150px]" />
      </div>

      {/* 手动下载引导 */}
      {phase === "manual_download" && (
        <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-lg p-4 flex flex-col gap-3 flex-shrink-0">
          <div className="flex items-start gap-2">
            <FolderSearch size={16} className="text-yellow-400 mt-0.5 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-yellow-300">Node.js 运行时下载失败，请手动下载</p>
              <p className="text-xs text-yellow-400/70 mt-1">
                您的网络环境无法自动下载 Node.js 运行时。请用浏览器手动下载后放到安装目录，然后点击"重试"。
              </p>
            </div>
          </div>
          <div className="bg-gray-900/60 rounded-md p-3 text-xs text-gray-300 space-y-1.5">
            <p>1. 点击下方按钮，在 GitHub Release 页面下载 <code className="text-yellow-300">node-v22-win-x64.zip</code></p>
            <p>2. 将下载的 zip 文件放到安装目录：<code className="text-brand-400 break-all">{manifest?.install_dir || "C:\\OpenClaw"}</code></p>
            <p>3. 点击下方"重试"按钮继续安装</p>
          </div>
          <button
            onClick={() => {
              if (isTauri && manualDownloadUrl) {
                invoke("open_url", { url: manualDownloadUrl }).catch(() => {
                  window.open(manualDownloadUrl, "_blank");
                });
              }
            }}
            className="flex items-center justify-center gap-2 py-2 bg-yellow-600 hover:bg-yellow-500
              text-white text-sm font-medium rounded-lg transition-colors"
          >
            <ExternalLink size={13} />
            打开 GitHub 下载页面
          </button>
        </div>
      )}

      {/* 底部 */}
      <div className="flex items-center justify-between flex-shrink-0">
        {(phase === "failed" || phase === "manual_download") ? (
          <>
            <p className="text-sm text-red-400 flex-1 mr-4 truncate">
              {phase === "manual_download" ? "请手动下载 Node.js 后重试" : errorMsg}
            </p>
            <button
              onClick={() => { setPhase("idle"); startedRef.current = false; startInstall(); }}
              className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded-lg transition-colors"
            >
              <RefreshCw size={14} />
              重试
            </button>
          </>
        ) : phase === "done" ? (
          <>
            <p className="text-sm text-brand-400">安装成功 ✓</p>
            <button
              onClick={onDone}
              className="px-6 py-2 bg-brand-500 hover:bg-brand-600 text-gray-950 font-semibold text-sm rounded-lg transition-colors"
            >
              下一步 →
            </button>
          </>
        ) : (
          <p className="text-sm text-gray-500 flex items-center gap-2">
            <Loader size={14} className="animate-spin text-brand-400" />
            安装中，请稍候...
          </p>
        )}
      </div>
    </div>
  );
}
