import { Markup } from "telegraf";
import type { MenuItem, MenuItemLocalization } from "@prisma/client";

import { makeCallbackData, toShortId } from "../common/callback-data";
import type { I18nService } from "../modules/i18n/i18n.service";
import { isAdminAreaUser } from "../modules/permissions/capabilities";

const PAGE_EDIT_PREFIX = "page_edit";
export const NAV_BACK_DATA = "nav:back";
export const NAV_ROOT_DATA = "nav:root";
/** Slot ids for nav buttons in unified page button order (must match MenuService.NAV_SLOT_*). */
export const NAV_SLOT_BACK = "__nav_back";
export const NAV_SLOT_TO_MAIN = "__nav_to_main";
/** Slot ids for system buttons on root menu (must match MenuService.SYS_SLOT_*). */
const SYS_SLOT_PARTNER_REGISTER = "__sys_partner_register";
const SYS_SLOT_MY_CABINET = "__sys_my_cabinet";
const SYS_SLOT_MENTOR_CONTACT = "__sys_mentor_contact";
const SYS_SLOT_LANGUAGE = "__sys_lang";
const SYS_SLOT_ADMIN_PANEL = "__sys_admin_panel";
const SYS_SLOT_CONFIGURE_PAGE = "__sys_configure_page";
const SYS_SLOT_CONFIGURED_MARKER = "__sys_configured_marker";
const ONBOARDING_PREFIX = "onboarding";

export const SCENE_CANCEL_DATA = "scene:cancel";

/** Keyboard shown after "action_stale": В главное меню; for admin also Вернуться в админку. */
export const buildStaleActionKeyboard = (
  i18n: I18nService,
  languageCode: string,
  isAdmin: boolean
) => {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]
  ];
  if (isAdmin) {
    rows.push([Markup.button.callback(i18n.t(languageCode, "return_to_admin"), makeCallbackData("admin", "open"))]);
  }
  return Markup.inlineKeyboard(rows);
};

/** One row: Назад (optional) + В главное меню (optional). Use for all non-root screens. */
export const buildNavigationRow = (
  i18n: I18nService,
  languageCode: string,
  opts: { back?: string | true; toMain?: boolean }
): ReturnType<typeof Markup.button.callback>[] => {
  const row: ReturnType<typeof Markup.button.callback>[] = [];
  if (opts.back === true) {
    row.push(Markup.button.callback(i18n.t(languageCode, "back"), NAV_BACK_DATA));
  } else if (typeof opts.back === "string") {
    row.push(Markup.button.callback(i18n.t(languageCode, "back"), opts.back));
  }
  if (opts.toMain) {
    row.push(Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA));
  }
  return row;
};

export const buildCancelKeyboard = (i18n: I18nService, languageCode: string) =>
  Markup.inlineKeyboard([[Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)]]);

export const buildSceneCancelBackKeyboard = (
  i18n: I18nService,
  languageCode: string,
  backCallbackData?: string
) => {
  const row = backCallbackData
    ? [
        Markup.button.callback(i18n.t(languageCode, "back"), backCallbackData),
        Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)
      ]
    : [Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)];
  return Markup.inlineKeyboard([row]);
};

/** Wizard step: Назад, Отмена, optionally Пропустить; then В главное меню, optionally Вернуться к странице, Вернуться в админку */
export const buildWizardStepKeyboard = (
  i18n: I18nService,
  languageCode: string,
  opts: { backData: string; skip?: boolean; fromPageId?: string }
) => {
  const row1 = [
    Markup.button.callback(i18n.t(languageCode, "back"), opts.backData),
    Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)
  ];
  if (opts.skip) {
    row1.push(Markup.button.callback(i18n.t(languageCode, "skip_btn"), makeCallbackData("create_menu", "skip", "content")));
  }
  const rows: ReturnType<typeof Markup.button.callback>[][] = [row1];
  rows.push(buildNavigationRow(i18n, languageCode, { toMain: true }));
  if (opts.fromPageId) {
    rows.push([
      Markup.button.callback(i18n.t(languageCode, "return_to_page"), makeCallbackData(PAGE_EDIT_PREFIX, "open", opts.fromPageId)),
      Markup.button.callback(i18n.t(languageCode, "return_to_admin"), makeCallbackData("admin", "open"))
    ]);
  }
  return Markup.inlineKeyboard(rows);
};

/** Preview step: Сохранить, Изменить название/тип/содержимое, Назад, Отмена + return row */
export const buildCreateMenuPreviewKeyboard = (
  i18n: I18nService,
  languageCode: string,
  fromPageId?: string
) => {
  const prefix = "create_menu";
  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback(i18n.t(languageCode, "wizard_save"), makeCallbackData(prefix, "preview", "save"))],
    [
      Markup.button.callback(i18n.t(languageCode, "wizard_edit_title"), makeCallbackData(prefix, "preview", "edit_title")),
      Markup.button.callback(i18n.t(languageCode, "wizard_edit_type"), makeCallbackData(prefix, "preview", "edit_type"))
    ],
    [Markup.button.callback(i18n.t(languageCode, "wizard_edit_content"), makeCallbackData(prefix, "preview", "edit_content"))],
    [
      Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData(prefix, "back", "3")),
      Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)
    ],
    buildNavigationRow(i18n, languageCode, { toMain: true })
  ];
  if (fromPageId) {
    rows.push([
      Markup.button.callback(i18n.t(languageCode, "return_to_page"), makeCallbackData(PAGE_EDIT_PREFIX, "open", fromPageId)),
      Markup.button.callback(i18n.t(languageCode, "return_to_admin"), makeCallbackData("admin", "open"))
    ]);
  }
  return Markup.inlineKeyboard(rows);
};

export const buildLanguageSceneKeyboard = (
  i18n: I18nService,
  languageCode: string,
  prefix: string = "scene_lang",
  opts?: { fromPageId?: string }
) => {
  const langs = i18n.availableLanguages();
  const rows = langs.map((l) => [Markup.button.callback(l.label, makeCallbackData(prefix, "lang", l.code))]);
  rows.push([Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)]);
  rows.push(buildNavigationRow(i18n, languageCode, { toMain: true }));
  if (opts?.fromPageId) {
    rows.push([
      Markup.button.callback(i18n.t(languageCode, "return_to_page"), makeCallbackData(PAGE_EDIT_PREFIX, "open", opts.fromPageId)),
      Markup.button.callback(i18n.t(languageCode, "return_to_admin"), makeCallbackData("admin", "open"))
    ]);
  }
  return Markup.inlineKeyboard(rows);
};

const DRIP_W_PREFIX = "drip_w";

/** Drip wizard: all buttons vertical (one per row). */
export const buildDripTriggerKeyboard = (i18n: I18nService, languageCode: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "drip_trigger_registration"), makeCallbackData(DRIP_W_PREFIX, "trigger", "ON_REGISTRATION"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_trigger_payment"), makeCallbackData(DRIP_W_PREFIX, "trigger", "ON_PAYMENT"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_trigger_tag"), makeCallbackData(DRIP_W_PREFIX, "trigger", "ON_TAG_ASSIGNED"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_trigger_event"), makeCallbackData(DRIP_W_PREFIX, "trigger", "ON_EVENT"))],
    [Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, languageCode, { toMain: true }).map((btn) => [btn])
  ]);

