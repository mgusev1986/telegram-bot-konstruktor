export type TelegramMessageRef =
  | { kind: "private"; channelId: bigint; messageId: number }
  | { kind: "public"; username: string; messageId: number };

/**
 * Parses Telegram message links:
 * - https://t.me/c/<internalId>/<messageId>  (private channels)
 * - https://t.me/<username>/<messageId>     (public channels)
 * Also supports t.me/ without protocol.
 */
export function parseTelegramMessageLink(input: string): TelegramMessageRef | null {
  const raw = input.trim();
  if (!raw) return null;
  const url = raw.startsWith("http") ? raw : `https://${raw.replace(/^\/\//, "")}`;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.hostname !== "t.me" && u.hostname !== "telegram.me") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  if (parts[0] === "c") {
    const internalId = parts[1];
    const msg = parts[2];
    if (!internalId || !msg) return null;
    const internalNum = Number(internalId);
    const messageId = Number(msg);
    if (!Number.isInteger(internalNum) || !Number.isInteger(messageId) || messageId <= 0) return null;
    // Telegram private channel links use channel id without -100 prefix.
    const channelId = BigInt(`-100${internalId}`);
    return { kind: "private", channelId, messageId };
  }

  const username = parts[0];
  const messageId = Number(parts[1]);
  if (!username || !Number.isInteger(messageId) || messageId <= 0) return null;
  return { kind: "public", username, messageId };
}

