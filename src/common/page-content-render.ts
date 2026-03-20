/**
 * Central render logic for page content shown in Telegram.
 * Used by bot (pages, preview), broadcast, drip, and menu welcome.
 * Applies personalization, formatting (bold, blockquote), and ensures HTML safety.
 */

import { maybeFormatForTelegram } from "./content-formatting";
import { applyPersonalization, type PersonalizationProfile } from "./personalization";

/**
 * Renders content for Telegram: personalizes placeholders and formats rich text.
 * - Existing HTML (from Telegram entities) passes through.
 * - Legacy [b], **, > authoring format is converted to HTML.
 * - Placeholder values are escaped for safe injection into HTML.
 */
export function renderPageContent(
  rawText: string,
  profile: PersonalizationProfile
): string {
  if (!rawText?.trim()) return "";
  const formatted = maybeFormatForTelegram(rawText);
  return applyPersonalization(formatted, profile, { escapeForHtml: true });
}