export const buildDripDelayKeyboard = (i18n: I18nService, languageCode: string, stepNumber: number) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "drip_delay_now"), makeCallbackData(DRIP_W_PREFIX, "delay", "0d"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_delay_1d"), makeCallbackData(DRIP_W_PREFIX, "delay", "1d"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_delay_2d"), makeCallbackData(DRIP_W_PREFIX, "delay", "2d"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_delay_3d"), makeCallbackData(DRIP_W_PREFIX, "delay", "3d"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_delay_7d"), makeCallbackData(DRIP_W_PREFIX, "delay", "7d"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_delay_other"), makeCallbackData(DRIP_W_PREFIX, "delay", "other"))],
    [Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, languageCode, { toMain: true }).map((btn) => [btn])
  ]);

export const buildDripCustomUnitKeyboard = (i18n: I18nService, languageCode: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "drip_unit_minutes"), makeCallbackData(DRIP_W_PREFIX, "unit", "MINUTES"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_unit_hours"), makeCallbackData(DRIP_W_PREFIX, "unit", "HOURS"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_unit_days"), makeCallbackData(DRIP_W_PREFIX, "unit", "DAYS"))],
    [Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, languageCode, { toMain: true }).map((btn) => [btn])
  ]);

export const buildDripAfterStepKeyboard = (i18n: I18nService, languageCode: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "drip_btn_add_step"), makeCallbackData(DRIP_W_PREFIX, "add_step"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_btn_edit_last"), makeCallbackData(DRIP_W_PREFIX, "edit_last"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_btn_delete_last"), makeCallbackData(DRIP_W_PREFIX, "delete_last"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_btn_finish"), makeCallbackData(DRIP_W_PREFIX, "finish"))],
    [Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, languageCode, { toMain: true }).map((btn) => [btn])
  ]);

export const buildDripConfirmKeyboard = (i18n: I18nService, languageCode: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "drip_btn_save"), makeCallbackData(DRIP_W_PREFIX, "save"))],
    [Markup.button.callback(i18n.t(languageCode, "drip_btn_edit_campaign"), makeCallbackData(DRIP_W_PREFIX, "edit"))],
    [Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, languageCode, { toMain: true }).map((btn) => [btn])
  ]);

const MENU_TYPE_KEYS = ["type_text", "type_photo", "type_video", "type_document", "type_link", "item_type_section"] as const;
const MENU_TYPE_VALUES = ["TEXT", "PHOTO", "VIDEO", "DOCUMENT", "LINK", "SUBMENU"] as const;

export const buildItemTypeSceneKeyboard = (
  i18n: I18nService,
  languageCode: string,
  prefix: string,
  backCallbackData?: string
) => {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [
      Markup.button.callback(i18n.t(languageCode, "type_text"), makeCallbackData(prefix, "type", "TEXT")),
      Markup.button.callback(i18n.t(languageCode, "type_photo"), makeCallbackData(prefix, "type", "PHOTO")),
      Markup.button.callback(i18n.t(languageCode, "type_video"), makeCallbackData(prefix, "type", "VIDEO"))
    ],
    [
      Markup.button.callback(i18n.t(languageCode, "type_document"), makeCallbackData(prefix, "type", "DOCUMENT")),
      Markup.button.callback(i18n.t(languageCode, "type_link"), makeCallbackData(prefix, "type", "LINK")),
      Markup.button.callback(i18n.t(languageCode, "item_type_section"), makeCallbackData(prefix, "type", "SUBMENU"))
    ]
  ];
  if (backCallbackData) {
    rows.push([
      Markup.button.callback(i18n.t(languageCode, "back"), backCallbackData),
      Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)
    ]);
  } else {
    rows.push([Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)]);
  }
  return Markup.inlineKeyboard(rows);
};

export const buildParentRootKeyboard = (i18n: I18nService, languageCode: string, prefix: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "parent_root_main_menu"), makeCallbackData(prefix, "parent", "root"))],
    [Markup.button.callback(i18n.t(languageCode, "cancel_btn"), SCENE_CANCEL_DATA)]
  ]);

export const buildReturnToAdminKeyboard = (i18n: I18nService, languageCode: string) =>
  Markup.inlineKeyboard([[Markup.button.callback(i18n.t(languageCode, "return_to_admin"), makeCallbackData("admin", "open"))]]);

export const buildReturnToPageEditorKeyboard = (pageId: string, i18n: I18nService, languageCode: string) =>
  Markup.inlineKeyboard([[Markup.button.callback(i18n.t(languageCode, "return_to_page"), makeCallbackData(PAGE_EDIT_PREFIX, "open", pageId))]]);

export const buildReturnToAdminOrPageKeyboard = (pageId: string, i18n: I18nService, languageCode: string) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "return_to_page"), makeCallbackData(PAGE_EDIT_PREFIX, "open", pageId))],
    [Markup.button.callback(i18n.t(languageCode, "return_to_admin"), makeCallbackData("admin", "open"))]
  ]);

export const buildReturnToButtonManagementKeyboard = (pageId: string, i18n: I18nService, languageCode: string) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(i18n.t(languageCode, "return_to_button_management"), makeCallbackData(PAGE_EDIT_PREFIX, "open_buttons", pageId)),
      ...buildNavigationRow(i18n, languageCode, { toMain: true })
    ]
  ]);

/** Central role check: OWNER/ALPHA_OWNER/ADMIN see admin buttons. Normal users never do. */
export const isAdminRole = (role?: string): boolean => isAdminAreaUser(role as any);

/**
 * User-facing menu keyboard: strict vertical list layout.
 * If slotOrder is provided, rows follow that order (content ids + NAV_SLOT_BACK, NAV_SLOT_TO_MAIN).
 * Otherwise: content items in array order, then nav row(s) at the end.
 */
