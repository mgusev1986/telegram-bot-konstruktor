import { describe, expect, it, vi } from "vitest";

import { FallbackTranslationProvider } from "../src/modules/ai/providers/fallback-translation.provider";

describe("Translation provider auto policy", () => {
  it("auto returns ollama->cerebras fallback when CEREBRAS_API_KEY is set", async () => {
    vi.resetModules();
    vi.doMock("../src/config/env", () => ({
      env: {
        TRANSLATION_PROVIDER: "auto",
        OLLAMA_BASE_URL: "http://localhost:11434",
        OLLAMA_MODEL: "qwen2.5:14b",
        CEREBRAS_API_KEY: "sk-test-key",
        CEREBRAS_MODEL: "llama3.1-8b",
        CEREBRAS_BASE_URL: "https://api.cerebras.ai/v1",
        LOG_LEVEL: "info"
      }
    }));

    const { createAiTranslationProvider } = await import("../src/modules/ai/providers/provider-factory");
    const provider = createAiTranslationProvider("auto");
    expect(provider.kind).toBe("ollama");
    // Avoid `instanceof` because `vi.resetModules()` can create multiple module instances.
    const p = provider as any;
    expect(typeof p?.fallbackUsedCount).toBe("number");
    expect(typeof p?.primaryUsedCount).toBe("number");
    expect(p?.lastUsedProvider === null || p?.lastUsedProvider === undefined).toBe(true);
  });

  it("auto returns ollama only when CEREBRAS_API_KEY is missing", async () => {
    vi.resetModules();
    vi.doMock("../src/config/env", () => ({
      env: {
        TRANSLATION_PROVIDER: "auto",
        OLLAMA_BASE_URL: "http://localhost:11434",
        OLLAMA_MODEL: "qwen2.5:14b",
        CEREBRAS_API_KEY: "",
        CEREBRAS_MODEL: "llama3.1-8b",
        CEREBRAS_BASE_URL: "https://api.cerebras.ai/v1",
        LOG_LEVEL: "info"
      }
    }));

    const { createAiTranslationProvider } = await import("../src/modules/ai/providers/provider-factory");
    const provider = createAiTranslationProvider("auto");
    expect(provider.kind).toBe("ollama");
    const p = provider as any;
    // In ollama-only mode there must be no fallback counters.
    expect(p?.fallbackUsedCount).toBeUndefined();
  });

  it("cerebras override returns Cerebras provider only", async () => {
    vi.resetModules();
    vi.doMock("../src/config/env", () => ({
      env: {
        TRANSLATION_PROVIDER: "cerebras",
        CEREBRAS_API_KEY: "sk-test-key",
        CEREBRAS_MODEL: "llama3.1-8b",
        CEREBRAS_BASE_URL: "https://api.cerebras.ai/v1",
        LOG_LEVEL: "info"
      }
    }));

    const { createAiTranslationProvider } = await import("../src/modules/ai/providers/provider-factory");
    const provider = createAiTranslationProvider("cerebras");
    expect(provider.kind).toBe("cerebras");
    const p = provider as any;
    expect(p?.fallbackUsedCount).toBeUndefined();
  });
});

