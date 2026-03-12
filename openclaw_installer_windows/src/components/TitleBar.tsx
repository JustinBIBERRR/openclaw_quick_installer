import { useEffect, useState } from "react";
import { Minus, Maximize2, Minimize2, X } from "lucide-react";
import LanguageSwitch from "./LanguageSwitch";
import { useI18n } from "../i18n/useI18n";

interface Props {
  title: string;
}

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export default function TitleBar({ title }: Props) {
  const [maximized, setMaximized] = useState(false);
  const { t } = useI18n();

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
    <div
      className="h-12 flex items-center border-b border-white/10 flex-shrink-0 select-none shadow-[0_1px_0_rgba(255,255,255,0.03)]"
      style={{ background: "linear-gradient(180deg, rgba(9,16,28,0.96) 0%, rgba(6,11,20,0.94) 100%)" }}
    >
      {/* ── 左侧拖拽区：图标 + 标题（仅此区域可拖动窗口）── */}
      <div
        data-tauri-drag-region
        className="flex-1 flex items-center gap-3 h-full px-6 cursor-default overflow-hidden"
      >
        <div className="w-5 h-5 accent-primary flex items-center justify-center">
          <svg viewBox="0 0 100 100" className="w-full h-full" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M50 85 L35 55 C35 30 65 30 65 55 Z" />
            <circle cx="43" cy="50" r="2" fill="currentColor" />
            <circle cx="57" cy="50" r="2" fill="currentColor" />
            <path d="M32 50 C20 45 15 30 20 20 C25 15 35 25 35 35 Z" />
            <path d="M68 50 C80 45 85 30 80 20 C75 15 65 25 65 35 Z" />
          </svg>
        </div>
        <span className="text-white/80 text-sm font-medium tracking-wide truncate pointer-events-none">{title}</span>
      </div>

      {/* ── 右侧按钮区：明确排除在拖拽区之外 ── */}
      <div className="flex items-center h-full flex-shrink-0 text-white/50 gap-2 pr-2">
        <LanguageSwitch />
        {/* 最小化 */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleMinimize}
          title={t("titlebar.minimize")}
          className="w-12 h-full flex items-center justify-center
            hover:bg-white/10 hover:text-white transition-colors duration-200
            focus:outline-none"
        >
          <Minus size={16} strokeWidth={1.5} />
        </button>

        {/* 最大化 / 还原 */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleToggleMaximize}
          title={maximized ? t("titlebar.restore") : t("titlebar.maximize")}
          className="w-12 h-full flex items-center justify-center
            hover:bg-white/10 hover:text-white transition-colors duration-200
            focus:outline-none"
        >
          {maximized
            ? <Minimize2 size={14} strokeWidth={1.5} />
            : <Maximize2 size={14} strokeWidth={1.5} />
          }
        </button>

        {/* 关闭 */}
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={handleClose}
          title={t("titlebar.close")}
          className="w-12 h-full flex items-center justify-center
            hover:bg-red-500 hover:text-white transition-colors duration-200
            focus:outline-none"
        >
          <X size={16} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