export const buildMenuKeyboard = (
  items: Array<
    (MenuItem & { locked: boolean; localizations: MenuItemLocalization[] }) | {
      id: string;
      locked: boolean;
      localizations: MenuItemLocalization[];
      type?: string;
      targetMenuItemId?: string | null;
    }
  >,
  languageCode: string,
  i18n: I18nService,
  parentId?: string | null,
  userRole?: string,
  /** When viewing a section/subsection, pass its id so "Настроить страницу" opens editor for THIS page. */
  currentPageId?: string | null,
  /** Optional: full slot order (content ids + NAV_SLOT_BACK, NAV_SLOT_TO_MAIN). When set, nav buttons are interleaved per order. */
  slotOrder?: string[] | null,
  mentorUsername?: string | null,
  externalPartnerUrl?: string | null,
  /** Id of __sys_target_partner_register. When item is SECTION_LINK to this target: if externalPartnerUrl use url button, else hide. */
  partnerRegisterTargetId?: string | null,
  /** Id of __sys_target_mentor_contact. When item is SECTION_LINK to this: if mentorUsername use url button (direct to chat), else callback. */
  mentorContactTargetId?: string | null,
  /** Кнопки «Ссылка на чат/канал» — показываются в подменю после оплаты */
  productChatLinks?: Array<{ link: string; label: string }>
) => {
  const showAdminButtons = isAdminRole(userRole);
  const isRootScreen = parentId === undefined;
  const pageIdForConfigure = currentPageId ?? parentId ?? "root";
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const rootSlotSet = isRootScreen ? new Set(slotOrder ?? []) : new Set<string>();
  const assumeAllSysEnabled = isRootScreen && rootSlotSet.size === 0;
  const showRootSys = (sysSlotId: string): boolean => {
    // Backward compatibility: if slotOrder not provided for root, keep current behavior
    // (show all system buttons unless explicitly configured).
    return assumeAllSysEnabled ? true : rootSlotSet.has(sysSlotId);
  };

  let rows: Array<Array<ReturnType<typeof Markup.button.callback> | ReturnType<typeof Markup.button.url>>>;

  const isPartnerRegisterLink = (item: { type?: string; targetMenuItemId?: string | null }): boolean =>
    item.type === "SECTION_LINK" && partnerRegisterTargetId != null && item.targetMenuItemId === partnerRegisterTargetId;

  const isMentorContactLink = (item: { type?: string; targetMenuItemId?: string | null }): boolean =>
    item.type === "SECTION_LINK" && mentorContactTargetId != null && item.targetMenuItemId === mentorContactTargetId;

  const buildRowForItem = (item: (typeof items)[number]) => {
    const localization = i18n.pickLocalized(item.localizations, languageCode);
    const title = localization?.title ?? item.id;
    const label = title;
    const externalUrl = localization?.externalUrl?.trim();
    if (isPartnerRegisterLink(item)) {
      if (externalPartnerUrl) return [Markup.button.url(label, externalPartnerUrl)];
      return null;
    }
    if (isMentorContactLink(item) && mentorUsername?.trim()) {
      return [Markup.button.url(label, `https://t.me/${mentorUsername.trim()}`)];
    }
    if (item.type === "EXTERNAL_LINK" && !item.locked && externalUrl) {
      return [Markup.button.url(label, externalUrl)];
    }
    return [Markup.button.callback(label, makeCallbackData("menu", "open", item.id))];
  };

  if (slotOrder != null && slotOrder.length > 0) {
    rows = [];
    if (productChatLinks?.length) {
      for (const { link, label } of productChatLinks) {
        rows.push([Markup.button.url(label, link)]);
      }
    }
    const backCallback = parentId != null ? makeCallbackData("menu", "back", parentId || "root") : null;
    for (const slotId of slotOrder) {
      if (slotId === NAV_SLOT_BACK && backCallback) {
        rows.push([Markup.button.callback(i18n.t(languageCode, "back"), backCallback)]);
      } else if (slotId === NAV_SLOT_TO_MAIN) {
        rows.push([Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]);
      } else {
        const item = itemsById.get(slotId);
        if (item) {
          const row = buildRowForItem(item);
          if (row) rows.push(row);
        }
      }
    }
  } else {
    rows = [];
    if (productChatLinks?.length) {
      for (const { link, label } of productChatLinks) {
        rows.push([Markup.button.url(label, link)]);
      }
    }
    rows.push(...items.map(buildRowForItem).filter((r): r is NonNullable<typeof r> => r != null));
  }

  // Utility/system buttons should not be mixed into regular pages/submenus.
  // Root screen keeps utility buttons; submenus keep only content + navigation (+ configure for admin).
  // Root system buttons can be hidden via PageNavConfig slotOrder sys-slots.
  if (isRootScreen) {
    if (showRootSys(SYS_SLOT_PARTNER_REGISTER) && externalPartnerUrl) {
      rows.push([Markup.button.url(i18n.t(languageCode, "partner_register_btn"), externalPartnerUrl)]);
    }
    // Мой кабинет, Связь с наставником, Сменить язык — для всех пользователей (в т.ч. USER).
    // Pending owner (ожидающий активации) не доходит до buildMenuKeyboard — видит пустой экран в sendRootWithWelcome.
    if (showRootSys(SYS_SLOT_MY_CABINET)) {
      rows.push([Markup.button.callback(i18n.t(languageCode, "my_cabinet"), makeCallbackData("cabinet", "open"))]);
    }
    if (showRootSys(SYS_SLOT_MENTOR_CONTACT)) {
      const mentorUrl = mentorUsername?.trim() ? `https://t.me/${mentorUsername.trim()}` : null;
      rows.push([
        mentorUrl
          ? Markup.button.url(i18n.t(languageCode, "mentor_contact"), mentorUrl)
          : Markup.button.callback(i18n.t(languageCode, "mentor_contact"), makeCallbackData("mentor", "open"))
      ]);
    }
    if (showRootSys(SYS_SLOT_LANGUAGE)) {
      rows.push([Markup.button.callback(i18n.t(languageCode, "change_language"), makeCallbackData("lang", "picker"))]);
    }
    if (showAdminButtons && showRootSys(SYS_SLOT_ADMIN_PANEL)) {
      rows.push([Markup.button.callback(i18n.t(languageCode, "admin_panel"), makeCallbackData("admin", "open"))]);
    }
    if (showAdminButtons && showRootSys(SYS_SLOT_CONFIGURE_PAGE)) {
      rows.push([Markup.button.callback(i18n.t(languageCode, "configure_page"), makeCallbackData(PAGE_EDIT_PREFIX, "open", pageIdForConfigure ?? "root"))]);
    }
  } else if (showAdminButtons) {
    rows.push([Markup.button.callback(i18n.t(languageCode, "configure_page"), makeCallbackData(PAGE_EDIT_PREFIX, "open", pageIdForConfigure ?? "root"))]);
  }

  if (parentId !== undefined && (slotOrder == null || slotOrder.length === 0)) {
    const navRow = buildNavigationRow(i18n, languageCode, {
      back: makeCallbackData("menu", "back", parentId || "root"),
      toMain: true
    });
    for (const btn of navRow) {
      rows.push([btn]);
    }
  }

  return Markup.inlineKeyboard(rows);
};

export type PageEditorChild = {
  id: string;
  title: string;
  isActive: boolean;
  type: "SUBMENU" | "TEXT" | "PHOTO" | "VIDEO" | "DOCUMENT" | "LINK" | "SECTION_LINK" | "EXTERNAL_LINK";
};

/** Submenu with content-editing options (replace text/photo/video/document, full replace, attach video). */
export const buildPageEditorContentSubmenuKeyboard = (
  pageId: string,
  languageCode: string,
  i18n: I18nService,
  opts?: { hasVideo?: boolean; editingContentLanguageCode?: string }
) => {
  const editingContentLanguageCode = opts?.editingContentLanguageCode ?? languageCode;
  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback("✏️ " + i18n.t(languageCode, "langv_btn_replace_text"), makeCallbackData(PAGE_EDIT_PREFIX, "edit_text", pageId, editingContentLanguageCode))],
    [Markup.button.callback("🖼 " + i18n.t(languageCode, "langv_btn_replace_photo"), makeCallbackData(PAGE_EDIT_PREFIX, "edit_photo", pageId, editingContentLanguageCode))],
    [Markup.button.callback("🎬 " + i18n.t(languageCode, "langv_btn_replace_video"), makeCallbackData(PAGE_EDIT_PREFIX, "edit_video", pageId, editingContentLanguageCode))],
    [Markup.button.callback("📄 " + i18n.t(languageCode, "langv_btn_replace_document"), makeCallbackData(PAGE_EDIT_PREFIX, "edit_document", pageId, editingContentLanguageCode))],
    [Markup.button.callback("🔁 " + i18n.t(languageCode, "langv_btn_full_replace"), makeCallbackData(PAGE_EDIT_PREFIX, "edit_full", pageId, editingContentLanguageCode))],
    [Markup.button.callback("🎬 " + i18n.t(languageCode, "page_attach_video"), makeCallbackData(PAGE_EDIT_PREFIX, "attach_video", pageId))],
  ];
  if (opts?.hasVideo) {
    rows.push([Markup.button.callback("🗑 " + i18n.t(languageCode, "page_detach_video"), makeCallbackData(PAGE_EDIT_PREFIX, "detach_video", pageId))]);
  }
  rows.push([Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData(PAGE_EDIT_PREFIX, "open", pageId))]);
  for (const btn of buildNavigationRow(i18n, languageCode, { toMain: true })) {
    rows.push([btn]);
  }
  return Markup.inlineKeyboard(rows);
};

