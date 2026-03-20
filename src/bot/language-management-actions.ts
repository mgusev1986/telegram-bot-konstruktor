/**
 * Pure helper: determines whether a callback `action` belongs to language-management flows.
 *
 * IMPORTANT:
 * - This is used to guard backend mutations (must block for OWNER/ADMIN/USER).
 * - Keep it exhaustive for all language-management callback actions produced by keyboards/flows.
 */

const LANGUAGE_MANAGEMENT_PREFIXES = ["langv_", "add_lang_", "regen_lang_"] as const;

const LANGUAGE_MANAGEMENT_EXACT_ACTIONS = new Set<string>([
  // Admin entrypoints for language management.
  "add_lang",
  "languages",
  "list_langs",
  "lang_detail",
  "lang_delete_prompt",
  "lang_delete_confirm",
  "open_lang_version",
  "edit_lang_version",
  "regen_lang_prompt",
  "regen_lang_start",

  // Language generation progress refresh.
  "lang_gen_refresh"
]);

export const isLanguageManagementAction = (action?: string | null): boolean => {
  if (!action) return false;
  if (LANGUAGE_MANAGEMENT_EXACT_ACTIONS.has(action)) return true;
  return LANGUAGE_MANAGEMENT_PREFIXES.some((p) => action.startsWith(p));
};

