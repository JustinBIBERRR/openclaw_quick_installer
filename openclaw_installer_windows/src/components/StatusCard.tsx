interface Props {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  tone?: "default" | "ok" | "warn" | "error";
  trailing?: React.ReactNode;
}

const toneClass: Record<NonNullable<Props["tone"]>, string> = {
  default: "border-white/12 bg-white/[0.025]",
  ok: "border-emerald-400/35 bg-emerald-500/12",
  warn: "border-yellow-400/35 bg-yellow-500/12",
  error: "border-red-400/35 bg-red-500/12",
};

export default function StatusCard({ title, description, icon, tone = "default", trailing }: Props) {
  return (
    <div className={`rounded-2xl border p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] ${toneClass[tone]}`}>
      <div className="flex items-start gap-3">
        {icon && <div className="mt-0.5 opacity-90">{icon}</div>}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-heading tracking-[0.01em]">{title}</p>
          {description && <p className="text-xs text-muted mt-1.5 leading-relaxed">{description}</p>}
        </div>
        {trailing && <div>{trailing}</div>}
      </div>
    </div>
  );
}
