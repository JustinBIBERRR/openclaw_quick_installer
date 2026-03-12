import { motion } from "framer-motion";
import { Bot, ExternalLink, Zap } from "lucide-react";
import type { InstallationSummary } from "../types";
import { useI18n } from "../i18n/useI18n";

interface Props {
  installationSummary: InstallationSummary | null;
  onOpenManager: () => void;
  onOpenChat?: () => void;
}

export default function Success({ installationSummary, onOpenManager, onOpenChat }: Props) {
  const { t } = useI18n();

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className="h-full flex flex-col items-center justify-center py-8 sm:py-14 px-4 sm:px-6 overflow-y-auto"
    >
      {/* Success pulse + green robot avatar (design: Figma / peace-sound-15737115.figma.site) */}
      <div className="relative mb-6 sm:mb-9 group flex-shrink-0">
        {/* Success pulse background */}
        <motion.div
          animate={{ scale: [1, 1.2, 1], opacity: [0.5, 0.2, 0.5] }}
          transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
          className="absolute inset-0 bg-[#39FF14] blur-[60px] sm:blur-[80px] rounded-full mix-blend-screen opacity-50"
        />
        {/* Celebratory avatar: glass circle + Bot icon + scanning line */}
        <div className="w-24 h-24 sm:w-32 sm:h-32 rounded-full glass-surface flex items-center justify-center relative z-10 border-[#39FF14]/30 overflow-hidden">
          <Bot size={48} className="sm:w-16 sm:h-16 text-[#39FF14]" strokeWidth={1.5} />
          <motion.div
            animate={{ y: ["-100%", "200%"] }}
            transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
            className="absolute left-0 right-0 h-1 bg-[#39FF14]/50 shadow-[0_0_10px_#39FF14]"
          />
        </div>
      </div>

      {/* Success heading */}
      <motion.h1
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="text-3xl sm:text-4xl font-bold mb-3 sm:mb-4 tracking-tight text-white text-center"
      >
        {t("success.title")}
      </motion.h1>

      {/* Success message */}
      <motion.p
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="text-base sm:text-lg mb-6 sm:mb-8 text-[#39FF14]/80 text-center"
      >
        {t("success.subtitle")}
      </motion.p>

      {/* Installation summary */}
      {installationSummary && (
        <div className="glass-surface radius-standard p-4 sm:p-6 mb-6 sm:mb-8 max-w-xl w-full">
          <h3 className="text-base sm:text-lg font-semibold text-heading mb-3 sm:mb-4">{t("success.summary")}</h3>
          <div className="space-y-2 sm:space-y-3 text-xs sm:text-sm">
            <div className="flex justify-between items-center gap-3">
              <span className="text-muted flex-shrink-0">{t("success.installDir")}</span>
              <span className="text-sm sm:text-base font-mono text-right truncate max-w-[150px] sm:max-w-[200px]" title={installationSummary.installDir}>
                {installationSummary.installDir}
              </span>
            </div>
            <div className="flex justify-between items-center gap-3">
              <span className="text-muted flex-shrink-0">{t("success.gatewayUrl")}</span>
              <span className="text-sm sm:text-base font-mono">localhost:{installationSummary.gatewayPort}</span>
            </div>
            <div className="flex justify-between items-center gap-3">
              <span className="text-muted flex-shrink-0">{t("success.apiStatus")}</span>
              <span className={`font-medium ${installationSummary.apiConfigured ? "accent-success" : "text-yellow-400"}`}>
                {installationSummary.apiConfigured ? t("success.configured") : t("success.needConfig")}
              </span>
            </div>
            {installationSummary.apiConfigured && installationSummary.apiProvider && (
              <div className="flex justify-between items-center gap-3">
                <span className="text-muted flex-shrink-0">{t("success.provider")}</span>
                <span className="text-sm sm:text-base capitalize">{installationSummary.apiProvider}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 w-full max-w-lg">
        {onOpenChat && (
          <button
            onClick={onOpenChat}
            className="flex-1 h-10 sm:h-11 flex items-center justify-center gap-2 px-5 sm:px-6 text-xs sm:text-sm radius-small border border-white/10 text-white/70 hover:text-white hover:bg-white/5 transition-colors font-medium"
          >
            <ExternalLink size={16} className="sm:w-[18px] sm:h-[18px]" />
            {t("success.openChat")}
          </button>
        )}
        
        <button
          onClick={onOpenManager}
          className="flex-1 h-10 sm:h-11 flex items-center justify-center gap-2 px-6 sm:px-8 text-xs sm:text-sm radius-small bg-white text-black font-semibold hover:bg-gray-200 transition-colors shadow-[0_0_20px_rgba(255,255,255,0.3)]"
        >
          <Zap size={16} className="text-black sm:w-[18px] sm:h-[18px]" />
          {t("success.openManager")}
        </button>
      </div>

      {/* Next steps hint */}
      <div className="mt-5 sm:mt-7 text-center">
        <p className="text-[0.7rem] sm:text-xs text-muted mb-1.5 sm:mb-2">{t("success.nextSteps")}</p>
        <div className="text-xs sm:text-sm text-base space-y-0.5 sm:space-y-1">
          {!installationSummary?.apiConfigured && (
            <p>{t("success.stepConfigApi")}</p>
          )}
          <p>{t("success.stepOpenChat")}</p>
          <p>{t("success.stepReadDocs")}</p>
        </div>
      </div>
    </motion.div>
  );
}