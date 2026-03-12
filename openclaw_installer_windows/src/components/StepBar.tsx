import { Check } from "lucide-react";

interface Props {
  steps: string[];
  current: number;
}

export default function StepBar({ steps, current }: Props) {
  const clampedCurrent = Math.max(0, Math.min(current, steps.length - 1));
  const progressRatio = steps.length > 1 ? clampedCurrent / (steps.length - 1) : 0;

  return (
    <div className="w-full glass-surface radius-standard px-7 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
      <div className="flex items-center justify-between relative">
        {/* 背景连接线 */}
        <div className="absolute top-4 left-7 right-7 h-[2px] bg-white/10" />
        {/* 进度连接线 */}
        <div
          className="absolute top-4 left-7 h-[2px] bg-accent-primary transition-all duration-500 shadow-[0_0_8px_rgba(0,229,255,0.55)]"
          style={{ width: `calc((100% - 56px) * ${progressRatio})` }}
        />
        
        {steps.map((label, i) => {
          const done = i < clampedCurrent;
          const active = i === clampedCurrent;
          return (
            <div key={i} className="flex flex-col items-center gap-2 relative z-10">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all duration-300
                  ${done ? "accent-primary-bg text-black accent-primary-glow" : ""}
                  ${active ? "bg-accent-primary/20 border-2 border-accent-primary accent-primary text-accent-primary" : ""}
                  ${!done && !active ? "bg-white/5 border border-white/20 text-white/40" : ""}
                `}
              >
                {done ? <Check size={14} strokeWidth={3} /> : i + 1}
              </div>
              <span
                className={`text-[11px] text-center leading-tight whitespace-nowrap transition-colors
                  ${active ? "accent-primary font-semibold" : ""}
                  ${done ? "text-white/80" : ""}
                  ${!done && !active ? "text-muted" : ""}
                `}
              >
                {label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
