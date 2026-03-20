/**
 * Content formatting for Telegram bot page rendering.
 * Converts admin-authored formatting to Telegram HTML parse_mode.
 * Supports: bold ([b]...[/b], **...**), blockquote (> lines).
 */

import { escapeHtml } from "./html";

/**
 * Converts authoring format to Telegram-safe HTML.
 * - [b]...[/b] and **...** → <b>...</b>
 * - Lines starting with > → <blockquote>...</blockquote>
 * - Escapes user content for HTML safety.
 * - Preserves line breaks and paragraph structure.
 * - Plain text with no formatting is escaped and returned as-is.
 */
export function formatPageContentForTelegram(raw: string): string {
  if (!raw || typeof raw !== "string") return "";

  const lines = raw.split("\n");
  const result: string[] = [];
  let blockquoteLines: string[] = [];

  const flushBlockquote = () => {
    if (blockquoteLines.length > 0) {
      const content = blockquoteLines
        .map((line) => formatInlineAndEscape(line))
        .join("\n");
      result.push(`<blockquote>${content}</blockquote>`);
      blockquoteLines = [];
    }
  };

  const formatInlineAndEscape = (line: string): string => {
    let s = line;
    // [b]...[/b] (BBCode)
    s = s.replace(/\[b\]([\s\S]*?)\[\/b\]/gi, (_, content) => `<b>${escapeHtml(content)}</b>`);
    // **...** (Markdown-style)
    s = s.replace(/\*\*([^*]+)\*\*/g, (_, content) => `<b>${escapeHtml(content)}</b>`);
    // Preserve <b>...</b> blocks (already escaped), escape plain text only
    return s.replace(/(<b>[\s\S]*?<\/b>)|([\s\S])/gi, (_, block, ch) => (block ? block : escapeHtml(ch)));
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(">")) {
      blockquoteLines.push(trimmed.slice(1).replace(/^\s+/, ""));
    } else {
      flushBlockquote();
      result.push(formatInlineAndEscape(line));
    }
  }
  flushBlockquote();

  return result.join("\n");
}

/**
 * Applies formatPageContentForTelegram if the text appears to need formatting.
 * If text already contains valid Telegram HTML tags, returns as-is (caller must ensure safety).
 * Otherwise converts authoring format to HTML.
 */
export function maybeFormatForTelegram(text: string): string {
  if (!text || typeof text !== "string") return "";
  const hasAuthoringFormat =
    /\[b\]|\[\/b\]|\*\*[^*]+\*\*|^>/m.test(text) ||
    !/<\/?(b|strong|i|em|u|s|strike|del|code|pre|a|blockquote)\b/i.test(text);
  if (hasAuthoringFormat) {
    return formatPageContentForTelegram(text);
  }
  return text;
}
