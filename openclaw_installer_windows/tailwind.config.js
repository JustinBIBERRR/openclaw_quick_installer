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
  // C: 原型青色（从 Figma 原型提取）
  prototypeCyan: {
    50: "#e0ffff",
    100: "#b3ffff",
    200: "#80ffff",
    300: "#4dffff",
    400: "#1affff",
    500: "#00E5FF", // 主色
    600: "#00ccf2",
    700: "#00b3e6",
  },
};

const ACTIVE_BRAND_PRESET = "prototypeCyan";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: BRAND_PRESETS[ACTIVE_BRAND_PRESET],
        // 原型配色系统
        space: {
          black: "#060B14",
        },
        accent: {
          primary: "#00E5FF",
          success: "#39FF14",
        },
      },
      fontFamily: {
        mono: ["'JetBrains Mono'", "Consolas", "monospace"],
      },
      borderRadius: {
        'standard': '24px',
        'small': '12px',
      },
      backdropBlur: {
        'xl': '16px',
        'lg': '12px',
      },
      boxShadow: {
        'glow-primary': '0 0 20px rgba(0, 229, 255, 0.4)',
        'glow-success': '0 0 15px rgba(57, 255, 20, 0.5)',
      },
      animation: {
        'shimmer': 'shimmer 2s infinite',
        'log-line-in': 'log-line-in 0.35s ease-out forwards',
      },
      keyframes: {
        shimmer: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'log-line-in': {
          '0%': { opacity: '0', transform: 'translateY(6px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },
    },
  },
  plugins: [],
};
