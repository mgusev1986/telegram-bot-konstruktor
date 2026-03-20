import { z } from "zod";

import { ValidationError } from "./errors";

const callbackSchema = z.string().min(1).max(64).regex(/^[a-z_]+:[a-z0-9_\-:]+$/i);

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
