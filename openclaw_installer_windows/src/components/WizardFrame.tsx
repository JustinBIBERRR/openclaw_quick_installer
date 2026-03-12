import StepBar from "./StepBar";

interface Props {
  showSteps: boolean;
  steps: string[];
  current: number;
  children: React.ReactNode;
}

export default function WizardFrame({ showSteps, steps, current, children }: Props) {
  return (
    <div className="flex-1 overflow-hidden relative">
      <div className="fixed top-[-20%] left-[-10%] w-[50%] h-[50%] bg-accent-primary/10 blur-[140px] rounded-full pointer-events-none" />
      <div className="fixed bottom-[-20%] right-[-10%] w-[50%] h-[50%] bg-accent-success/8 blur-[140px] rounded-full pointer-events-none" />

      <div className="relative z-10 h-full max-w-6xl mx-auto px-6 pb-6 flex flex-col gap-3">
        {showSteps && (
          <div className="pt-4 pb-2">
            <StepBar steps={steps} current={current} />
          </div>
        )}
        <div className="flex-1 min-h-0 glass-surface radius-standard overflow-hidden shadow-[0_20px_60px_rgba(0,0,0,0.32),inset_0_1px_0_rgba(255,255,255,0.06)]">
          {children}
        </div>
      </div>
    </div>
  );
}
