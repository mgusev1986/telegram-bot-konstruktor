/**
 * Сборка linkedChats из полей формы backoffice (Кнопка 1/2: label, invite, post link, identifier).
 */

/** Placeholder text from form hints — must not be persisted as a real invite. */
export function isLinkedChatInvitePlaceholder(url: string): boolean {
  const n = url.trim().toLowerCase().replace(/^http:\/\//i, "https://");
  return n === "https://t.me/+invitehashchat" || n === "https://t.me/+invitehashchannel";
}

export function isTelegramInviteOrJoinchatUrl(url: string): boolean {
  return /^https?:\/\/t\.me\/(?:\+[\w-]+|joinchat\/[\w-]+)/i.test(url.trim());
}

export function normalizeTelegramHttpsUrl(url: string): string {
  const t = url.trim();
  if (!t) return "";
  if (/^https:\/\//i.test(t)) return t;
  if (/^http:\/\//i.test(t)) return `https://${t.slice(7).replace(/^\/\//, "")}`;
  if (/^t\.me\//i.test(t)) return `https://${t}`;
  return t;
}

function normalizePrivateIdentifier(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const linkMatch = raw.match(/t\.me\/(?:c|o)\/(\d+)/i);
  if (linkMatch) return `-100${linkMatch[1]}`;
  if (/^-100\d{6,}$/.test(raw)) return raw;
  if (/^100\d{6,}$/.test(raw)) return `-${raw}`;
  if (/^\d{6,}$/.test(raw)) return `-100${raw}`;
  return raw;
}

export function readStructuredLinkedChatsFromBody(body: Record<string, unknown>): Array<{
  link?: string;
  identifier?: string;
  label?: string;
}> {
  const rows: Array<{ link?: string; identifier?: string; label?: string }> = [];
  for (const i of [1, 2]) {
    const label = String(body[`linkedChatLabel${i}`] ?? "").trim();
    let linkField = String(body[`linkedChatLink${i}`] ?? "").trim();
    if (isLinkedChatInvitePlaceholder(linkField)) linkField = "";
    const postLinkRaw = String(body[`linkedChatPostLink${i}`] ?? "").trim();
    const postLink = normalizeTelegramHttpsUrl(postLinkRaw);
    const rawIdentifier = String(body[`linkedChatIdentifier${i}`] ?? "").trim();
    const postLinkMatch =
      postLink.match(/t\.me\/(?:c|o)\/(\d+)/i) || linkField.match(/t\.me\/(?:c|o)\/(\d+)/i);
    const identifier = normalizePrivateIdentifier(
      rawIdentifier || (postLinkMatch ? `-100${postLinkMatch[1]}` : "")
    );

    let normalizedLink = "";
    if (linkField && isTelegramInviteOrJoinchatUrl(linkField)) {
      normalizedLink = normalizeTelegramHttpsUrl(linkField);
    } else if (linkField && !/^https?:\/\/t\.me\/(?:c|o)\/\d+/i.test(linkField)) {
      normalizedLink = normalizeTelegramHttpsUrl(linkField);
    } else if (postLink && /^https:\/\/t\.me\/(?:c|o)\/\d+/i.test(postLink)) {
      normalizedLink = postLink;
    } else if (linkField) {
      normalizedLink = normalizeTelegramHttpsUrl(linkField);
    }

    if (!label && !linkField && !postLinkRaw && !rawIdentifier && !identifier) continue;
    rows.push({
      label: label || undefined,
      link: normalizedLink || undefined,
      identifier: identifier || undefined
    });
  }
  return rows;
}
