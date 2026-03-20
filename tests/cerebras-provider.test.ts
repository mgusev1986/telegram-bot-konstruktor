import { describe, expect, it, vi, afterEach } from "vitest";

import { CerebrasTranslationProvider } from "../src/modules/ai/providers/cerebras-translation.provider";

describe("CerebrasTranslationProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    global.fetch = undefined;
  });

  it("maps request and parses Cerebras chat response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "translated-cerebras" } }]
      })
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const provider = new CerebrasTranslationProvider({
      apiKey: "test-key",
      model: "llama3.1-8b"
    });

    const out = await provider.translateText({
      text: "Hello world",
      sourceLanguageCode: "en",
      targetLanguageCode: "ru"
    });

    expect(out).toBe("translated-cerebras");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("api.cerebras.ai");
    expect(url).toContain("/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    expect(String(init.body)).toContain("Hello world");
  });

  it("throws on malformed Cerebras response (missing choices)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({})
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const provider = new CerebrasTranslationProvider({
      apiKey: "test-key",
      model: "llama3.1-8b"
    });

    await expect(
      provider.translateText({
        text: "prompt",
        sourceLanguageCode: "en",
        targetLanguageCode: "ru"
      })
    ).rejects.toThrow(/Cerebras response parsing failed/i);
  });

  it("throws on malformed Cerebras response (empty content)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "   " } }]
      })
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const provider = new CerebrasTranslationProvider({
      apiKey: "test-key",
      model: "llama3.1-8b"
    });

    await expect(
      provider.translateText({
        text: "prompt",
        sourceLanguageCode: "en",
        targetLanguageCode: "ru"
      })
    ).rejects.toThrow(/Cerebras response parsing failed/i);
  });
});
