import { describe, expect, it, vi, afterEach } from "vitest";

import { WorkersAiTranslationProvider } from "../src/modules/ai/providers/workers-ai-translation.provider";

describe("WorkersAiTranslationProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    global.fetch = undefined;
  });

  it("maps request and parses Cloudflare response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: { response: "translated-workers" } })
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const provider = new WorkersAiTranslationProvider({
      accountId: "acc-1",
      apiToken: "token-1",
      model: "@cf/meta/llama-3.1-8b-instruct"
    });

    const out = await provider.translateText({
      text: "prompt",
      sourceLanguageCode: "ru",
      targetLanguageCode: "en"
    });

    expect(out).toBe("translated-workers");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/accounts/acc-1/ai/run/%40cf%2Fmeta%2Fllama-3.1-8b-instruct");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-1");
    expect(String(init.body)).toContain("\"messages\"");
  });
});
