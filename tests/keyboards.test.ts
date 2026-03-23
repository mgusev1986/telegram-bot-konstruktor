import { describe, it, expect } from "vitest";
import {
  buildMenuKeyboard,
  buildContentScreenKeyboard,
  buildNavigationRow,
  buildButtonManagementKeyboard,
  buildCabinetKeyboard,
  buildAdminKeyboard,
  buildScheduledBroadcastHubKeyboard,
  buildScheduledBroadcastListKeyboard,
  buildScheduledBroadcastDetailKeyboard,
  buildLanguageKeyboard,
  buildPageEditorKeyboard,
  buildPageEditorContentSubmenuKeyboard,
  buildLanguageVersionHubKeyboard,
  buildLanguageVersionPageActionsKeyboard,
  buildLanguageVersionPreviewConfirmKeyboard,
  buildUserManagementPromptKeyboard,
  buildUserManagementCardKeyboard,
  buildUserManagementAdminListKeyboard,
  buildUserManagementDeleteConfirmKeyboard,
  NAV_ROOT_DATA,
  NAV_BACK_DATA,
  NAV_SLOT_BACK,
  NAV_SLOT_TO_MAIN,
} from "../src/bot/keyboards";
import { createMockI18n } from "./helpers/mock-i18n";

type InlineKeyboardMarkup = { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> };

function getInlineKeyboardRows(kb: { reply_markup: InlineKeyboardMarkup }): Array<Array<{ text: string; callback_data?: string; url?: string }>> {
  return kb.reply_markup.inline_keyboard;
}

function getAllCallbackData(kb: { reply_markup: InlineKeyboardMarkup }): string[] {
  const rows = kb.reply_markup.inline_keyboard;
  const out: string[] = [];
  for (const row of rows) {
    for (const btn of row) {
      if (btn.callback_data) out.push(btn.callback_data);
    }
  }
  return out;
}

const i18n = createMockI18n();
const lang = "ru";

