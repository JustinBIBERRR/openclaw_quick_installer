import { Check } from "lucide-react";

interface Props {
  steps: string[];
  current: number;
}

export default function StepBar({ steps, current }: Props) {
  return (
    <div className="w-full rounded-2xl border border-slate-800 bg-slate-900/70 px-4 py-3">
      <div className="flex items-center gap-0">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={i} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1.5 min-w-[72px]">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all
                  ${done ? "bg-brand-500 text-white shadow-[0_0_0_4px_rgba(34,197,94,0.08)]" : ""}
                  ${active ? "bg-brand-400 text-gray-950 ring-2 ring-brand-400/70 ring-offset-2 ring-offset-gray-950" : ""}
                  ${!done && !active ? "bg-slate-800 text-slate-500 border border-slate-700" : ""}
                `}
              >
                {done ? <Check size={14} strokeWidth={3} /> : i + 1}
              </div>
              <span
                className={`text-[11px] text-center leading-tight whitespace-nowrap
                  ${active ? "text-brand-300 font-semibold" : ""}
                  ${done ? "text-slate-300" : ""}
                  ${!done && !active ? "text-slate-600" : ""}
                `}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`flex-1 h-[2px] mb-4 mx-2 rounded-full transition-colors
                  ${done ? "bg-brand-500/80" : "bg-slate-800"}
                `}
              />
            )}
          </div>
        );
      })}
      </div>
    </div>
  );
}
