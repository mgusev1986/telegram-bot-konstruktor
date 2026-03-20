export type AiTranslationProviderKind = "ollama" | "workers_ai" | "cerebras";

export interface AiTranslateTextInput {
  text: string;
  sourceLanguageCode: string;
  targetLanguageCode: string;
}

export interface AiTranslationProvider {
  readonly kind: AiTranslationProviderKind;
  readonly model: string;
  translateText(input: AiTranslateTextInput): Promise<string>;
  translateBatch(inputs: AiTranslateTextInput[]): Promise<string[]>;
  healthcheck(): Promise<void>;
}

/** Options for orchestration: explicit provider override or auto with fallback. */
export type TranslationProviderOverride = "ollama" | "workers_ai" | "cerebras" | "auto";