export const buildPageEditorKeyboard = (
  pageId: string,
  _children: PageEditorChild[],
  languageCode: string,
  i18n: I18nService,
  opts?: { hasVideo?: boolean; editingContentLanguageCode?: string; canManageSystemButtons?: boolean }
) => {
  const editingContentLanguageCode = opts?.editingContentLanguageCode ?? languageCode;
  const rows: ReturnType<typeof Markup.button.callback>[][] = [
    [Markup.button.callback("✏️ " + i18n.t(languageCode, "page_edit_content"), makeCallbackData(PAGE_EDIT_PREFIX, "cnt", pageId, editingContentLanguageCode))],
    [Markup.button.callback("➕ " + i18n.t(languageCode, "page_add_section"), makeCallbackData(PAGE_EDIT_PREFIX, "add_sec", pageId))],
    [Markup.button.callback("🔗 " + i18n.t(languageCode, "page_add_button"), makeCallbackData(PAGE_EDIT_PREFIX, "add_btn", pageId))],
    [Markup.button.callback("🧩 " + i18n.t(languageCode, "page_manage_buttons"), makeCallbackData(PAGE_EDIT_PREFIX, "manage_buttons", pageId))],
    ...(pageId === "root" && opts?.canManageSystemButtons
      ? [[Markup.button.callback("🧩 " + i18n.t(languageCode, "admin_system_buttons"), makeCallbackData("admin", "system_buttons"))]]
      : []),
    [Markup.button.callback(i18n.t(languageCode, "reminders_hub_title"), makeCallbackData(PAGE_EDIT_PREFIX, "open_reminders", pageId))],
  ];

  if (pageId !== "root") {
    rows.push([Markup.button.callback(i18n.t(languageCode, "page_delete_page"), makeCallbackData(PAGE_EDIT_PREFIX, "delete", pageId))]);
  }
  rows.push([Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData(PAGE_EDIT_PREFIX, "back", pageId))]);
  for (const btn of buildNavigationRow(i18n, languageCode, { toMain: true })) {
    rows.push([btn]);
  }

  return Markup.inlineKeyboard(rows);
};

export type ButtonManagementItem = PageEditorChild & { targetTitle?: string; isNavSlot?: true };

export const buildButtonManagementKeyboard = (
  pageId: string,
  items: ButtonManagementItem[],
  languageCode: string,
  i18n: I18nService
) => {
  const short = (labels: { ru: string; en: string; de?: string }): string => {
    const lc = (languageCode ?? "ru").toLowerCase();
    if (lc.startsWith("en")) return labels.en;
    if (lc.startsWith("de") && labels.de) return labels.de;
    return labels.ru;
  };
  const upLabel = short({ ru: "⬆️ Вверх", en: "⬆️ Up", de: "⬆️ Hoch" });
  const downLabel = short({ ru: "⬇️ Вниз", en: "⬇️ Down", de: "⬇️ Runter" });

  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (const item of items) {
    const statusLabel = item.isActive ? i18n.t(languageCode, "item_active") : i18n.t(languageCode, "item_inactive");
    const statusIcon = item.isActive ? "✅" : "➖";

    if (item.isNavSlot) {
      // Header row (tap to view details)
      rows.push([
        Markup.button.callback(
          `Кнопка ${item.title} · ${statusIcon} ${statusLabel}`,
          makeCallbackData(PAGE_EDIT_PREFIX, "open", item.id)
        )
      ]);

      const toggleKey = item.isActive ? "btn_disable" : "btn_enable";
      const toggleIcon = item.isActive ? "➖" : "✅";
      rows.push([Markup.button.callback(`${toggleIcon} ${i18n.t(languageCode, toggleKey)}`, makeCallbackData(PAGE_EDIT_PREFIX, "toggle_nav", item.id))]);
      rows.push([Markup.button.callback(upLabel, makeCallbackData(PAGE_EDIT_PREFIX, "up", item.id))]);
      rows.push([Markup.button.callback(downLabel, makeCallbackData(PAGE_EDIT_PREFIX, "down", item.id))]);
    } else {
      const targetLabel = item.targetTitle ?? i18n.t(languageCode, "this_section");
      rows.push([
        Markup.button.callback(
          `Кнопка «${item.title}» → ${targetLabel} · ${statusIcon} ${statusLabel}`,
          makeCallbackData(PAGE_EDIT_PREFIX, "open", item.id)
        )
      ]);

      const toggleKey = item.isActive ? "btn_disable" : "btn_enable";
      rows.push([Markup.button.callback(`✏️ ${i18n.t(languageCode, "btn_rename")}`, makeCallbackData(PAGE_EDIT_PREFIX, "btn_rename", item.id))]);
      if (item.type === "SECTION_LINK") {
        rows.push([Markup.button.callback(`🎯 ${i18n.t(languageCode, "btn_change_target")}`, makeCallbackData(PAGE_EDIT_PREFIX, "btn_link", item.id))]);
      }
      const toggleIcon = item.isActive ? "➖" : "✅";
      rows.push([Markup.button.callback(`${toggleIcon} ${i18n.t(languageCode, toggleKey)}`, makeCallbackData(PAGE_EDIT_PREFIX, "toggle", item.id))]);
      rows.push([Markup.button.callback(upLabel, makeCallbackData(PAGE_EDIT_PREFIX, "up", item.id))]);
      rows.push([Markup.button.callback(downLabel, makeCallbackData(PAGE_EDIT_PREFIX, "down", item.id))]);
      rows.push([Markup.button.callback(`❌ ${i18n.t(languageCode, "delete_item")}`, makeCallbackData(PAGE_EDIT_PREFIX, "del_item", item.id))]);
    }
  }
  // Navigation (vertical)
  rows.push([Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData(PAGE_EDIT_PREFIX, "back", pageId))]);
  rows.push([Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]);
  return Markup.inlineKeyboard(rows);
};

