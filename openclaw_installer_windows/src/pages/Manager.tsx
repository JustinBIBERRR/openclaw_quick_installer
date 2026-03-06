import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ExternalLink, RefreshCw, Square, Play, FolderOpen,
  Trash2, ChevronRight, Loader, FileEdit, Stethoscope, Wrench,
  AlertTriangle, X
} from "lucide-react";
import StatusDot from "../components/StatusDot";
import TitleBar from "../components/TitleBar";
import type { AppManifest, GatewayStatus, DoctorResult, CommandResult, CliCapabilities } from "../types";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  manifest: AppManifest;
  cliCaps: CliCapabilities | null;
  gatewayStatus: GatewayStatus;
  onStatusChange: (s: GatewayStatus) => void;
  onManifestChange?: (m: AppManifest) => void;
}

function buildManagerRecoveryHint(message: string, backendHint: string | null): string | null {
  const lower = `${message} ${backendHint || ""}`.toLowerCase();
  if (lower.includes("too many failed authentication attempts") || lower.includes("authentication attempts")) {
    return "浏览器可能缓存了旧 token。请先重启 Gateway，并使用无痕模式重新打开 Chat。";
  }
  if (lower.includes("no api key found") || lower.includes("auth-profiles")) {
    return backendHint || "未找到可用 API Key。请先运行诊断/修复，再检查模型配置。";
  }
  if (lower.includes("gateway.mode") || lower.includes("mode local") || lower.includes("unconfigured")) {
    return backendHint || "网关模式或配置未就绪。建议先运行诊断与修复。";
  }
  if (lower.includes("cmd_not_found") || lower.includes("找不到 openclaw")) {
    return backendHint || "系统未发现 openclaw 命令。请重新打开安装器并检查 PATH。";
  }
  return backendHint;
}

