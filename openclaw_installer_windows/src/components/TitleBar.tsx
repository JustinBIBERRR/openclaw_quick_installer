import { useEffect, useState } from "react";
import { Minus, Maximize2, Minimize2, X } from "lucide-react";

interface Props {
  title: string;
}

const isTauri = typeof window !== "undefined" && "__TAURI__" in window;

type WinAPI = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  close: () => Promise<void>;
};

export default function TitleBar({ title }: Props) {
  const [win, setWin] = useState<WinAPI | null>(null);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri) return;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const w = getCurrentWindow() as WinAPI;
      setWin(w);
      // 初始化最大化状态
      w.isMaximized().then(setMaximized);
    });
  }, []);

  async function handleMinimize() {
    await win?.minimize();
  }

  async function handleToggleMaximize() {
    await win?.toggleMaximize();
    const next = await win?.isMaximized();
    setMaximized(next ?? false);
  }

  async function handleClose() {
    await win?.close();
  }

  return (
    <div
      data-tauri-drag-region
      className="h-10 flex items-center justify-between px-4 bg-gray-950 border-b border-gray-800 flex-shrink-0 select-none"
    >
      {/* 左侧：图标 + 标题 */}
      <div className="flex items-center gap-2" data-tauri-drag-region>
        <span className="text-brand-400 font-semibold text-sm">🦞</span>
        <span className="text-gray-300 text-sm font-medium">{title}</span>
      </div>

      {/* 右侧：窗口控制按钮（Tauri 有时连接真实 API，浏览器预览只显示样式）*/}
      <div className="flex items-center">
        {/* 最小化 */}
        <button
          onClick={isTauri ? handleMinimize : undefined}
          title="最小化"
          className="w-11 h-10 flex items-center justify-center text-gray-400
            hover:bg-gray-700 hover:text-gray-100 transition-colors duration-100"
        >
          <Minus size={14} strokeWidth={1.8} />
        </button>

        {/* 最大化 / 还原 */}
        <button
          onClick={isTauri ? handleToggleMaximize : undefined}
          title={maximized ? "还原" : "最大化"}
          className="w-11 h-10 flex items-center justify-center text-gray-400
            hover:bg-gray-700 hover:text-gray-100 transition-colors duration-100"
        >
          {maximized
            ? <Minimize2 size={13} strokeWidth={1.8} />
            : <Maximize2 size={13} strokeWidth={1.8} />
          }
        </button>

        {/* 关闭 */}
        <button
          onClick={isTauri ? handleClose : undefined}
          title="关闭"
          className="w-11 h-10 flex items-center justify-center text-gray-400
            hover:bg-red-600 hover:text-white transition-colors duration-100"
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
