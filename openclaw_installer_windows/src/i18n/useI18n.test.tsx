import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import Welcome from "../pages/Welcome";
import { LOCALE_STORAGE_KEY } from "./messages";
import { I18nProvider } from "./useI18n";
import LanguageSwitch from "../components/LanguageSwitch";

describe("i18n language persistence", () => {
  it("uses english by default when no stored locale", () => {
    localStorage.clear();

    render(
      <I18nProvider>
        <Welcome onNext={() => undefined} />
      </I18nProvider>
    );

    expect(screen.getByRole("button", { name: "Start Installation" })).toBeInTheDocument();
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
  });

  it("switches to english and persists locale", async () => {
    localStorage.clear();
    localStorage.setItem(LOCALE_STORAGE_KEY, "zh");

    render(
      <I18nProvider>
        <LanguageSwitch />
        <Welcome onNext={() => undefined} />
      </I18nProvider>
    );

    expect(screen.getByRole("button", { name: /开始安装/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "English" }));

    expect(screen.getByRole("button", { name: "Start Installation" })).toBeInTheDocument();
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
  });
});