describe("Keyboards: menu keyboard", () => {
  it("each root-level menu button has callback menu:open:<pageId>", () => {
    const items = [
      { id: "page-1", locked: false, localizations: [{ languageCode: "ru", title: "Section 1" }] },
      { id: "page-2", locked: false, localizations: [{ languageCode: "ru", title: "Section 2" }] },
    ];
    const kb = buildMenuKeyboard(items as any, lang, i18n, null, undefined, undefined);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("menu:open:page-1");
    expect(callbacks).toContain("menu:open:page-2");
  });

  it("contains nav:root (В главное меню) when parentId is defined", () => {
    const items = [
      { id: "child", locked: false, localizations: [{ languageCode: "ru", title: "Child" }] },
    ];
    const kb = buildMenuKeyboard(items as any, lang, i18n, "parent-id", undefined, undefined);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain(NAV_ROOT_DATA);
  });

  it("back button uses menu:back:<parentId>", () => {
    const items = [
      { id: "child", locked: false, localizations: [{ languageCode: "ru", title: "Child" }] },
    ];
    const kb = buildMenuKeyboard(items as any, lang, i18n, "parent-id", undefined, undefined);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks.some((c) => c.startsWith("menu:back:"))).toBe(true);
    expect(callbacks).toContain("menu:back:parent-id");
  });

  it("slotOrder interleaves content and nav buttons (back, toMain) in order", () => {
    const items = [
      { id: "a", locked: false, localizations: [{ languageCode: "ru", title: "A" }] },
      { id: "b", locked: false, localizations: [{ languageCode: "ru", title: "B" }] },
    ];
    const slotOrder = ["a", NAV_SLOT_BACK, "b", NAV_SLOT_TO_MAIN];
    const kb = buildMenuKeyboard(items as any, lang, i18n, "parent-id", undefined, undefined, slotOrder);
    const callbacks = getAllCallbackData(kb as any);
    const openA = callbacks.indexOf("menu:open:a");
    const back = callbacks.indexOf("menu:back:parent-id");
    const openB = callbacks.indexOf("menu:open:b");
    const root = callbacks.indexOf(NAV_ROOT_DATA);
    expect(openA).toBeGreaterThanOrEqual(0);
    expect(back).toBeGreaterThan(openA);
    expect(openB).toBeGreaterThan(back);
    expect(root).toBeGreaterThan(openB);
  });

  it("admin sees configure_page with page_edit:open:<currentPageId>", () => {
    const items = [
      { id: "sec", locked: false, localizations: [{ languageCode: "ru", title: "Sec" }] },
    ];
    const kb = buildMenuKeyboard(items as any, lang, i18n, "root", "ADMIN", "sec");
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("page_edit:open:sec");
  });

  it("submenu back points to source parent, configure_page points to currentPageId", () => {
    const items = [
      { id: "child", locked: false, localizations: [{ languageCode: "ru", title: "Child" }] },
    ];
    const kb = buildMenuKeyboard(items as any, lang, i18n, "source-parent", "ADMIN", "target-page");
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("menu:back:source-parent");
    expect(callbacks).toContain("page_edit:open:target-page");
  });

  it("submenu does not include utility/system buttons (cabinet/mentor/language/admin)", () => {
    const items = [
      { id: "child", locked: false, localizations: [{ languageCode: "ru", title: "Child" }] },
    ];
    const kb = buildMenuKeyboard(items as any, lang, i18n, "parent-id", "USER", "parent-id");
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).not.toContain("cabinet:open");
    expect(callbacks).not.toContain("mentor:open");
    expect(callbacks).not.toContain("lang:picker");
    expect(callbacks).not.toContain("admin:open");
  });

  it("user role does not see configure_page", () => {
    const items = [
      { id: "sec", locked: false, localizations: [{ languageCode: "ru", title: "Sec" }] },
    ];
    const kb = buildMenuKeyboard(items as any, lang, i18n, null, "USER", undefined);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks.some((c) => c.startsWith("page_edit:open:"))).toBe(false);
  });

  it("root screen: user role hides admin_panel and configure_page but shows cabinet, mentor, language", () => {
    const items = [
      { id: "sec", locked: false, localizations: [{ languageCode: "ru", title: "Sec" }] },
    ];
    const kb = buildMenuKeyboard(items as any, lang, i18n, undefined, "USER", undefined, undefined);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).not.toContain("admin:open");
    expect(callbacks).not.toContain("page_edit:open:root");
    expect(callbacks).toContain("cabinet:open");
    expect(callbacks).toContain("mentor:open");
    expect(callbacks).toContain("lang:picker");
  });

  it("root screen: admin role shows cabinet, mentor, language", () => {
    const items = [
      { id: "sec", locked: false, localizations: [{ languageCode: "ru", title: "Sec" }] },
    ];
    const kb = buildMenuKeyboard(items as any, lang, i18n, undefined, "ADMIN", undefined, undefined);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("cabinet:open");
    expect(callbacks).toContain("mentor:open");
    expect(callbacks).toContain("lang:picker");
  });

  it("root external partner button is rendered only when externalPartnerUrl is provided", () => {
    const items = [{ id: "sec", locked: false, localizations: [{ languageCode: "ru", title: "Sec" }] }];
    const externalUrl = "https://example.com/partner";

    const kbWith = buildMenuKeyboard(items as any, lang, i18n, undefined, "USER", undefined, undefined, undefined, externalUrl);
    const rowsWith = getInlineKeyboardRows(kbWith as any);
    const hasPartnerUrl = rowsWith.some((row) => row[0]?.url === externalUrl);
    expect(hasPartnerUrl).toBe(true);

    const kbWithout = buildMenuKeyboard(items as any, lang, i18n, undefined, "USER", undefined, undefined, undefined, null);
    const rowsWithout = getInlineKeyboardRows(kbWithout as any);
    const hasPartnerUrl2 = rowsWithout.some((row) => row[0]?.url === externalUrl);
    expect(hasPartnerUrl2).toBe(false);
  });

  it("root shows partner, cabinet, mentor, language in order (USER and ADMIN roles)", () => {
    const items = [{ id: "sec", locked: false, localizations: [{ languageCode: "ru", title: "Sec" }] }];
    const externalUrl = "https://example.com/partner";

    const kb = buildMenuKeyboard(items as any, lang, i18n, undefined, "USER", undefined, undefined, undefined, externalUrl);
    const rows = getInlineKeyboardRows(kb as any);

    const cabinetIdx = rows.findIndex((row) => row[0]?.callback_data === "cabinet:open");
    const mentorIdx = rows.findIndex((row) => row[0]?.callback_data === "mentor:open");
    const partnerIdx = rows.findIndex((row) => row[0]?.url === externalUrl);
    const langIdx = rows.findIndex((row) => row[0]?.callback_data === "lang:picker");

    expect(cabinetIdx).toBeGreaterThanOrEqual(0);
    expect(mentorIdx).toBeGreaterThanOrEqual(0);
    expect(partnerIdx).toBeGreaterThanOrEqual(0);
    expect(langIdx).toBeGreaterThanOrEqual(0);
    expect(partnerIdx).toBeLessThan(cabinetIdx);
    expect(cabinetIdx).toBeLessThan(mentorIdx);
    expect(mentorIdx).toBeLessThan(langIdx);
  });

  it("all visible page buttons are one per row (vertical layout)", () => {
    const items = [
      { id: "a", locked: false, localizations: [{ languageCode: "ru", title: "A" }] },
      { id: "b", locked: false, localizations: [{ languageCode: "ru", title: "B" }] },
    ];
    const kb = buildMenuKeyboard(items as any, lang, i18n, null, undefined, undefined);
    const rows = getInlineKeyboardRows(kb as any);
    const menuOpenRows = rows.filter((row) =>
      row.some((btn) => btn.callback_data?.startsWith("menu:open:"))
    );
    menuOpenRows.forEach((row) => {
      expect(row.length).toBe(1);
    });
  });

  it("renders external menu item as native URL button when unlocked", () => {
    const items = [
      {
        id: "external-1",
        type: "EXTERNAL_LINK",
        locked: false,
        localizations: [{ languageCode: "ru", title: "Docs", externalUrl: "https://example.com/docs" }]
      }
    ];

    const kb = buildMenuKeyboard(items as any, lang, i18n, null, "USER", undefined);
    const rows = getInlineKeyboardRows(kb as any);

    expect(rows[0]?.[0]?.url).toBe("https://example.com/docs");
    expect(rows[0]?.[0]?.callback_data).toBeUndefined();
    expect(rows[0]).toHaveLength(1);
  });

  it("keeps locked external menu item as callback button for access checks", () => {
    const items = [
      {
        id: "external-locked",
        type: "EXTERNAL_LINK",
        locked: true,
        localizations: [{ languageCode: "ru", title: "Docs", externalUrl: "https://example.com/docs" }]
      }
    ];

    const kb = buildMenuKeyboard(items as any, lang, i18n, null, "USER", undefined);
    const rows = getInlineKeyboardRows(kb as any);

    expect(rows[0]?.[0]?.callback_data).toBe("menu:open:external-locked");
    expect(rows[0]?.[0]?.url).toBeUndefined();
  });

  it("renders locked section with plain title text instead of lock-prefixed label", () => {
    const items = [
      {
        id: "locked-section",
        locked: true,
        localizations: [{ languageCode: "ru", title: "Обучение" }]
      }
    ];

    const kb = buildMenuKeyboard(items as any, lang, i18n, null, "USER", undefined);
    const rows = getInlineKeyboardRows(kb as any);

    expect(rows[0]?.[0]?.text).toBe("Обучение");
  });
});

