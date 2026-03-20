/**
 * Converts Telegram message entities to canonical HTML for storage and rendering.
 * Preserves formatting from admin-authored messages (bold, blockquote, etc.).
 */

import type { MessageEntity } from "telegraf/types";
import { escapeHtml } from "./html";

/** Supported entity types that map to Telegram HTML parse_mode. */
const ENTITY_HTML_MAP: Record<string, { open: string; close: string }> = {
  bold: { open: "<b>", close: "</b>" },
  italic: { open: "<i>", close: "</i>" },
  underline: { open: "<u>", close: "</u>" },
  strikethrough: { open: "<s>", close: "</s>" },
  spoiler: { open: "<tg-spoiler>", close: "</tg-spoiler>" },
  code: { open: "<code>", close: "</code>" },
  pre: { open: "<pre>", close: "</pre>" },
  blockquote: { open: "<blockquote>", close: "</blockquote>" }
};

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

type Edge = { pos: number; kind: "open" | "close"; openTag: string; closeTag: string };

/**
 * Converts text + entities to Telegram-safe HTML.
 * - Uses UTF-16 indices (JS string indices match Telegram offset/length).
 * - Unsupported entities (custom_emoji, mention, etc.): preserve plain text.
 * - text_link: uses entity.url for href.
 */
export function telegramEntitiesToHtml(text: string, entities?: MessageEntity[] | null): string {
  if (!text) return "";
  if (!entities?.length) return escapeHtml(text);

  const edges: Edge[] = [];

  for (const entity of entities) {
    const offset = entity.offset ?? 0;
    const length = entity.length ?? 0;
    const end = offset + length;

    if (end > text.length || offset < 0) continue;

    if (entity.type === "text_link" && "url" in entity && typeof entity.url === "string") {
      const href = escapeAttr(entity.url);
      edges.push({
        pos: offset,
        kind: "open",
        openTag: `<a href="${href}">`,
        closeTag: "</a>"
      });
      edges.push({ pos: end, kind: "close", openTag: "", closeTag: "</a>" });
      continue;
    }

    const mapping = ENTITY_HTML_MAP[entity.type];
    if (!mapping) continue;

    edges.push({
      pos: offset,
      kind: "open",
      openTag: mapping.open,
      closeTag: mapping.close
    });
    edges.push({
      pos: end,
      kind: "close",
      openTag: mapping.open,
      closeTag: mapping.close
    });
  }

  edges.sort((a, b) => {
    if (a.pos !== b.pos) return a.pos - b.pos;
    return a.kind === "close" ? -1 : 1;
  });

  const result: string[] = [];
  let pos = 0;
  const stack: string[] = [];

  for (const edge of edges) {
    if (edge.pos > pos) {
      result.push(escapeHtml(text.slice(pos, edge.pos)));
      pos = edge.pos;
    }
    if (edge.kind === "open") {
      stack.push(edge.closeTag);
      result.push(edge.openTag);
    } else {
      const closeTag = stack.pop();
      if (closeTag) result.push(closeTag);
    }
  }

  if (pos < text.length) {
    result.push(escapeHtml(text.slice(pos)));
  }

  return result.join("");
}
