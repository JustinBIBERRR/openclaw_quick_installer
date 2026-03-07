/** @type {import('tailwindcss').Config} */
const BRAND_PRESETS = {
  // A: 冷静科技蓝（对比柔和，适合长时间使用）
  coolBlue: {
    50: "#eff6ff",
    100: "#dbeafe",
    200: "#bfdbfe",
    300: "#93c5fd",
    400: "#60a5fa",
    500: "#3b82f6",
    600: "#2563eb",
    700: "#1d4ed8",
  },
  // B: 亮感清爽蓝（按钮更醒目，氛围更轻快）
  brightBlue: {
    50: "#eef2ff",
    100: "#e0e7ff",
    200: "#c7d2fe",
    300: "#a5b4fc",
    400: "#818cf8",
    500: "#6366f1",
    600: "#4f46e5",
    700: "#4338ca",
  },
};

const ACTIVE_BRAND_PRESET = "brightBlue";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: BRAND_PRESETS[ACTIVE_BRAND_PRESET],
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
