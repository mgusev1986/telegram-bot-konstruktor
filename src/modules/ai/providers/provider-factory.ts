import { env } from "../../../config/env";
import { logger } from "../../../common/logger";
import { CerebrasTranslationProvider } from "./cerebras-translation.provider";
import { FallbackTranslationProvider } from "./fallback-translation.provider";
import { OllamaTranslationProvider } from "./ollama-translation.provider";
import type { AiTranslationProvider, TranslationProviderOverride } from "./types";
import { WorkersAiTranslationProvider } from "./workers-ai-translation.provider";

const timeoutMs = env.TRANSLATION_TIMEOUT_MS ?? 30_000;

const mustNonEmpty = (v: string | undefined | null, name: string): string => {
  const s = (v ?? "").trim();
  if (!s) throw new Error(`${name} is required for requested AI provider`);
  return s;
};

export const createAiTranslationProvider = (override?: TranslationProviderOverride): AiTranslationProvider => {
  const requested: TranslationProviderOverride =
    override ??
    (env.TRANSLATION_PROVIDER as TranslationProviderOverride | undefined) ??
    (env.AI_TRANSLATION_PROVIDER as TranslationProviderOverride);

  const makeOllama = (): AiTranslationProvider => {
    const provider = new OllamaTranslationProvider({
      model: env.OLLAMA_MODEL ?? env.AI_TRANSLATION_MODEL,
      baseUrl: env.OLLAMA_BASE_URL,
      timeoutMs
    });
    logger.info({ provider: provider.kind, model: provider.model }, "AI translation provider selected");
    return provider;
  };

  const makeCerebras = (): AiTranslationProvider => {
    const apiKey = mustNonEmpty(env.CEREBRAS_API_KEY, "CEREBRAS_API_KEY");
    const provider = new CerebrasTranslationProvider({
      apiKey,
      model: env.CEREBRAS_MODEL ?? "llama3.1-8b",
      baseUrl: env.CEREBRAS_BASE_URL,
      timeoutMs
    });
    logger.info({ provider: provider.kind, model: provider.model }, "AI translation provider selected");
    return provider;
  };

  const maybeWrapWithFallback = (primary: AiTranslationProvider): AiTranslationProvider => {
    const fb = env.TRANSLATION_FALLBACK_PROVIDER;
    if (!fb) return primary;
    if (primary.kind === fb) return primary;

    const fallbackProvider = fb === "ollama" ? makeOllama() : makeCerebras();
    const wrapped = new FallbackTranslationProvider({
      providers: [primary, fallbackProvider],
      logFallback: true
    });
    logger.info(
      { primary: primary.kind, fallback: fb },
      "AI translation provider wrapped with fallback"
    );
    return wrapped;
  };

  if (requested === "ollama") {
    return maybeWrapWithFallback(makeOllama());
  }

  if (requested === "cerebras") {
    return maybeWrapWithFallback(makeCerebras());
  }

  if (requested === "auto") {
    // Auto policy without async: try ollama first; if it fails during translation, fallback to cerebras.
    const ollamaProvider = makeOllama();
    const canUseCerebras = Boolean(env.CEREBRAS_API_KEY && env.CEREBRAS_API_KEY.trim().length > 0);
    if (!canUseCerebras) return ollamaProvider;

    const cerebrasProvider = makeCerebras();
    const fallback = new FallbackTranslationProvider({
      providers: [ollamaProvider, cerebrasProvider],
      logFallback: true
    });
    logger.info({ provider: "auto", primary: "ollama", fallback: "cerebras" }, "AI auto policy: ollama -> cerebras fallback");
    return fallback;
  }

  // Legacy workers_ai: primary online provider, optional cerebras fallback.
  const workersProvider = new WorkersAiTranslationProvider({
    accountId: mustNonEmpty(env.CLOUDFLARE_ACCOUNT_ID, "CLOUDFLARE_ACCOUNT_ID"),
    apiToken: mustNonEmpty(env.CLOUDFLARE_AI_API_TOKEN, "CLOUDFLARE_AI_API_TOKEN"),
    model: mustNonEmpty(env.CLOUDFLARE_AI_MODEL, "CLOUDFLARE_AI_MODEL"),
    timeoutMs
  });

  const useFallback =
    env.AI_TRANSLATION_FALLBACK_ENABLED &&
    Boolean(env.CEREBRAS_API_KEY && env.CEREBRAS_API_KEY.trim().length > 0);

  if (useFallback) {
    const apiKey = env.CEREBRAS_API_KEY.trim();
    const cerebrasProvider = new CerebrasTranslationProvider({
      apiKey,
      model: env.CEREBRAS_MODEL ?? "llama3.1-8b",
      baseUrl: env.CEREBRAS_BASE_URL,
      timeoutMs
    });
    const fallback = new FallbackTranslationProvider({
      providers: [workersProvider, cerebrasProvider],
      logFallback: true
    });
    logger.info(
      { provider: "workers_ai", fallback: "cerebras", model: workersProvider.model },
      "AI translation provider selected (with fallback)"
    );
    return fallback;
  }

  logger.info({ provider: workersProvider.kind, model: workersProvider.model }, "AI translation provider selected");
  return workersProvider;
};
