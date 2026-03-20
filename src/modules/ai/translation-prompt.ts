import type { AiTranslateTextInput } from "./providers/types";

export const buildTranslationPrompt = (
  input: AiTranslateTextInput,
  maskedText: string,
  strict: boolean
): string => {
  const strictPart = strict
    ? "IMPORTANT: all __TR_TOKEN_<number>__ placeholders must appear in the output EXACTLY and in the same count. Do not add or remove tokens."
    : "Keep all __TR_TOKEN_<number>__ placeholders EXACTLY unchanged. Do not translate them.";

  return [
    "You are a professional translation assistant for Telegram bot content.",
    `Translate from ${input.sourceLanguageCode} to ${input.targetLanguageCode}.`,
    "Rules:",
    "- Preserve meaning and natural tone.",
    "- Keep line breaks and punctuation.",
    "- Preserve HTML and Telegram formatting markers represented by __TR_TOKEN_<number>__ placeholders.",
    "- Do NOT translate placeholders like __TR_TOKEN_0__; keep them as-is.",
    "- Keep CTA phrases concise and action-oriented.",
    "- Do NOT translate brand names unless source text explicitly asks to localize them.",
    "- Do NOT translate URLs, usernames, route-like keys, callback keys, media ids, or technical tokens.",
    "- Return ONLY the translated text, without quotes, markdown, or commentary.",
    strictPart,
    "",
    "Source text:",
    maskedText
  ].join("\n");
};