/** Keyboard for leaf content (no submenu): nav buttons vertical; optional productChatLinks (URL buttons after payment); optional admin. */
export const buildContentScreenKeyboard = (
  parentId: string | null,
  languageCode: string,
  i18n: I18nService,
  opts?: {
    currentPageId?: string;
    userRole?: string;
    slotOrder?: string[] | null;
    /** Кнопки «Ссылка на чат/канал» — показываются после оплаты в этой секции */
    productChatLinks?: Array<{ link: string; label: string }>;
  }
) => {
  const rows: (ReturnType<typeof Markup.button.callback> | ReturnType<typeof Markup.button.url>)[][] = [];
  const backCallback = makeCallbackData("menu", "back", parentId ?? "root");

  if (opts?.productChatLinks?.length) {
    for (const { link, label } of opts.productChatLinks) {
      rows.push([Markup.button.url(label, link)]);
    }
  }
  if (opts?.slotOrder != null && opts.slotOrder.length > 0) {
    for (const slotId of opts.slotOrder) {
      if (slotId === NAV_SLOT_BACK) {
        rows.push([Markup.button.callback(i18n.t(languageCode, "back"), backCallback)]);
      } else if (slotId === NAV_SLOT_TO_MAIN) {
        rows.push([Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]);
      }
    }
  } else {
    const navRow = buildNavigationRow(i18n, languageCode, { back: backCallback, toMain: true });
    for (const btn of navRow) {
      rows.push([btn]);
    }
  }
  if (opts?.currentPageId && isAdminRole(opts.userRole)) {
    rows.push([
      Markup.button.callback(i18n.t(languageCode, "configure_page"), makeCallbackData(PAGE_EDIT_PREFIX, "open", opts.currentPageId))
    ]);
  }
  return Markup.inlineKeyboard(rows);
};

export const buildPageDeleteConfirmKeyboard = (pageId: string, languageCode: string, i18n: I18nService) => {
  const rows = [
    [Markup.button.callback(i18n.t(languageCode, "page_delete_confirm_btn"), makeCallbackData(PAGE_EDIT_PREFIX, "confirm_del", pageId))],
    [
      Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData(PAGE_EDIT_PREFIX, "back", pageId)),
      Markup.button.callback(i18n.t(languageCode, "cancel_btn"), makeCallbackData(PAGE_EDIT_PREFIX, "cancel_del", pageId))
    ],
    buildNavigationRow(i18n, languageCode, { toMain: true })
  ];
  return Markup.inlineKeyboard(rows);
};

export const buildPageDeleteItemConfirmKeyboard = (
  itemId: string,
  parentPageId: string,
  languageCode: string,
  i18n: I18nService,
  fromButtonManagement?: boolean
) => {
  const backAction = fromButtonManagement ? "open_buttons" : "open";
  const rows = [
    [Markup.button.callback(i18n.t(languageCode, "page_delete_confirm_btn"), makeCallbackData(PAGE_EDIT_PREFIX, "confirm_del_item", itemId))],
    [
      Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData(PAGE_EDIT_PREFIX, backAction, parentPageId)),
      Markup.button.callback(i18n.t(languageCode, "cancel_btn"), makeCallbackData(PAGE_EDIT_PREFIX, "cancel_del_item", itemId))
    ],
    buildNavigationRow(i18n, languageCode, { toMain: true })
  ];
  return Markup.inlineKeyboard(rows);
};

export const buildLanguageKeyboard = (i18n: I18nService, languageCode: string, languageCodes?: string[]) => {
  const all = i18n.availableLanguages();
  const normalizedCodes =
    languageCodes && languageCodes.length > 0 ? languageCodes.map((c) => String(c).toLowerCase()) : undefined;

  const languages = normalizedCodes
    ? normalizedCodes
        .map((code) => all.find((l) => l.code === code) ?? ({ code: code as any, label: code } as any))
        // Preserve order but deduplicate by code.
        .filter((l, idx, arr) => arr.findIndex((x) => x.code === l.code) === idx)
    : all;

  const rows = languages.map((language) => [
    Markup.button.callback(language.label, makeCallbackData("lang", "set", language.code))
  ]);

  rows.push(buildNavigationRow(i18n, languageCode, { back: true, toMain: true }));
  return Markup.inlineKeyboard(rows);
};

export const buildCabinetKeyboard = (
  languageCode: string,
  i18n: I18nService,
  referralLink: string,
  opts?: {
    showPayButton?: boolean;
    showAdminLink?: boolean;
    mentorUsername?: string | null;
    showLanguageButton?: boolean;
    showRefundButton?: boolean;
  }
) => {
  const short = (labels: { ru: string; en: string }): string => {
    const lc = (languageCode ?? "ru").toLowerCase();
    return lc.startsWith("en") ? labels.en : labels.ru;
  };
  const shareText = short({
    // Short, share-ready and more "selling" than a greeting.
    // Leading newline helps Telegram render a clearer separation between the URL line and the text block.
    ru: "\n👆 Привет! Посмотри как работает эта бизнес-система, жми на ссылку!",
    en: "\n👆 Hi! See how this business system works — tap the link!"
  });
  const shareUrl =
    "https://t.me/share/url?url=" +
    encodeURIComponent(referralLink) +
    "&text=" +
    encodeURIComponent(shareText);

  // Cabinet UX requirement: strictly vertical layout (one button per row).
  const rows: Array<Array<ReturnType<typeof Markup.button.callback> | ReturnType<typeof Markup.button.url>>> = [];

  rows.push([Markup.button.url(i18n.t(languageCode, "copy_link"), shareUrl)]);
  rows.push([Markup.button.callback(i18n.t(languageCode, "cabinet_set_external_ref_link"), makeCallbackData("cabinet", "set_external_ref_link"))]);
  rows.push([Markup.button.callback(i18n.t(languageCode, "my_structure"), makeCallbackData("cabinet", "structure"))]);
  rows.push([Markup.button.callback(i18n.t(languageCode, "structure_export"), makeCallbackData("export", "structure"))]);
  if (opts?.showLanguageButton ?? true) {
    rows.push([Markup.button.callback(i18n.t(languageCode, "change_language"), makeCallbackData("lang", "picker"))]);
  }
  rows.push([
    opts?.mentorUsername
      ? Markup.button.url(i18n.t(languageCode, "mentor_contact"), `https://t.me/${opts.mentorUsername}`)
      : Markup.button.callback(i18n.t(languageCode, "mentor_contact"), makeCallbackData("mentor", "open"))
  ]);

  if (opts?.showRefundButton) {
    rows.push([Markup.button.callback(i18n.t(languageCode, "refund_request_btn"), makeCallbackData("cabinet", "refund_request"))]);
  }
  if (opts?.showAdminLink) {
    rows.push([Markup.button.callback(i18n.t(languageCode, "return_to_admin"), makeCallbackData("admin", "open"))]);
  }
  for (const btn of buildNavigationRow(i18n, languageCode, { back: true, toMain: true })) {
    rows.push([btn]);
  }
  return Markup.inlineKeyboard(rows);
};

export const buildStructureKeyboard = (languageCode: string, i18n: I18nService) => {
  const rows = [
    [Markup.button.callback(i18n.t(languageCode, "structure_export"), makeCallbackData("export", "structure"))],
    buildNavigationRow(i18n, languageCode, { back: true, toMain: true })
  ];
  return Markup.inlineKeyboard(rows);
};

