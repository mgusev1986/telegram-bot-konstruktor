/**
 * Парсинг ссылок на чаты/каналы Telegram для Product.linkedChats.
 * Поддерживает: t.me/channel, t.me/c/123/1, t.me/+invite, @username, числовой ID.
 */
export interface LinkedChatEntry {
  link?: string;
  label?: string;
  identifier?: string;
}

function parseSingleLinkedChatInput(raw: string): LinkedChatEntry | null {
  const s = raw.trim();
  if (!s) return null;

  const normalized = s.replace(/^https?:\/\//, "").replace(/^www\./, "");
  const lower = normalized.toLowerCase();

  // Числовой ID: -1001234567890 или 1001234567890
  const numMatch = s.match(/^-?\d{10,}$/);
  if (numMatch) {
    const id = numMatch[0];
    const n = BigInt(id);
    return { identifier: String(n), label: id.startsWith("-100") ? "Канал/чат" : "Чат" };
  }

  // @username
  if (s.startsWith("@")) {
    const username = s.slice(1).replace(/[^a-zA-Z0-9_]/g, "");
    if (username) {
      const link = `https://t.me/${username}`;
      return { link, identifier: `@${username}`, label: "Канал" };
    }
  }

  // t.me/channelname (публичный канал)
  const pubMatch = normalized.match(/^t\.me\/([a-zA-Z0-9_]+)$/i);
  if (pubMatch) {
    const username = pubMatch[1];
    const link = `https://t.me/${username}`;
    return { link, identifier: `@${username}`, label: "Канал" };
  }

  // t.me/c/1234567890/1 (приватный супергрупп/канал)
  const privMatch = normalized.match(/^t\.me\/c\/(\d+)(?:\/\d+)?$/i);
  if (privMatch) {
    const numPart = privMatch[1] ?? "";
    const fullId = numPart.startsWith("-") ? numPart : `-100${numPart}`;
    const link = `https://t.me/c/${numPart}/1`;
    return { link, identifier: fullId, label: "Чат/канал" };
  }

  // t.me/joinchat/xxx или t.me/+xxx (инвайт-ссылка)
  const inviteMatch = normalized.match(/^t\.me\/(?:\+([A-Za-z0-9_-]+)|joinchat\/([A-Za-z0-9_-]+))$/i);
  if (inviteMatch) {
    const hash = inviteMatch[1] ?? inviteMatch[2];
    const link = `https://t.me/+${hash}`;
    return { link, label: "Чат/канал" };
  }

  // Любая валидная ссылка t.me
  if (lower.startsWith("t.me/") || s.includes("t.me/")) {
    const url = s.startsWith("http") ? s : `https://${normalized}`;
    return { link: url, label: "Чат/канал" };
  }

  return null;
}

function isInviteLink(link: string | undefined): boolean {
  return typeof link === "string" && /^https:\/\/t\.me\/(?:\+|joinchat\/)/i.test(link);
}

function isPrivateMessageLink(link: string | undefined): boolean {
  return typeof link === "string" && /^https:\/\/t\.me\/c\/\d+(?:\/\d+)?$/i.test(link);
}

function chooseDisplayLink(current: string | undefined, candidate: string | undefined): string | undefined {
  if (!candidate) return current;
  if (!current) return candidate;
  if (isInviteLink(candidate) && !isInviteLink(current)) return candidate;
  if (isPrivateMessageLink(current) && !isPrivateMessageLink(candidate)) return candidate;
  return current;
}

/**
 * Допускает составной формат:
 *   https://t.me/+invite | https://t.me/c/1234567890/1
 *   https://t.me/+invite | -1001234567890
 * чтобы использовать invite-link для входа и identifier для ban/unban.
 */
export function parseLinkedChatInput(raw: string): LinkedChatEntry | null {
  const parts = raw
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length <= 1) return parseSingleLinkedChatInput(raw);

  // Custom label format:
  //   Label | https://t.me/chat_or_channel
  //   Label | https://t.me/+invite | -1001234567890
  const firstParsed = parseSingleLinkedChatInput(parts[0] ?? "");
  if (!firstParsed) {
    const label = parts[0] ?? "";
    const payloadParts = parts.slice(1);
    const mergedWithLabel: LinkedChatEntry = { label };
    for (const part of payloadParts) {
      const parsed = parseSingleLinkedChatInput(part);
      if (!parsed) continue;
      mergedWithLabel.link = chooseDisplayLink(mergedWithLabel.link, parsed.link);
      if (!mergedWithLabel.identifier && parsed.identifier) mergedWithLabel.identifier = parsed.identifier;
    }
    if (mergedWithLabel.link || mergedWithLabel.identifier) return mergedWithLabel;
    return null;
  }

  const merged: LinkedChatEntry = {};
  for (const part of parts) {
    const parsed = parseSingleLinkedChatInput(part);
    if (!parsed) continue;
    merged.link = chooseDisplayLink(merged.link, parsed.link);
    if (!merged.identifier && parsed.identifier) merged.identifier = parsed.identifier;
    if (!merged.label && parsed.label) merged.label = parsed.label;
  }

  return merged.link || merged.identifier ? merged : null;
}

export function parseLinkedChatsFromForm(rawLines: string): LinkedChatEntry[] {
  const results: LinkedChatEntry[] = [];
  const lines = rawLines.split("\n").map((l) => l.trim()).filter(Boolean);
  const seen = new Set<string>();

  for (const line of lines) {
    const parsed = parseLinkedChatInput(line);
    if (parsed) {
      const key = parsed.link ?? parsed.identifier ?? "";
      if (key && !seen.has(key)) {
        seen.add(key);
        results.push(parsed);
      }
    }
  }
  return results;
}

export function getDisplayLinks(linkedChats: unknown): Array<{ link: string; label: string }> {
  if (!Array.isArray(linkedChats)) return [];
  const out: Array<{ link: string; label: string }> = [];
  for (const item of linkedChats) {
    if (item && typeof item === "object" && "link" in item && typeof (item as any).link === "string") {
      const rawLabel = typeof (item as any).label === "string" ? (item as any).label.trim() : "";
      out.push({ link: (item as any).link, label: rawLabel || "Перейти" });
    }
  }
  return out;
}

export function getBanIdentifiers(linkedChats: unknown): string[] {
  if (!Array.isArray(linkedChats)) return [];
  const out: string[] = [];
  for (const item of linkedChats) {
    if (item && typeof item === "object" && "identifier" in item && typeof (item as any).identifier === "string") {
      out.push((item as any).identifier);
    }
  }
  return out;
}
