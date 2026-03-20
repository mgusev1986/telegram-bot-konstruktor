import { logger } from "../../../common/logger";
import type { AiTranslateTextInput, AiTranslationProvider } from "./types";

export interface CerebrasTranslationProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
}

type CerebrasChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

export class CerebrasTranslationProvider implements AiTranslationProvider {
  public readonly kind = "cerebras" as const;
  public readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  public constructor(options: CerebrasTranslationProviderOptions) {
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? "https://api.cerebras.ai/v1").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async runChat(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          max_tokens: 4096,
          stream: false
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Cerebras request failed: ${res.status} ${res.statusText} ${errText}`.trim());
      }
      const json = (await res.json()) as CerebrasChatResponse;
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) {
        const errMsg = json?.error?.message ?? "missing choices[0].message.content";
        throw new Error(`Cerebras response parsing failed (${errMsg})`);
      }
      return content.trim();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Cerebras request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async translateText(input: AiTranslateTextInput): Promise<string> {
    // AiTranslationService passes the full prompt (with masked tokens) as input.text
    const result = await this.runChat(input.text);
    return result;
  }

  public async translateBatch(inputs: AiTranslateTextInput[]): Promise<string[]> {
    const out: string[] = [];
    for (const item of inputs) {
      out.push(await this.translateText(item));
    }
    return out;
  }

  public async healthcheck(): Promise<void> {
    await this.runChat("Reply with exactly: ok");
    logger.debug({ provider: this.kind, model: this.model }, "AI provider healthcheck passed");
  }
}
