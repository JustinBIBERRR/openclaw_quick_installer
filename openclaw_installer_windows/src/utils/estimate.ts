/**
 * 根据环境检测结果计算剩余时间预估
 * - node_installed: 是否有 Node.js 18+
 * - openclaw_installed: 是否已安装 OpenClaw CLI
 * - config_exists: 是否有 openclaw.json 配置
 */
export interface EnvEstimate {
  node_installed: boolean;
  openclaw_installed: boolean;
  config_exists: boolean;
}

/** 安装步骤预估（仅 Node + OpenClaw CLI 安装） */
export function getInstallStepEstimate(env: EnvEstimate | null): string {
  if (!env) return "约 1-3 分钟";
  if (env.openclaw_installed) return "约 30 秒"; // 验证即可
  if (env.node_installed) return "约 1-2 分钟"; // 仅 npm 安装
  return "约 3-5 分钟"; // Node 下载安装 + npm
}

/** 完整向导剩余时间预估（安装 + 配置 API + 启动 Gateway） */
export function getFullWizardEstimate(env: EnvEstimate | null): string {
  if (!env) return "约 4-6 分钟";
  let install = 0;
  if (env.openclaw_installed) install = 0.5; // 30 秒验证
  else if (env.node_installed) install = 1.5; // 1-2 分钟
  else install = 4; // 3-5 分钟
  const apikey = env.config_exists ? 0 : 1; // 有配置则跳过
  const launching = 0.5; // 30 秒
  const total = install + apikey + launching;
  if (total <= 1) return "约 1 分钟";
  if (total <= 2) return "约 1-2 分钟";
  if (total <= 3) return "约 2-3 分钟";
  return "约 4-6 分钟";
}
