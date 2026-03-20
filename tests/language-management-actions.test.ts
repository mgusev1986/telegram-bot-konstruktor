import { describe, expect, it } from "vitest";

import { isLanguageManagementAction } from "../src/bot/language-management-actions";

describe("Language-management action classification", () => {
  it("matches exact known actions", () => {
    const positives = [
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
      "lang_gen_refresh"
    ];

    for (const a of positives) {
      expect(isLanguageManagementAction(a)).toBe(true);
    }
  });

  it("matches language management prefixes", () => {
    const positives = ["langv_pages", "langv_rtxt", "add_lang_pick:en", "regen_lang_start", "regen_lang_prompt:en"];
    for (const a of positives) {
      expect(isLanguageManagementAction(a)).toBe(true);
    }
  });

  it("rejects non-language actions", () => {
    expect(isLanguageManagementAction(undefined)).toBe(false);
    expect(isLanguageManagementAction(null)).toBe(false);
    expect(isLanguageManagementAction("admin:open")).toBe(false);
    expect(isLanguageManagementAction("broadcast:open")).toBe(false);
    expect(isLanguageManagementAction("lang")).toBe(false);
  });
});