describe("Keyboards: content screen (leaf page)", () => {
  it("has back = menu:back:<parentId> and toMain = nav:root", () => {
    const kb = buildContentScreenKeyboard("parent-id", lang, i18n, {
      currentPageId: "page-id",
      userRole: "USER",
    });
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("menu:back:parent-id");
    expect(callbacks).toContain(NAV_ROOT_DATA);
  });

  it("admin sees configure_page for current page", () => {
    const kb = buildContentScreenKeyboard("parent-id", lang, i18n, {
      currentPageId: "page-id",
      userRole: "ADMIN",
    });
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("page_edit:open:page-id");
  });

  it("user does not see configure_page", () => {
    const kb = buildContentScreenKeyboard("parent-id", lang, i18n, {
      currentPageId: "page-id",
      userRole: "USER",
    });
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks.some((c) => c.startsWith("page_edit:open:"))).toBe(false);
  });

  it("nav buttons are vertical (one per row)", () => {
    const kb = buildContentScreenKeyboard("parent-id", lang, i18n);
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => {
      expect(row.length).toBe(1);
    });
  });
});

describe("Keyboards: cabinet", () => {
  it("does not include cabinet:copy_link callback (uses share URL button instead)", () => {
    const kb = buildCabinetKeyboard(lang, i18n, "https://t.me/test_bot?start=ref_abc", {
      showAdminLink: false,
    });
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).not.toContain("cabinet:copy_link");
  });

  it("uses URL button for mentor contact when mentor username is known", () => {
    const kb = buildCabinetKeyboard(lang, i18n, "https://t.me/test_bot?start=ref_abc", {
      showAdminLink: false,
      mentorUsername: "mentor_user",
    });
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).not.toContain("mentor:open");
  });

  it("is strictly vertical (one button per row)", () => {
    const kb = buildCabinetKeyboard(lang, i18n, "https://t.me/test_bot?start=ref_abc", {
      showAdminLink: true,
      mentorUsername: "mentor_user",
    });
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => {
      expect(row.length).toBe(1);
    });
  });

  it("external referral link button is placed between copy_link and my_structure", () => {
    const kb = buildCabinetKeyboard(lang, i18n, "https://t.me/test_bot?start=ref_abc", {
      showAdminLink: false,
    });
    const rows = getInlineKeyboardRows(kb as any);

    // Row 0: share URL button (URL action, no callback_data)
    expect(rows[0]?.[0]?.url).toBeDefined();
    // Row 1: our external referral link input entrypoint
    expect(rows[1]?.[0]?.callback_data).toBe("cabinet:set_external_ref_link");
    // Row 2: "my_structure"
    expect(rows[2]?.[0]?.callback_data).toBe("cabinet:structure");
  });
});

