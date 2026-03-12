import { useEffect, useRef } from "react";
import type { LogEntry } from "../types";
import { useI18n } from "../i18n/useI18n";

interface Props {
  logs: LogEntry[];
  maxHeight?: string;
}

const levelColor: Record<LogEntry["level"], string> = {
  info: "text-gray-300",
  ok:   "text-brand-400",
  warn: "text-yellow-400",
  error: "text-red-400",
  dim:  "text-gray-500",
};

const levelPrefix: Record<LogEntry["level"], string> = {
  info:  "  ",
  ok:    "✓ ",
  warn:  "! ",
  error: "✗ ",
  dim:   "  ",
};

export default function LogScroller({ logs, maxHeight = "h-48" }: Props) {
  const { t } = useI18n();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  return (
    <div
      className={`${maxHeight} overflow-y-auto p-0.5 font-mono text-xs sm:text-sm`}
    >
      {logs.length === 0 ? (
        <span className="text-gray-600">{t("common.waitingOutput")}</span>
      ) : (
        logs.map((log) => (
          <div
            key={log.id}
            className={`leading-5 break-words animate-log-line-in ${levelColor[log.level]}`}
          >
            <span className="text-gray-600">{levelPrefix[log.level]}</span>
            {log.message}
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}
