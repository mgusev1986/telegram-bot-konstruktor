import { logger } from "../../../common/logger";
import type { AiTranslateTextInput, AiTranslationProvider, AiTranslationProviderKind } from "./types";

export interface FallbackTranslationProviderOptions {
  providers: AiTranslationProvider[];
  /** If true, log when fallback is used. */
  logFallback?: boolean;
}

/**
 * Wraps multiple providers and tries them in order. On failure, falls back to the next.
 * Reports which provider was actually used via onProviderUsed callback if provided.
 */
export class FallbackTranslationProvider implements AiTranslationProvider {
  public readonly kind: AiTranslationProvider["kind"];
  public readonly model: string;
  private readonly providers: AiTranslationProvider[];
  private readonly logFallback: boolean;
  public lastUsedProvider: AiTranslationProviderKind | null = null;
  public fallbackUsedCount = 0;
  public primaryUsedCount = 0;

  public constructor(options: FallbackTranslationProviderOptions) {
    if (options.providers.length === 0) {
      throw new Error("FallbackTranslationProvider requires at least one provider");
    }
    this.providers = options.providers;
    this.kind = this.providers[0]!.kind;
    this.model = this.providers.map((p) => `${p.kind}:${p.model}`).join("|");
    this.logFallback = options.logFallback ?? true;
  }

  public async translateText(input: AiTranslateTextInput): Promise<string> {
    let lastError: unknown = null;
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      try {
        const result = await provider.translateText(input);
        this.lastUsedProvider = provider.kind;
        if (i === 0) this.primaryUsedCount += 1;
        if (i > 0) this.fallbackUsedCount += 1;
        if (i > 0 && this.logFallback) {
          logger.info(
            { provider: provider.kind, attempted: this.providers.slice(0, i).map((p) => p.kind) },
            "Translation fallback: primary failed, secondary succeeded"
          );
        }
        return result;
      } catch (err) {
        lastError = err;
        logger.warn(
          { provider: provider.kind, error: err instanceof Error ? err.message : String(err) },
          "Translation provider failed, trying fallback"
        );
      }
    }
    throw lastError;
  }

  public async translateBatch(inputs: AiTranslateTextInput[]): Promise<string[]> {
    const out: string[] = [];
    for (const input of inputs) {
      out.push(await this.translateText(input));
    }
    return out;
  }

  public async healthcheck(): Promise<void> {
    let lastError: unknown = null;
    for (const provider of this.providers) {
      try {
        await provider.healthcheck();
        this.lastUsedProvider = provider.kind;
        return;
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }
}