describe("Keyboards: admin", () => {
  it("does not show drip manage entrypoint in root admin list", () => {
    const kb = buildAdminKeyboard(lang, i18n);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).not.toContain("admin:drip_manage");
  });

  it("does not include preview_structure entrypoint in admin keyboard", () => {
    const kb = buildAdminKeyboard(lang, i18n);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).not.toContain("admin:preview_structure");
  });

  it("does not expose export_xlsx entrypoint in admin keyboard", () => {
    const kb = buildAdminKeyboard(lang, i18n);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).not.toContain("admin:export_xlsx");
  });

  it("does not include admin:publish entrypoint in admin keyboard", () => {
    const kb = buildAdminKeyboard(lang, i18n);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).not.toContain("admin:publish");
  });

  it("shows user management entry when canManageUsers=true (OWNER / ALPHA_OWNER UI)", () => {
    const kb = buildAdminKeyboard(lang, i18n, { canManageUsers: true } as any);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("admin:manage_user");
  });

  it("hides user management entry when canManageUsers=false (ADMIN UI)", () => {
    const kb = buildAdminKeyboard(lang, i18n, { canManageUsers: false } as any);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).not.toContain("admin:manage_user");
  });
});

describe("Keyboards: user management", () => {
  it("search prompt keyboard is vertical", () => {
    const kb = buildUserManagementPromptKeyboard(lang, i18n);
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));
  });

  it("user card keyboard toggles assign/revoke buttons and keeps callbacks short", () => {
    const assignKb = buildUserManagementCardKeyboard(lang, i18n, "11111111-1111-1111-1111-111111111111", {
      source: "search",
      canAssignAdmin: true,
      canDelete: true
    });
    const assignCallbacks = getAllCallbackData(assignKb as any);
    expect(assignCallbacks).toContain("usermgmt:assign_admin:11111111-111:search");
    expect(assignCallbacks).toContain("usermgmt:delete:11111111-111:search");
    expect(assignCallbacks).not.toContain("usermgmt:revoke_admin:11111111-111:search");
    getInlineKeyboardRows(assignKb as any).forEach((row) => expect(row.length).toBe(1));
    assignCallbacks.forEach((callback) => expect(callback.length).toBeLessThanOrEqual(64));

    const revokeKb = buildUserManagementCardKeyboard(lang, i18n, "22222222-2222-2222-2222-222222222222", {
      source: "admins",
      canRevokeAdmin: true
    });
    const revokeCallbacks = getAllCallbackData(revokeKb as any);
    expect(revokeCallbacks).toContain("usermgmt:revoke_admin:22222222-222:admins");
    expect(revokeCallbacks).not.toContain("usermgmt:assign_admin:22222222-222:admins");
    revokeCallbacks.forEach((callback) => expect(callback.length).toBeLessThanOrEqual(64));
  });

  it("admin list keyboard is clickable, vertical, and callback-safe", () => {
    const kb = buildUserManagementAdminListKeyboard(lang, i18n, [
      { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", label: "@alpha_admin" },
      { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", label: "No username" }
    ]);
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));

    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("usermgmt:view:aaaaaaaa-aaa:admins");
    expect(callbacks).toContain("usermgmt:view:bbbbbbbb-bbb:admins");
    callbacks.forEach((callback) => expect(callback.length).toBeLessThanOrEqual(64));
  });

  it("delete confirm keyboard uses second-step confirm and stays vertical", () => {
    const kb = buildUserManagementDeleteConfirmKeyboard(
      lang,
      i18n,
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
      "search"
    );
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));

    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("usermgmt:delete_confirm:cccccccc-ccc:search");
    callbacks.forEach((callback) => expect(callback.length).toBeLessThanOrEqual(64));
  });
});

