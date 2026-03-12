import { Languages } from "lucide-react";
import { useI18n } from "../i18n/useI18n";

export default function LanguageSwitch() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="flex items-center gap-2 px-2 py-1 rounded-xl bg-white/[0.04] border border-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
      <Languages size={14} className="text-white/60" />
      <button
        onClick={() => setLocale("zh")}
        className={`text-xs px-2.5 py-1 rounded-lg transition-all duration-200 ${
          locale === "zh"
            ? "bg-accent-primary text-black font-semibold shadow-[0_0_10px_rgba(0,229,255,0.45)]"
            : "text-white/70 hover:text-white hover:bg-white/5"
        }`}
        title={t("common.zh")}
      >
        {t("common.zh")}
      </button>
      <button
        onClick={() => setLocale("en")}
        className={`text-xs px-2.5 py-1 rounded-lg transition-all duration-200 ${
          locale === "en"
            ? "bg-accent-primary text-black font-semibold shadow-[0_0_10px_rgba(0,229,255,0.45)]"
            : "text-white/70 hover:text-white hover:bg-white/5"
        }`}
        title={t("common.en")}
      >
        English
      </button>
    </div>
  );
}
