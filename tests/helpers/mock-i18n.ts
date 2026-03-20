import type { I18nService } from "../../src/modules/i18n/i18n.service";

/** Minimal I18n mock for tests: returns key as translation, supports pickLocalized and availableLanguages. */
export function createMockI18n(): I18nService {
  return {
    defaultLanguage: "ru",
    resolveLanguage: (lang: string | null | undefined) => (lang && lang.length >= 2 ? lang : "ru"),
    t: (_lang: string | null | undefined, key: string) => key,
    availableLanguages: () => [
      { code: "ru" as const, label: "Русский" },
      { code: "en" as const, label: "English" },
    ],
    pickLocalized: <T extends { languageCode: string }>(items: T[], lang: string | null | undefined) =>
      items.find((i) => i.languageCode === (lang ?? "ru")) ?? items[0] ?? null,
  } as unknown as I18nService;
}
