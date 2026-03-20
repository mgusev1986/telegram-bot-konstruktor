import { logger } from "../../../common/logger";
import type { AiTranslateTextInput, AiTranslationProvider } from "./types";

export interface WorkersAiTranslationProviderOptions {
  accountId: string;
  apiToken: string;
  model: string;
  timeoutMs?: number;
}

type WorkersAiResponse = {
  result?: {
    response?: string;
  };
  errors?: Array<{ message?: string }>;
};

export class WorkersAiTranslationProvider implements AiTranslationProvider {
  public readonly kind = "workers_ai" as const;
  public readonly model: string;
  private readonly timeoutMs: number;
  private readonly endpoint: string;
  private readonly apiToken: string;

  public constructor(options: WorkersAiTranslationProviderOptions) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.apiToken = options.apiToken;
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/ai/run/${encodeURIComponent(options.model)}`;
  }

  private async runPrompt(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: prompt }],
          temperature: 0.2,
          top_p: 0.9
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Workers AI request failed: ${res.status} ${res.statusText} ${errText}`.trim());
      }
      const json = (await res.json()) as WorkersAiResponse;
      const out = json?.result?.response;
      if (typeof out !== "string" || !out.trim()) {
        const firstError = json?.errors?.[0]?.message ?? "missing result.response";
        throw new Error(`Workers AI response parsing failed (${firstError})`);
      }
      return out.trim();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Workers AI request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async translateText(input: AiTranslateTextInput): Promise<string> {
    return this.runPrompt(input.text);
  }

  public async translateBatch(inputs: AiTranslateTextInput[]): Promise<string[]> {
    const out: string[] = [];
    for (const item of inputs) {
      out.push(await this.translateText(item));
    }
    return out;
  }

  public async healthcheck(): Promise<void> {
    await this.runPrompt("Reply with exactly: ok");
    logger.debug({ provider: this.kind, model: this.model }, "AI provider healthcheck passed");
  }
}
