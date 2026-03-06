import { useCallback } from "react";

const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Direction =
  | "North" | "South" | "East" | "West"
  | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

const EDGE = 5;

const edges: { dir: Direction; style: React.CSSProperties; cursor: string }[] = [
  { dir: "North",     style: { top: 0, left: EDGE, right: EDGE, height: EDGE }, cursor: "ns-resize" },
  { dir: "South",     style: { bottom: 0, left: EDGE, right: EDGE, height: EDGE }, cursor: "ns-resize" },
  { dir: "West",      style: { top: EDGE, bottom: EDGE, left: 0, width: EDGE }, cursor: "ew-resize" },
  { dir: "East",      style: { top: EDGE, bottom: EDGE, right: 0, width: EDGE }, cursor: "ew-resize" },
  { dir: "NorthWest", style: { top: 0, left: 0, width: EDGE, height: EDGE }, cursor: "nwse-resize" },
  { dir: "NorthEast", style: { top: 0, right: 0, width: EDGE, height: EDGE }, cursor: "nesw-resize" },
  { dir: "SouthWest", style: { bottom: 0, left: 0, width: EDGE, height: EDGE }, cursor: "nesw-resize" },
  { dir: "SouthEast", style: { bottom: 0, right: 0, width: EDGE, height: EDGE }, cursor: "nwse-resize" },
];

export default function ResizeHandles() {
  const startResize = useCallback(async (dir: Direction) => {
    if (!isTauri) return;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().startResizeDragging(dir);
    } catch { /* maximized or unsupported */ }
  }, []);

  if (!isTauri) return null;

  return (
    <>
      {edges.map((e) => (
        <div
          key={e.dir}
          onMouseDown={() => startResize(e.dir)}
          style={{ position: "fixed", zIndex: 9999, cursor: e.cursor, ...e.style }}
        />
      ))}
    </>
  );
}
