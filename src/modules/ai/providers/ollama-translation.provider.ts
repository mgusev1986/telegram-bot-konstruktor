import { logger } from "../../../common/logger";
import type { AiTranslateTextInput, AiTranslationProvider } from "./types";

export interface OllamaTranslationProviderOptions {
  model: string;
  baseUrl: string;
  timeoutMs?: number;
}

export class OllamaTranslationProvider implements AiTranslationProvider {
  public readonly kind = "ollama" as const;
  public readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  public constructor(options: OllamaTranslationProviderOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  private async requestGenerate(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          prompt,
          stream: false,
          options: { temperature: 0.2, top_p: 0.9 }
        }),
        signal: controller.signal
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Ollama request failed: ${res.status} ${res.statusText} ${errText}`.trim());
      }
      const json = await res.json();
      const translated = json?.response;
      if (typeof translated !== "string") {
        throw new Error("Ollama response parsing failed (missing json.response)");
      }
      return translated.trim();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Ollama request timed out after ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async translateText(input: AiTranslateTextInput): Promise<string> {
    return this.requestGenerate(input.text);
  }

  public async translateBatch(inputs: AiTranslateTextInput[]): Promise<string[]> {
    const out: string[] = [];
    for (const item of inputs) {
      out.push(await this.translateText(item));
    }
    return out;
  }

  public async healthcheck(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 5_000));
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`Ollama healthcheck failed: ${res.status} ${res.statusText}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Ollama healthcheck timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    logger.debug({ provider: this.kind, model: this.model }, "AI provider healthcheck passed");
  }
}
