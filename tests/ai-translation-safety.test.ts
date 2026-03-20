import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { AiTranslationService, maskLocalizableSafetyTokens } from "../src/modules/ai/ai-translation.service";
import type { AiTranslateTextInput, AiTranslationProvider } from "../src/modules/ai/providers/types";

describe("AI translation safety: placeholders and formatting", () => {
  const original =
    "Привет, {name}! {{first_name}} {{last_name}}. Ссылка: https://example.com и @username. <b>Жирный</b>";

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // ensure fetch restored
    // @ts-expect-error test runtime cleanup
    global.fetch = undefined;
  });

  it("mask/restore keeps tokens byte-identical", () => {
    const { maskedText, restore } = maskLocalizableSafetyTokens(original);
    expect(maskedText).not.toContain("{name}");
    expect(maskedText).not.toContain("{{first_name}}");
    expect(maskedText).not.toContain("https://example.com");
    expect(maskedText).not.toContain("@username");
    expect(maskedText).not.toContain("<b>");

    const restored = restore(maskedText);
    expect(restored).toBe(original);
  });

  const createEchoProvider = (): AiTranslationProvider => ({
    kind: "ollama",
    model: "test-model",
    async translateText(input: AiTranslateTextInput): Promise<string> {
      const source = input.text.split("Source text:\n")[1] ?? "";
      return source.trim();
    },
    async translateBatch(inputs: AiTranslateTextInput[]): Promise<string[]> {
      return inputs.map((item) => {
        const source = item.text.split("Source text:\n")[1] ?? "";
        return source.trim();
      });
    },
    async healthcheck(): Promise<void> {}
  });

  it("translateText restores placeholders with mocked provider response", async () => {
    const safety = maskLocalizableSafetyTokens(original);
    const svc = new AiTranslationService(createEchoProvider());
    const out = await svc.translateText({
      text: original,
      sourceLanguageCode: "ru",
      targetLanguageCode: "en"
    });

    expect(out).toBe(original);
    expect(safety.maskedText).not.toBe(original);
  });

  it("translateText returns empty string for empty input", async () => {
    const svc = new AiTranslationService(createEchoProvider());
    const out = await svc.translateText({
      text: "   ",
      sourceLanguageCode: "ru",
      targetLanguageCode: "en"
    });
    expect(out).toBe("");
  });

  it("throws when provider drops placeholders", async () => {
    const badProvider: AiTranslationProvider = {
      kind: "workers_ai",
      model: "bad-model",
      async translateText(): Promise<string> {
        return "broken";
      },
      async translateBatch(inputs: AiTranslateTextInput[]): Promise<string[]> {
        return Array.from({ length: inputs.length }, () => "broken");
      },
      async healthcheck(): Promise<void> {}
    };

    const svc = new AiTranslationService(badProvider);
    await expect(
      svc.translateText({
        text: original,
        sourceLanguageCode: "ru",
        targetLanguageCode: "en"
      })
    ).rejects.toThrow("Translation safety check failed");
  });
});