export const buildPaywallKeyboard = (
  languageCode: string,
  productId: string,
  i18n: I18nService,
  opts?: {
    payButtonText?: string;
    balance?: number;
    price?: number;
    useBalanceFlow?: boolean;
  }
) => {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  const useBalanceFlow = opts?.useBalanceFlow ?? false;
  const balance = opts?.balance ?? 0;
  const price = opts?.price ?? 0;
  const canPayFromBalance = useBalanceFlow && price > 0 && balance >= price;

  if (canPayFromBalance) {
    rows.push([
      Markup.button.callback(`✅ ${i18n.t(languageCode, "pay_from_balance")}`, makeCallbackData("pay", "balance", productId))
    ]);
  }
  if (useBalanceFlow) {
    rows.push([
      Markup.button.callback(`💳 ${i18n.t(languageCode, "top_up_balance")}`, makeCallbackData("pay", "deposit", productId))
    ]);
  }
  if (!useBalanceFlow) {
    const btnLabel = opts?.payButtonText?.trim() || i18n.t(languageCode, "pay_now");
    rows.push([
      Markup.button.callback(`💳 ${btnLabel} USDT (BEP20)`, makeCallbackData("pay", "network", productId, "USDT_BEP20"))
    ]);
  }
  rows.push(buildNavigationRow(i18n, languageCode, { back: true, toMain: true }));
  return Markup.inlineKeyboard(rows);
};

export const buildDepositScreenKeyboard = (
  languageCode: string,
  i18n: I18nService,
  depositId: string
) => {
  const rows = [
    [Markup.button.callback(i18n.t(languageCode, "check_deposit_status"), makeCallbackData("pay", "check", depositId))],
    buildNavigationRow(i18n, languageCode, { back: true, toMain: true })
  ];
  return Markup.inlineKeyboard(rows);
};

export const buildPaymentReviewKeyboard = (paymentId: string, languageCode: string, i18n: I18nService) => {
  const rows = [
    [
      Markup.button.callback(
        i18n.t(languageCode, "request_payment_review"),
        makeCallbackData("pay", "review", paymentId)
      )
    ],
    buildNavigationRow(i18n, languageCode, { back: true, toMain: true })
  ];
  return Markup.inlineKeyboard(rows);
};

/** Keyboard for "Структура бота" screen: open root, refresh, back to admin. */
export const buildStructureScreenKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(i18n.t(languageCode, "set_main_page"), makeCallbackData(PAGE_EDIT_PREFIX, "open", "root")),
    ],
    [Markup.button.callback(i18n.t(languageCode, "return_to_admin"), makeCallbackData("admin", "open"))],
    buildNavigationRow(i18n, languageCode, { toMain: true })
  ]);

/**
 * Admin UX hub for the "Добавить кнопку/раздел" action:
 * routes directly to existing working flows (create-section / create-button / manage buttons).
 */
export const buildAddSectionButtonHubKeyboard = (
  languageCode: string,
  i18n: I18nService,
  fromPageId: string
) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "➕ " + i18n.t(languageCode, "page_add_section"),
        makeCallbackData(PAGE_EDIT_PREFIX, "add_sec", fromPageId)
      )
    ],
    [
      Markup.button.callback(
        "🔗 " + i18n.t(languageCode, "page_add_button"),
        makeCallbackData(PAGE_EDIT_PREFIX, "add_btn", fromPageId)
      )
    ],
    [Markup.button.callback("🧩 " + i18n.t(languageCode, "page_manage_buttons"), makeCallbackData(PAGE_EDIT_PREFIX, "manage_buttons", fromPageId))],
    [Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData(PAGE_EDIT_PREFIX, "open", fromPageId))],
    [Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]
  ]);

const ADMIN_PREFIX = "admin";

/** Keyboard for preview: Return to page, Return to admin, Main. */
export const buildPreviewScreenKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(i18n.t(languageCode, "return_to_page"), makeCallbackData(PAGE_EDIT_PREFIX, "open", "root")),
      Markup.button.callback(i18n.t(languageCode, "return_to_admin"), makeCallbackData(ADMIN_PREFIX, "open"))
    ],
    buildNavigationRow(i18n, languageCode, { toMain: true })
  ]);

/** Keyboard for publish confirmation: Confirm, Back, Cancel. fromOnboarding: confirm uses onboarding:publish_confirm. */
export const buildPublishConfirmKeyboard = (languageCode: string, i18n: I18nService, fromOnboarding?: boolean) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        i18n.t(languageCode, "preview_btn_confirm_publish"),
        makeCallbackData(fromOnboarding ? ONBOARDING_PREFIX : ADMIN_PREFIX, "publish_confirm")
      )
    ],
    [
      Markup.button.callback(
        i18n.t(languageCode, "preview_btn_back"),
        makeCallbackData(fromOnboarding ? ONBOARDING_PREFIX : ADMIN_PREFIX, "open")
      ),
      Markup.button.callback(
        i18n.t(languageCode, "preview_btn_cancel"),
        makeCallbackData(fromOnboarding ? ONBOARDING_PREFIX : ADMIN_PREFIX, "open")
      )
    ]
  ]);

export const buildAdminKeyboard = (
  languageCode: string,
  i18n: I18nService,
  opts?: {
    showOnboardingContinue?: boolean;
    showOnboardingRestart?: boolean;
    canManageLanguages?: boolean;
    canManageSystemButtons?: boolean;
    canManageUsers?: boolean;
  }
) => {
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  if (opts?.canManageUsers) {
    rows.push([Markup.button.callback(i18n.t(languageCode, "admin_manage_user"), makeCallbackData("admin", "manage_user"))]);
  }
  if (opts?.showOnboardingContinue) {
    rows.push([Markup.button.callback(i18n.t(languageCode, "onboarding_continue_setup"), makeCallbackData(ONBOARDING_PREFIX, "open"))]);
  }
  if (opts?.showOnboardingRestart) {
    rows.push([Markup.button.callback(i18n.t(languageCode, "onboarding_restart_wizard"), makeCallbackData(ONBOARDING_PREFIX, "start"))]);
  }
  rows.push(
    [Markup.button.callback(i18n.t(languageCode, "admin_structure"), makeCallbackData("admin", "structure"))],
    [Markup.button.callback(i18n.t(languageCode, "admin_create_menu_item"), makeCallbackData("admin", "create_menu"))],
    [Markup.button.callback(i18n.t(languageCode, "admin_broadcast"), makeCallbackData("admin", "create_broadcast"))],
    [Markup.button.callback(i18n.t(languageCode, "admin_scheduled"), makeCallbackData("admin", "scheduled_hub"))],
    [Markup.button.callback(i18n.t(languageCode, "admin_drip"), makeCallbackData("admin", "create_drip"))],
    ...(opts?.canManageLanguages
      ? [[Markup.button.callback(i18n.t(languageCode, "admin_add_language_version"), makeCallbackData("admin", "languages"))]]
      : []),
    ...(opts?.canManageSystemButtons
      ? [[Markup.button.callback(i18n.t(languageCode, "admin_system_buttons"), makeCallbackData("admin", "system_buttons"))]]
      : []),
    [
      Markup.button.callback(i18n.t(languageCode, "admin_export_html"), makeCallbackData("admin", "export"))
    ],
    [Markup.button.callback(i18n.t(languageCode, "admin_full_reset"), makeCallbackData("admin", "wipe"))],
    buildNavigationRow(i18n, languageCode, { toMain: true })
  );
  return Markup.inlineKeyboard(rows);
};

