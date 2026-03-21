import type { BackofficeUserRole } from "@prisma/client";

import { env } from "../../config/env";

export type BackofficeAction =
  | "bot_settings:write"
  | "bot_clone:create"
  | "bot_lifecycle:pause_resume"
  | "bot_lifecycle:archive_delete"
  | "bot_roles:manage"
  | "paid_access:manage"
  | "payments:confirm_manual"
  | "global_user_directory:view";

export type BackofficeCapabilities = Set<BackofficeAction>;

/** Whether this backoffice user can view the platform-wide user directory (audience) — ALPHA_OWNER only. */
export function canViewGlobalUserDirectory(role: BackofficeUserRole, email: string): boolean {
  if (role === "ALPHA_OWNER") return true;
  if (env.BACKOFFICE_ALPHA_EMAIL && email === env.BACKOFFICE_ALPHA_EMAIL) return true;
  // Single-owner: if only BACKOFFICE_ADMIN_EMAIL is set (no BACKOFFICE_ALPHA_EMAIL), that admin sees all bases
  if (env.BACKOFFICE_ADMIN_EMAIL && !env.BACKOFFICE_ALPHA_EMAIL && email === env.BACKOFFICE_ADMIN_EMAIL) return true;
  return false;
}

const OWNER_ACTIONS: BackofficeAction[] = [
  "bot_settings:write",
  "bot_clone:create",
  "bot_lifecycle:pause_resume",
  "bot_lifecycle:archive_delete",
  "bot_roles:manage",
  "paid_access:manage",
  "payments:confirm_manual"
];

const ADMIN_ACTIONS: BackofficeAction[] = [
  "bot_settings:write",
  "bot_lifecycle:pause_resume",
  "paid_access:manage"
];

export function getBackofficeCapabilities(role: BackofficeUserRole, email?: string): BackofficeCapabilities {
  const caps = new Set<BackofficeAction>();
  const isAlpha =
    role === "ALPHA_OWNER" ||
    (email && env.BACKOFFICE_ALPHA_EMAIL && email === env.BACKOFFICE_ALPHA_EMAIL) ||
    (email && env.BACKOFFICE_ADMIN_EMAIL && !env.BACKOFFICE_ALPHA_EMAIL && email === env.BACKOFFICE_ADMIN_EMAIL);
  if (isAlpha) {
    caps.add("global_user_directory:view");
  }
  if (role === "ALPHA_OWNER" || role === "OWNER") {
    OWNER_ACTIONS.forEach((a) => caps.add(a));
    return caps;
  }
  if (role === "ADMIN") {
    ADMIN_ACTIONS.forEach((a) => caps.add(a));
    return caps;
  }
  return caps;
}

export function canPerform(role: BackofficeUserRole, action: BackofficeAction, email?: string): boolean {
  return getBackofficeCapabilities(role, email).has(action);
}

