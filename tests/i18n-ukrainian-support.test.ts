import { describe, expect, it } from "vitest";
import { I18nService } from "../src/modules/i18n/i18n.service";
import { buildCreateBotForm } from "../src/http/backoffice/register-backoffice";

describe("Ukrainian (uk) language support", () => {
  const i18n = new I18nService("ru");

  it("uk is present in availableLanguages", () => {
    const langs = i18n.availableLanguages();
    const uk = langs.find((l) => l.code === "uk");
    expect(uk).toBeDefined();
    expect(uk!.label).toBe("Українська");
  });

  it("resolveLanguage returns uk for uk input", () => {
    expect(i18n.resolveLanguage("uk")).toBe("uk");
  });

  it("t() falls back to default when uk dictionary has no key", () => {
    // uk only has language_name; other keys fall back to ru
    const result = i18n.t("uk", "main_menu");
    expect(result).toBe("Главное меню"); // from ru fallback
  });

  it("buildCreateBotForm with languageOptions including uk renders Ukrainian option", () => {
    const html = buildCreateBotForm({
      languageOptions: [
        { code: "ru", label: "Русский" },
        { code: "en", label: "English" },
        { code: "uk", label: "Українська" }
      ]
    });
    expect(html).toContain('value="uk"');
    expect(html).toContain("Українська");
  });

  it("buildCreateBotForm with formValues baseLanguageCode uk selects Ukrainian", () => {
    const html = buildCreateBotForm({
      formValues: { baseLanguageCode: "uk" },
      languageOptions: [
        { code: "ru", label: "Русский" },
        { code: "uk", label: "Українська" }
      ]
    });
    expect(html).toContain('value="uk" selected');
  });
});
