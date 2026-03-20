// Centralized role/capability helpers.
// IMPORTANT: keep these functions pure (no Prisma/db calls) so they can be used by UI keyboard builders.

export type BotRole = "ALPHA_OWNER" | "OWNER" | "ADMIN" | "USER";

type RoleLike = BotRole | string | null | undefined;
type UserLike = { role?: RoleLike } | null | undefined;

const roleOf = (input: RoleLike | UserLike): RoleLike => {
  if (!input) return undefined;
  if (typeof input === "string") return input;
  return input.role;
};

export const isAlphaOwner = (input: RoleLike | UserLike): boolean => roleOf(input) === "ALPHA_OWNER";
export const isOwner = (input: RoleLike | UserLike): boolean => roleOf(input) === "OWNER";
export const isAdmin = (input: RoleLike | UserLike): boolean => roleOf(input) === "ADMIN";
export const isUser = (input: RoleLike | UserLike): boolean => roleOf(input) === "USER";

// Admin area access (admin hub + page editor entry points).
export const isAdminAreaUser = (input: RoleLike | UserLike): boolean => {
  const r = roleOf(input);
  return r === "ALPHA_OWNER" || r === "OWNER" || r === "ADMIN";
};

// Language management is ALPHA_OWNER-only.
export const canManageLanguages = (input: RoleLike | UserLike): boolean => isAlphaOwner(input);

// Admin management of other admin users is ALPHA_OWNER-only.
// OWNER/ADMIN are bot-scoped roles and must not grant global admin powers.
export const canManageAdmins = (input: RoleLike | UserLike): boolean => isAlphaOwner(input);

