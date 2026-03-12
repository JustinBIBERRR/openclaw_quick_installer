import type { CommandResult } from "../types";

export function mapInstallFailure(result: CommandResult): string {
  const fallbackMsg = result.message || "安装失败";
  if (result.code === "NPM_PERMISSION_DENIED") {
    return "OpenClaw CLI 安装失败（npm 权限不足）";
  }
  if (result.code === "NPM_NETWORK_ERROR") {
    return "OpenClaw CLI 安装失败（网络异常）";
  }
  if (result.code === "OPENCLAW_NOT_FOUND" || result.code === "INSTALL_VERIFY_FAILED") {
    return "安装后未找到 openclaw 命令";
  }
  if (result.code === "NODE_RUNTIME_NOT_READY") {
    return "Node.js 运行时未就绪";
  }
  return fallbackMsg;
}

export function mapInstallCatchFailure(rawError: unknown): string {
  const raw = rawError instanceof Error ? rawError.message : String(rawError);
  const lower = raw.toLowerCase();
  if (lower.includes("npm")) {
    return "OpenClaw CLI 安装失败（npm 阶段）";
  }
  if (lower.includes("node")) {
    return "Node.js 安装失败";
  }
  if (lower.includes("msi")) {
    return "Node.js MSI 安装失败";
  }
  if (lower.includes("version")) {
    return "OpenClaw 安装验证失败";
  }
  return raw;
}