export const buildUserManagementPromptKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "usermgmt_view_admins_btn"), makeCallbackData("usermgmt", "list_admins"))],
    [Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData("admin", "open"))],
    [Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]
  ]);

export const buildUserManagementCardKeyboard = (
  languageCode: string,
  i18n: I18nService,
  targetUserId: string,
  opts?: {
    source?: "search" | "admins";
    canAssignAdmin?: boolean;
    canRevokeAdmin?: boolean;
    canDelete?: boolean;
  }
) => {
  const source = opts?.source ?? "search";
  const shortUserId = toShortId(targetUserId);
  const rows: ReturnType<typeof Markup.button.callback>[][] = [];

  if (opts?.canAssignAdmin) {
    rows.push([
      Markup.button.callback(i18n.t(languageCode, "usermgmt_assign_admin_btn"), makeCallbackData("usermgmt", "assign_admin", shortUserId, source))
    ]);
  }
  if (opts?.canRevokeAdmin) {
    rows.push([
      Markup.button.callback(i18n.t(languageCode, "usermgmt_revoke_admin_btn"), makeCallbackData("usermgmt", "revoke_admin", shortUserId, source))
    ]);
  }
  if (opts?.canDelete) {
    rows.push([
      Markup.button.callback(i18n.t(languageCode, "usermgmt_delete_btn"), makeCallbackData("usermgmt", "delete", shortUserId, source))
    ]);
  }

  rows.push(
    [Markup.button.callback(i18n.t(languageCode, "usermgmt_view_admins_btn"), makeCallbackData("usermgmt", "list_admins"))],
    [Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData("usermgmt", source === "admins" ? "list_admins" : "prompt"))],
    [Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]
  );

  return Markup.inlineKeyboard(rows);
};

export const buildUserManagementAdminListKeyboard = (
  languageCode: string,
  i18n: I18nService,
  admins: Array<{ id: string; label: string }>
) => {
  const rows: ReturnType<typeof Markup.button.callback>[][] = admins.map((admin) => [
    Markup.button.callback(admin.label, makeCallbackData("usermgmt", "view", toShortId(admin.id), "admins"))
  ]);

  rows.push(
    [Markup.button.callback(i18n.t(languageCode, "usermgmt_prompt_btn"), makeCallbackData("usermgmt", "prompt"))],
    [Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData("admin", "open"))],
    [Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]
  );

  return Markup.inlineKeyboard(rows);
};

export const buildUserManagementDeleteConfirmKeyboard = (
  languageCode: string,
  i18n: I18nService,
  targetUserId: string,
  source: "search" | "admins" = "search"
) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(
        i18n.t(languageCode, "usermgmt_delete_confirm_btn"),
        makeCallbackData("usermgmt", "delete_confirm", toShortId(targetUserId), source)
      )
    ],
    [Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData("usermgmt", "view", toShortId(targetUserId), source))],
    [Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]
  ]);

export const buildLanguageVersionHubKeyboard = (
  uiLanguageCode: string,
  i18n: I18nService,
  editingContentLanguageCode: string,
  opts?: { canManageLanguages?: boolean }
) =>
  opts?.canManageLanguages
    ? Markup.inlineKeyboard([
        [Markup.button.callback("🏠 " + i18n.t(uiLanguageCode, "langv_btn_root"), makeCallbackData("admin", "langv_page_open", editingContentLanguageCode, "root"))],
        [Markup.button.callback("📂 " + i18n.t(uiLanguageCode, "langv_btn_sections"), makeCallbackData("admin", "langv_pages", editingContentLanguageCode))],
        [Markup.button.callback("👁 " + i18n.t(uiLanguageCode, "langv_btn_preview"), makeCallbackData("admin", "langv_preview", editingContentLanguageCode))],
        [Markup.button.callback("✅ " + i18n.t(uiLanguageCode, "langv_btn_publish"), makeCallbackData("admin", "langv_publish", editingContentLanguageCode))],
        [Markup.button.callback(i18n.t(uiLanguageCode, "back"), makeCallbackData("admin", "lang_detail", editingContentLanguageCode))],
        [Markup.button.callback(i18n.t(uiLanguageCode, "to_main_menu"), NAV_ROOT_DATA)]
      ])
    : Markup.inlineKeyboard([
        [Markup.button.callback(i18n.t(uiLanguageCode, "return_to_admin"), makeCallbackData("admin", "open"))],
        ...buildNavigationRow(i18n, uiLanguageCode, { toMain: true }).map((btn) => [btn])
      ]);

export const buildLanguageVersionPageActionsKeyboard = (
  uiLanguageCode: string,
  i18n: I18nService,
  editingContentLanguageCode: string,
  pageId: string,
  opts?: { canManageLanguages?: boolean }
) =>
  opts?.canManageLanguages
    ? Markup.inlineKeyboard([
        [Markup.button.callback("✏️ " + i18n.t(uiLanguageCode, "langv_btn_replace_text"), makeCallbackData("admin", "langv_rtxt", editingContentLanguageCode, pageId))],
        [Markup.button.callback("🖼 " + i18n.t(uiLanguageCode, "langv_btn_replace_photo"), makeCallbackData("admin", "langv_rpho", editingContentLanguageCode, pageId))],
        [Markup.button.callback("🎬 " + i18n.t(uiLanguageCode, "langv_btn_replace_video"), makeCallbackData("admin", "langv_rvid", editingContentLanguageCode, pageId))],
        [Markup.button.callback("📄 " + i18n.t(uiLanguageCode, "langv_btn_replace_document"), makeCallbackData("admin", "langv_rdoc", editingContentLanguageCode, pageId))],
        [Markup.button.callback("🔁 " + i18n.t(uiLanguageCode, "langv_btn_full_replace"), makeCallbackData("admin", "langv_rfull", editingContentLanguageCode, pageId))],
        [Markup.button.callback("👁 " + i18n.t(uiLanguageCode, "langv_btn_page_preview"), makeCallbackData("admin", "langv_page_preview", editingContentLanguageCode, pageId))],
        [Markup.button.callback(i18n.t(uiLanguageCode, "back"), makeCallbackData("admin", "langv_pages", editingContentLanguageCode))],
        [Markup.button.callback(i18n.t(uiLanguageCode, "to_main_menu"), NAV_ROOT_DATA)]
      ])
    : Markup.inlineKeyboard([
        [Markup.button.callback(i18n.t(uiLanguageCode, "return_to_admin"), makeCallbackData("admin", "open"))],
        ...buildNavigationRow(i18n, uiLanguageCode, { toMain: true }).map((btn) => [btn])
      ]);

export const buildLanguageVersionPreviewConfirmKeyboard = (
  uiLanguageCode: string,
  i18n: I18nService,
  editingContentLanguageCode: string,
  pageId: string,
  opts?: { canManageLanguages?: boolean }
) =>
  opts?.canManageLanguages
    ? Markup.inlineKeyboard([
        [Markup.button.callback("✅ " + i18n.t(uiLanguageCode, "langv_btn_publish"), makeCallbackData("admin", "langv_post_publish", editingContentLanguageCode, pageId))],
        [Markup.button.callback(i18n.t(uiLanguageCode, "back"), makeCallbackData("admin", "langv_page_open", editingContentLanguageCode, pageId))],
        [Markup.button.callback(i18n.t(uiLanguageCode, "to_main_menu"), NAV_ROOT_DATA)]
      ])
    : Markup.inlineKeyboard([
        [Markup.button.callback(i18n.t(uiLanguageCode, "return_to_admin"), makeCallbackData("admin", "open"))],
        ...buildNavigationRow(i18n, uiLanguageCode, { toMain: true }).map((btn) => [btn])
      ]);

