import { Check } from "lucide-react";

interface Props {
  steps: string[];
  current: number;
}

export default function StepBar({ steps, current }: Props) {
  return (
    <div className="flex items-center gap-0">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={i} className="flex items-center flex-1 last:flex-none">
            <div className="flex flex-col items-center gap-1 min-w-[60px]">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all
                  ${done ? "bg-brand-500 text-white" : ""}
                  ${active ? "bg-brand-400 text-gray-950 ring-2 ring-brand-400 ring-offset-2 ring-offset-gray-950" : ""}
                  ${!done && !active ? "bg-gray-800 text-gray-500" : ""}
                `}
              >
                {done ? <Check size={14} strokeWidth={3} /> : i + 1}
              </div>
              <span
                className={`text-[10px] text-center leading-tight whitespace-nowrap
                  ${active ? "text-brand-400 font-medium" : ""}
                  ${done ? "text-gray-400" : ""}
                  ${!done && !active ? "text-gray-600" : ""}
                `}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`flex-1 h-0.5 mb-4 mx-1 transition-colors
                  ${done ? "bg-brand-500" : "bg-gray-800"}
                `}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
