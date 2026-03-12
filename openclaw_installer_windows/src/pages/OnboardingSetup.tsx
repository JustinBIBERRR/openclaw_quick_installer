import type { CliCapabilities, OnboardingSummary } from "../types";
import UnifiedConfigPanel from "../components/UnifiedConfigPanel";
import { useI18n } from "../i18n/useI18n";

interface Props {
  cliCaps: CliCapabilities | null;
  cliCapsLoading: boolean;
  onDone: (summary: OnboardingSummary | null) => void;
}

export default function OnboardingSetup({ cliCaps, cliCapsLoading, onDone }: Props) {
  const { t } = useI18n();

  return (
    <div className="h-full flex flex-col px-6 py-6 overflow-hidden gap-4">
      <div className="flex-shrink-0">
        <h2 className="text-2xl font-semibold text-heading tracking-[-0.01em]">{t("step.onboarding")}</h2>
        <p className="text-sm text-muted mt-1.5 leading-relaxed">{t("onboarding.subtitle")}</p>
      </div>
      <div className="flex-1 min-h-0">
        <UnifiedConfigPanel
          cliCaps={cliCaps}
          cliCapsLoading={cliCapsLoading}
          mode="wizard"
          onDone={onDone}
        />
      </div>
    </div>
  );
}
