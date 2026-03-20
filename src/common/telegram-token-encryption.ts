import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

/** SHA256 hex of token for duplicate detection. Same token = same hash. */
export function hashTelegramBotToken(plainToken: string): string {
  return createHash("sha256").update(plainToken, "utf8").digest("hex");
}
const KEY_BYTES = 32;

function deriveKey(secret: string): Buffer {
  // Deterministic key derivation so we only need one string in env.
  return createHash("sha256").update(secret, "utf8").digest().subarray(0, KEY_BYTES);
}

/**
 * Encrypts Telegram bot token for "at rest" storage.
 * Output format: `v1.<ivB64>.<tagB64>.<ciphertextB64>`
 *
 * IMPORTANT: Never log the plaintext token or decrypted values.
 */
export function encryptTelegramBotToken(plainToken: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = randomBytes(12); // recommended size for GCM
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainToken, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${ciphertext.toString("base64")}`;
}

/**
 * Decrypts token previously stored by `encryptTelegramBotToken`.
 */
export function decryptTelegramBotToken(payload: string, secret: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted token payload format");
  }

  const ivB64 = parts[1]!;
  const tagB64 = parts[2]!;
  const ciphertextB64 = parts[3]!;
  const key = deriveKey(secret);
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

