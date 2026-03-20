export interface PersonalizationProfile {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  fullName?: string | null;
}

/** Accepts both camelCase (User) and snake_case (API/forms). */
type ProfileLike = PersonalizationProfile | Record<string, unknown>;

const safeValue = (value: string | null | undefined, fallback = ""): string => value?.trim() || fallback;

/** Fallback when no name is available. Used for {name} placeholder. */
const NAME_FALLBACK = "друг";

/** Extract field from profile, supporting both camelCase and snake_case. */
const getProfileField = (p: ProfileLike, camel: string, snake: string): string | null | undefined => {
  const raw = (p as Record<string, unknown>)[camel] ?? (p as Record<string, unknown>)[snake];
  return typeof raw === "string" ? raw : null;
};

/**
 * Builds a normalized profile from User or plain object. Ensures we never leave {name} unreplaced.
 */
export const toPersonalizationProfile = (source: ProfileLike): PersonalizationProfile => {
  const firstName = getProfileField(source, "firstName", "first_name");
  const lastName = getProfileField(source, "lastName", "last_name");
  const username = getProfileField(source, "username", "username");
  const fullName = getProfileField(source, "fullName", "full_name");
  const computedFullName = [firstName, lastName].filter(Boolean).join(" ").trim() || undefined;
  return {
    firstName: firstName ?? "",
    lastName: lastName ?? "",
    username: username ?? undefined,
    fullName: (fullName ?? computedFullName) || undefined
  };
};

import { escapeHtml } from "./html";

/**
 * Replaces placeholders in text with user data. Use for all user-facing content.
 * Admin-facing placeholder: {name} → first_name, else full_name, else "друг".
 * Legacy: {{first_name}}, {{last_name}}, {{username}}, {{full_name}}.
 * When opts.escapeForHtml is true, substituted values are escaped for Telegram HTML.
 */
export const applyPersonalization = (
  template: string,
  profile: ProfileLike,
  opts?: { escapeForHtml?: boolean }
): string => {
  const p = toPersonalizationProfile(profile);
  let firstName = safeValue(p.firstName, NAME_FALLBACK);
  let lastName = safeValue(p.lastName);
  let username = safeValue(p.username, "user");
  let fullName = safeValue(p.fullName, [firstName, lastName].filter(Boolean).join(" ") || firstName);
  let name = safeValue(p.firstName) || safeValue(p.fullName) || NAME_FALLBACK;

  if (opts?.escapeForHtml) {
    firstName = escapeHtml(firstName);
    lastName = escapeHtml(lastName);
    username = escapeHtml(username);
    fullName = escapeHtml(fullName);
    name = escapeHtml(name);
  }

  // Normalize Unicode braces (e.g. fullwidth) to ASCII for reliable replacement
  const normalized = template.replace(/\uFF5B/g, "{").replace(/\uFF5D/g, "}");

  let result = normalized
    .replaceAll("{name}", name)
    .replaceAll("{{first_name}}", firstName)
    .replaceAll("{{last_name}}", lastName)
    .replaceAll("{{username}}", username)
    .replaceAll("{{full_name}}", fullName);

  // Replace any {{key}} from profile for custom params (e.g. {{url}}, {{title}})
  const known = new Set(["firstName", "first_name", "lastName", "last_name", "username", "fullName"]);
  for (const [k, v] of Object.entries(profile as Record<string, unknown>)) {
    if (known.has(k)) continue;
    const val = typeof v === "string" ? v : v != null ? String(v) : "";
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    result = result.replaceAll(new RegExp(`\\{\\{${escaped}\\}\\}`, "g"), val);
  }
  return result;
};

/**
 * Central helper recommended for all rendering paths.
 * Keeps backward compatibility with applyPersonalization().
 */
export const renderPersonalizedText = (
  text: string,
  profile: ProfileLike,
  opts?: { resolvePlaceholders?: boolean }
): string => {
  if (opts?.resolvePlaceholders === false) return text;
  return applyPersonalization(text, profile);
};
