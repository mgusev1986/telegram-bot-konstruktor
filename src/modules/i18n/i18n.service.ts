import { applyPersonalization, type PersonalizationProfile } from "../../common/personalization";
import { env } from "../../config/env";
import { dictionaries, type DictionaryKey, type SupportedDictionaryLanguage } from "./static-dictionaries";

type MaybeLanguage = string | null | undefined;

export class I18nService {
  public readonly defaultLanguage: SupportedDictionaryLanguage;

  public constructor(defaultLanguage: SupportedDictionaryLanguage = env.DEFAULT_LANGUAGE as SupportedDictionaryLanguage) {
    this.defaultLanguage = defaultLanguage in dictionaries ? defaultLanguage : "ru";
  }

  /**
   * Resolves a language code (e.g. from Telegram's User.language_code: "en", "en-US", "zh-hans")
   * to a supported bot language. If the code is supported — returns it; otherwise returns default (e.g. "ru").
   */
  public resolveLanguage(language: MaybeLanguage): SupportedDictionaryLanguage {
    if (!language) {
      return this.defaultLanguage;
    }

    const normalized = language.toLowerCase().trim();

    if (normalized in dictionaries) {
      return normalized as SupportedDictionaryLanguage;
    }

    // Try primary part for IETF tags like "en-US", "zh-hans"
    const primary = normalized.split("-")[0];
    if (primary && primary in dictionaries) {
      return primary as SupportedDictionaryLanguage;
    }

    return this.defaultLanguage;
  }

  /**
   * Language code for DB-backed localizations (menus/pages/welcome).
   * Unlike {@link resolveLanguage}, this does NOT collapse unknown codes to `ru`,
   * because content translations may exist for arbitrary languageCode values.
   */
  public normalizeLocalizationLanguageCode(language: MaybeLanguage): string {
    if (!language) return this.defaultLanguage;
    return language.toLowerCase();
  }

  public t(
    language: MaybeLanguage,
    key: DictionaryKey,
    params?: PersonalizationProfile
  ): string {
    const resolvedLanguage = this.resolveLanguage(language);
    // Static dictionaries may temporarily diverge by key set between languages.
    // Keep runtime fallback behavior while avoiding over-constraining types here.
    const dict = dictionaries as unknown as Record<SupportedDictionaryLanguage, Record<DictionaryKey, string>>;
    const template = dict[resolvedLanguage]?.[key] ?? dict[this.defaultLanguage]?.[key] ?? key;

    return params ? applyPersonalization(template, params) : template;
  }

  public availableLanguages(): Array<{ code: SupportedDictionaryLanguage; label: string }> {
    // UI language labels are available for a small set.
    // Content localizations can still be created for arbitrary languageCodes in DB.
    const allowed: SupportedDictionaryLanguage[] = ["ru", "en", "es", "de", "fr", "it", "pt", "pl", "uk", "tr", "ar", "ja"];
    return allowed
      .filter((code) => code in dictionaries)
      .map((code) => ({
        code,
        label: dictionaries[code].language_name
      }));
  }

  public pickLocalized<T extends { languageCode: string }>(items: T[], language: MaybeLanguage): T | null {
    // IMPORTANT: do not collapse unknown languageCode to `defaultLanguage` here.
    // Content localizations should be looked up by exact languageCode.
    const normalized = this.normalizeLocalizationLanguageCode(language);
    return items.find((item) => item.languageCode === normalized) ?? items.find((item) => item.languageCode === this.defaultLanguage) ?? items[0] ?? null;
  }
}
