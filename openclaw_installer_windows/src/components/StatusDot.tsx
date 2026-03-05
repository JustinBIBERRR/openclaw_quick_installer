import type { GatewayStatus } from "../types";

interface Props {
  status: GatewayStatus;
}

export default function StatusDot({ status }: Props) {
  if (status === "running") {
    return (
      <span className="flex items-center gap-1.5">
        <span className="relative flex h-2.5 w-2.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-60" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-brand-500" />
        </span>
        <span className="text-brand-400 text-sm font-medium">运行中</span>
      </span>
    );
  }
  if (status === "starting") {
    return (
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-yellow-400 animate-pulse" />
        <span className="text-yellow-400 text-sm font-medium">启动中...</span>
      </span>
    );
  }
  if (status === "checking") {
    return (
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full bg-gray-500 animate-pulse" />
        <span className="text-gray-400 text-sm font-medium">检测中...</span>
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
      <span className="text-red-400 text-sm font-medium">已停止</span>
    </span>
  );
}
