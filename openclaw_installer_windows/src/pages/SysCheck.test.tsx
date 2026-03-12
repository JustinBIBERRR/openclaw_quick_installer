import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import SysCheck from "./SysCheck";
import { I18nProvider } from "../i18n/useI18n";
import { LOCALE_STORAGE_KEY } from "../i18n/messages";

describe("SysCheck preview mode", () => {
  it("passes checks and continues with fallback install dir", async () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh");
    const onDone = vi.fn();
    render(
      <I18nProvider>
        <SysCheck envEstimate={null} onDone={onDone} />
      </I18nProvider>
    );

    await waitFor(() => {
      expect(screen.getByText(/所有检测通过/)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole("button", { name: "开始安装 →" }));
    expect(onDone).toHaveBeenCalledWith("C:\\OpenClaw");
  });
});