export default function Manager({ manifest, cliCaps, gatewayStatus, onStatusChange }: Props) {
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastErrorHint, setLastErrorHint] = useState<string | null>(null);
  const [doctorResult, setDoctorResult] = useState<DoctorResult | null>(null);
  const [showDoctorPanel, setShowDoctorPanel] = useState(false);

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
    setLastError(null);
    setLastErrorHint(null);
    
    try {
      if (action === "start") {
        onStatusChange("starting");
        const result = await invoke<CommandResult>("start_gateway_bg", {
          installDir: manifest.install_dir,
          port,
        });
        if (!result.success) {
          setLastError(result.message);
          setLastErrorHint(buildManagerRecoveryHint(result.message, result.hint));
          onStatusChange("stopped");
          return;
        }
        // 等待并检查状态
        await new Promise((r) => setTimeout(r, 3000));
        const status = await invoke<string>("get_gateway_status", { installDir: manifest.install_dir, port });
        if (status !== "running") {
          // 启动可能失败，检查几次
          let retries = 3;
          while (retries > 0) {
            await new Promise((r) => setTimeout(r, 2000));
            const s = await invoke<string>("get_gateway_status", { installDir: manifest.install_dir, port });
            if (s === "running") {
              onStatusChange("running");
              return;
            }
            retries--;
          }
          setLastError("Gateway 启动失败，请检查配置或运行诊断");
          setLastErrorHint("可能是配置文件问题或端口被占用");
          onStatusChange("stopped");
        } else {
          onStatusChange("running");
        }
      } else if (action === "stop" || action === "force_stop") {
        await invoke("kill_gateway_process", { installDir: manifest.install_dir, port });
        onStatusChange("stopped");
      } else if (action === "restart") {
        onStatusChange("starting");
        await invoke("kill_gateway_process", { installDir: manifest.install_dir, port });
        await new Promise((r) => setTimeout(r, 1500));
        const result = await invoke<CommandResult>("start_gateway_bg", { installDir: manifest.install_dir, port });
        if (!result.success) {
          setLastError(result.message);
          setLastErrorHint(buildManagerRecoveryHint(result.message, result.hint));
          onStatusChange("stopped");
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
        checkStatus();
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(msg);
      console.error(e);
      checkStatus();
    } finally {
      setActionLoading(null);
    }
  }

  async function runDiagnose() {
    if (!cliCaps?.has_doctor) {
      setLastError("当前 OpenClaw 版本不支持 doctor 诊断");
      setLastErrorHint("请升级 OpenClaw 后重试");
      return;
    }
    setActionLoading("diagnose");
    setShowDoctorPanel(true);
    try {
      const result = await invoke<DoctorResult>("run_doctor");
      setDoctorResult(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(`诊断失败: ${msg}`);
    } finally {
      setActionLoading(null);
    }
  }

  async function runFix() {
    if (!cliCaps?.has_doctor) {
      setLastError("当前 OpenClaw 版本不支持 doctor --fix");
      setLastErrorHint("请升级 OpenClaw 后重试");
      return;
    }
    setActionLoading("fix");
    try {
      const result = await invoke<CommandResult>("run_doctor_fix");
      if (result.success) {
        setLastError(null);
        setDoctorResult(null);
        // 修复后重新诊断
        const newResult = await invoke<DoctorResult>("run_doctor");
        setDoctorResult(newResult);
      } else {
        setLastError(`修复失败: ${result.message}`);
        setLastErrorHint(result.hint || null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastError(`修复失败: ${msg}`);
    } finally {
      setActionLoading(null);
    }
  }

  async function openLogDirectory() {
    try {
      const logDir = await invoke<string>("get_log_directory");
      await invoke("open_folder", { path: logDir });
    } catch (e) {
      console.error("打开日志目录失败:", e);
    }
  }

  async function openRuntimeLogDirectory() {
    try {
      await invoke("open_folder", { path: `${manifest.install_dir}\\logs` });
    } catch (e) {
      console.error("打开运行日志目录失败:", e);
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
                  onClick={async () => {
                    try {
                      if (cliCaps?.has_dashboard) {
                        const result = await invoke<CommandResult>("run_dashboard");
                        if (!result.success) {
                          setLastError(result.message);
                          setLastErrorHint(buildManagerRecoveryHint(result.message, result.hint || null));
                        }
                      } else {
                        await invoke("open_url", { url: chatUrl });
                      }
                    } catch (e) {
                      const msg = e instanceof Error ? e.message : String(e);
                      setLastError(msg);
                      setLastErrorHint(buildManagerRecoveryHint(msg, null));
                    }
                  }}
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

        {/* 错误提示卡片 */}
        {lastError && (
          <div className="bg-red-900/20 border border-red-800/50 rounded-xl p-4">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <AlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm text-red-400">{lastError}</p>
                  {lastErrorHint && (
                    <p className="text-xs text-red-300/70 mt-1">{lastErrorHint}</p>
                  )}
                </div>
              </div>
              <button
                onClick={() => { setLastError(null); setLastErrorHint(null); }}
                className="text-red-400/50 hover:text-red-400 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            <div className="flex gap-2 mt-3 pl-7">
              <button
                onClick={runDiagnose}
                disabled={actionLoading !== null || !cliCaps?.has_doctor}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-900/40 hover:bg-yellow-800/50 text-yellow-400 text-xs rounded-lg transition-colors disabled:opacity-50"
              >
                <Stethoscope size={12} />
                诊断问题
              </button>
              <button
                onClick={runFix}
                disabled={actionLoading !== null || !cliCaps?.has_doctor}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-900/40 hover:bg-yellow-800/50 text-yellow-400 text-xs rounded-lg transition-colors disabled:opacity-50"
              >
                <Wrench size={12} />
                一键修复
              </button>
            </div>
          </div>
        )}

        {/* 诊断结果面板 */}
        {showDoctorPanel && (
          <div className="bg-gray-900 rounded-xl border border-gray-700 p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-medium text-gray-200 flex items-center gap-2">
                <Stethoscope size={16} className="text-yellow-400" />
                诊断结果
              </h4>
              <button
                onClick={() => { setShowDoctorPanel(false); setDoctorResult(null); }}
                className="text-gray-500 hover:text-gray-300 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
            
            {actionLoading === "diagnose" ? (
              <div className="flex items-center gap-2 text-gray-400 text-sm">
                <Loader size={14} className="animate-spin" />
                正在诊断...
              </div>
            ) : doctorResult ? (
              <div className="space-y-2">
                <div className={`text-sm ${doctorResult.passed ? "text-green-400" : "text-yellow-400"}`}>
                  {doctorResult.summary}
                </div>
                {doctorResult.issues.length > 0 && (
                  <ul className="text-xs space-y-1 pl-2 border-l-2 border-gray-700">
                    {doctorResult.issues.map((issue, i) => (
                      <li key={i} className={`pl-2 ${issue.severity === "error" ? "text-red-400" : "text-yellow-500"}`}>
                        {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={runFix}
                    disabled={actionLoading !== null || doctorResult.passed}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-yellow-900/40 hover:bg-yellow-800/50 text-yellow-400 text-xs rounded-lg transition-colors disabled:opacity-50"
                  >
                    {actionLoading === "fix" ? <Loader size={12} className="animate-spin" /> : <Wrench size={12} />}
                    {actionLoading === "fix" ? "修复中..." : "运行修复"}
                  </button>
                  <button
                    onClick={runDiagnose}
                    disabled={actionLoading !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs rounded-lg transition-colors disabled:opacity-50"
                  >
                    <RefreshCw size={12} />
                    重新诊断
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-xs text-gray-500">点击"诊断问题"开始检测</p>
            )}
          </div>
        )}

        {/* 快捷操作列表 */}
        <div className="bg-gray-900 rounded-xl border border-gray-700 divide-y divide-gray-800">
          <ActionRow
            icon={<Stethoscope size={16} className="text-yellow-400" />}
            label="诊断与修复"
            desc="运行 openclaw doctor 检测并修复问题"
            loading={actionLoading === "diagnose"}
            onClick={runDiagnose}
          />
          <ActionRow
            icon={<FolderOpen size={16} className="text-blue-400" />}
            label="查看 installer 日志"
            desc="%USERPROFILE%\\.openclaw\\installer-logs"
            onClick={openLogDirectory}
          />
          <ActionRow
            icon={<FolderOpen size={16} className="text-blue-400" />}
            label="查看运行日志"
            desc="<install_dir>\\logs"
            onClick={openRuntimeLogDirectory}
          />
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