describe("Keyboards: scheduled broadcasts management", () => {
  it("hub keyboard is vertical (one button per row)", () => {
    const kb = buildScheduledBroadcastHubKeyboard(lang, i18n);
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));
  });

  it("list keyboard includes scheduled_open callbacks (uuid-safe) and is vertical", () => {
    const broadcastId = "11111111-1111-1111-1111-111111111111";
    const kb = buildScheduledBroadcastListKeyboard(lang, i18n, [{ id: broadcastId, label: "item" }]);
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain(`admin:scheduled_open:${broadcastId}`);
    callbacks.forEach((c) => expect(c.length).toBeLessThanOrEqual(64));
  });

  it("detail keyboard contains stop/delete callbacks (uuid-safe) and is vertical", () => {
    const broadcastId = "22222222-2222-2222-2222-222222222222";
    const kb = buildScheduledBroadcastDetailKeyboard(lang, i18n, broadcastId);
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain(`admin:scheduled_send_now:${broadcastId}`);
    expect(callbacks).toContain(`admin:scheduled_stop:${broadcastId}`);
    expect(callbacks).toContain(`admin:scheduled_delete:${broadcastId}`);
    callbacks.forEach((c) => expect(c.length).toBeLessThanOrEqual(64));
  });
});

describe("Keyboards: page editor language hub", () => {
  it("is fully vertical and exposes edit content submenu + structure actions", () => {
    const kb = buildPageEditorKeyboard("root", [], lang, i18n, {
      editingContentLanguageCode: "en",
      hasVideo: true
    });
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));

    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("page_edit:cnt:root:en");
    expect(callbacks).toContain("page_edit:add_sec:root");
    expect(callbacks).toContain("page_edit:add_btn:root");
    expect(callbacks).toContain("page_edit:manage_buttons:root");
    expect(callbacks).toContain("page_edit:open_reminders:root");
    expect(callbacks).toContain("page_edit:back:root");
    expect(callbacks).toContain(NAV_ROOT_DATA);
    callbacks.forEach((callback) => expect(callback.length).toBeLessThanOrEqual(64));
  });

  it("exposes system buttons link when canManageSystemButtons and root", () => {
    const kb = buildPageEditorKeyboard("root", [], lang, i18n, { canManageSystemButtons: true });
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("admin:system_buttons");
  });

  it("does not expose system buttons link when canManageSystemButtons false", () => {
    const kb = buildPageEditorKeyboard("root", [], lang, i18n, {});
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).not.toContain("admin:system_buttons");
  });

  it("content submenu exposes all replace/attach actions", () => {
    const kb = buildPageEditorContentSubmenuKeyboard("root", lang, i18n, {
      editingContentLanguageCode: "en",
      hasVideo: true
    });
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));

    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("page_edit:edit_text:root:en");
    expect(callbacks).toContain("page_edit:edit_full:root:en");
    expect(callbacks).toContain("page_edit:attach_video:root");
    expect(callbacks).toContain("page_edit:detach_video:root");
    expect(callbacks).toContain("page_edit:open:root");
    expect(callbacks).toContain(NAV_ROOT_DATA);
  });
});

