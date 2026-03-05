import { useEffect, useState } from "react";
import { Minus, Maximize2, Minimize2, X } from "lucide-react";

interface Props {
  title: string;
}

const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

export default function TitleBar({ title }: Props) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    // 监听窗口最大化状态变化
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const win = getCurrentWindow();
      win.isMaximized().then(setMaximized);
      // 监听 resize 事件，实时更新最大化图标
      win.onResized(() => {
        win.isMaximized().then(setMaximized);
      });
    });
  }, []);

  async function handleMinimize(e: React.MouseEvent) {
    e.stopPropagation();
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch (err) {
      console.error("minimize failed", err);
    }
  }

  async function handleToggleMaximize(e: React.MouseEvent) {
    e.stopPropagation();
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      await win.toggleMaximize();
      setMaximized(await win.isMaximized());
    } catch (err) {
      console.error("toggleMaximize failed", err);
    }
  }

  async function handleClose(e: React.MouseEvent) {
    e.stopPropagation();
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch (err) {
      console.error("close failed", err);
    }
  }

  return (
    <div className="h-10 flex items-center bg-gray-950 border-b border-gray-800 flex-shrink-0 select-none">
      {/* ── 左侧拖拽区：图标 + 标题（仅此区域可拖动窗口）── */}
      <div
        data-tauri-drag-region
        className="flex-1 flex items-center gap-2 h-full px-4 cursor-default overflow-hidden"
      >
        <span className="text-brand-400 font-semibold text-sm pointer-events-none">🦞</span>
        <span className="text-gray-300 text-sm font-medium truncate pointer-events-none">{title}</span>
      </div>

      {/* ── 右侧按钮区：明确排除在拖拽区之外 ── */}
      <div className="flex items-center h-full flex-shrink-0">
        {/* 最小化 */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleMinimize}
          title="最小化"
          className="w-11 h-full flex items-center justify-center text-gray-400
            hover:bg-gray-700 hover:text-gray-100 transition-colors duration-100
            focus:outline-none"
        >
          <Minus size={14} strokeWidth={1.8} />
        </button>

        {/* 最大化 / 还原 */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleToggleMaximize}
          title={maximized ? "还原窗口" : "最大化"}
          className="w-11 h-full flex items-center justify-center text-gray-400
            hover:bg-gray-700 hover:text-gray-100 transition-colors duration-100
            focus:outline-none"
        >
          {maximized
            ? <Minimize2 size={12} strokeWidth={1.8} />
            : <Maximize2 size={12} strokeWidth={1.8} />
          }
        </button>

        {/* 关闭 */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleClose}
          title="关闭"
          className="w-11 h-full flex items-center justify-center text-gray-400
            hover:bg-red-600 hover:text-white transition-colors duration-100
            focus:outline-none"
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
