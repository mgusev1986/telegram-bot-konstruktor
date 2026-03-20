import { describe, expect, it, vi } from "vitest";

import { FallbackTranslationProvider } from "../src/modules/ai/providers/fallback-translation.provider";
import type { AiTranslationProvider, AiTranslateTextInput } from "../src/modules/ai/providers/types";

describe("FallbackTranslationProvider", () => {
  it("uses primary provider when it succeeds", async () => {
    const primary: AiTranslationProvider = {
      kind: "workers_ai",
      model: "cf-model",
      async translateText() {
        return "from-primary";
      },
      async translateBatch(inputs: AiTranslateTextInput[]) {
        return inputs.map(() => "from-primary");
      },
      async healthcheck() {}
    };
    const fallback = new FallbackTranslationProvider({ providers: [primary], logFallback: false });
    const out = await fallback.translateText({
      text: "hi",
      sourceLanguageCode: "en",
      targetLanguageCode: "ru"
    });
    expect(out).toBe("from-primary");
    expect(fallback.lastUsedProvider).toBe("workers_ai");
  });

  it("falls back to secondary when primary fails", async () => {
    const primary: AiTranslationProvider = {
      kind: "workers_ai",
      model: "cf-model",
      async translateText() {
        throw new Error("Primary failed");
      },
      async translateBatch() {
        throw new Error("Primary failed");
      },
      async healthcheck() {}
    };
    const secondary: AiTranslationProvider = {
      kind: "cerebras",
      model: "cerebras-model",
      async translateText() {
        return "from-secondary";
      },
      async translateBatch(inputs: AiTranslateTextInput[]) {
        return inputs.map(() => "from-secondary");
      },
      async healthcheck() {}
    };
    const provider = new FallbackTranslationProvider({
      providers: [primary, secondary],
      logFallback: false
    });
    const out = await provider.translateText({
      text: "hi",
      sourceLanguageCode: "en",
      targetLanguageCode: "ru"
    });
    expect(out).toBe("from-secondary");
    expect(provider.lastUsedProvider).toBe("cerebras");
  });

  it("throws when all providers fail", async () => {
    const failProvider: AiTranslationProvider = {
      kind: "ollama",
      model: "ollama",
      async translateText() {
        throw new Error("Ollama unreachable");
      },
      async translateBatch() {
        throw new Error("Ollama unreachable");
      },
      async healthcheck() {
        throw new Error("Ollama unreachable");
      }
    };
    const provider = new FallbackTranslationProvider({ providers: [failProvider], logFallback: false });
    await expect(
      provider.translateText({ text: "hi", sourceLanguageCode: "en", targetLanguageCode: "ru" })
    ).rejects.toThrow("Ollama unreachable");
  });
});
