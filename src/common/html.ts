/**
 * Escape user-controlled text for Telegram HTML parse_mode.
 * Prevents breaking tags and injection.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert legacy [b]...[/b] to <b>...</b> for Telegram HTML.
 * Use for i18n strings that may still contain BBCode.
 */
export function bbToHtml(s: string): string {
  return s.replace(/\[b\]/g, "<b>").replace(/\[\/b\]/g, "</b>");
}
