import type { CliCapabilities, OnboardingSummary } from "../types";
import UnifiedConfigPanel from "../components/UnifiedConfigPanel";

interface Props {
  cliCaps: CliCapabilities | null;
  onDone: (summary: OnboardingSummary | null) => void;
}

export default function OnboardingSetup({ cliCaps, onDone }: Props) {
  return (
    <div className="h-full flex flex-col px-6 py-4 overflow-hidden">
      <UnifiedConfigPanel
        cliCaps={cliCaps}
        mode="wizard"
        onDone={onDone}
      />
    </div>
  );
}
