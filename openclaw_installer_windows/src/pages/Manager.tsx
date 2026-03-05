import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ExternalLink, RefreshCw, Square, Play, FolderOpen,
  Trash2, ChevronRight, Loader, FileEdit
} from "lucide-react";
import StatusDot from "../components/StatusDot";
import TitleBar from "../components/TitleBar";
import type { AppManifest, GatewayStatus } from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  manifest: AppManifest;
  gatewayStatus: GatewayStatus;
  onStatusChange: (s: GatewayStatus) => void;
  onManifestChange?: (m: AppManifest) => void;
}

export default function Manager({ manifest, gatewayStatus, onStatusChange }: Props) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const port = manifest.gateway_port || 18789;
  const chatUrl = `http://localhost:${port}/chat`;

  // 定期轮询 Gateway 状态
  useEffect(() => {
    checkStatus();
    const timer = setInterval(checkStatus, 5000);
    return () => clearInterval(timer);
  }, [port]);

  async function checkStatus() {
    try {
      const s = await invoke<string>("get_gateway_status", {
        installDir: manifest.install_dir,
        port,
      });
      onStatusChange(s === "running" ? "running" : "stopped");
    } catch {
      onStatusChange("stopped");
    }
  }

  async function doAction(action: string) {
    setActionLoading(action);
    try {
      if (action === "start") {
        onStatusChange("starting");
        await invoke("start_gateway_bg", { installDir: manifest.install_dir, port });
        setTimeout(checkStatus, 3000);
      } else if (action === "stop" || action === "force_stop") {
        await invoke("kill_gateway_process", { installDir: manifest.install_dir, port });
        onStatusChange("stopped");
      } else if (action === "restart") {
        onStatusChange("starting");
        await invoke("kill_gateway_process", { installDir: manifest.install_dir, port });
        await new Promise((r) => setTimeout(r, 1500));
        await invoke("start_gateway_bg", { installDir: manifest.install_dir, port });
        setTimeout(checkStatus, 3000);
      }
    } catch (e) {
      console.error(e);
      checkStatus();
    } finally {
      setActionLoading(null);
    }
  }

  const providerLabel: Record<string, string> = {
    anthropic: "Anthropic Claude",
    openai: "OpenAI GPT",
    deepseek: "DeepSeek",
    custom: "自定义 API",
    skip: "未配置",
  };

  return (
    <div className="h-screen flex flex-col bg-gray-950">
      <TitleBar title="OpenClaw Manager" />

      <div className="flex-1 overflow-y-auto px-6 py-5 flex flex-col gap-4">
        {/* 状态卡片 */}
        <div className="bg-gray-900 rounded-xl border border-gray-700 p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-base font-semibold text-gray-100">Gateway 状态</h3>
              <p className="text-xs text-gray-500 mt-0.5">{chatUrl}</p>
            </div>
            <StatusDot status={gatewayStatus} />
          </div>

          <div className="grid grid-cols-2 gap-2 mb-4 text-sm">
            <div className="bg-gray-800 rounded-lg p-3">
              <p className="text-xs text-gray-500 mb-0.5">监听端口</p>
              <p className="text-gray-200 font-mono">{port}</p>
            </div>
            <div className="bg-gray-800 rounded-lg p-3">
              <p className="text-xs text-gray-500 mb-0.5">AI 服务</p>
              <p className="text-gray-200">
                {manifest.api_key_configured
                  ? providerLabel[manifest.api_provider] || manifest.api_provider
                  : <span className="text-yellow-500">未配置</span>}
              </p>
            </div>
          </div>

          {/* 主操作按钮 */}
          <div className="flex gap-2">
            {gatewayStatus === "running" ? (
              <>
                <button
                  onClick={() => invoke("open_url", { url: chatUrl })}
                  className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-brand-500 hover:bg-brand-600 text-gray-950 font-semibold text-sm rounded-lg transition-colors"
                >
                  <ExternalLink size={15} />
                  打开 Chat 界面
                </button>
                <button
                  onClick={() => doAction("restart")}
                  disabled={actionLoading !== null}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-lg transition-colors disabled:opacity-50"
                >
                  <RefreshCw size={14} className={actionLoading === "restart" ? "animate-spin" : ""} />
                  重启
                </button>
                <button
                  onClick={() => doAction("stop")}
                  disabled={actionLoading !== null}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-sm rounded-lg transition-colors disabled:opacity-50"
                >
                  <Square size={14} />
                  停止
                </button>
              </>
            ) : gatewayStatus === "starting" ? (
              <div className="flex gap-2 w-full">
                <div className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-gray-800 text-gray-400 text-sm rounded-lg">
                  <RefreshCw size={14} className="animate-spin" />
                  启动中...
                </div>
                <button
                  onClick={() => doAction("force_stop")}
                  disabled={actionLoading !== null}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 bg-red-900/50 hover:bg-red-800/60 text-red-300 text-sm rounded-lg transition-colors disabled:opacity-50"
                >
                  <Square size={14} />
                  停止
                </button>
              </div>
            ) : (
              <button
                onClick={() => doAction("start")}
                disabled={actionLoading !== null}
                className="flex-1 flex items-center justify-center gap-2 py-2.5 bg-brand-500 hover:bg-brand-600 disabled:bg-gray-700 disabled:text-gray-500 text-gray-950 font-semibold text-sm rounded-lg transition-colors"
              >
                <Play size={14} />
                启动 Gateway
              </button>
            )}
          </div>
        </div>

        {/* 快捷操作列表 */}
        <div className="bg-gray-900 rounded-xl border border-gray-700 divide-y divide-gray-800">
          <ActionRow
            icon={<FileEdit size={16} />}
            label="修改 API Key"
            desc={manifest.api_key_configured ? "编辑 ~/.openclaw/openclaw.json 配置文件" : "打开配置文件设置 API Key"}
            onClick={async () => {
              try {
                await invoke("open_config_file");
              } catch (e) {
                console.error("打开配置文件失败:", e);
              }
            }}
          />
          <ActionRow
            icon={<FolderOpen size={16} />}
            label="安装目录"
            desc={manifest.install_dir}
            onClick={async () => {
              try {
                await invoke("open_folder", { path: manifest.install_dir });
              } catch (e) {
                console.error("打开目录失败:", e);
              }
            }}
          />
          <ActionRow
            icon={<Trash2 size={16} className="text-red-400" />}
            label={<span className="text-red-400">卸载 OpenClaw</span>}
            desc="停止 Gateway 并删除所有已安装的文件"
            loading={actionLoading === "uninstall"}
            onClick={async () => {
              if (!confirm("确定要卸载 OpenClaw 吗？\n\n将停止 Gateway 并删除安装目录。\n（~/.openclaw/ 配置文件会保留）")) return;
              setActionLoading("uninstall");
              try {
                await invoke("kill_gateway_process", { installDir: manifest.install_dir, port });
                await invoke("uninstall", { installDir: manifest.install_dir });
                alert("卸载完成！程序将关闭。");
                if (isTauri) {
                  const { getCurrentWindow } = await import("@tauri-apps/api/window");
                  await getCurrentWindow().close();
                }
              } catch (e) {
                alert(`卸载失败: ${e}`);
              } finally {
                setActionLoading(null);
              }
            }}
          />
        </div>

        {/* 版本信息 */}
        <p className="text-center text-xs text-gray-700">
          OpenClaw Manager v{manifest.version} · 安装目录: {manifest.install_dir}
        </p>
      </div>
    </div>
  );
}

function ActionRow({
  icon,
  label,
  desc,
  loading,
  onClick,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  desc: string;
  loading?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-gray-800 transition-colors text-left disabled:opacity-50"
    >
      <span className="text-gray-400 flex-shrink-0">
        {loading ? <Loader size={16} className="animate-spin" /> : icon}
      </span>
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-200">{label}</div>
        <div className="text-xs text-gray-500 mt-0.5 truncate">{desc}</div>
      </div>
      <ChevronRight size={14} className="text-gray-600 flex-shrink-0" />
    </button>
  );
}
