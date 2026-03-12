import { ChevronRight } from "lucide-react";
import { useI18n } from "../i18n/useI18n";

interface Props {
  onNext: () => void;
  onCleanup?: () => void;
  cleanupBusy?: boolean;
}

// Minimalist Claw Logo component
const ClawLogo = ({ className = "w-24 h-24" }) => (
  <svg 
    viewBox="0 0 100 100" 
    className={`${className} accent-primary drop-shadow-[0_0_12px_rgba(0,229,255,0.6)]`}
    fill="none" 
    stroke="currentColor" 
    strokeWidth="3" 
    strokeLinecap="round" 
    strokeLinejoin="round"
  >
    {/* Center Body */}
    <path d="M50 85 L35 55 C35 30 65 30 65 55 Z" />
    <circle cx="43" cy="50" r="2" fill="currentColor" />
    <circle cx="57" cy="50" r="2" fill="currentColor" />
    {/* Left Claw */}
    <path d="M32 50 C20 45 15 30 20 20 C25 15 35 25 35 35 Z" />
    <path d="M20 20 L28 10 M35 35 L40 28" opacity="0.5"/>
    {/* Right Claw */}
    <path d="M68 50 C80 45 85 30 80 20 C75 15 65 25 65 35 Z" />
    <path d="M80 20 L72 10 M65 35 L60 28" opacity="0.5"/>
  </svg>
);

export default function Welcome({ onNext, onCleanup = () => {}, cleanupBusy = false }: Props) {
  const { t } = useI18n();

  return (
    <div className="h-full flex flex-col items-center justify-center py-8 sm:py-14 px-4 sm:px-6">
      {/* Logo with glow effect */}
      <div className="relative mb-6 sm:mb-9">
        <div className="absolute inset-0 bg-accent-primary/25 blur-[48px] sm:blur-[64px] rounded-full" />
        <ClawLogo className="w-24 h-24 sm:w-32 sm:h-32 relative z-10" />
      </div>
      
      {/* Main heading */}
      <h1 className="text-3xl sm:text-[2.55rem] font-bold mb-3 sm:mb-4 tracking-[-0.02em] text-heading text-center">
        {t("welcome.title")}
      </h1>
      
      {/* Subtitle */}
      <p className="text-base sm:text-[1.02rem] mb-6 sm:mb-10 text-muted text-center max-w-[32rem] sm:max-w-[34rem] leading-relaxed px-2">
        {t("welcome.subtitle")}
      </p>

      {/* Features preview */}
      <div className="glass-surface radius-standard p-4 sm:p-6 mb-6 sm:mb-9 max-w-xl w-full">
        <div className="space-y-2 sm:space-y-3 text-sm">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full accent-primary-bg flex-shrink-0"></div>
            <span className="text-sm sm:text-base">{t("welcome.feature1")}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full accent-primary-bg flex-shrink-0"></div>
            <span className="text-sm sm:text-base">{t("welcome.feature2")}</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full accent-primary-bg flex-shrink-0"></div>
            <span className="text-sm sm:text-base">{t("welcome.feature3")}</span>
          </div>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row items-center justify-center gap-3 w-full max-w-2xl px-4">
        {/* Main CTA button - 主按钮(大) */}
        <button
          onClick={onNext}
          className="group relative flex items-center justify-center gap-2 sm:gap-3 px-8 sm:px-10 py-3.5 sm:py-4 radius-standard accent-primary-bg text-black font-semibold overflow-hidden accent-primary-glow transition-all duration-300 hover:scale-[1.03] w-full sm:flex-1 sm:min-w-0"
        >
          <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-out" />
          <span className="relative z-10 text-base sm:text-lg whitespace-nowrap  text-black">{t("welcome.cta")}</span>
          <ChevronRight size={18} className="relative z-10 group-hover:translate-x-1 transition-transform" />
        </button>
        
        {/* Cleanup button - 清理按钮(小) */}
        <button
          onClick={onCleanup}
          disabled={cleanupBusy}
          className="px-4 sm:px-5 py-2.5 sm:py-3 text-xs sm:text-sm rounded-lg border border-red-400/40 text-red-200 hover:bg-red-400/10 disabled:opacity-60 disabled:cursor-not-allowed transition-colors whitespace-nowrap w-full sm:w-auto"
        >
          {cleanupBusy ? t("welcome.cleanupRunning") : t("welcome.cleanup")}
        </button>
      </div>
    </div>
  );
}