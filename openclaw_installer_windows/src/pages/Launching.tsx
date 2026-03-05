import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader, RefreshCw, ExternalLink, Square } from "lucide-react";
import LogScroller from "../components/LogScroller";
import type { AppManifest, LogEntry } from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  manifest: AppManifest;
  logs: LogEntry[];
  addLog: (level: LogEntry["level"], message: string) => void;
  onDone: (manifest: AppManifest) => void;
}

type LaunchPhase = "idle" | "starting" | "done" | "failed";

export default function Launching({ manifest, logs, addLog, onDone }: Props) {
  const [phase, setPhase] = useState<LaunchPhase>("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [stopping, setStopping] = useState(false);
  const startedRef = useRef(false);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    const unlistenLog = listen<{ level: string; message: string }>(
      "gateway-log",
      (e) => addLog((e.payload.level as LogEntry["level"]) || "info", e.payload.message)
    );

    startGateway();
    return () => {
      unlistenLog.then((f) => f());
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  async function startGateway() {
    cancelledRef.current = false;
    setPhase("starting");
    setErrorMsg("");
    setElapsed(0);
    setStopping(false);
    timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
    addLog("info", "正在启动 Gateway...");

    if (!isTauri) {
      await new Promise((r) => setTimeout(r, 1200));
      const gwLogs = [
        "[预览] 读取 manifest.json → C:\\OpenClaw",
        "[预览] 执行: openclaw start --port 18789",
        "[预览] Gateway starting on 0.0.0.0:18789",
        "[预览] OpenClaw Gateway v1.0.3 ready",
      ];
      for (const log of gwLogs) {
        if (cancelledRef.current) break;
        await new Promise((r) => setTimeout(r, 400));
        addLog("info", log);
      }
      if (cancelledRef.current) return;
      if (timerRef.current) clearInterval(timerRef.current);
      setPhase("done");
      addLog("ok", `Gateway 已就绪 → http://localhost:18789/chat`);
      onDone({ ...manifest, gateway_port: 18789, gateway_pid: 12345 });
      return;
    }

    try {
      const result = await invoke<AppManifest>("start_gateway", {
        installDir: manifest.install_dir,
        port: manifest.gateway_port || 18789,
      });
      if (timerRef.current) clearInterval(timerRef.current);
      if (cancelledRef.current) return;
      setPhase("done");
      addLog("ok", `Gateway 已就绪 → http://localhost:${result.gateway_port}/chat`);
      onDone(result);
    } catch (e: unknown) {
      if (timerRef.current) clearInterval(timerRef.current);
      if (cancelledRef.current) return;
      const msg = e instanceof Error ? e.message : String(e);
      setPhase("failed");
      setErrorMsg(msg);
      addLog("error", `启动失败: ${msg}`);
    }
  }

  async function handleStop() {
    setStopping(true);
    cancelledRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    addLog("warn", "正在停止 Gateway...");

    try {
      await invoke("kill_gateway_process", {
        installDir: manifest.install_dir,
        port: manifest.gateway_port || 18789,
      });
      addLog("info", "Gateway 已停止");
    } catch (e) {
      addLog("error", `停止失败: ${e}`);
    }

    setStopping(false);
    setPhase("failed");
    setErrorMsg("已手动停止 Gateway");
  }

  async function handleRetry() {
    cancelledRef.current = true;
    if (timerRef.current) clearInterval(timerRef.current);
    addLog("warn", "正在停止旧进程...");

    try {
      await invoke("kill_gateway_process", {
        installDir: manifest.install_dir,
        port: manifest.gateway_port || 18789,
      });
    } catch { /* ignore */ }

    await new Promise((r) => setTimeout(r, 1000));
    startGateway();
  }

  const chatUrl = `http://localhost:${manifest.gateway_port || 18789}/chat`;

  return (
    <div className="h-full flex flex-col px-6 py-4 gap-4 overflow-y-auto">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">启动 Gateway</h2>
        <p className="text-sm text-gray-400 mt-0.5">
          启动本地 AI 网关，完成后将自动打开浏览器
        </p>
      </div>

      <div className="bg-gray-900 rounded-lg border border-gray-700 p-4">
        {phase === "starting" && (
          <div className="flex items-center gap-3">
            <Loader size={20} className="text-brand-400 animate-spin flex-shrink-0" />
            <div>
              <p className="text-sm text-gray-200">Gateway 启动中...</p>
              <p className="text-xs text-gray-500 mt-0.5">已等待 {elapsed}s / 最长等待 90s</p>
            </div>
          </div>
        )}
        {phase === "done" && (
          <div className="flex items-center gap-3">
            <span className="relative flex h-4 w-4 flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-60" />
              <span className="relative inline-flex rounded-full h-4 w-4 bg-brand-500" />
            </span>
            <div>
              <p className="text-sm text-brand-400 font-medium">Gateway 运行中</p>
              <p className="text-xs text-gray-500 mt-0.5">{chatUrl}</p>
            </div>
          </div>
        )}
        {phase === "failed" && (
          <div>
            <p className="text-sm text-red-400">启动失败</p>
            <p className="text-xs text-gray-500 mt-1 break-all">{errorMsg}</p>
          </div>
        )}
      </div>

      <div className="flex-1">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-xs text-gray-500 font-medium uppercase tracking-wide">Gateway 日志</span>
        </div>
        <LogScroller logs={logs} maxHeight="h-full min-h-[150px]" />
      </div>

      <div className="flex items-center justify-between flex-shrink-0">
        {phase === "starting" && (
          <>
            <p className="text-sm text-gray-500">正在等待 Gateway 响应...</p>
            <div className="flex gap-2">
              <button
                onClick={handleStop}
                disabled={stopping}
                className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600
                  disabled:opacity-50 text-gray-200 text-sm rounded-lg transition-colors"
              >
                <Square size={14} />
                {stopping ? "停止中..." : "停止"}
              </button>
              <button
                onClick={handleRetry}
                disabled={stopping}
                className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600
                  disabled:opacity-50 text-gray-200 text-sm rounded-lg transition-colors"
              >
                <RefreshCw size={14} />
                重试
              </button>
            </div>
          </>
        )}
        {phase === "failed" && (
          <>
            <p className="text-xs text-gray-500 max-w-xs">
              如果问题持续，请尝试重启或检查端口是否被占用
            </p>
            <button
              onClick={handleRetry}
              className="flex items-center gap-2 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm rounded-lg transition-colors"
            >
              <RefreshCw size={14} />
              重新启动
            </button>
          </>
        )}
        {phase === "done" && (
          <>
            <p className="text-sm text-brand-400">安装完成！桌面快捷方式已创建</p>
            <button
              onClick={() => invoke("open_url", { url: chatUrl })}
              className="flex items-center gap-2 px-6 py-2 bg-brand-500 hover:bg-brand-600 text-gray-950 font-semibold text-sm rounded-lg transition-colors"
            >
              <ExternalLink size={14} />
              打开 OpenClaw
            </button>
          </>
        )}
      </div>
    </div>
  );
}
