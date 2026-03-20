import { logger } from "../../common/logger";
import { createAiTranslationProvider } from "./providers/provider-factory";
import type { AiTranslateTextInput, AiTranslationProvider, AiTranslationProviderKind } from "./providers/types";
import { buildTranslationPrompt } from "./translation-prompt";

type MaskResult = {
  maskedText: string;
  restore: (translatedText: string) => string;
  maskedTokens: string[];
};

const escapeForIncludes = (s: string): string => s; // readability alias

const maskWithRegex = (text: string, regex: RegExp, getToken: (idx: number) => string, tokens: string[], restoreMap: Map<string, string>): string => {
  let idx = tokens.length;
  return text.replace(regex, (match) => {
    const token = getToken(idx);
    idx += 1;
    tokens.push(token);
    restoreMap.set(token, match);
    return token;
  });
};

/**
 * Protects strings so the model cannot change placeholders, handles, URLs and HTML tags.
 * We mask them into opaque tokens, translate, then restore exact originals.
 */
export const maskLocalizableSafetyTokens = (input: string): MaskResult => {
  const tokens: string[] = [];
  const restoreMap = new Map<string, string>();
  const getToken = (idx: number) => `__TR_TOKEN_${idx}__`;

  // IMPORTANT: apply in an order where more specific patterns are masked first.
  let masked = input;

  // 1) HTML/Telegram tags: keep them byte-identical.
  // Examples: <b>...</b>, <i>...</i>, <a href="...">...</a>
  masked = maskWithRegex(masked, /<\/?[a-zA-Z][^>]*>/g, getToken, tokens, restoreMap);

  // 1.1) Telegram bold markers used by sendRichMessage: [b]...[/b]
  masked = maskWithRegex(masked, /\[\/?b\]/g, getToken, tokens, restoreMap);

  // 2) Telegram placeholders like {{first_name}} and {name}
  masked = maskWithRegex(masked, /\{\{[a-zA-Z0-9_]+\}\}/g, getToken, tokens, restoreMap);
  masked = maskWithRegex(masked, /\{[a-zA-Z0-9_]+\}/g, getToken, tokens, restoreMap);

  // 3) Handles
  masked = maskWithRegex(masked, /@[a-zA-Z0-9_]{3,}/g, getToken, tokens, restoreMap);

  // 4) URLs
  // - http(s) URLs
  // - t.me links without scheme
  masked = maskWithRegex(masked, /\bhttps?:\/\/[^\s]+/g, getToken, tokens, restoreMap);
  masked = maskWithRegex(masked, /\bt\.me\/[^\s]+/g, getToken, tokens, restoreMap);

  const restore = (translatedText: string): string => {
    let out = translatedText;
    for (const [token, original] of restoreMap.entries()) {
      out = out.split(token).join(original);
    }
    return out;
  };

  return {
    maskedText: masked,
    restore,
    maskedTokens: tokens
  };
};

export class AiTranslationService {
  public constructor(private readonly provider: AiTranslationProvider = createAiTranslationProvider()) {}

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static extractRetryDelayMs(errMessage: string): number | null {
    // Common snippets in Gemini error:
    // - "retryDelay": "45s"
    // - "retryDelay": "0s"
    // - "Please retry in 68.675055ms."

    const secondsMatch = errMessage.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
    if (secondsMatch) {
      const seconds = Number(secondsMatch[1]);
      if (!Number.isFinite(seconds)) return null;
      return Math.max(0, Math.round(seconds * 1000));
    }

    const msMatch = errMessage.match(/Please retry in\s*([0-9]+(?:\.[0-9]+)?)\s*ms/i);
    if (msMatch) {
      const ms = Number(msMatch[1]);
      if (!Number.isFinite(ms)) return null;
      return Math.max(0, Math.round(ms));
    }

    // Fallback: any "retryDelay": "<num>s" variant.
    const fallbackSeconds = errMessage.match(/retryDelay["']\s*:\s*"(\d+(?:\.\d+)?)\s*s"/i);
    if (fallbackSeconds) {
      const seconds = Number(fallbackSeconds[1]);
      if (!Number.isFinite(seconds)) return null;
      return Math.max(0, Math.round(seconds * 1000));
    }

    return null;
  }

  private static isQuotaOrRateLimit(errMessage: string): boolean {
    return /429\b/i.test(errMessage) || /RESOURCE_EXHAUSTED/i.test(errMessage) || /quota/i.test(errMessage);
  }

  private static buildPromptWithStrictness(input: AiTranslateTextInput, maskedText: string, strict: boolean): string {
    return buildTranslationPrompt(input, maskedText, strict);
  }

  private async translateMaskedWithFallback(input: AiTranslateTextInput, maskedText: string): Promise<string> {
    const tryTranslate = async (strict: boolean): Promise<string> => {
      const promptInput: AiTranslateTextInput = { ...input, text: maskedText };
      const prompt = AiTranslationService.buildPromptWithStrictness(promptInput, maskedText, strict);
      return this.provider.translateText({ ...promptInput, text: prompt });
    };

    const translateWithRetry = async (strict: boolean): Promise<string> => {
      const maxAttempts = 4;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          return await tryTranslate(strict);
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (!AiTranslationService.isQuotaOrRateLimit(msg) || attempt === maxAttempts - 1) {
            throw err;
          }
          const extractedDelayMs = AiTranslationService.extractRetryDelayMs(msg);
          const backoffDelayMs = 3000 * (attempt + 1);
          const retryDelayMs = Math.max(extractedDelayMs ?? backoffDelayMs, backoffDelayMs);
          logger.info(
            {
              attempt: attempt + 1,
              maxAttempts,
              provider: this.provider.kind,
              extractedDelayMs,
              retryDelayMs
            },
            "AI provider rate limit hit; waiting before retry"
          );
          await AiTranslationService.sleep(retryDelayMs);
        }
      }
      throw lastErr;
    };

    try {
      return await translateWithRetry(false);
    } catch {
      return translateWithRetry(true);
    }
  }

