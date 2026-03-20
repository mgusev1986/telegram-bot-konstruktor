import { beforeEach, describe, expect, it, vi } from "vitest";

describe("AI provider selection", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("selects ollama provider from env", async () => {
    vi.doMock("../src/config/env", () => ({
      env: {
        AI_TRANSLATION_PROVIDER: "ollama",
        AI_TRANSLATION_MODEL: "qwen2.5:14b",
        OLLAMA_BASE_URL: "http://localhost:11434",
        LOG_LEVEL: "info"
      }
    }));

    const { createAiTranslationProvider } = await import("../src/modules/ai/providers/provider-factory");
    const provider = createAiTranslationProvider();
    expect(provider.kind).toBe("ollama");
  });

  it("selects workers_ai provider from env", async () => {
    vi.doMock("../src/config/env", () => ({
      env: {
        AI_TRANSLATION_PROVIDER: "workers_ai",
        AI_TRANSLATION_MODEL: "ignored",
        OLLAMA_BASE_URL: "http://localhost:11434",
        LOG_LEVEL: "info",
        CLOUDFLARE_ACCOUNT_ID: "acc",
        CLOUDFLARE_AI_API_TOKEN: "token",
        CLOUDFLARE_AI_MODEL: "@cf/meta/llama-3.1-8b-instruct"
      }
    }));

    const { createAiTranslationProvider } = await import("../src/modules/ai/providers/provider-factory");
    const provider = createAiTranslationProvider();
    expect(provider.kind).toBe("workers_ai");
  });
});