describe("Keyboards: button management (page editor)", () => {
  it("is fully vertical (one button per row)", () => {
    const items = [
      { id: "btn-1", title: "Продукт 1", isActive: true, type: "TEXT", targetTitle: "этот раздел" },
      { id: NAV_SLOT_BACK, title: "↩️ Назад", isActive: true, type: "TEXT", isNavSlot: true as const },
    ];
    const kb = buildButtonManagementKeyboard("page-id", items as any, lang, i18n);
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));
  });

  it("prefixes all managed items with 'Кнопка' in the header text", () => {
    const items = [
      { id: "btn-1", title: "Продукт 1", isActive: true, type: "TEXT", targetTitle: "этот раздел" },
      { id: NAV_SLOT_BACK, title: "↩️ Назад", isActive: true, type: "TEXT", isNavSlot: true as const },
      { id: NAV_SLOT_TO_MAIN, title: "🗂 В главное меню", isActive: true, type: "TEXT", isNavSlot: true as const }
    ];
    const kb = buildButtonManagementKeyboard("page-id", items as any, lang, i18n);
    const rows = getInlineKeyboardRows(kb as any);

    const openRows = rows.filter((row) => row[0]?.callback_data?.startsWith("page_edit:open:"));
    expect(openRows.length).toBeGreaterThanOrEqual(3);

    openRows.forEach((row) => {
      expect(row[0].text.startsWith("Кнопка")).toBe(true);
    });
  });

  it("includes destructive delete action for regular buttons", () => {
    const items = [
      { id: "btn-1", title: "A", isActive: true, type: "TEXT", targetTitle: "этот раздел" },
    ];
    const kb = buildButtonManagementKeyboard("page-id", items as any, lang, i18n);
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("page_edit:del_item:btn-1");
  });
});

describe("Keyboards: language-version editor", () => {
  it("hub keyboard is vertical and callbacks are short", () => {
    const kb = buildLanguageVersionHubKeyboard("ru", i18n, "en", { canManageLanguages: true });
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain("admin:langv_page_open:en:root");
    expect(callbacks).toContain("admin:langv_pages:en");
    expect(callbacks).toContain("admin:langv_preview:en");
    expect(callbacks).toContain("admin:langv_publish:en");
    expect(callbacks).not.toContain("admin:langv_save_draft:en");
    callbacks.forEach((c) => expect(c.length).toBeLessThanOrEqual(64));
  });

  it("page actions keyboard is vertical and exposes partial replace actions", () => {
    const pageId = "11111111-1111-1111-1111-111111111111";
    const kb = buildLanguageVersionPageActionsKeyboard("ru", i18n, "en", pageId, { canManageLanguages: true });
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).toContain(`admin:langv_rtxt:en:${pageId}`);
    expect(callbacks).toContain(`admin:langv_rpho:en:${pageId}`);
    expect(callbacks).toContain(`admin:langv_rvid:en:${pageId}`);
    expect(callbacks).toContain(`admin:langv_rdoc:en:${pageId}`);
    expect(callbacks).toContain(`admin:langv_rfull:en:${pageId}`);
    callbacks.forEach((c) => expect(c.length).toBeLessThanOrEqual(64));
  });

  it("preview confirm keyboard is vertical and has publish/back/main only", () => {
    const pageId = "11111111-1111-1111-1111-111111111111";
    const kb = buildLanguageVersionPreviewConfirmKeyboard("ru", i18n, "en", pageId, { canManageLanguages: true });
    const rows = getInlineKeyboardRows(kb as any);
    rows.forEach((row) => expect(row.length).toBe(1));
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks).not.toContain(`admin:langv_post_draft:en:${pageId}`);
    expect(callbacks).toContain(`admin:langv_post_publish:en:${pageId}`);
    expect(callbacks).toContain(`admin:langv_page_open:en:${pageId}`);
    expect(callbacks).toContain(NAV_ROOT_DATA);
  });
});