  public async translateText(input: AiTranslateTextInput): Promise<string> {
    const text = input.text ?? "";
    if (!text.trim()) return "";

    const { maskedText, restore, maskedTokens } = maskLocalizableSafetyTokens(text);
    const translatedMasked = await this.translateMaskedWithFallback(input, maskedText);
    const translatedTrimmed = translatedMasked.trim();
    for (const token of maskedTokens) {
      if (!escapeForIncludes(translatedTrimmed).includes(token)) {
        throw new Error(`Translation safety check failed: missing token ${token}`);
      }
    }
    return restore(translatedTrimmed);
  }

  public async translateBatch(inputs: AiTranslateTextInput[]): Promise<string[]> {
    if (inputs.length === 0) return [];

    type Prepared = {
      input: AiTranslateTextInput;
      maskedText: string;
      restore: (translatedText: string) => string;
      maskedTokens: string[];
      isEmpty: boolean;
    };

    const prepared: Prepared[] = inputs.map((input) => {
      const text = input.text ?? "";
      if (!text.trim()) {
        return {
          input,
          maskedText: "",
          restore: (translatedText: string) => translatedText,
          maskedTokens: [],
          isEmpty: true
        };
      }
      const { maskedText, restore, maskedTokens } = maskLocalizableSafetyTokens(text);
      return {
        input,
        maskedText,
        restore,
        maskedTokens,
        isEmpty: false
      };
    });

    const out: string[] = new Array(inputs.length).fill("");
    const nonEmptyIndices = prepared
      .map((p, idx) => ({ p, idx }))
      .filter((x) => !x.p.isEmpty)
      .map((x) => x.idx);

    const translateWithRetry = async (strict: boolean): Promise<string[]> => {
      const maxAttempts = 4;
      let lastErr: unknown = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          if (nonEmptyIndices.length === 0) return out;

          const providerInputs: AiTranslateTextInput[] = nonEmptyIndices.map((idx) => {
            const item = prepared[idx]!;
            const prompt = AiTranslationService.buildPromptWithStrictness(item.input, item.maskedText, strict);
            // Providers must receive prompt text in `text`.
            return { ...item.input, text: prompt };
          });

          const providerOutputs = await this.provider.translateBatch(providerInputs);
          if (providerOutputs.length !== providerInputs.length) {
            throw new Error(
              `Batch output count mismatch: expected ${providerInputs.length}, got ${providerOutputs.length}`
            );
          }

          for (let j = 0; j < nonEmptyIndices.length; j++) {
            const originalIdx = nonEmptyIndices[j]!;
            const translatedMasked = String(providerOutputs[j] ?? "").trim();
            const item = prepared[originalIdx]!;

            // Safety check: tokens must still be present.
            for (const token of item.maskedTokens) {
              if (!escapeForIncludes(translatedMasked).includes(token)) {
                throw new Error(`Translation safety check failed: missing token ${token}`);
              }
            }
            out[originalIdx] = item.restore(translatedMasked);
          }

          return out;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (!AiTranslationService.isQuotaOrRateLimit(msg) || attempt === maxAttempts - 1) {
            throw err;
          }

          const extractedDelayMs = AiTranslationService.extractRetryDelayMs(msg);
          const backoffDelayMs = 3000 * (attempt + 1);
          const retryDelayMs = Math.max(extractedDelayMs ?? backoffDelayMs, backoffDelayMs);
          logger.info(
            {
              attempt: attempt + 1,
              maxAttempts,
              provider: this.provider.kind,
              extractedDelayMs,
              retryDelayMs
            },
            "AI provider rate limit hit; waiting before retry (batch)"
          );
          await AiTranslationService.sleep(retryDelayMs);
        }
      }
      throw lastErr;
    };

    try {
      return await translateWithRetry(false);
    } catch {
      return await translateWithRetry(true);
    }
  }

  public async healthcheck(): Promise<void> {
    await this.provider.healthcheck();
  }

  public getFallbackUsage():
    | {
        fallbackUsedCount: number;
        primaryUsedCount: number;
      }
    | null {
    const p = this.provider as any;
    if (typeof p?.fallbackUsedCount === "number" && typeof p?.primaryUsedCount === "number") {
      return { fallbackUsedCount: p.fallbackUsedCount, primaryUsedCount: p.primaryUsedCount };
    }
    return null;
  }

  public getUsedProviderKind(): AiTranslationProviderKind | null {
    const p = this.provider as any;
    const lastUsed = p?.lastUsedProvider;
    if (typeof lastUsed === "string") return lastUsed as AiTranslationProviderKind;
    const kind = p?.kind;
    if (typeof kind === "string") return kind as AiTranslationProviderKind;
    return null;
  }
}

