import { bbToHtml, escapeHtml } from "../../common/html";

type ScreenTemplateInput = {
  /** First line of the screen, e.g. "Шаг 2 из 6" or "⚙️ Админ-панель" */
  header: string;
  /** 1–3 short lines explaining the screen */
  explain?: string[];
  /** The single main action line, will be rendered bold (HTML) */
  action?: string;
  /** Accepted formats / examples (each line becomes a bullet) */
  formats?: string[];
  /** Optional hint block, printed as-is on new line(s) */
  hint?: string;
};

const compact = (lines: Array<string | undefined | null>): string[] =>
  lines.map((l) => (l ?? "").trim()).filter(Boolean);

/** Renders screen content as HTML for Telegram parse_mode: 'HTML'. No raw [b] tags. */
export const renderScreen = (input: ScreenTemplateInput): string => {
  const parts: string[] = [];

  parts.push(bbToHtml(input.header.trim()));

  const explain = compact(input.explain ?? []);
  if (explain.length > 0) {
    parts.push("", ...explain.map(bbToHtml));
  }

  if (input.action && input.action.trim() !== "") {
    const a = input.action.trim().replace(/\[b\]|\[\/b\]|<b>|<\/b>/gi, "").trim();
    parts.push("", `<b>${escapeHtml(a)}</b>`);
  }

  const formats = compact(input.formats ?? []);
  if (formats.length > 0) {
    parts.push("", ...formats.map((l) => `- ${escapeHtml(l)}`));
  }

  if (input.hint && input.hint.trim() !== "") {
    parts.push("", bbToHtml(input.hint.trim()));
  }

  return parts.join("\n").trim();
};