/**
 * Admin hub for "Отложенные": create new scheduled broadcast, or manage planned ones.
 * All buttons are vertical (one per row).
 */
export const buildScheduledBroadcastHubKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [Markup.button.callback("➕ Создать новую отложенную", makeCallbackData("admin", "create_scheduled"))],
    [Markup.button.callback("📅 Запланированные", makeCallbackData("admin", "scheduled_list"))],
    [Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData("admin", "open"))],
    [Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]
  ]);

export const buildScheduledBroadcastListKeyboard = (
  languageCode: string,
  i18n: I18nService,
  items: Array<{ id: string; label: string }>
) =>
  Markup.inlineKeyboard([
    ...items.slice(0, 20).map((it) => [Markup.button.callback(it.label, makeCallbackData("admin", "scheduled_open", it.id))]),
    [Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData("admin", "scheduled_hub"))],
    [Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]
  ]);

export const buildScheduledBroadcastDetailKeyboard = (
  languageCode: string,
  i18n: I18nService,
  broadcastId: string
) =>
  Markup.inlineKeyboard([
    [Markup.button.callback("▶️ Отправить сейчас", makeCallbackData("admin", "scheduled_send_now", broadcastId))],
    [Markup.button.callback("✏️ Редактировать", makeCallbackData("admin", "scheduled_edit", broadcastId))],
    [Markup.button.callback("⏸ Остановить", makeCallbackData("admin", "scheduled_stop", broadcastId))],
    [Markup.button.callback("🗑 Удалить", makeCallbackData("admin", "scheduled_delete", broadcastId))],
    [Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData("admin", "scheduled_list"))],
    [Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)]
  ]);

/** Confirmation for full bot reset: Yes, No, Cancel. */
export const buildResetConfirmKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "reset_confirm_yes"), makeCallbackData("admin", "wipe_confirm_yes"))],
    [
      Markup.button.callback(i18n.t(languageCode, "reset_confirm_no"), makeCallbackData("admin", "wipe_confirm_no")),
      Markup.button.callback(i18n.t(languageCode, "cancel_btn"), makeCallbackData("admin", "open"))
    ]
  ]);

export const buildOnboardingWelcomeKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "onboarding_btn_start"), makeCallbackData(ONBOARDING_PREFIX, "start"))],
    [
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_skip"), makeCallbackData(ONBOARDING_PREFIX, "skip")),
      Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)
    ]
  ]);

export const buildOnboardingStep1CompleteKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "onboarding_btn_next"), makeCallbackData(ONBOARDING_PREFIX, "next", "2"))],
    [
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_edit_again"), makeCallbackData(ONBOARDING_PREFIX, "again", "1")),
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_skip"), makeCallbackData(ONBOARDING_PREFIX, "skip")),
      Markup.button.callback(i18n.t(languageCode, "cancel_btn"), makeCallbackData(ONBOARDING_PREFIX, "cancel"))
    ],
    buildNavigationRow(i18n, languageCode, { toMain: true })
  ]);

export const buildOnboardingStep2CompleteKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "onboarding_btn_next"), makeCallbackData(ONBOARDING_PREFIX, "next", "3"))],
    [
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_add_another"), makeCallbackData(ONBOARDING_PREFIX, "again", "2")),
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_skip"), makeCallbackData(ONBOARDING_PREFIX, "skip")),
      Markup.button.callback(i18n.t(languageCode, "cancel_btn"), makeCallbackData(ONBOARDING_PREFIX, "cancel"))
    ],
    buildNavigationRow(i18n, languageCode, { toMain: true })
  ]);

/** After creating a section during onboarding: add another section OR go to main menu. No preview/publish step. */
export const buildOnboardingChoiceAfterSectionKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_add_another_section"), makeCallbackData(ONBOARDING_PREFIX, "choice_after", "add")),
      Markup.button.callback(i18n.t(languageCode, "to_main_menu"), NAV_ROOT_DATA)
    ],
    [Markup.button.callback(i18n.t(languageCode, "cancel_btn"), makeCallbackData(ONBOARDING_PREFIX, "cancel"))]
  ]);

export const buildOnboardingStep3CompleteKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "onboarding_btn_next"), makeCallbackData(ONBOARDING_PREFIX, "next", "4"))],
    [
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_add_another"), makeCallbackData(ONBOARDING_PREFIX, "again", "3")),
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_skip"), makeCallbackData(ONBOARDING_PREFIX, "skip")),
      Markup.button.callback(i18n.t(languageCode, "cancel_btn"), makeCallbackData(ONBOARDING_PREFIX, "cancel"))
    ],
    buildNavigationRow(i18n, languageCode, { toMain: true })
  ]);

export const buildOnboardingStep4Keyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "onboarding_btn_got_it"), makeCallbackData(ONBOARDING_PREFIX, "next", "5"))],
    [
      Markup.button.callback(i18n.t(languageCode, "back"), makeCallbackData(ONBOARDING_PREFIX, "back", "4")),
      Markup.button.callback(i18n.t(languageCode, "cancel_btn"), makeCallbackData(ONBOARDING_PREFIX, "cancel"))
    ],
    buildNavigationRow(i18n, languageCode, { toMain: true })
  ]);

export const buildOnboardingStep5Keyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "preview_structure_title"), makeCallbackData("admin", "preview_structure"))],
    [
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_publish"), makeCallbackData(ONBOARDING_PREFIX, "publish")),
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_skip"), makeCallbackData(ONBOARDING_PREFIX, "skip")),
      Markup.button.callback(i18n.t(languageCode, "cancel_btn"), makeCallbackData(ONBOARDING_PREFIX, "cancel"))
    ],
    buildNavigationRow(i18n, languageCode, { toMain: true })
  ]);

export const buildOnboardingStep5SuccessKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_open_bot"), makeCallbackData("nav", "root")),
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_to_admin"), makeCallbackData("admin", "open"))
    ],
    [Markup.button.callback(i18n.t(languageCode, "onboarding_btn_finish_wizard"), makeCallbackData(ONBOARDING_PREFIX, "finish"))]
  ]);

export const buildOnboardingStep6Keyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_open_main"), makeCallbackData("nav", "root")),
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_to_admin"), makeCallbackData("admin", "open"))
    ],
    [
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_add_section"), makeCallbackData(PAGE_EDIT_PREFIX, "open", "root")),
      Markup.button.callback(i18n.t(languageCode, "onboarding_btn_finish_wizard"), makeCallbackData(ONBOARDING_PREFIX, "finish"))
    ]
  ]);

export const buildOnboardingEmptyStateKeyboard = (languageCode: string, i18n: I18nService) =>
  Markup.inlineKeyboard([
    [Markup.button.callback(i18n.t(languageCode, "onboarding_btn_launch_wizard"), makeCallbackData(ONBOARDING_PREFIX, "start"))],
    [Markup.button.callback(i18n.t(languageCode, "return_to_admin"), makeCallbackData("admin", "open"))]
  ]);
