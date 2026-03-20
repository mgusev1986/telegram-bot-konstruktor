import { describe, expect, it, vi, afterEach } from "vitest";

import { OllamaTranslationProvider } from "../src/modules/ai/providers/ollama-translation.provider";

describe("OllamaTranslationProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    global.fetch = undefined;
  });

  it("maps request and parses response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: "translated" })
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const provider = new OllamaTranslationProvider({
      model: "qwen2.5:14b",
      baseUrl: "http://localhost:11434"
    });

    const out = await provider.translateText({
      text: "prompt",
      sourceLanguageCode: "ru",
      targetLanguageCode: "en"
    });

    expect(out).toBe("translated");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/generate");
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain("\"model\":\"qwen2.5:14b\"");
  });
});