describe("Keyboards: language-management visibility gating", () => {
  it("admin hub shows admin:languages only for canManageLanguages=true", () => {
    const kbAlpha = buildAdminKeyboard(lang, i18n, { canManageLanguages: true } as any);
    const callbacksAlpha = getAllCallbackData(kbAlpha as any);
    expect(callbacksAlpha).toContain("admin:languages");

    const kbOwner = buildAdminKeyboard(lang, i18n, { canManageLanguages: false } as any);
    const callbacksOwner = getAllCallbackData(kbOwner as any);
    expect(callbacksOwner).not.toContain("admin:languages");
  });

  it("language-version hub keyboard hides langv_* callbacks when canManageLanguages=false", () => {
    const kb = buildLanguageVersionHubKeyboard("ru", i18n, "en", { canManageLanguages: false });
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks.some((c) => c.startsWith("admin:langv_"))).toBe(false);
    expect(callbacks).not.toContain("admin:langv_page_open:en:root");
  });

  it("language-version page actions keyboard hides langv_* replace actions when canManageLanguages=false", () => {
    const pageId = "11111111-1111-1111-1111-111111111111";
    const kb = buildLanguageVersionPageActionsKeyboard("ru", i18n, "en", pageId, { canManageLanguages: false });
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks.some((c) => c.startsWith("admin:langv_r"))).toBe(false);
  });

  it("language-version preview confirm keyboard hides langv_post_* actions when canManageLanguages=false", () => {
    const pageId = "11111111-1111-1111-1111-111111111111";
    const kb = buildLanguageVersionPreviewConfirmKeyboard("ru", i18n, "en", pageId, { canManageLanguages: false });
    const callbacks = getAllCallbackData(kb as any);
    expect(callbacks.some((c) => c.startsWith("admin:langv_post_"))).toBe(false);
    expect(callbacks).not.toContain(`admin:langv_post_publish:en:${pageId}`);
  });
});

describe("Keyboards: navigation row", () => {
  it("back: true yields NAV_BACK_DATA", () => {
    const row = buildNavigationRow(i18n, lang, { back: true, toMain: true });
    const backBtn = row.find((b) => (b as any).callback_data === NAV_BACK_DATA);
    expect(backBtn).toBeDefined();
  });

  it("toMain: true yields NAV_ROOT_DATA", () => {
    const row = buildNavigationRow(i18n, lang, { toMain: true });
    const mainBtn = row.find((b) => (b as any).callback_data === NAV_ROOT_DATA);
    expect(mainBtn).toBeDefined();
  });
});

describe("Keyboards: language picker", () => {
  it("buildLanguageKeyboard filters by provided languageCodes", () => {
    const kb = buildLanguageKeyboard(i18n, lang, ["en"]);
    const rows = getInlineKeyboardRows(kb as any);
    const langRows = rows.filter((row) => row[0]?.callback_data?.startsWith("lang:set:"));
    expect(langRows).toHaveLength(1);
    expect(langRows[0][0].callback_data).toContain("lang:set:en");
  });
});
