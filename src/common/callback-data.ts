import { z } from "zod";

import { ValidationError } from "./errors";

const callbackSchema = z.string().min(1).max(64).regex(/^[a-z_]+:[a-z0-9_\-:]+$/i);

/** Telegram callback_data limit is 64 bytes. */
export const CALLBACK_DATA_MAX_LENGTH = 64;

/**
 * Shorten UUID to first 12 hex chars for callback payloads.
 * Use resolveShortId in handlers to look up by prefix (collision risk is negligible).
 */
export const toShortId = (id: string): string => {
  if (id.length <= 12) return id;
  return id.slice(0, 12);
};

export const makeCallbackData = (...parts: string[]): string => {
  const value = parts.join(":");
  const parsed = callbackSchema.safeParse(value);

  if (!parsed.success) {
    throw new ValidationError("Invalid callback data payload", parsed.error.flatten());
  }

  return value;
};

export const splitCallbackData = (callbackData: string): string[] => {
  const parsed = callbackSchema.safeParse(callbackData);

  if (!parsed.success) {
    throw new ValidationError("Malformed callback data");
  }

  return callbackData.split(":");
};
