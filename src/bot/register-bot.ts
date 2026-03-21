import { Markup, Scenes, Telegraf, session } from "telegraf";
import type { PaymentNetwork } from "@prisma/client";

import { makeCallbackData, splitCallbackData } from "../common/callback-data";
import { logger } from "../common/logger";
import { ForbiddenError } from "../common/errors";
import { applyPersonalization } from "../common/personalization";
import { renderPageContent } from "./helpers/render-page-content";
import { isValidTimeZone } from "../common/timezone";
import { env } from "../config/env";
import type { AppServices } from "../app/services";
import { MenuService } from "../modules/menu/menu.service";
import type { BotContext } from "./context";
import { extractFormattedContentText, extractMessageContent, readTextMessage } from "./helpers/message-content";
import {
  buildAdminKeyboard,
  buildStructureScreenKeyboard,
  buildAddSectionButtonHubKeyboard,
  buildPreviewScreenKeyboard,
  buildPublishConfirmKeyboard,
  buildButtonManagementKeyboard,
  type ButtonManagementItem,
  buildCabinetKeyboard,
  buildContentScreenKeyboard,
  buildStructureKeyboard,
  buildLanguageKeyboard,
  buildMenuKeyboard,
  buildNavigationRow,
  buildPageDeleteConfirmKeyboard,
  buildPageDeleteItemConfirmKeyboard,
  buildPageEditorKeyboard,
  buildPageEditorContentSubmenuKeyboard,
  buildLanguageVersionHubKeyboard,
  buildLanguageVersionPageActionsKeyboard,
  buildLanguageVersionPreviewConfirmKeyboard,
  buildPaymentReviewKeyboard,
  buildPaywallKeyboard,
  buildCancelKeyboard,
  buildStaleActionKeyboard,
  buildScheduledBroadcastHubKeyboard,
  buildScheduledBroadcastListKeyboard,
  buildScheduledBroadcastDetailKeyboard,
  buildOnboardingWelcomeKeyboard,
  buildOnboardingBaseLanguageKeyboard,
  buildOnboardingStep1CompleteKeyboard,
  buildOnboardingStep2CompleteKeyboard,
  buildOnboardingStep3CompleteKeyboard,
  buildOnboardingStep4Keyboard,
  buildOnboardingChoiceAfterSectionKeyboard,
  buildOnboardingStep5Keyboard,
  buildOnboardingStep5SuccessKeyboard,
  buildOnboardingStep6Keyboard,
  buildOnboardingEmptyStateKeyboard,
  buildResetConfirmKeyboard,
  isAdminRole,
  NAV_ROOT_DATA,
  SCENE_CANCEL_DATA
} from "./keyboards";
import { canManageLanguages } from "../modules/permissions/capabilities";
import { isLanguageManagementAction } from "./language-management-actions";
import { createBroadcastScene, createScheduledBroadcastScene, CREATE_BROADCAST_SCENE, CREATE_SCHEDULED_BROADCAST_SCENE } from "./scenes/create-broadcast.scene";
import { createButtonLinkScene, CREATE_BUTTON_LINK_SCENE } from "./scenes/create-button-link.scene";
import { createDripScene, CREATE_DRIP_SCENE } from "./scenes/create-drip-campaign.scene";
import { addDripStepScene, ADD_DRIP_STEP_SCENE } from "./scenes/add-drip-step.scene";
import { addDripStepButtonsScene, ADD_DRIP_STEP_BUTTONS_SCENE } from "./scenes/add-drip-step-buttons.scene";
import { attachVideoFromLibraryScene, ATTACH_VIDEO_FROM_LIBRARY_SCENE } from "./scenes/attach-video-from-library.scene";
import { createMenuItemScene, CREATE_MENU_ITEM_SCENE } from "./scenes/create-menu-item.scene";
import { createSectionScene, CREATE_SECTION_SCENE } from "./scenes/create-section.scene";
import { editPageContentScene, EDIT_PAGE_CONTENT_SCENE } from "./scenes/edit-page-content.scene";
import { renameButtonScene, RENAME_BUTTON_SCENE } from "./scenes/rename-button.scene";
import { setExternalReferralLinkScene, SET_EXTERNAL_REFERRAL_LINK_SCENE } from "./scenes/set-external-referral-link.scene";
import {
  INACTIVITY_REMINDER_ADMIN_SCENE,
  inactivityReminderAdminScene
} from "./scenes/inactivity-reminder-admin.scene";

const COMMAND_ARGUMENT_RE = /^\/\w+(?:@\w+)?(?:\s+(.+))?$/i;

const extractCommandArgument = (text: string | undefined): string => {
  const match = text?.match(COMMAND_ARGUMENT_RE);
  return match?.[1]?.trim() ?? "";
};

export const registerBot = (services: AppServices, opts: { botToken: string }): Telegraf<BotContext> => {
  const bot = new Telegraf<BotContext>(opts.botToken);
  const stage = new Scenes.Stage<any>([
    createMenuItemScene,
    createSectionScene,
    createButtonLinkScene,
    createBroadcastScene,
    createScheduledBroadcastScene,
    createDripScene,
    addDripStepScene,
    addDripStepButtonsScene,
    attachVideoFromLibraryScene,
    editPageContentScene,
    renameButtonScene,
    setExternalReferralLinkScene,
    inactivityReminderAdminScene
  ]);

  // For user-facing screens, do not auto-prepend page title to body text.
  // If body exists, it is the source of truth. Keep a fallback to title only when body is empty.
  // Also deduplicate old content where body started with the same title.
  const composeTitleBody = (title: string, body: string): string => {
    const t = (title ?? "").trim();
    let b = (body ?? "").trim();
    if (t && b) {
      const bLines = b.split("\n");
      const firstLine = (bLines[0] ?? "").trim();
      if (firstLine === t) {
        b = bLines.slice(1).join("\n").trim();
      }
    }
    return b || t;
  };

  bot.catch(async (error, ctx) => {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : undefined;
    const callbackData = "callbackQuery" in ctx && ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;
    logger.error(
      { error, message: errMsg, stack: errStack, callbackData, code: (error as any)?.code, response: (error as any)?.response },
      "Bot error"
    );
    const locale = (ctx as BotContext).currentUser?.selectedLanguage ?? "ru";
    await ctx.reply(services.i18n.t(locale, "error_generic"));
  });

  bot.use((ctx, next) => {
    ctx.services = services;
    return next();
  });

  bot.use(session());

  const ingestMediaAsset = async (post: any) => {
    if (!post || !post.chat || !post.message_id) return;
    const channelId = BigInt(post.chat.id);
    const messageId = Number(post.message_id);
    const createdAt = post.date ? new Date(Number(post.date) * 1000) : new Date();
    const caption = post.caption ?? "";

    // Prefer VIDEO; also support PHOTO/DOCUMENT.
    if (post.video?.file_id) {
      await services.mediaLibrary.upsertAsset({
        channelId,
        messageId,
        mediaType: "VIDEO",
        fileId: post.video.file_id,
        fileUniqueId: post.video.file_unique_id ?? null,
        caption,
        createdAt
      });
      return;
    }
    const photo = Array.isArray(post.photo) ? post.photo.at(-1) : null;
    if (photo?.file_id) {
      await services.mediaLibrary.upsertAsset({
        channelId,
        messageId,
        mediaType: "PHOTO",
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id ?? null,
        caption,
        createdAt
      });
      return;
    }
    if (post.document?.file_id) {
      await services.mediaLibrary.upsertAsset({
        channelId,
        messageId,
        mediaType: "DOCUMENT",
        fileId: post.document.file_id,
        fileUniqueId: post.document.file_unique_id ?? null,
        caption,
        createdAt
      });
    }
  };

  // Media library ingest: index channel and group posts with media (video/photo/document).
  // Channel updates don't have ctx.from, so handle them before user-loading middleware.
  bot.on("channel_post", async (ctx) => {
    await ingestMediaAsset((ctx.update as any).channel_post);
  });
  bot.on("message", async (ctx, next) => {
    const post = (ctx.update as any).message;
    const chatType = post?.chat?.type;
    // Private links t.me/c/... can reference private channels and private supergroups.
    if (chatType === "supergroup" || chatType === "group") {
      await ingestMediaAsset(post);
    }
    return next();
  });

  /** User loading MUST run before stage so that ctx.currentUser is set for escape hatch and for scenes. */
  bot.use(async (ctx, next) => {
    if (!ctx.from) {
      return next();
    }

    const allowed = await services.rateLimit.consume(String(ctx.from.id), "telegram");

    if (!allowed) {
      const locale = (ctx as BotContext).currentUser?.selectedLanguage ?? "ru";
      await ctx.reply(services.i18n.t(locale, "rate_limit_exceeded"));
      return;
    }

    const existing = await services.users.findByTelegramId(BigInt(ctx.from.id));
    const commandArg =
      ctx.message && "text" in ctx.message && ctx.message.text.startsWith("/start")
        ? extractCommandArgument(ctx.message.text)
        : "";
    const referralCode = services.referrals.parseReferralPayload(commandArg);
    let inviter = await services.referrals.resolveInviterByCode(referralCode);

    // Self-referral: пользователь перешёл по своей же ссылке — просто игнорируем, показываем меню
    if (existing && inviter && inviter.id === existing.id) {
      inviter = null;
    } else if (existing && !existing.invitedByUserId && inviter) {
      await services.referrals.validateInviter(existing.id, inviter.id);
    }

    const telegramLanguageCode = (ctx.from as { language_code?: string })?.language_code;
    const preferredLanguage = services.i18n.resolveLanguage(telegramLanguageCode);

    const result = await services.users.ensureTelegramUser(
      ctx.from,
      existing?.invitedByUserId ? null : inviter?.id,
      preferredLanguage
    );

    const newlyBound = Boolean(
      existing && !existing.invitedByUserId && inviter && result.user.invitedByUserId === inviter.id
    );

    ctx.currentUser = result.user;
    // Bot-scoped roles (OWNER/ADMIN) must be resolved from BotRoleAssignment, not from User.role.
    const botScopedRole = await services.permissions.getActiveBotRole(result.user.id);
    (ctx.currentUser as any).effectiveBotRole = botScopedRole;
    if (botScopedRole) {
      // In-memory override for UI/scene routing.
      // PermissionService must still treat ALPHA_OWNER as the only global absolute role.
      (ctx.currentUser as any).role = botScopedRole;
    }

    if (result.isNew) {
      await services.drips.enrollUser(result.user.id, "ON_REGISTRATION");
    }

    if ((result.isNew || newlyBound) && inviter) {
      await services.referrals.registerReferral(inviter, result.user);
    }

    return next();
  });

  /** Global escape hatch: /start and "В главное меню" (nav:root) MUST run before stage so they work from inside any scene. */
  bot.use(async (ctx, next) => {
    if (ctx.message && "text" in ctx.message) {
      const text = (ctx.message as { text: string }).text.trim();
      const rawCmd = text.split(/\s/)[0]?.toLowerCase() ?? "";
      const cmd = rawCmd.split("@")[0] ?? rawCmd;
      if (cmd === "/start") {
        await resetUserSessionToRoot(ctx);
        await sendRootWithWelcome(ctx);
        return;
      }
    }
    if (ctx.callbackQuery && "data" in ctx.callbackQuery && ctx.callbackQuery.data === NAV_ROOT_DATA) {
      try {
        await ctx.answerCbQuery();
      } catch {
        // ignore
      }
      await resetUserSessionToRoot(ctx);
      await sendRootWithWelcome(ctx);
      return;
    }
    return next();
  });

  // Scene cancel must run BEFORE stage middleware.
  // Some wizard steps may handle callbacks and stop propagation, so a later global handler would be skipped.
  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery && "data" in ctx.callbackQuery && ctx.callbackQuery.data === SCENE_CANCEL_DATA) {
      const botCtx = ctx as BotContext;
      const locale = services.i18n.resolveLanguage(botCtx.currentUser?.selectedLanguage);
      const sceneId = ctx.scene?.current?.id;

      logger.info({ userId: botCtx.currentUser?.id, sceneId }, "Cancel button (scene:cancel) clicked (early handler)");

      // Confirm callback to remove Telegram loading state.
      try {
        await ctx.answerCbQuery();
      } catch {
        // ignore
      }

      if (sceneId) {
        logger.info({ userId: botCtx.currentUser?.id, sceneId }, "Leaving current scene due to cancel (early handler)");
        await ctx.scene.leave();
      }

      const isConstructorScene =
        sceneId != null && [CREATE_MENU_ITEM_SCENE, CREATE_SECTION_SCENE, CREATE_BUTTON_LINK_SCENE, CREATE_DRIP_SCENE].includes(sceneId);

      const baseKey = isConstructorScene ? "creation_cancelled" : "action_cancelled";
      const msg = services.i18n.t(locale, baseKey as any) + "\n" + services.i18n.t(locale, "cancel_reassurance");

      const kb =
        isAdminRole(botCtx.currentUser?.role) && isConstructorScene
          ? Markup.inlineKeyboard([
              buildNavigationRow(services.i18n, locale, { toMain: true }),
              [Markup.button.callback(services.i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))]
            ])
          : Markup.inlineKeyboard([buildNavigationRow(services.i18n, locale, { toMain: true })]);

      if (ctx.callbackQuery.message && "message_id" in ctx.callbackQuery.message) {
        try {
          await ctx.editMessageText(msg, kb);
        } catch {
          await ctx.reply(msg, kb);
        }
      } else {
        await ctx.reply(msg, kb);
      }

      return;
    }
    return next();
  });

  bot.use(stage.middleware());

  type NavSession = { navCurrent?: string; navPrev?: string };
  type PreviewRole = "ALPHA_OWNER" | "OWNER" | "ADMIN" | "USER";
  // NOTE: previewRole is a UI-only override for SUPER_ADMIN account. It must not modify production permissions.
  type ExtendedNavSession = NavSession & {
    previewRole?: PreviewRole;
    // UI language (admin dictionary language) is sourced from current user profile.
    // Content language is a separate layer selected in language-version editor.
    editingContentLanguageCode?: string;
    // Pending not-yet-saved page patches in language-version editor.
    langvPending?: Record<string, {
      pageId: string;
      isRoot: boolean;
      languageCode: string;
      updateMode: "full" | "text_only" | "photo_only" | "video_only" | "document_only";
      contentText?: string;
      mediaType?: "NONE" | "PHOTO" | "VIDEO" | "DOCUMENT" | "LINK" | "VOICE" | "VIDEO_NOTE";
      mediaFileId?: string | null;
      externalUrl?: string | null;
      updatedAt: number;
    }>;
    langvVersionPreview?: {
      languageCode: string;
      uiLanguageCode: string;
      stack: string[]; // "root" + page ids
    };
  };
  const getNavSession = (ctx: BotContext): NavSession => {
    const s = (ctx as unknown as { session?: NavSession }).session;
    return s ? { navCurrent: s.navCurrent, navPrev: s.navPrev } : {};
  };
  const setNavCurrent = (ctx: BotContext, screenId: string) => {
    const s = ((ctx as unknown as { session?: ExtendedNavSession }).session ?? {}) as ExtendedNavSession;
    (ctx as unknown as { session: ExtendedNavSession }).session = { ...s, navCurrent: screenId };
  };
  const setNavBeforeShow = (ctx: BotContext, screenId: string) => {
    const s = ((ctx as unknown as { session?: ExtendedNavSession }).session ?? {}) as ExtendedNavSession;
    (ctx as unknown as { session: ExtendedNavSession }).session = {
      ...s,
      navPrev: s.navCurrent,
      navCurrent: screenId
    };
  };
  const setEditingContentLanguageCode = (ctx: BotContext, languageCode: string) => {
    const s = ((ctx as unknown as { session?: ExtendedNavSession }).session ?? {}) as ExtendedNavSession;
    (ctx as unknown as { session: ExtendedNavSession }).session = {
      ...s,
      editingContentLanguageCode: services.i18n.normalizeLocalizationLanguageCode(languageCode)
    };
  };
  const resolveAdminUiLanguageCode = (user: { selectedLanguage?: string | null }) =>
    services.i18n.resolveLanguage(user.selectedLanguage);
  const resolveEditingContentLanguageCode = (ctx: BotContext, user: { selectedLanguage?: string | null }) => {
    const s = (ctx as unknown as { session?: ExtendedNavSession }).session as ExtendedNavSession | undefined;
    return services.i18n.normalizeLocalizationLanguageCode(s?.editingContentLanguageCode ?? user.selectedLanguage);
  };
  const getLangvPendingMap = (ctx: BotContext): NonNullable<ExtendedNavSession["langvPending"]> => {
    const s = ((ctx as unknown as { session?: ExtendedNavSession }).session ?? {}) as ExtendedNavSession;
    return s.langvPending ?? {};
  };
  const setLangvPendingMap = (ctx: BotContext, pending: NonNullable<ExtendedNavSession["langvPending"]>) => {
    const s = ((ctx as unknown as { session?: ExtendedNavSession }).session ?? {}) as ExtendedNavSession;
    (ctx as unknown as { session: ExtendedNavSession }).session = {
      ...s,
      langvPending: pending
    };
  };

  /** Full hard reset: leave any scene/wizard, clear session to root-only state. */
  const resetUserSessionToRoot = async (ctx: BotContext): Promise<void> => {
    if (ctx.scene?.current) {
      await ctx.scene.leave();
    }
    const s = (ctx as unknown as { session?: ExtendedNavSession }).session ?? ({} as ExtendedNavSession);
    (ctx as unknown as { session: ExtendedNavSession }).session = {
      navCurrent: "menu:open:root",
      navPrev: undefined,
      previewRole: s.previewRole
    };
  };

  const resolveEffectiveRole = (ctx: BotContext): string => {
    const user = ctx.currentUser;
    if (!user) return "USER";
    const superAdminTelegramId = BigInt(process.env.SUPER_ADMIN_TELEGRAM_ID ?? "0");
    const isSuperAdmin = user.telegramUserId === superAdminTelegramId;
    const previewRole = ((ctx as unknown as { session?: ExtendedNavSession }).session as ExtendedNavSession | undefined)?.previewRole;
    if (isSuperAdmin && previewRole) return previewRole;
    if (isSuperAdmin) return "ALPHA_OWNER";
    const anyUser = user as unknown as { effectiveBotRole?: string | null };
    return anyUser.effectiveBotRole ?? "USER";
  };

  const shouldShowCabinetLanguageButton = async (user: BotContext["currentUser"]): Promise<boolean> => {
    if (!user) return true;
    const rootItems = await services.menu.getMenuItemsForParent(user, null);
    const rootSlotOrder = await services.menu.getEffectiveSlotOrder("root", rootItems.map((i) => i.id));
    return rootSlotOrder.includes(MenuService.SYS_SLOT_LANGUAGE);
  };

  /** Render the true root home screen (welcome + main menu). For admin with empty menu and incomplete onboarding, show empty state. */
  const sendRootWithWelcome = async (ctx: BotContext): Promise<void> => {
    setNavCurrent(ctx, "menu:open:root");
    const user = ctx.currentUser!;
    const effectiveRole = resolveEffectiveRole(ctx);
    // Leaving any previous reminder "stop" point: keep only root reminders.
    await services.inactivityReminders.cancelPendingForUserExcept(user.id, "root");
    const mentorUsername =
      user.mentorUserId ? (await services.users.findById(user.mentorUserId))?.username ?? null : null;
    const menuEmpty = await services.menu.isRootMenuEmpty();
    const onboardingIncomplete =
      user.onboardingCompletedAt == null && (user.onboardingStep != null || menuEmpty);
    if (
      isAdminRole(effectiveRole) &&
      onboardingIncomplete &&
      menuEmpty
    ) {
      const locale = services.i18n.resolveLanguage(user.selectedLanguage);
      const text =
        services.i18n.t(locale, "onboarding_empty_title") +
        "\n\n" +
        services.i18n.t(locale, "onboarding_empty_intro");
      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        { text },
        buildOnboardingEmptyStateKeyboard(locale, services.i18n)
      );
      return;
    }
    const welcome = await services.menu.getWelcome(user, ctx.from ?? undefined);
    const items = await services.menu.getMenuItemsForParent(user, null);
    const rootSlotOrder = await services.menu.getEffectiveSlotOrder("root", items.map((i) => i.id));
    const externalPartnerUrl = await services.cabinet.getPartnerRegisterLinkForUser(user);
    const partnerRegisterTargetId = await services.menu.getSystemTargetMenuItemId("partner_register");
    await services.navigation.replaceScreen(
      user,
      ctx.telegram,
      ctx.chat?.id ?? user.telegramUserId,
      welcome,
      buildMenuKeyboard(
        items,
        user.selectedLanguage,
        services.i18n,
        undefined,
        effectiveRole,
        undefined,
        rootSlotOrder,
        mentorUsername,
        externalPartnerUrl,
        partnerRegisterTargetId
      )
    );

    await services.inactivityReminders.scheduleForPageOpen(user, "root", {
      shouldSchedule: false
    });
  };

  /** Build opts for admin keyboard (onboarding + capability flags). */
  const getAdminKeyboardOpts = async (
    user: { role?: string; onboardingStep?: number | null; onboardingCompletedAt?: Date | null },
    roleForUi?: string
  ) => {
    const effectiveUiRole = roleForUi ?? user.role;
    if (!isAdminRole(effectiveUiRole)) return undefined;
    const menuEmpty = await services.menu.isRootMenuEmpty();
    return {
      // Показывать «Продолжить настройку» только когда меню пустое — если разделы уже созданы, бот считается настроенным
      showOnboardingContinue: user.onboardingCompletedAt == null && menuEmpty,
      showOnboardingRestart: user.onboardingCompletedAt != null,
      // UI visibility must follow the *effective* role (including SUPER_ADMIN preview override),
      // but production permissions are still enforced in backend guards.
      canManageLanguages: canManageLanguages(effectiveUiRole as any),
      // System buttons (incl. language) can be hidden only by ALPHA_OWNER.
      canManageSystemButtons: effectiveUiRole === "ALPHA_OWNER"
    };
  };

  const sendRootMenu = async (ctx: BotContext, parentId: string | null = null) => {
    setNavCurrent(ctx, "menu:open:" + (parentId ?? "root"));
    const user = ctx.currentUser!;
    const effectiveRole = resolveEffectiveRole(ctx);
    const items = await services.menu.getMenuItemsForParent(user, parentId);
    const currentPageId = parentId ?? "root";

    const text =
      items.length === 0
        ? services.i18n.t(user.selectedLanguage, "menu_empty")
        : parentId
          ? services.i18n.t(user.selectedLanguage, "submenu")
          : services.i18n.t(user.selectedLanguage, "main_menu");

    const slotOrder = await services.menu.getEffectiveSlotOrder(currentPageId, items.map((i) => i.id));
    const mentorUsername =
      user.mentorUserId ? (await services.users.findById(user.mentorUserId))?.username ?? null : null;
    const externalPartnerUrl = await services.cabinet.getPartnerRegisterLinkForUser(user);
    const partnerRegisterTargetId = await services.menu.getSystemTargetMenuItemId("partner_register");
    await services.navigation.replaceScreen(
      user,
      ctx.telegram,
      ctx.chat?.id ?? user.telegramUserId,
      { text },
      buildMenuKeyboard(
        items,
        user.selectedLanguage,
        services.i18n,
        parentId ?? undefined,
        effectiveRole,
        currentPageId,
        slotOrder,
        mentorUsername,
        externalPartnerUrl,
        partnerRegisterTargetId
      )
    );
  };

  /** Render a single menu page by id with real saved content. Used for "Назад" and unified page open. Root -> sendRootWithWelcome. */
  const sendMenuPage = async (ctx: BotContext, pageId: string | null) => {
    const user = ctx.currentUser!;
    const effectiveRole = resolveEffectiveRole(ctx);
    if (!pageId || pageId === "root") {
      await sendRootWithWelcome(ctx);
      return;
    }
    setNavCurrent(ctx, "menu:open:" + pageId);
    // Leaving any previous reminder "stop" point: keep only this page reminders.
    await services.inactivityReminders.cancelPendingForUserExcept(user.id, pageId);
    const content = await services.menu.getMenuItemContent(user, pageId);
    const children = await services.menu.getMenuItemsForParent(user, content.item.id);

    if (content.locked) {
      // Locked content: cancel all pending reminders to avoid "soft spam" on an unreachable step.
      await services.inactivityReminders.cancelPendingForUserExcept(user.id, null);
      setNavBeforeShow(ctx, "paywall:locked:" + content.item.id);
      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        { text: services.i18n.t(user.selectedLanguage, "access_locked") },
        content.item.productId
          ? buildPaywallKeyboard(user.selectedLanguage, content.item.productId, services.i18n)
          : {}
      );
      return;
    }

    if (content.item.type === "SUBMENU" || children.length > 0) {
      const titleText = content.localization.title ? renderPageContent(content.localization.title, user) : "";
      const bodyText = content.localization.contentText ? renderPageContent(content.localization.contentText, user) : "";
      const composedText = composeTitleBody(titleText, bodyText);
      const hasMedia =
        (content.localization.mediaType === "PHOTO" ||
          content.localization.mediaType === "VIDEO" ||
          content.localization.mediaType === "DOCUMENT") &&
        Boolean(content.localization.mediaFileId);
      const slotOrder = await services.menu.getEffectiveSlotOrder(content.item.id, children.map((c) => c.id));
      const mentorUsername =
        user.mentorUserId ? (await services.users.findById(user.mentorUserId))?.username ?? null : null;
      const externalPartnerUrl = await services.cabinet.getPartnerRegisterLinkForUser(user);
      const partnerRegisterTargetId = await services.menu.getSystemTargetMenuItemId("partner_register");
      const productChatLinks =
        content.item.productId && content.item.product?.linkedChats
          ? await services.subscriptionChannel.resolveProductLinksForDisplay(
              content.item.product.linkedChats,
              ctx.telegram
            )
          : [];
      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        hasMedia
          ? {
              text: composedText,
              mediaType: content.localization.mediaType,
              mediaFileId: content.localization.mediaFileId
            }
          : { text: composedText },
        buildMenuKeyboard(
          children,
          user.selectedLanguage,
          services.i18n,
          content.item.parentId ?? "root",
          effectiveRole,
          content.item.id,
          slotOrder,
          mentorUsername,
          externalPartnerUrl,
          partnerRegisterTargetId,
          productChatLinks.length ? productChatLinks : undefined
        )
      );
      await services.inactivityReminders.scheduleForPageOpen(user, content.item.id, {
        shouldSchedule: false
      });
      return;
    }

    const contentSlotOrder = await services.menu.getEffectiveSlotOrder(content.item.id, []);
    const productChatLinks =
      content.item.productId && content.item.product?.linkedChats
        ? await services.subscriptionChannel.resolveProductLinksForDisplay(
            content.item.product.linkedChats,
            ctx.telegram
          )
        : [];
    await services.navigation.replaceScreen(
      user,
      ctx.telegram,
      ctx.chat?.id ?? user.telegramUserId,
      {
        text: content.localization.contentText ? renderPageContent(content.localization.contentText, user) : undefined,
        mediaType: content.localization.mediaType,
        mediaFileId: content.localization.mediaFileId,
        externalUrl: content.localization.externalUrl
      },
      buildContentScreenKeyboard(content.item.parentId ?? "root", user.selectedLanguage, services.i18n, {
        currentPageId: content.item.id,
        userRole: effectiveRole,
        slotOrder: contentSlotOrder,
        productChatLinks: productChatLinks.length ? productChatLinks : undefined
      })
    );

    await services.inactivityReminders.scheduleForPageOpen(user, content.item.id, {
      shouldSchedule: false
    });
  };

  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery && "data" in ctx.callbackQuery && ctx.callbackQuery.data === SCENE_CANCEL_DATA) {
      const botCtx = ctx as BotContext;
      const locale = services.i18n.resolveLanguage(botCtx.currentUser?.selectedLanguage);
      const sceneId = ctx.scene?.current?.id;

      logger.info(
        { userId: botCtx.currentUser?.id, sceneId },
        "Cancel button (scene:cancel) clicked"
      );

      // Подтверждаем callback, чтобы убрать "часики".
      try {
        await ctx.answerCbQuery();
      } catch {
        // ignore
      }

      if (sceneId) {
        logger.info({ userId: botCtx.currentUser?.id, sceneId }, "Leaving current scene due to cancel");
        await ctx.scene.leave();
      }

      const isConstructorScene =
        sceneId != null &&
        [CREATE_MENU_ITEM_SCENE, CREATE_SECTION_SCENE, CREATE_BUTTON_LINK_SCENE, CREATE_DRIP_SCENE].includes(sceneId);

      const baseKey = isConstructorScene ? "creation_cancelled" : "action_cancelled";
      const msg =
        services.i18n.t(locale, baseKey as any) +
        "\n" +
        services.i18n.t(locale, "cancel_reassurance");

      const kb =
        isAdminRole(botCtx.currentUser?.role) && isConstructorScene
          ? Markup.inlineKeyboard([
              buildNavigationRow(services.i18n, locale, { toMain: true }),
              [Markup.button.callback(services.i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))]
            ])
          : Markup.inlineKeyboard([buildNavigationRow(services.i18n, locale, { toMain: true })]);

      logger.info(
        {
          userId: botCtx.currentUser?.id,
          sceneId,
          isConstructorScene,
          destination: isConstructorScene ? "admin_or_main" : "main_only"
        },
        "Scene cancel handled, sending confirmation screen"
      );

      // Чтобы не плодить дубликаты одинаковых экранов в чате, стараемся редактировать
      // исходное сообщение с inline-кнопками, а не отправлять новое.
      if (ctx.callbackQuery.message && "message_id" in ctx.callbackQuery.message) {
        try {
          await ctx.editMessageText(msg, kb);
        } catch {
          // Если редактирование не удалось (сообщение уже изменено/устарело) — отправляем новое.
          await ctx.reply(msg, kb);
        }
      } else {
        await ctx.reply(msg, kb);
      }
      return;
    }
    if (ctx.message && "text" in ctx.message) {
      const text = (ctx.message as { text: string }).text.trim();
      const rawCmd = text.split(/\s/)[0]?.toLowerCase() ?? "";
      const cmd = rawCmd.split("@")[0] ?? rawCmd;
      if (cmd === "/admin" || cmd === "/cancel") {
        if (ctx.scene?.current) {
          const sceneId = ctx.scene.current.id;
          await ctx.scene.leave();
          const locale = services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
          const isConstructorScene = [CREATE_MENU_ITEM_SCENE, CREATE_SECTION_SCENE, CREATE_BUTTON_LINK_SCENE, CREATE_DRIP_SCENE].includes(sceneId);
          const cancelMsg = isConstructorScene
            ? services.i18n.t(locale, "creation_cancelled")
            : services.i18n.t(locale, "action_cancelled");
          const kb =
            isAdminRole(ctx.currentUser?.role) && isConstructorScene
              ? Markup.inlineKeyboard([
                  buildNavigationRow(services.i18n, locale, { toMain: true }),
                  [Markup.button.callback(services.i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))]
                ])
              : Markup.inlineKeyboard([buildNavigationRow(services.i18n, locale, { toMain: true })]);
          await ctx.reply(cancelMsg, kb);
          if (cmd === "/admin" && isAdminRole(ctx.currentUser?.role)) {
            const opts = await getAdminKeyboardOpts(ctx.currentUser!, resolveEffectiveRole(ctx));
            const adminText =
              services.i18n.t(locale, "admin_panel") + "\n\n" + services.i18n.t(locale, "changes_autosaved");
            await ctx.reply(adminText, buildAdminKeyboard(locale, services.i18n, opts));
            return;
          }
          if (cmd === "/cancel") {
            return;
          }
        }
        if (cmd === "/admin" && isAdminRole(ctx.currentUser?.role)) {
          const locale = services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
          const opts = await getAdminKeyboardOpts(ctx.currentUser!, resolveEffectiveRole(ctx));
          const adminText =
            services.i18n.t(locale, "admin_panel") + "\n\n" + services.i18n.t(locale, "changes_autosaved");
          await ctx.reply(adminText, buildAdminKeyboard(locale, services.i18n, opts));
          return;
        }
        if (cmd === "/cancel") {
          const locale = services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
          await ctx.reply(services.i18n.t(locale, "action_cancelled"));
          return;
        }
      }
    }

    // Step 1 intake: any message type (text, photo, video, document). Must run for photo+caption, not only "text" messages.
    if (
      ctx.message &&
      !ctx.scene?.current &&
      ctx.currentUser &&
      isAdminRole(ctx.currentUser.role) &&
      ctx.currentUser.onboardingStep === 1
    ) {
      const rawText = ctx.message && "text" in ctx.message ? (ctx.message as { text?: string }).text?.trim() ?? "" : "";
      if (!rawText.startsWith("/")) {
          const locale = services.i18n.resolveLanguage(ctx.currentUser.selectedLanguage);
          const stepLabel = (s: number) =>
            services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", String(s));
          const renderStep1Help = async () => {
            const step1Text =
              stepLabel(1) +
              "\n\n" +
              services.i18n.t(locale, "onboarding_step1_intro") +
              "\n\n" +
              services.i18n.t(locale, "personalization_hint");
            await ctx.reply(step1Text, Markup.inlineKeyboard([
              [Markup.button.callback(services.i18n.t(locale, "cancel_btn"), makeCallbackData("onboarding", "cancel")), ...buildNavigationRow(services.i18n, locale, { toMain: true })]
            ]));
          };

          try {
            logger.info({ userId: ctx.currentUser.id }, "Onboarding step 1 input received");
            const content = extractMessageContent(ctx);
            const supportedMedia = ["PHOTO", "VIDEO", "DOCUMENT"];
            const hasSupportedContent =
              content.text !== undefined ||
              (content.mediaFileId != null && (content.mediaType == null || supportedMedia.includes(content.mediaType)));

            if (!hasSupportedContent) {
              logger.info({ userId: ctx.currentUser.id }, "Onboarding step 1 validation failed: unsupported content");
              await ctx.reply(services.i18n.t(locale, "onboarding_step1_content_error"));
              await renderStep1Help();
              return;
            }

            logger.info({ userId: ctx.currentUser.id, mediaType: content.mediaType ?? null, hasText: Boolean(content.text), hasFile: Boolean(content.mediaFileId) }, "Onboarding step 1 content detected");
            const baseLang = await services.menu.getBaseLanguage(ctx.currentUser.id);
            const textForStorage = extractFormattedContentText(content);
            await services.menu.setWelcome(
              ctx.currentUser.id,
              baseLang,
              textForStorage,
              content.mediaType ?? "NONE",
              content.mediaFileId ?? null
            );
            logger.info({ userId: ctx.currentUser.id }, "Onboarding step 1 root content saved");

            const typeKey =
              content.mediaType === "PHOTO"
                ? "onboarding_step1_accepted_type_photo"
                : content.mediaType === "VIDEO"
                  ? "onboarding_step1_accepted_type_video"
                  : content.mediaType === "DOCUMENT"
                    ? content.text !== undefined && content.text !== ""
                      ? "onboarding_step1_accepted_type_document"
                      : "onboarding_step1_accepted_type_document_only"
                    : "onboarding_step1_accepted_type_text";
            const typeLabel = services.i18n.t(locale, typeKey);
            const textPreview =
              content.text != null && content.text !== ""
                ? content.text.length > 80
                  ? content.text.slice(0, 80) + "…"
                  : content.text
                : "";
            const whatAccepted =
              textPreview !== ""
                ? `${services.i18n.t(locale, "onboarding_step1_what_accepted")}:\n• ${typeLabel}\n• ${services.i18n.t(locale, "onboarding_step1_text_preview")}: ${textPreview}`
                : `${services.i18n.t(locale, "onboarding_step1_what_accepted")}:\n• ${typeLabel}`;
            const successBlock = [
              services.i18n.t(locale, "onboarding_step1_success"),
              "",
              whatAccepted,
              "",
              `${services.i18n.t(locale, "next_step")}: ${services.i18n.t(locale, "onboarding_step2_title")}`
            ].join("\n");
            await ctx.reply(successBlock);

            // Move to step 2 immediately and keep the wizard guided.
            await services.users.setOnboardingStep(ctx.currentUser.id, 2);
            const refreshed = await services.users.findById(ctx.currentUser.id);
            if (refreshed) ctx.currentUser = refreshed;
            logger.info({ userId: ctx.currentUser.id }, "Onboarding advanced to step 2");
            // Не отправляем отдельный текстовый экран шага 2 здесь,
            // чтобы не дублировать сообщение. Экран шага 2 полностью
            // показывает сама сцена CREATE_SECTION_SCENE.
            logger.info({ userId: ctx.currentUser.id }, "Onboarding step 2: entering create section scene");
            await ctx.scene.enter(CREATE_SECTION_SCENE, { parentId: null, fromPageId: "root", fromOnboardingStep: 2 });
            return;
          } catch (error) {
            logger.error({ userId: ctx.currentUser.id, error }, "Onboarding step 1 failed");
            await ctx.reply(services.i18n.t(locale, "onboarding_step_error_generic"));
            await renderStep1Help();
            return;
          }
      }
    }
    return next();
  });

  /** Reject stale wizard/scene callbacks when user is no longer in that scene. */
  // Only callbacks that belong to active scenes/wizards should be rejected as stale.
  // "dripm:" is a stable management route (not a scene), so it must NOT be treated as stale.
  const SCENE_CALLBACK_PREFIXES = ["create_sec:", "create_btn:", "create_menu:", "broadcast:", "drip:", "medialib:"];
  const isStaleSceneCallback = (data: string): boolean =>
    data === SCENE_CANCEL_DATA ||
    SCENE_CALLBACK_PREFIXES.some((p) => data.startsWith(p));

  bot.use(async (ctx, next) => {
    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      if (!ctx.scene?.current && isStaleSceneCallback(data)) {
        await ctx.answerCbQuery();
        const locale = services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
        await ctx.reply(services.i18n.t(locale, "action_stale"), buildStaleActionKeyboard(services.i18n, locale, isAdminRole(ctx.currentUser?.role)));
        return;
      }
    }
    return next();
  });

  bot.start(async (ctx) => {
    await resetUserSessionToRoot(ctx);
    await sendRootWithWelcome(ctx);
  });

  bot.command("admin", async (ctx) => {
    const currentUser = ctx.currentUser;
    const superAdminTelegramId = BigInt(process.env.SUPER_ADMIN_TELEGRAM_ID ?? "0");
    const isSuperAdmin = currentUser?.telegramUserId === superAdminTelegramId;

    // Preview override is only allowed for SUPER_ADMIN, per requirements.
    if (isSuperAdmin) {
      const s = ((ctx as unknown as { session?: any }).session ?? {}) as any;
      s.previewRole = "ADMIN" satisfies PreviewRole;
      (ctx as unknown as { session?: any }).session = s;

      await resetUserSessionToRoot(ctx);
      await sendRootWithWelcome(ctx);
      return;
    }

    // Non-preview: keep existing behavior for real admins.
    if (!isAdminRole(currentUser?.role)) {
      await ctx.reply(services.i18n.t(currentUser?.selectedLanguage, "permission_denied"));
      return;
    }

    const locale = services.i18n.resolveLanguage(currentUser?.selectedLanguage);
    const adminText = services.i18n.t(locale, "admin_panel") + "\n\n" + services.i18n.t(locale, "changes_autosaved");
    const opts = await getAdminKeyboardOpts(currentUser!, resolveEffectiveRole(ctx));
    await ctx.reply(adminText, buildAdminKeyboard(locale, services.i18n, opts));
  });

  bot.command("owner", async (ctx) => {
    const currentUser = ctx.currentUser;
    const superAdminTelegramId = BigInt(process.env.SUPER_ADMIN_TELEGRAM_ID ?? "0");
    const isSuperAdmin = currentUser?.telegramUserId === superAdminTelegramId;

    if (!isSuperAdmin) {
      const locale = services.i18n.resolveLanguage(currentUser?.selectedLanguage);
      await ctx.reply(services.i18n.t(locale, "permissions.denied"));
      return;
    }

    const s = ((ctx as unknown as { session?: any }).session ?? {}) as any;
    s.previewRole = "OWNER" satisfies PreviewRole;
    (ctx as unknown as { session?: any }).session = s;

    await resetUserSessionToRoot(ctx);
    await sendRootWithWelcome(ctx);
  });

  bot.command("alpha_owner", async (ctx) => {
    const currentUser = ctx.currentUser;
    const superAdminTelegramId = BigInt(process.env.SUPER_ADMIN_TELEGRAM_ID ?? "0");
    const isSuperAdmin = currentUser?.telegramUserId === superAdminTelegramId;

    if (!isSuperAdmin) {
      const locale = services.i18n.resolveLanguage(currentUser?.selectedLanguage);
      await ctx.reply(services.i18n.t(locale, "permissions.denied"));
      return;
    }

    const s = ((ctx as unknown as { session?: any }).session ?? {}) as any;
    s.previewRole = "ALPHA_OWNER" satisfies PreviewRole;
    (ctx as unknown as { session?: any }).session = s;

    await resetUserSessionToRoot(ctx);
    await sendRootWithWelcome(ctx);
  });

  bot.command("user", async (ctx) => {
    const currentUser = ctx.currentUser;
    const superAdminTelegramId = BigInt(process.env.SUPER_ADMIN_TELEGRAM_ID ?? "0");
    const isSuperAdmin = currentUser?.telegramUserId === superAdminTelegramId;

    if (!isSuperAdmin) {
      const locale = services.i18n.resolveLanguage(currentUser?.selectedLanguage);
      await ctx.reply(services.i18n.t(locale, "permissions.denied"));
      return;
    }

    const s = ((ctx as unknown as { session?: any }).session ?? {}) as any;
    s.previewRole = "USER" satisfies PreviewRole;
    (ctx as unknown as { session?: any }).session = s;

    await resetUserSessionToRoot(ctx);
    await sendRootWithWelcome(ctx);
  });

  bot.command("grant_admin", async (ctx) => {
    await services.permissions.ensureOwner(ctx.currentUser!.id);
    const arg = extractCommandArgument(readTextMessage(ctx));
    await services.permissions.grantAdmin(ctx.currentUser!.id, arg);
    await ctx.reply(`Admin granted: ${arg}`);
  });

  bot.command("revoke_admin", async (ctx) => {
    await services.permissions.ensureOwner(ctx.currentUser!.id);
    const arg = extractCommandArgument(readTextMessage(ctx));
    await services.permissions.revokeAdmin(ctx.currentUser!.id, arg);
    await ctx.reply(`Admin revoked: ${arg}`);
  });

  bot.command("create_menu_item", async (ctx) => {
    await services.permissions.ensurePermission(ctx.currentUser!.id, "canEditMenu");
    await ctx.scene.enter(CREATE_MENU_ITEM_SCENE);
  });

  bot.command("create_broadcast", async (ctx) => {
    await services.permissions.ensurePermission(ctx.currentUser!.id, "canSendBroadcasts");
    await ctx.scene.enter(CREATE_BROADCAST_SCENE);
  });

  bot.command("create_scheduled_broadcast", async (ctx) => {
    await services.permissions.ensurePermission(ctx.currentUser!.id, "canScheduleMessages");
    await ctx.scene.enter(CREATE_SCHEDULED_BROADCAST_SCENE);
  });

  bot.command("set_timezone", async (ctx) => {
    const user = ctx.currentUser;
    if (!user) return;

    const arg = extractCommandArgument(readTextMessage(ctx));
    if (!arg) {
      await ctx.reply("Укажите timezone для локальной доставки. Пример: `Europe/Warsaw` или `UTC`");
      return;
    }

    const normalized = arg.trim();
    if (["unset", "clear", "none"].includes(normalized.toLowerCase())) {
      await services.users.setTimeZone(user.id, null);
      await ctx.reply("Timezone очищен (будет использоваться fallback).");
      return;
    }

    const tz = normalized.toUpperCase() === "UTC" ? "UTC" : normalized;
    if (!isValidTimeZone(tz)) {
      await ctx.reply("Некорректный timezone. Ожидается IANA-строка: например `Europe/Warsaw`.");
      return;
    }

    await services.users.setTimeZone(user.id, tz);
    await ctx.reply(`Timezone сохранен: ${tz}`);
  });

  bot.command("create_drip_campaign", async (ctx) => {
    await services.permissions.ensurePermission(ctx.currentUser!.id, "canSendBroadcasts");
    await ctx.scene.enter(CREATE_DRIP_SCENE);
  });

  bot.command("set_welcome", async (ctx) => {
    await services.permissions.ensurePermission(ctx.currentUser!.id, "canManageTemplates");
    const raw = extractCommandArgument(readTextMessage(ctx));
    const [languageCode, ...textParts] = raw.split(" ");
    const text = textParts.join(" ").trim();

    if (!languageCode || !text) {
      await ctx.reply(services.i18n.t(ctx.currentUser?.selectedLanguage ?? "ru", "set_welcome_use_constructor"));
      return;
    }

    await services.menu.setWelcome(ctx.currentUser!.id, languageCode.toLowerCase(), text);
    await ctx.reply(services.i18n.t(ctx.currentUser?.selectedLanguage, "welcome_builder_saved"));
  });

  bot.command("preview_menu", async (ctx) => {
    await services.permissions.ensurePermission(ctx.currentUser!.id, "canEditMenu");
    const preview = await services.menu.previewTree(ctx.currentUser!.selectedLanguage);
    await ctx.reply(preview);
  });

  bot.command("publish", async (ctx) => {
    await services.permissions.ensurePermission(ctx.currentUser!.id, "canManageTemplates");
    await services.audit.log(ctx.currentUser!.id, "publish_template", "presentation_template", null, {});
    await ctx.reply(services.i18n.t(ctx.currentUser?.selectedLanguage, "publish_done"));
  });

  bot.command("confirm_payment", async (ctx) => {
    await services.permissions.ensurePermission(ctx.currentUser!.id, "canManagePayments");
    const paymentId = extractCommandArgument(readTextMessage(ctx));
    await services.payments.confirmPayment(paymentId, ctx.currentUser!.id);
    const locale = services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    await ctx.reply(services.i18n.t(locale, "payment_confirmed_admin"));
  });

  bot.command("export_users", async (ctx) => {
    const effectiveRole = resolveEffectiveRole(ctx);
    const locale = services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    const { buffer, totalCount, exportDate } = await services.exports.buildUsersHtmlReport(ctx.currentUser!, {
      effectiveRole: effectiveRole as any,
      languageCode: locale
    });
    const filename = services.exports.formatExportFilename("html", exportDate, "users");
      const captionTypeLabel = services.i18n.t(
        locale,
        effectiveRole === "ALPHA_OWNER" ? "export_type_users_html" : "export_type_first_line_html"
      );
    const caption = services.i18n
      .t(locale, "export_caption_with_type")
      .replace("{{type}}", captionTypeLabel)
      .replace("{{date}}", services.exports.formatExportDate(exportDate))
      .replace("{{count}}", String(totalCount));
    await ctx.replyWithDocument(
      { source: buffer, filename },
      { caption }
    );
  });

  bot.on("contact", async (ctx) => {
    await services.users.saveContact(ctx.currentUser!.id, ctx.message.contact.phone_number);
    const locale = services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    await ctx.reply(services.i18n.t(locale, "contact_saved"));
  });

  bot.action(/.*/, async (ctx) => {
    if (!("data" in ctx.callbackQuery)) {
      return;
    }

    const parts = splitCallbackData(ctx.callbackQuery.data);
    const [scope, action, value, extra] = parts;
    const user = ctx.currentUser!;

    try {
      await ctx.answerCbQuery();
    } catch {
      // ignore: Telegram may reject late/duplicate callback answers
    }

    if (scope === "nav") {
      if (action === "root") {
        // Always use the unified root resolver with welcome + real saved root page.
        await sendRootWithWelcome(ctx);
        return;
      }
      if (action === "back") {
        const prev = getNavSession(ctx).navPrev;
        if (prev?.startsWith("menu:open:")) {
          const pageId = prev.slice("menu:open:".length);
          await sendMenuPage(ctx, pageId === "root" ? null : pageId);
          return;
        }
        if (prev === "cabinet:open" || prev === "cabinet:structure") {
          const cabinet = await services.cabinet.buildCabinet(user);
          setNavCurrent(ctx, "cabinet:open");
          const showPayButton = await services.cabinet.shouldShowPayButton(user);
          const link = services.cabinet.getReferralLink(user);
          const mentorUsername = user.mentorUserId
            ? (await services.users.findById(user.mentorUserId))?.username ?? null
            : null;
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: cabinet },
            buildCabinetKeyboard(user.selectedLanguage, services.i18n, link, {
              showPayButton,
              showAdminLink: isAdminRole(resolveEffectiveRole(ctx)),
              mentorUsername,
              showLanguageButton: await shouldShowCabinetLanguageButton(user)
            })
          );
          return;
        }
        if (prev === "admin:open" && isAdminRole(user.role)) {
          const locale = services.i18n.resolveLanguage(user.selectedLanguage);
          setNavCurrent(ctx, "admin:open");
          const opts = await getAdminKeyboardOpts(user, resolveEffectiveRole(ctx));
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: services.i18n.t(locale, "admin_panel") },
            buildAdminKeyboard(locale, services.i18n, opts)
          );
          return;
        }
        if (prev?.startsWith("page_edit:open:")) {
          const pageId = prev.slice("page_edit:open:".length);
          const locale = services.i18n.resolveLanguage(user.selectedLanguage);
          const children = await services.menu.getChildMenuItemsForAdmin(pageId === "root" ? null : pageId);
          const pageTitle =
            pageId === "root"
              ? services.i18n.t(locale, "page_root_title")
              : await (async () => {
                  const item = await services.menu.findMenuItemById(pageId);
                  if (item) {
                    const loc = services.i18n.pickLocalized(item.localizations, locale);
                    return loc?.title ?? item.key;
                  }
                  return pageId;
                })();
          const childList = children.map((c) => ({
            id: c.id,
            title: services.i18n.pickLocalized(c.localizations, locale)?.title ?? c.key,
            isActive: c.isActive,
            type: c.type
          }));
          setNavCurrent(ctx, prev);
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: pageTitle },
            buildPageEditorKeyboard(pageId, childList, locale, services.i18n)
          );
          return;
        }
        if (prev === "lang:picker") {
          setNavCurrent(ctx, "lang:picker");
          const activeLangCodes = await services.menu.getActiveTemplateLanguageCodes();
          const codesSet = new Set(activeLangCodes.map((c) => String(c).toLowerCase()));
          if (user.selectedLanguage) codesSet.add(String(user.selectedLanguage).toLowerCase());
          // Always allow selecting base language and RU even when menu-item localizations are still empty.
          // This prevents UX dead-ends like "no Russian language available".
          const baseLang = await services.menu.getBaseLanguage(user.id);
          codesSet.add(String(baseLang).toLowerCase());
          codesSet.add("ru");
          const languageCodes = Array.from(codesSet);
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: services.i18n.t(user.selectedLanguage, "wizard_step_lang") },
            buildLanguageKeyboard(services.i18n, user.selectedLanguage, languageCodes)
          );
          return;
        }
        if (prev === "mentor:open") {
          setNavCurrent(ctx, "mentor:open");
          if (!user.mentorUserId) {
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text: services.i18n.t(user.selectedLanguage, "mentor_not_assigned") },
              Markup.inlineKeyboard([buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })])
            );
            return;
          }
          const mentor = await services.users.findById(user.mentorUserId);
          if (!mentor) {
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text: services.i18n.t(user.selectedLanguage, "mentor_not_found") },
              Markup.inlineKeyboard([buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })])
            );
            return;
          }
          if (mentor.username) {
            const locale = services.i18n.resolveLanguage(user.selectedLanguage);
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text: `https://t.me/${mentor.username}` },
              Markup.inlineKeyboard([
                [Markup.button.url(services.i18n.t(locale, "open_mentor_btn"), `https://t.me/${mentor.username}`)],
                buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })
              ])
            );
            return;
          }
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: services.i18n.t(user.selectedLanguage, "no_mentor_username") },
            Markup.inlineKeyboard([buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })])
          );
          return;
        }
        if (prev?.startsWith("paywall:") || prev?.startsWith("pay:")) {
          await sendRootWithWelcome(ctx);
          return;
        }
        await sendRootWithWelcome(ctx);
        return;
      }
      return;
    }

    if (scope === "page_edit") {
      if (!isAdminRole(user.role)) {
        await ctx.reply(services.i18n.t(user.selectedLanguage, "permission_denied"));
        return;
      }
      // `locale` is used only for UI (static dictionary strings).
      // `contentLanguageCode` must be the exact DB localization languageCode (no fallback-to-ru).
      const locale = resolveAdminUiLanguageCode(user);
      const contentLanguageCode = resolveEditingContentLanguageCode(ctx, user);

      const showPageEditor = async (pageId: string) => {
        const children = await services.menu.getChildMenuItemsForAdmin(pageId === "root" ? null : pageId);
        const pageTitle =
          pageId === "root"
            ? services.i18n.t(locale, "page_root_title")
            : await (async () => {
                const item = await services.menu.findMenuItemById(pageId);
                if (item) {
                  const loc = services.i18n.pickLocalized(item.localizations, contentLanguageCode);
                  return loc?.title ?? item.key;
                }
                return pageId;
              })();
        const parentTitle =
          pageId === "root"
            ? null
            : await (async () => {
                const item = await services.menu.findMenuItemById(pageId);
                if (!item?.parentId) return null;
                const parent = await services.menu.findMenuItemById(item.parentId);
                if (!parent) return null;
                const loc = services.i18n.pickLocalized(parent.localizations, contentLanguageCode);
                return loc?.title ?? parent.key;
              })();

        const { childSections, buttons } = await services.menu.getPageEditorBlocks(
          pageId === "root" ? null : pageId,
          contentLanguageCode
        );
        const childList = children.map((c) => ({
          id: c.id,
          title: services.i18n.pickLocalized(c.localizations, contentLanguageCode)?.title ?? c.key,
          isActive: c.isActive,
          type: c.type
        }));

        const header = services.i18n.t(locale, "screen_header_page_editor");
        const contextLine =
          pageId === "root"
            ? services.i18n.t(locale, "page_editor_parent_root")
            : services.i18n.t(locale, "page_editor_editing").replace("{{title}}", pageTitle);
        const parentLine =
          parentTitle != null
            ? "\n" + services.i18n.t(locale, "page_editor_parent").replace("{{title}}", parentTitle)
            : "";
        const blockChildrenLabel = services.i18n.t(locale, "page_editor_block_children");
        const blockChildrenList =
          childSections.length === 0
            ? services.i18n.t(locale, "page_editor_no_children")
            : childSections.map((s) => `• ${s.title}`).join("\n");
        const blockButtonsLabel = services.i18n.t(locale, "page_editor_block_buttons");
        const blockButtonsList =
          buttons.length === 0
            ? services.i18n.t(locale, "page_editor_no_buttons")
            : buttons.map((b) => `• ${b.title} → ${b.targetTitle}`).join("\n");
        const screenText = [
          header,
          contextLine + parentLine,
          "",
          `${blockChildrenLabel}:`,
          blockChildrenList,
          "",
          `${blockButtonsLabel}:`,
          blockButtonsList
        ].join("\n");

        // Detect if current localization has video attached (for "remove video" action).
        const locRow =
          pageId === "root"
            ? null
            : await services.menu.findMenuItemById(pageId).then((item) => {
                if (!item) return null;
                const loc = services.i18n.pickLocalized(item.localizations, contentLanguageCode);
                return loc ?? null;
              });
        const hasVideo = (locRow as any)?.mediaType === "VIDEO" && Boolean((locRow as any)?.mediaFileId);

        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text: screenText },
          buildPageEditorKeyboard(pageId, childList, locale, services.i18n, {
            hasVideo,
            editingContentLanguageCode: contentLanguageCode
          })
        );
      };

      const showButtonManagement = async (pageId: string) => {
        setNavCurrent(ctx, "page_edit:buttons:" + pageId);
        const children = await services.menu.getChildMenuItemsForAdmin(pageId === "root" ? null : pageId);
        const contentIdsOrdered = children.map((c) => c.id);
        const slotOrder = await services.menu.getEffectiveSlotOrder(pageId, contentIdsOrdered);
        const isRoot = pageId === "root";
        const items: ButtonManagementItem[] = [];
        for (const slotId of slotOrder) {
          if (slotId === MenuService.NAV_SLOT_BACK && !isRoot) {
            items.push({
              id: slotId,
              title: services.i18n.t(locale, "back"),
              isActive: true,
              type: "TEXT",
              isNavSlot: true
            });
          } else if (slotId === MenuService.NAV_SLOT_TO_MAIN) {
            items.push({
              id: slotId,
              title: services.i18n.t(locale, "to_main_menu"),
              isActive: true,
              type: "TEXT",
              isNavSlot: true
            });
          } else {
            const c = children.find((x) => x.id === slotId);
            if (c) {
                const title = services.i18n.pickLocalized(c.localizations, contentLanguageCode)?.title ?? c.key;
              let targetTitle: string | undefined;
              if (c.type === "SECTION_LINK" && c.targetMenuItemId) {
                const target = await services.menu.findMenuItemById(c.targetMenuItemId);
                targetTitle = target
                  ? services.i18n.pickLocalized(target.localizations, contentLanguageCode)?.title ?? target.key
                  : undefined;
              }
              items.push({ id: c.id, title, isActive: c.isActive, type: c.type, targetTitle });
            }
          }
        }
        if (!isRoot) {
          if (!slotOrder.includes(MenuService.NAV_SLOT_BACK)) {
            items.push({
              id: MenuService.NAV_SLOT_BACK,
              title: services.i18n.t(locale, "back"),
              isActive: false,
              type: "TEXT",
              isNavSlot: true
            });
          }
          if (!slotOrder.includes(MenuService.NAV_SLOT_TO_MAIN)) {
            items.push({
              id: MenuService.NAV_SLOT_TO_MAIN,
              title: services.i18n.t(locale, "to_main_menu"),
              isActive: false,
              type: "TEXT",
              isNavSlot: true
            });
          }
        }
        const header =
          services.i18n.t(locale, "page_manage_buttons") +
          "\n\n" +
          services.i18n.t(locale, "hint_manage_buttons");
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text: header },
          buildButtonManagementKeyboard(pageId, items, locale, services.i18n)
        );
      };

      const showRemindersHub = async (triggerPageId: string) => {
        const locale = services.i18n.resolveLanguage(user.selectedLanguage);
          const pageTitle =
          triggerPageId === "root"
            ? services.i18n.t(locale, "page_root_title")
            : await services.menu.findMenuItemById(triggerPageId).then((it) => {
                const loc = it ? services.i18n.pickLocalized(it.localizations, contentLanguageCode) : null;
                return loc?.title ?? it?.key ?? triggerPageId;
              });

        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback(services.i18n.t(locale, "reminders_btn_add"), makeCallbackData("page_edit", "rem_add", triggerPageId))],
          [Markup.button.callback(services.i18n.t(locale, "reminders_btn_templates"), makeCallbackData("page_edit", "rem_tpl", triggerPageId))],
          [Markup.button.callback(services.i18n.t(locale, "reminders_btn_timer"), makeCallbackData("page_edit", "rem_timer", triggerPageId))],
          [Markup.button.callback(services.i18n.t(locale, "reminders_btn_active"), makeCallbackData("page_edit", "rem_list", triggerPageId))],
          [Markup.button.callback(services.i18n.t(locale, "back"), makeCallbackData("page_edit", "open", triggerPageId))],
          [Markup.button.callback(services.i18n.t(locale, "to_main_menu"), NAV_ROOT_DATA)]
        ]);

        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          {
            text: [
              services.i18n.t(locale, "reminders_hub_title"),
              "",
              services.i18n.t(locale, "reminders_hub_source_page").replace("{{title}}", pageTitle),
              services.i18n.t(locale, "reminders_hub_description")
            ].join("\n")
          },
          keyboard
        );
      };

      const showRemindersTimerScreen = async (triggerPageId: string) => {
        const locale = services.i18n.resolveLanguage(user.selectedLanguage);
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          {
            text: [
              services.i18n.t(locale, "reminders_timer_title"),
              "",
              services.i18n.t(locale, "reminders_timer_description")
            ].join("\n")
          },
          Markup.inlineKeyboard([
            [Markup.button.callback(services.i18n.t(locale, "reminders_btn_add"), makeCallbackData("page_edit", "rem_add", triggerPageId))],
            [Markup.button.callback(services.i18n.t(locale, "back"), makeCallbackData("page_edit", "open_reminders", triggerPageId))],
            [Markup.button.callback(services.i18n.t(locale, "to_main_menu"), NAV_ROOT_DATA)]
          ])
        );
      };

      const showRemindersActive = async (triggerPageId: string) => {
        const locale = services.i18n.resolveLanguage(user.selectedLanguage);

        const rules = await services.inactivityReminders.listRulesForTriggerPageId(triggerPageId);
        const sourcePageTitle =
          triggerPageId === "root"
            ? services.i18n.t(locale, "page_root_title")
            : await services.menu.findMenuItemById(triggerPageId).then((it) => {
                if (!it) return triggerPageId;
                return services.i18n.pickLocalized(it.localizations, contentLanguageCode)?.title ?? it.key;
              });

        if (rules.length === 0) {
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            {
              text: [
                services.i18n.t(locale, "reminders_active_title"),
                "",
                `Для страницы: ${sourcePageTitle}`,
                "",
                services.i18n.t(locale, "reminders_active_empty")
              ].join("\n")
            },
            Markup.inlineKeyboard([
              [Markup.button.callback(services.i18n.t(locale, "reminders_btn_add"), makeCallbackData("page_edit", "rem_add", triggerPageId))],
              [Markup.button.callback(services.i18n.t(locale, "back"), makeCallbackData("page_edit", "open_reminders", triggerPageId))],
              [Markup.button.callback(services.i18n.t(locale, "to_main_menu"), NAV_ROOT_DATA)]
            ])
          );
          return;
        }

        const lines: string[] = [
          services.i18n.t(locale, "reminders_active_title"),
          "",
          `Страница-источник: ${sourcePageTitle}`,
          ""
        ];
        const keyboardRows: any[] = [];

        for (const [idx, rule] of rules.entries()) {
          const templateTitle = rule.template?.title ?? rule.templateId;
          const targetItem = await services.menu.findMenuItemById(rule.targetMenuItemId);
          const targetTitle = targetItem
            ? services.i18n.pickLocalized(targetItem.localizations, contentLanguageCode)?.title ?? targetItem.key
            : rule.targetMenuItemId;
          const statusLabel = rule.isActive ? "ВКЛЮЧЕНО" : "ВЫКЛЮЧЕНО";

          lines.push(
            `#${idx + 1}`,
            `Целевое действие: ${targetTitle}`,
            `Задержка: ${rule.delayMinutes} мин`,
            `Шаблон: ${templateTitle}`,
            `CTA: ${rule.ctaLabel}`,
            `Статус: ${statusLabel}`,
            ""
          );

          keyboardRows.push([
            Markup.button.callback(
              `${rule.isActive ? "⛔️ Отключить" : "✅ Включить"} #${idx + 1}`,
              makeCallbackData("page_edit", "rem_toggle", rule.id)
            )
          ]);
          keyboardRows.push([Markup.button.callback(`✏️ Изменить #${idx + 1}`, makeCallbackData("page_edit", "rem_edit", rule.id))]);
          keyboardRows.push([Markup.button.callback(`🗑 Удалить #${idx + 1}`, makeCallbackData("page_edit", "rem_del_confirm", rule.id))]);
        }

        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          {
            text: lines.join("\n")
          },
          Markup.inlineKeyboard([
            ...keyboardRows,
            [Markup.button.callback(services.i18n.t(locale, "reminders_btn_add"), makeCallbackData("page_edit", "rem_add", triggerPageId))],
            [Markup.button.callback(services.i18n.t(locale, "back"), makeCallbackData("page_edit", "open_reminders", triggerPageId))],
            [Markup.button.callback(services.i18n.t(locale, "to_main_menu"), NAV_ROOT_DATA)]
          ])
        );
      };

      if (action === "open" && value) {
        setNavBeforeShow(ctx, "page_edit:open:" + value);
        try {
          if (value !== "root") {
            const item = await services.menu.findMenuItemById(value);
            if (!item) {
              await ctx.reply(services.i18n.t(locale, "error_generic"));
              await sendRootWithWelcome(ctx);
              return;
            }
          }
          await showPageEditor(value);
        } catch (err) {
          logger.error({ err, pageId: value, userId: user.id }, "showPageEditor failed");
          await ctx.reply(services.i18n.t(locale, "error_generic"));
          await sendRootWithWelcome(ctx);
        }
        return;
      }

      if (action === "open_content_menu" && value) {
        const pageId = value;
        const editingLangCode = extra
          ? services.i18n.normalizeLocalizationLanguageCode(String(extra))
          : contentLanguageCode;
        const locRow =
          pageId === "root"
            ? null
            : await services.menu.findMenuItemById(pageId).then((item) => {
                if (!item) return null;
                const loc = services.i18n.pickLocalized(item.localizations, editingLangCode);
                return loc ?? null;
              });
        const hasVideo = (locRow as any)?.mediaType === "VIDEO" && Boolean((locRow as any)?.mediaFileId);
        const pageTitle =
          pageId === "root"
            ? services.i18n.t(locale, "page_root_title")
            : await services.menu.findMenuItemById(pageId).then((it) => {
                const loc = it ? services.i18n.pickLocalized(it.localizations, editingLangCode) : null;
                return loc?.title ?? it?.key ?? pageId;
              });
        const header = services.i18n.t(locale, "page_edit_content");
        const contextLine = services.i18n.t(locale, "page_editor_editing").replace("{{title}}", pageTitle);
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text: `${header}\n\n${contextLine}` },
          buildPageEditorContentSubmenuKeyboard(pageId, locale, services.i18n, {
            hasVideo,
            editingContentLanguageCode: editingLangCode
          })
        );
        return;
      }

      if (action === "back" && value) {
        const pageId = value;
        const nav = getNavSession(ctx).navCurrent ?? "";
        if (nav.startsWith("page_edit:buttons:")) {
          setNavCurrent(ctx, "page_edit:open:" + pageId);
          await showPageEditor(pageId);
          return;
        }
        if (pageId === "root") {
          await sendRootWithWelcome(ctx);
        } else {
          const item = await services.menu.findMenuItemById(pageId);
          const parentId = item?.parentId ?? null;
          if (parentId === null) {
            await sendRootWithWelcome(ctx);
          } else {
            setNavCurrent(ctx, "page_edit:open:" + parentId);
            await showPageEditor(parentId);
          }
        }
        return;
      }

      const enterEditContentScene = async (
        pageId: string,
        updateMode: "full" | "text_only" | "photo_only" | "video_only" | "document_only"
      ) => {
        await ctx.reply(services.i18n.t(locale, "explain_edit_content"));
        const editingLanguageCode = extra
          ? services.i18n.normalizeLocalizationLanguageCode(String(extra))
          : contentLanguageCode;
        setEditingContentLanguageCode(ctx, editingLanguageCode);
        await ctx.scene.enter(EDIT_PAGE_CONTENT_SCENE, {
          menuItemId: pageId,
          isRoot: pageId === "root",
          languageCode: editingLanguageCode,
          uiLanguageCode: locale,
          updateMode
        });
      };

      if ((action === "edit" || action === "edit_full") && value) {
        await enterEditContentScene(value, "full");
        return;
      }
      if (action === "edit_text" && value) {
        await enterEditContentScene(value, "text_only");
        return;
      }
      if (action === "edit_photo" && value) {
        await enterEditContentScene(value, "photo_only");
        return;
      }
      if (action === "edit_video" && value) {
        await enterEditContentScene(value, "video_only");
        return;
      }
      if (action === "edit_document" && value) {
        await enterEditContentScene(value, "document_only");
        return;
      }

      if (action === "attach_video" && value) {
        const pageId = value;
        await ctx.scene.enter(ATTACH_VIDEO_FROM_LIBRARY_SCENE, {
          pageId,
          languageCode: contentLanguageCode,
          uiLanguageCode: locale
        });
        return;
      }

      if (action === "detach_video" && value) {
        const pageId = value;
        await services.menu.updateMenuItemContent(pageId, user.id, contentLanguageCode, {
          mediaType: "NONE",
          mediaFileId: null
        });
        await ctx.reply(services.i18n.t(locale, "page_video_detached"));
        await showPageEditor(pageId);
        return;
      }

      if (action === "add_btn" && value) {
        const parentId = value === "root" ? null : value;
        const fromPageId = value;
        await ctx.reply(services.i18n.t(locale, "explain_add_button"));
        await ctx.scene.enter(CREATE_BUTTON_LINK_SCENE, {
          parentId,
          fromPageId,
          languageCode: contentLanguageCode,
          uiLanguageCode: locale
        });
        return;
      }

      if (action === "add_sec" && value) {
        const parentId = value === "root" ? null : value;
        const fromPageId = value;
        await ctx.reply(services.i18n.t(locale, "explain_add_section"));
        await ctx.scene.enter(CREATE_SECTION_SCENE, {
          parentId,
          fromPageId,
          languageCode: contentLanguageCode,
          uiLanguageCode: locale
        });
        return;
      }

      if (action === "manage_buttons" && value) {
        await showButtonManagement(value);
        return;
      }

      if (action === "open_reminders" && value) {
        await showRemindersHub(value);
        return;
      }

      if (action === "rem_add" && value) {
        await ctx.scene.enter(INACTIVITY_REMINDER_ADMIN_SCENE, {
          mode: "create",
          triggerPageId: value,
          uiLanguageCode: locale,
          contentLanguageCode: contentLanguageCode
        });
        return;
      }

      // Backward-compatible aliases for already-sent buttons (old callback keys).
      if (action === "reminders_add" && value) {
        await ctx.scene.enter(INACTIVITY_REMINDER_ADMIN_SCENE, {
          mode: "create",
          triggerPageId: value,
          uiLanguageCode: locale,
          contentLanguageCode: contentLanguageCode
        });
        return;
      }

      if (action === "rem_tpl" && value) {
        await ctx.scene.enter(INACTIVITY_REMINDER_ADMIN_SCENE, {
          mode: "browse_templates",
          triggerPageId: value,
          uiLanguageCode: locale,
          contentLanguageCode: contentLanguageCode
        });
        return;
      }

      if (action === "reminders_templates" && value) {
        await ctx.scene.enter(INACTIVITY_REMINDER_ADMIN_SCENE, {
          mode: "browse_templates",
          triggerPageId: value,
          uiLanguageCode: locale,
          contentLanguageCode: contentLanguageCode
        });
        return;
      }

      if (action === "rem_timer" && value) {
        await showRemindersTimerScreen(value);
        return;
      }

      if (action === "reminders_timer" && value) {
        await showRemindersTimerScreen(value);
        return;
      }

      if (action === "rem_list" && value) {
        await showRemindersActive(value);
        return;
      }

      if (action === "reminders_active" && value) {
        await showRemindersActive(value);
        return;
      }

      if (action === "rem_edit" && value && extra) {
        const ruleId = value;
        const triggerPageId = extra;
        await ctx.scene.enter(INACTIVITY_REMINDER_ADMIN_SCENE, {
          mode: "edit",
          triggerPageId,
          ruleId,
          uiLanguageCode: locale,
          contentLanguageCode: contentLanguageCode
        });
        return;
      }
      if (action === "rem_edit" && value && !extra) {
        const byId = await services.inactivityReminders.getRuleById(value);
        const triggerPageId = byId?.triggerPageId ?? value;
        const rule = byId ?? (await services.inactivityReminders.getRuleByTriggerPageId(triggerPageId));
        if (!rule) { await showRemindersActive(triggerPageId); return; }
        await ctx.scene.enter(INACTIVITY_REMINDER_ADMIN_SCENE, {
          mode: "edit",
          triggerPageId,
          ruleId: rule.id,
          uiLanguageCode: locale,
          contentLanguageCode: contentLanguageCode
        });
        return;
      }

      if (action === "reminders_edit" && value) {
        const triggerPageId = value;
        await ctx.scene.enter(INACTIVITY_REMINDER_ADMIN_SCENE, {
          mode: "edit",
          triggerPageId,
          uiLanguageCode: locale,
          contentLanguageCode: contentLanguageCode
        });
        return;
      }

      if (action === "rem_toggle" && value) {
        const byId = await services.inactivityReminders.getRuleById(value);
        const triggerPageId = byId?.triggerPageId ?? (extra ?? value);
        const rule = byId ?? (await services.inactivityReminders.getRuleByTriggerPageId(triggerPageId));
        if (rule) {
          await services.inactivityReminders.setRuleActive(rule.id, !rule.isActive);
        }
        await showRemindersActive(triggerPageId);
        return;
      }

      if (action === "reminders_toggle" && value && extra) {
        // Old format: value=ruleId, extra=triggerPageId
        const triggerPageId = extra;
        const rule = await services.inactivityReminders.getRuleById(value);
        if (rule) {
          await services.inactivityReminders.setRuleActive(rule.id, !rule.isActive);
        }
        await showRemindersActive(triggerPageId);
        return;
      }

      if (action === "rem_del_confirm" && value && extra) {
        const ruleId = value;
        const triggerPageId = extra;
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          {
            text: "🗑 Удалить напоминание? Это действие нельзя отменить."
          },
          Markup.inlineKeyboard([
            [Markup.button.callback("🗑 Да, удалить", makeCallbackData("page_edit", "rem_del", ruleId, triggerPageId))],
            [Markup.button.callback(services.i18n.t(locale, "back"), makeCallbackData("page_edit", "rem_list", triggerPageId))]
          ])
        );
        return;
      }
      if (action === "rem_del_confirm" && value && !extra) {
        const byId = await services.inactivityReminders.getRuleById(value);
        const triggerPageId = byId?.triggerPageId ?? value;
        const rule = byId ?? (await services.inactivityReminders.getRuleByTriggerPageId(triggerPageId));
        if (!rule) { await showRemindersActive(triggerPageId); return; }
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          {
            text: "🗑 Удалить напоминание? Это действие нельзя отменить."
          },
          Markup.inlineKeyboard([
            [Markup.button.callback("🗑 Да, удалить", makeCallbackData("page_edit", "rem_del", rule.id))],
            [Markup.button.callback(services.i18n.t(locale, "back"), makeCallbackData("page_edit", "rem_list", triggerPageId))]
          ])
        );
        return;
      }

      if (action === "reminders_delete_confirm" && value && extra) {
        // Old format: value=ruleId, extra=triggerPageId
        const triggerPageId = extra;
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          {
            text: "🗑 Удалить напоминание? Это действие нельзя отменить."
          },
          Markup.inlineKeyboard([
            [Markup.button.callback("🗑 Да, удалить", makeCallbackData("page_edit", "rem_del", value, triggerPageId))],
            [Markup.button.callback(services.i18n.t(locale, "back"), makeCallbackData("page_edit", "rem_list", triggerPageId))]
          ])
        );
        return;
      }

      if (action === "rem_del" && value && extra) {
        const ruleId = value;
        const triggerPageId = extra;
        await services.inactivityReminders.deleteRule(ruleId);
        await showRemindersActive(triggerPageId);
        return;
      }
      if (action === "rem_del" && value && !extra) {
        const byId = await services.inactivityReminders.getRuleById(value);
        const triggerPageId = byId?.triggerPageId ?? value;
        const rule = byId ?? (await services.inactivityReminders.getRuleByTriggerPageId(triggerPageId));
        if (rule) {
          await services.inactivityReminders.deleteRule(rule.id);
        }
        await showRemindersActive(triggerPageId);
        return;
      }

      if (action === "reminders_delete" && value && extra) {
        // Old format: value=ruleId, extra=triggerPageId
        const triggerPageId = extra;
        await services.inactivityReminders.deleteRule(value);
        await showRemindersActive(triggerPageId);
        return;
      }

      if (action === "delete" && value) {
        const pageId = value;
        if (pageId === "root") {
          await ctx.reply(services.i18n.t(locale, "cannot_delete_root"));
          return;
        }
        const item = await services.menu.findMenuItemById(pageId);
        const pageTitle = item
          ? services.i18n.pickLocalized(item.localizations, contentLanguageCode)?.title ?? item.key
          : pageId;
        const confirmText = services.i18n
          .t(locale, "confirm_delete_page_named")
          .replace("{{title}}", pageTitle);
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text: confirmText },
          buildPageDeleteConfirmKeyboard(pageId, locale, services.i18n)
        );
        return;
      }

      if (action === "confirm_del" && value) {
        const pageId = value;
        const item = await services.menu.findMenuItemById(pageId);
        if (item) {
          await services.menu.deleteMenuItem(pageId, user.id);
          await sendMenuPage(ctx, item.parentId ?? null);
        }
        return;
      }

      if (action === "cancel_del" && value) {
        await ctx.reply(services.i18n.t(locale, "action_cancelled"));
        await showPageEditor(value);
        return;
      }

      if (action === "cancel_del_item" && value) {
        const item = await services.menu.findMenuItemById(value);
        if (item) {
          await ctx.reply(services.i18n.t(locale, "action_cancelled"));
          const parentId = item.parentId ?? "root";
          const nav = getNavSession(ctx).navCurrent ?? "";
          if (nav.startsWith("page_edit:buttons:")) {
            await showButtonManagement(parentId);
          } else {
            await showPageEditor(parentId);
          }
        }
        return;
      }

      const showPageEditorOrButtonManagement = async (parentPageId: string) => {
        const nav = getNavSession(ctx).navCurrent ?? "";
        if (nav.startsWith("page_edit:buttons:")) {
          await showButtonManagement(parentPageId);
        } else {
          await showPageEditor(parentPageId);
        }
      };

      if (action === "toggle" && value) {
        const item = await services.menu.findMenuItemById(value);
        if (item) {
          await services.menu.setMenuItemActive(value, !item.isActive, user.id);
          await showPageEditorOrButtonManagement(item.parentId ?? "root");
        }
        return;
      }

      if (action === "up" && value) {
        const nav = getNavSession(ctx).navCurrent ?? "";
        const pageId = nav.startsWith("page_edit:buttons:") ? nav.slice("page_edit:buttons:".length) : (await services.menu.findMenuItemById(value))?.parentId ?? "root";
        if (nav.startsWith("page_edit:buttons:")) {
          await services.menu.moveSlotOrder(pageId, value, "up", user.id);
        } else {
          const item = await services.menu.findMenuItemById(value);
          if (item) await services.menu.moveMenuItemOrder(value, "up", user.id);
        }
        await showPageEditorOrButtonManagement(pageId);
        return;
      }

      if (action === "down" && value) {
        const nav = getNavSession(ctx).navCurrent ?? "";
        const pageId = nav.startsWith("page_edit:buttons:") ? nav.slice("page_edit:buttons:".length) : (await services.menu.findMenuItemById(value))?.parentId ?? "root";
        if (nav.startsWith("page_edit:buttons:")) {
          await services.menu.moveSlotOrder(pageId, value, "down", user.id);
        } else {
          const item = await services.menu.findMenuItemById(value);
          if (item) await services.menu.moveMenuItemOrder(value, "down", user.id);
        }
        await showPageEditorOrButtonManagement(pageId);
        return;
      }

      if (action === "toggle_nav" && value) {
        const nav = getNavSession(ctx).navCurrent ?? "";
        if (nav.startsWith("page_edit:buttons:")) {
          const pageId = nav.slice("page_edit:buttons:".length);
          if (value === MenuService.NAV_SLOT_BACK || value === MenuService.NAV_SLOT_TO_MAIN) {
            await services.menu.toggleNavSlot(pageId, value, user.id);
            await showButtonManagement(pageId);
          }
        }
        return;
      }

      if (action === "open_buttons" && value) {
        await showButtonManagement(value);
        return;
      }

      if (action === "btn_rename" && value) {
        const item = await services.menu.findMenuItemById(value);
        if (item) {
          await ctx.scene.enter(RENAME_BUTTON_SCENE, {
            itemId: value,
            fromPageId: item.parentId ?? "root",
            languageCode: contentLanguageCode,
            uiLanguageCode: locale
          });
        }
        return;
      }

      if (action === "btn_link" && value) {
        const item = await services.menu.findMenuItemById(value);
        if (!item || item.type !== "SECTION_LINK") return;
        const sections = await services.menu.getContentSectionsForPicker(contentLanguageCode);
        if (sections.length === 0) {
          await ctx.reply(services.i18n.t(locale, "no_sections_for_link"));
          return;
        }
        const rows = sections.map((s) => [
          Markup.button.callback(s.title, makeCallbackData("page_edit", "set_link", value, s.id))
        ]);
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text: services.i18n.t(locale, "choose_target_section") },
          Markup.inlineKeyboard([
            ...rows,
            [
              Markup.button.callback(services.i18n.t(locale, "back"), makeCallbackData("page_edit", "open_buttons", item.parentId ?? "root")),
              Markup.button.callback(services.i18n.t(locale, "to_main_menu"), NAV_ROOT_DATA)
            ]
          ])
        );
        return;
      }

      if (action === "set_link" && value && extra) {
        const item = await services.menu.findMenuItemById(value);
        if (item) {
          await services.menu.updateMenuItemTarget(value, extra, user.id);
          await showButtonManagement(item.parentId ?? "root");
        }
        return;
      }

      if (action === "del_item" && value) {
        const item = await services.menu.findMenuItemById(value);
        if (item) {
          const parentPageId = item.parentId ?? "root";
          const fromButtonManagement = (getNavSession(ctx).navCurrent ?? "").startsWith("page_edit:buttons:");
          const itemTitle = services.i18n.pickLocalized(item.localizations, contentLanguageCode)?.title ?? item.key;
          const itemKind = item.type === "SECTION_LINK"
            ? services.i18n.t(locale, "item_kind_button")
            : services.i18n.t(locale, "item_kind_section");
          const confirmText = services.i18n
            .t(locale, "confirm_delete_item_named")
            .replace("{{kind}}", itemKind)
            .replace("{{title}}", itemTitle);
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: confirmText },
            buildPageDeleteItemConfirmKeyboard(value, parentPageId, locale, services.i18n, fromButtonManagement)
          );
        }
        return;
      }

      if (action === "confirm_del_item" && value) {
        const item = await services.menu.findMenuItemById(value);
        if (item) {
          const parentPageId = item.parentId ?? "root";
          await services.menu.deleteMenuItem(value, user.id);
          await showPageEditorOrButtonManagement(parentPageId);
        }
        return;
      }
    }

    if (scope === "menu" && action === "open" && value) {
      const linkItem = await services.menu.findMenuItemById(value);
      const isSectionLink = linkItem?.type === "SECTION_LINK" && linkItem.targetMenuItemId;

      if (isSectionLink) {
        const shouldSchedule = resolveEffectiveRole(ctx) === "USER";
        const targetExists = await services.menu.findMenuItemById(linkItem.targetMenuItemId!);
        if (!targetExists) {
          await services.inactivityReminders.cancelPendingForUserExcept(user.id, "root");
          setNavCurrent(ctx, "menu:open:root");
          const items = await services.menu.getMenuItemsForParent(user, null);
          const rootSlotOrder = await services.menu.getEffectiveSlotOrder("root", items.map((i) => i.id));
          const mentorUsername =
            user.mentorUserId ? (await services.users.findById(user.mentorUserId))?.username ?? null : null;
          const externalPartnerUrl = await services.cabinet.getPartnerRegisterLinkForUser(user);
          const partnerRegisterTargetId = await services.menu.getSystemTargetMenuItemId("partner_register");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: services.i18n.t(user.selectedLanguage, "link_target_missing") },
            buildMenuKeyboard(
              items,
              user.selectedLanguage,
              services.i18n,
              undefined,
              resolveEffectiveRole(ctx),
              undefined,
              rootSlotOrder,
              mentorUsername,
              externalPartnerUrl,
              partnerRegisterTargetId
            )
          );
          await services.inactivityReminders.scheduleForPageOpen(user, "root", { shouldSchedule: false });
          return;
        }

        if (targetExists.key.startsWith("__sys_target_")) {
          const sysKind = targetExists.key.slice("__sys_target_".length);

          if (sysKind === "my_cabinet") {
            setNavBeforeShow(ctx, "cabinet:open");
            const cabinet = await services.cabinet.buildCabinet(user);
            setNavCurrent(ctx, "cabinet:open");
            const showPayButton = await services.cabinet.shouldShowPayButton(user);
            const link = services.cabinet.getReferralLink(user);
            const mentorUsername = user.mentorUserId
              ? (await services.users.findById(user.mentorUserId))?.username ?? null
              : null;
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text: cabinet },
              buildCabinetKeyboard(user.selectedLanguage, services.i18n, link, {
                showPayButton,
                showAdminLink: isAdminRole(resolveEffectiveRole(ctx)),
                mentorUsername,
                showLanguageButton: await shouldShowCabinetLanguageButton(user)
              })
            );
            return;
          }

          if (sysKind === "mentor_contact") {
            setNavBeforeShow(ctx, "mentor:open");
            if (!user.mentorUserId) {
              await services.navigation.replaceScreen(
                user,
                ctx.telegram,
                ctx.chat?.id ?? user.telegramUserId,
                { text: services.i18n.t(user.selectedLanguage, "mentor_not_assigned") },
                Markup.inlineKeyboard([buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })])
              );
              return;
            }
            const mentor = await services.users.findById(user.mentorUserId);
            if (!mentor) {
              await services.navigation.replaceScreen(
                user,
                ctx.telegram,
                ctx.chat?.id ?? user.telegramUserId,
                { text: services.i18n.t(user.selectedLanguage, "mentor_not_found") },
                Markup.inlineKeyboard([buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })])
              );
              return;
            }
            if (mentor.username) {
              const locale = services.i18n.resolveLanguage(user.selectedLanguage);
              await services.navigation.replaceScreen(
                user,
                ctx.telegram,
                ctx.chat?.id ?? user.telegramUserId,
                { text: `https://t.me/${mentor.username}` },
                Markup.inlineKeyboard([
                  [Markup.button.url(services.i18n.t(locale, "open_mentor_btn"), `https://t.me/${mentor.username}`)],
                  buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })
                ])
              );
              return;
            }
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text: services.i18n.t(user.selectedLanguage, "no_mentor_username") },
              Markup.inlineKeyboard([buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })])
            );
            return;
          }

          if (sysKind === "change_language") {
            setNavBeforeShow(ctx, "lang:picker");
            const activeLangCodes = await services.menu.getActiveTemplateLanguageCodes();
            const codesSet = new Set(activeLangCodes.map((c) => String(c).toLowerCase()));
            if (user.selectedLanguage) codesSet.add(String(user.selectedLanguage).toLowerCase());
            const languageCodes = Array.from(codesSet);
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text: services.i18n.t(user.selectedLanguage, "wizard_step_lang") },
              buildLanguageKeyboard(services.i18n, user.selectedLanguage, languageCodes)
            );
            return;
          }

          if (sysKind === "partner_register") {
            const externalPartnerUrl = await services.cabinet.getPartnerRegisterLinkForUser(user);
            if (!externalPartnerUrl) {
              await ctx.reply(services.i18n.t(user.selectedLanguage, "sys_partner_link_not_set"));
              return;
            }
            setNavBeforeShow(ctx, "menu:sys:partner_register");
            try {
              await services.navigation.replaceScreen(
                user,
                ctx.telegram,
                ctx.chat?.id ?? user.telegramUserId,
                { text: externalPartnerUrl },
                Markup.inlineKeyboard([
                  [Markup.button.url(services.i18n.t(user.selectedLanguage, "partner_register_btn"), externalPartnerUrl)],
                  buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })
                ])
              );
            } catch (navErr) {
              logger.warn({ err: navErr, externalPartnerUrl }, "Partner register replaceScreen failed, sending plain reply");
              await ctx.reply(
                externalPartnerUrl,
                Markup.inlineKeyboard([
                  [Markup.button.url(services.i18n.t(user.selectedLanguage, "partner_register_btn"), externalPartnerUrl)],
                  buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })
                ])
              );
            }
            return;
          }
        }

        const content = await services.menu.getMenuItemContent(user, linkItem.targetMenuItemId!);
        if (content.locked) {
          await services.inactivityReminders.cancelPendingForUserExcept(user.id, null);
          setNavBeforeShow(ctx, "paywall:locked:" + linkItem.id);
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: services.i18n.t(user.selectedLanguage, "access_locked") },
            content.item.productId
              ? buildPaywallKeyboard(user.selectedLanguage, content.item.productId, services.i18n)
              : {}
          );
          return;
        }
        await services.inactivityReminders.cancelPendingForUserExcept(user.id, content.item.id);
        await services.menu.markViewed(user.id, linkItem.id, user.selectedLanguage);
        const targetChildren = await services.menu.getMenuItemsForParent(user, content.item.id);

        // Render target page with the same rules as normal menu:open:<targetId>,
        // but keep "Назад" pointing to the page where the SECTION_LINK button lives.
        if (content.item.type === "SUBMENU" || targetChildren.length > 0) {
          const titleText = content.localization.title ? renderPageContent(content.localization.title, user) : "";
          const bodyText = content.localization.contentText ? renderPageContent(content.localization.contentText, user) : "";
          const composedText = composeTitleBody(titleText, bodyText);
          const hasMedia =
            (content.localization.mediaType === "PHOTO" ||
              content.localization.mediaType === "VIDEO" ||
              content.localization.mediaType === "DOCUMENT") &&
            Boolean(content.localization.mediaFileId);
          const menuSlotOrder = await services.menu.getEffectiveSlotOrder(content.item.id, targetChildren.map((c) => c.id));
          const mentorUsername =
            user.mentorUserId ? (await services.users.findById(user.mentorUserId))?.username ?? null : null;
          const externalPartnerUrl = await services.cabinet.getPartnerRegisterLinkForUser(user);
          const partnerRegisterTargetId = await services.menu.getSystemTargetMenuItemId("partner_register");
          const linkProductChatLinks =
            content.item.productId && content.item.product?.linkedChats
              ? await services.subscriptionChannel.resolveProductLinksForDisplay(
                  content.item.product.linkedChats,
                  ctx.telegram
                )
              : [];
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            hasMedia
              ? {
                  text: composedText,
                  mediaType: content.localization.mediaType,
                  mediaFileId: content.localization.mediaFileId
                }
              : { text: composedText },
            buildMenuKeyboard(
              targetChildren,
              user.selectedLanguage,
              services.i18n,
              linkItem.parentId ?? "root",
              resolveEffectiveRole(ctx),
              content.item.id,
              menuSlotOrder,
              mentorUsername,
              externalPartnerUrl,
              partnerRegisterTargetId,
              linkProductChatLinks.length ? linkProductChatLinks : undefined
            )
          );
          await services.inactivityReminders.scheduleForPageOpen(user, content.item.id, { shouldSchedule: false });
        } else {
          const linkContentSlotOrder = await services.menu.getEffectiveSlotOrder(content.item.id, []);
          const linkProductChatLinks =
            content.item.productId && content.item.product?.linkedChats
              ? await services.subscriptionChannel.resolveProductLinksForDisplay(
                  content.item.product.linkedChats,
                  ctx.telegram
                )
              : [];
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            {
              text: content.localization.contentText ? renderPageContent(content.localization.contentText, user) : undefined,
              mediaType: content.localization.mediaType,
              mediaFileId: content.localization.mediaFileId,
              externalUrl: content.localization.externalUrl
            },
            buildContentScreenKeyboard(linkItem.parentId ?? "root", user.selectedLanguage, services.i18n, {
              currentPageId: content.item.id,
              userRole: resolveEffectiveRole(ctx),
              slotOrder: linkContentSlotOrder,
              productChatLinks: linkProductChatLinks.length ? linkProductChatLinks : undefined
            })
          );
          await services.inactivityReminders.scheduleForPageOpen(user, content.item.id, { shouldSchedule: false });
        }
        return;
      }

      const content = await services.menu.getMenuItemContent(user, value);
      const children = await services.menu.getMenuItemsForParent(user, content.item.id);
      const shouldSchedule = resolveEffectiveRole(ctx) === "USER";

      if (content.locked) {
        await services.inactivityReminders.cancelPendingForUserExcept(user.id, null);
        setNavBeforeShow(ctx, "paywall:locked:" + content.item.id);
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          {
            text: services.i18n.t(user.selectedLanguage, "access_locked")
          },
          content.item.productId
            ? buildPaywallKeyboard(user.selectedLanguage, content.item.productId, services.i18n)
            : {}
        );
        return;
      }

        await services.inactivityReminders.cancelPendingForUserExcept(user.id, content.item.id);
      await services.menu.markViewed(user.id, content.item.id, user.selectedLanguage);

      if (content.item.type === "SUBMENU" || children.length > 0) {
        setNavBeforeShow(ctx, "menu:open:" + value);
        const titleText = content.localization.title ? renderPageContent(content.localization.title, user) : "";
        const bodyText = content.localization.contentText ? renderPageContent(content.localization.contentText, user) : "";
        const composedText = composeTitleBody(titleText, bodyText);
        const hasMedia =
          (content.localization.mediaType === "PHOTO" ||
            content.localization.mediaType === "VIDEO" ||
            content.localization.mediaType === "DOCUMENT") &&
          Boolean(content.localization.mediaFileId);
        const menuSlotOrder = await services.menu.getEffectiveSlotOrder(content.item.id, children.map((c) => c.id));
        const mentorUsername =
          user.mentorUserId ? (await services.users.findById(user.mentorUserId))?.username ?? null : null;
        const externalPartnerUrl = await services.cabinet.getPartnerRegisterLinkForUser(user);
        const partnerRegisterTargetId = await services.menu.getSystemTargetMenuItemId("partner_register");
        const cbProductChatLinks =
          content.item.productId && content.item.product?.linkedChats
            ? await services.subscriptionChannel.resolveProductLinksForDisplay(
                content.item.product.linkedChats,
                ctx.telegram
              )
            : [];
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          hasMedia
            ? {
                text: composedText,
                mediaType: content.localization.mediaType,
                mediaFileId: content.localization.mediaFileId
              }
            : { text: composedText },
          buildMenuKeyboard(
            children,
            user.selectedLanguage,
            services.i18n,
            content.item.parentId ?? "root",
            resolveEffectiveRole(ctx),
            content.item.id,
            menuSlotOrder,
            mentorUsername,
            externalPartnerUrl,
            partnerRegisterTargetId,
            cbProductChatLinks.length ? cbProductChatLinks : undefined
          )
        );
        await services.inactivityReminders.scheduleForPageOpen(user, content.item.id, { shouldSchedule: false });
        return;
      }

      const contentSlotOrder = await services.menu.getEffectiveSlotOrder(content.item.id, []);
      const cbProductChatLinks =
        content.item.productId && content.item.product?.linkedChats
          ? await services.subscriptionChannel.resolveProductLinksForDisplay(
              content.item.product.linkedChats,
              ctx.telegram
            )
          : [];
      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        {
          text: content.localization.contentText ? renderPageContent(content.localization.contentText, user) : undefined,
          mediaType: content.localization.mediaType,
          mediaFileId: content.localization.mediaFileId,
          externalUrl: content.localization.externalUrl
        },
        buildContentScreenKeyboard(content.item.parentId ?? "root", user.selectedLanguage, services.i18n, {
          currentPageId: content.item.id,
          userRole: resolveEffectiveRole(ctx),
          slotOrder: contentSlotOrder,
          productChatLinks: cbProductChatLinks.length ? cbProductChatLinks : undefined
        })
      );
      await services.inactivityReminders.scheduleForPageOpen(user, content.item.id, { shouldSchedule: false });
      return;
    }

    if (scope === "menu" && action === "back") {
      await sendMenuPage(ctx, value === "root" ? null : value ?? null);
      return;
    }

    if (scope === "cabinet" && action === "open") {
      setNavBeforeShow(ctx, "cabinet:open");
      const cabinet = await services.cabinet.buildCabinet(user);
      const showPayButton = await services.cabinet.shouldShowPayButton(user);
      const link = services.cabinet.getReferralLink(user);
      const mentorUsername = user.mentorUserId
        ? (await services.users.findById(user.mentorUserId))?.username ?? null
        : null;
      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        { text: cabinet },
        buildCabinetKeyboard(user.selectedLanguage, services.i18n, link, {
          showPayButton,
          showAdminLink: isAdminRole(resolveEffectiveRole(ctx)),
          mentorUsername,
          showLanguageButton: await shouldShowCabinetLanguageButton(user)
        })
      );
      return;
    }

    if (scope === "cabinet" && action === "set_external_ref_link") {
      setNavBeforeShow(ctx, "cabinet:set_external_ref_link");
      await ctx.scene.enter(SET_EXTERNAL_REFERRAL_LINK_SCENE);
      return;
    }

    if (scope === "cabinet" && action === "copy_link") {
      // Telegram Bot API cannot copy to clipboard. This callback is kept for stale keyboards.
      // Prefer the URL share button in the cabinet keyboard (t.me/share/url).
      try {
        await ctx.answerCbQuery(services.i18n.t(user.selectedLanguage, "copy_link_sent"), { show_alert: true });
      } catch {
        // ignore
      }
      return;
    }

    if (scope === "cabinet" && action === "structure") {
      setNavBeforeShow(ctx, "cabinet:structure");
      const structureText = await services.cabinet.buildStructureScreen(user);
      setNavCurrent(ctx, "cabinet:structure");
      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        { text: structureText },
        buildStructureKeyboard(user.selectedLanguage, services.i18n)
      );
      return;
    }

    if (scope === "cabinet" && action === "pay") {
      // Payment entrypoint from cabinet is temporarily disabled (UX cleanup).
      // Keep payment flow itself intact (pay:* callbacks, paywall from locked content, etc.).
      const locale = services.i18n.resolveLanguage(user.selectedLanguage);
      const cabinet = await services.cabinet.buildCabinet(user);
      const link = services.cabinet.getReferralLink(user);
      const mentorUsername = user.mentorUserId
        ? (await services.users.findById(user.mentorUserId))?.username ?? null
        : null;
      setNavBeforeShow(ctx, "cabinet:open");
      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        { text: cabinet },
        buildCabinetKeyboard(locale, services.i18n, link, {
          showPayButton: false,
          showAdminLink: isAdminRole(resolveEffectiveRole(ctx)),
          mentorUsername,
          showLanguageButton: await shouldShowCabinetLanguageButton(user)
        })
      );
      return;
    }

    if (scope === "mentor" && action === "open") {
      setNavBeforeShow(ctx, "mentor:open");
      if (!user.mentorUserId) {
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text: services.i18n.t(user.selectedLanguage, "mentor_not_assigned") },
          Markup.inlineKeyboard([buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })])
        );
        return;
      }

      const mentor = await services.users.findById(user.mentorUserId);

      if (!mentor) {
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text: services.i18n.t(user.selectedLanguage, "mentor_not_found") },
          Markup.inlineKeyboard([buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })])
        );
        return;
      }

      if (mentor.username) {
        const locale = services.i18n.resolveLanguage(user.selectedLanguage);
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text: `https://t.me/${mentor.username}` },
          Markup.inlineKeyboard([
            [Markup.button.url(services.i18n.t(locale, "open_mentor_btn"), `https://t.me/${mentor.username}`)],
            buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })
          ])
        );
        return;
      }

      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        {
          text: services.i18n.t(user.selectedLanguage, "no_mentor_username")
        },
        Markup.inlineKeyboard([
          buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })
        ])
      );
      return;
    }

    if (scope === "mentor" && action === "request") {
      if (!user.mentorUserId) {
        await ctx.reply(services.i18n.t(user.selectedLanguage, "mentor_not_assigned"));
        return;
      }
      const mentor = await services.users.findById(user.mentorUserId);
      if (!mentor) {
        await ctx.reply(services.i18n.t(user.selectedLanguage, "mentor_not_found"));
        return;
      }
      await services.notifications.notifyMentorRequest(mentor, user);
      await ctx.reply(services.i18n.t(user.selectedLanguage, "mentor_request_sent"));
      return;
    }

    if (scope === "lang" && action === "picker") {
      setNavBeforeShow(ctx, "lang:picker");
      const activeLangCodes = await services.menu.getActiveTemplateLanguageCodes();
      const codesSet = new Set(activeLangCodes.map((c) => String(c).toLowerCase()));
      if (user.selectedLanguage) codesSet.add(String(user.selectedLanguage).toLowerCase());
      const languageCodes = Array.from(codesSet);
      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        { text: services.i18n.t(user.selectedLanguage, "wizard_step_lang") },
        buildLanguageKeyboard(services.i18n, user.selectedLanguage, languageCodes)
      );
      return;
    }

    if (scope === "lang" && action === "set" && value) {
      const updated = await services.users.setLanguage(user.id, value);
      ctx.currentUser = updated;
      await ctx.reply(services.i18n.t(updated.selectedLanguage, "language_updated"));
      await sendRootWithWelcome(ctx);
      return;
    }

    if (scope === "pay" && action === "network" && value && extra) {
      const { payment, product } = await services.payments.createPaymentRequest(
        user,
        value,
        extra as PaymentNetwork
      );
      setNavBeforeShow(ctx, "pay:review:" + payment.id);
      const localization =
        product.localizations.find((item) => item.languageCode === user.selectedLanguage) ??
        product.localizations[0];
      const text = [
        localization?.title ?? product.code,
        localization?.description ?? "",
        `Amount: ${payment.amount} ${payment.currency}`,
        `Wallet: ${payment.walletAddress}`,
        `Network: ${payment.network}`,
        `Reference: ${payment.referenceCode}`
      ]
        .filter(Boolean)
        .join("\n");
      await ctx.reply(text, buildPaymentReviewKeyboard(payment.id, user.selectedLanguage, services.i18n));
      return;
    }

    if (scope === "pay" && action === "review" && value) {
      const owner = await services.users.findByTelegramId(BigInt(process.env.SUPER_ADMIN_TELEGRAM_ID ?? "0"));
      if (owner) {
        await services.notifications.sendText(
          owner,
          "SYSTEM_ALERT",
          `Payment review requested for payment ${value}`,
          { paymentId: value, requesterUserId: user.id }
        );
      }
      setNavBeforeShow(ctx, "pay:request_sent");
      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        { text: "Запрос на проверку оплаты отправлен администраторам." },
        Markup.inlineKeyboard([buildNavigationRow(services.i18n, user.selectedLanguage, { back: true, toMain: true })])
      );
      return;
    }

    if (scope === "export" && action === "structure") {
      const effectiveRole = resolveEffectiveRole(ctx);
      const locale = services.i18n.resolveLanguage(user.selectedLanguage);
      const { buffer, totalCount, exportDate } = await services.exports.buildUsersHtmlReport(user, {
        effectiveRole: effectiveRole as any,
        languageCode: locale
      });
      const filename = services.exports.formatExportFilename("html", exportDate, "structure");
        const captionTypeLabel = services.i18n.t(
          locale,
          effectiveRole === "ALPHA_OWNER" ? "export_type_structure_html" : "export_type_first_line_html"
        );
      const exportDateText = services.exports.formatExportDate(exportDate);
      const caption = services.i18n
        .t(locale, "export_caption_with_type")
        .replace("{{type}}", captionTypeLabel)
        .replace("{{date}}", exportDateText)
        .replace("{{count}}", String(totalCount));
      await ctx.replyWithDocument(
        { source: buffer, filename },
        { caption }
      );
      return;
    }

    if (scope === "onboarding") {
      if (!isAdminRole(user.role)) return;
      const locale = services.i18n.resolveLanguage(user.selectedLanguage);
      const stepLabel = (s: number) =>
        services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", String(s));

      if (action === "lang" && value && ["ru", "en"].includes(value)) {
        await ctx.answerCbQuery();
        await services.menu.ensureActiveTemplate(user.id, value);
        await services.users.setOnboardingStep(user.id, 1);
        const refreshed = await services.users.findById(user.id);
        if (refreshed) ctx.currentUser = refreshed;
        const text =
          stepLabel(1) +
          "\n\n" +
          services.i18n.t(locale, "onboarding_step1_intro") +
          "\n\n" +
          services.i18n.t(locale, "personalization_hint");
        await services.navigation.replaceScreen(
          ctx.currentUser!,
          ctx.telegram,
          ctx.chat?.id ?? ctx.currentUser!.telegramUserId,
          { text, resolvePlaceholders: false },
          Markup.inlineKeyboard([buildNavigationRow(services.i18n, locale, { toMain: true })])
        );
        return;
      }

      if (action === "open" || action === "start") {
        if (action === "start") {
          const text =
            stepLabel(0) +
            " / " +
            stepLabel(1) +
            "\n\n" +
            services.i18n.t(locale, "onboarding_step0_title") +
            "\n\n" +
            services.i18n.t(locale, "onboarding_step0_intro");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildOnboardingBaseLanguageKeyboard(locale, services.i18n)
          );
          return;
        }
        const currentStep = user.onboardingStep ?? 0;
        if (currentStep === 0) {
          const text =
            services.i18n.t(locale, "onboarding_welcome_title") +
            "\n\n" +
            services.i18n.t(locale, "onboarding_welcome_intro");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildOnboardingWelcomeKeyboard(locale, services.i18n)
          );
          return;
        }
        if (currentStep === 1) {
          const text =
            stepLabel(1) +
            "\n\n" +
            services.i18n.t(locale, "onboarding_step1_intro") +
            "\n\n" +
            services.i18n.t(locale, "personalization_hint");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text, resolvePlaceholders: false },
            Markup.inlineKeyboard([buildNavigationRow(services.i18n, locale, { toMain: true })])
          );
          return;
        }
        if (currentStep === 2) {
          await ctx.reply(
            stepLabel(2) + "\n\n" + services.i18n.t(locale, "onboarding_step2_intro"),
            buildCancelKeyboard(services.i18n, locale)
          );
          await ctx.scene.enter(CREATE_SECTION_SCENE, { parentId: null, fromPageId: "root", fromOnboardingStep: 2 });
          return;
        }
        if (currentStep === 3) {
          const sections = await services.menu.getContentSectionsForPicker(user.selectedLanguage ?? locale);
          if (sections.length === 0) {
            await services.users.setOnboardingStep(user.id, 4);
            const text = stepLabel(4) + "\n\n" + services.i18n.t(locale, "onboarding_step4_intro");
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text },
              buildOnboardingStep4Keyboard(locale, services.i18n)
            );
          } else {
            await ctx.reply(
              stepLabel(3) + "\n\n" + services.i18n.t(locale, "onboarding_choice_after_section"),
              buildOnboardingChoiceAfterSectionKeyboard(locale, services.i18n)
            );
          }
          return;
        }
        if (currentStep === 4) {
          const text = stepLabel(4) + "\n\n" + services.i18n.t(locale, "onboarding_step4_intro");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildOnboardingStep4Keyboard(locale, services.i18n)
          );
          return;
        }
        if (currentStep === 5) {
          const text = stepLabel(5) + "\n\n" + services.i18n.t(locale, "onboarding_step5_intro");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildOnboardingStep5Keyboard(locale, services.i18n)
          );
          return;
        }
        if (currentStep === 6) {
          const text =
            services.i18n.t(locale, "onboarding_step6_title") +
            "\n\n" +
            services.i18n.t(locale, "onboarding_step6_summary") +
            "\n\n" +
            services.i18n.t(locale, "onboarding_step6_next");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildOnboardingStep6Keyboard(locale, services.i18n)
          );
        }
        return;
      }

      if (action === "skip") {
        await services.users.setOnboardingCompleted(user.id);
        const updated = await services.users.findById(user.id);
        if (updated) ctx.currentUser = updated;
        await sendRootWithWelcome(ctx);
        return;
      }

      if (action === "cancel") {
        await ctx.reply(services.i18n.t(locale, "action_cancelled"));
        await sendRootWithWelcome(ctx);
        return;
      }

      if (action === "choice_after" && value) {
          if (value === "add") {
            await services.users.setOnboardingStep(user.id, 3);
            const refreshed = await services.users.findById(user.id);
            if (refreshed) ctx.currentUser = refreshed;
            await ctx.scene.enter(CREATE_SECTION_SCENE, { parentId: null, fromPageId: "root", fromOnboardingStep: 3 });
            return;
          }
          if (value === "preview") {
            await services.users.setOnboardingStep(user.id, 4);
            const refreshed = await services.users.findById(user.id);
            if (refreshed) ctx.currentUser = refreshed;
            const text = stepLabel(4) + "\n\n" + services.i18n.t(locale, "onboarding_step4_intro");
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text },
              buildOnboardingStep4Keyboard(locale, services.i18n)
            );
            return;
          }
        }

      if (action === "next" && value) {
        const toStep = parseInt(value, 10);
        if (toStep === 1) {
          await services.users.setOnboardingStep(user.id, 1);
          const refreshed = await services.users.findById(user.id);
          if (refreshed) ctx.currentUser = refreshed;
          const text = stepLabel(1) + "\n\n" + services.i18n.t(locale, "onboarding_step1_intro") + "\n\n" + services.i18n.t(locale, "personalization_hint");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text, resolvePlaceholders: false },
            Markup.inlineKeyboard([buildNavigationRow(services.i18n, locale, { toMain: true })])
          );
          return;
        }
        if (toStep === 2) {
          await services.users.setOnboardingStep(user.id, 2);
          const refreshed = await services.users.findById(user.id);
          if (refreshed) ctx.currentUser = refreshed;
          await ctx.reply(
            stepLabel(2) + "\n\n" + services.i18n.t(locale, "onboarding_step2_intro"),
            buildCancelKeyboard(services.i18n, locale)
          );
          await ctx.scene.enter(CREATE_SECTION_SCENE, { parentId: null, fromPageId: "root", fromOnboardingStep: 2 });
          return;
        }
        if (toStep === 3) {
          await services.users.setOnboardingStep(user.id, 3);
          const refreshed = await services.users.findById(user.id);
          if (refreshed) ctx.currentUser = refreshed;
          const sections = await services.menu.getContentSectionsForPicker(user.selectedLanguage ?? locale);
          if (sections.length === 0) {
            await services.users.setOnboardingStep(user.id, 4);
            const refreshed2 = await services.users.findById(user.id);
            if (refreshed2) ctx.currentUser = refreshed2;
            const text = stepLabel(4) + "\n\n" + services.i18n.t(locale, "onboarding_step4_intro");
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text },
              buildOnboardingStep4Keyboard(locale, services.i18n)
            );
            return;
          }
          await ctx.reply(
            stepLabel(3) + "\n\n" + services.i18n.t(locale, "onboarding_choice_after_section"),
            buildOnboardingChoiceAfterSectionKeyboard(locale, services.i18n)
          );
          return;
        }
        if (toStep === 4) {
          await services.users.setOnboardingStep(user.id, 4);
          const refreshed = await services.users.findById(user.id);
          if (refreshed) ctx.currentUser = refreshed;
          const text = stepLabel(4) + "\n\n" + services.i18n.t(locale, "onboarding_step4_intro");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildOnboardingStep4Keyboard(locale, services.i18n)
          );
          return;
        }
        if (toStep === 5) {
          await services.users.setOnboardingStep(user.id, 5);
          const refreshed = await services.users.findById(user.id);
          if (refreshed) ctx.currentUser = refreshed;
          await ctx.reply(
            `${stepLabel(4)}\n\n${services.i18n.t(locale, "onboarding_step4_title")}: ${services.i18n.t(locale, "onboarding_btn_got_it")}\n${services.i18n.t(locale, "next_step")}: ${services.i18n.t(locale, "onboarding_step5_title")}`
          );
          const text = stepLabel(5) + "\n\n" + services.i18n.t(locale, "onboarding_step5_intro");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildOnboardingStep5Keyboard(locale, services.i18n)
          );
          return;
        }
        if (toStep === 6) {
          await services.users.setOnboardingStep(user.id, 6);
          const refreshed = await services.users.findById(user.id);
          if (refreshed) ctx.currentUser = refreshed;
          const text =
            services.i18n.t(locale, "onboarding_step6_title") +
            "\n\n" +
            services.i18n.t(locale, "onboarding_step6_summary") +
            "\n\n" +
            services.i18n.t(locale, "onboarding_step6_next");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildOnboardingStep6Keyboard(locale, services.i18n)
          );
          return;
        }
      }

      if (action === "again" && value) {
        const step = parseInt(value, 10);
        if (step === 1) {
          const text = stepLabel(1) + "\n\n" + services.i18n.t(locale, "onboarding_step1_intro") + "\n\n" + services.i18n.t(locale, "personalization_hint");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text, resolvePlaceholders: false },
            Markup.inlineKeyboard([buildNavigationRow(services.i18n, locale, { toMain: true })])
          );
          return;
        }
        if (step === 2) {
          await services.users.setOnboardingStep(user.id, 2);
          const refreshed = await services.users.findById(user.id);
          if (refreshed) ctx.currentUser = refreshed;
          await ctx.scene.enter(CREATE_SECTION_SCENE, { parentId: null, fromPageId: "root", fromOnboardingStep: 2 });
          return;
        }
        if (step === 3) {
          await services.users.setOnboardingStep(user.id, 3);
          const refreshed = await services.users.findById(user.id);
          if (refreshed) ctx.currentUser = refreshed;
          const sections = await services.menu.getContentSectionsForPicker(user.selectedLanguage ?? locale);
          if (sections.length === 0) {
            await services.users.setOnboardingStep(user.id, 4);
            const ref2 = await services.users.findById(user.id);
            if (ref2) ctx.currentUser = ref2;
            const text = stepLabel(4) + "\n\n" + services.i18n.t(locale, "onboarding_step4_intro");
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text },
              buildOnboardingStep4Keyboard(locale, services.i18n)
            );
          } else {
            await ctx.reply(
              stepLabel(3) + "\n\n" + services.i18n.t(locale, "onboarding_choice_after_section"),
              buildOnboardingChoiceAfterSectionKeyboard(locale, services.i18n)
            );
          }
          return;
        }
      }

      if (action === "back" && value === "4") {
        await services.users.setOnboardingStep(user.id, 3);
        const refreshed = await services.users.findById(user.id);
        if (refreshed) ctx.currentUser = refreshed;
        const sections = await services.menu.getContentSectionsForPicker(user.selectedLanguage ?? locale);
        if (sections.length > 0) {
          await ctx.reply(
            stepLabel(3) + "\n\n" + services.i18n.t(locale, "onboarding_choice_after_section"),
            buildOnboardingChoiceAfterSectionKeyboard(locale, services.i18n)
          );
        } else {
          await services.users.setOnboardingStep(user.id, 2);
          const ref2 = await services.users.findById(user.id);
          if (ref2) ctx.currentUser = ref2;
          await ctx.reply(
            stepLabel(2) + "\n\n" + services.i18n.t(locale, "onboarding_step2_intro"),
            buildCancelKeyboard(services.i18n, locale)
          );
          await ctx.scene.enter(CREATE_SECTION_SCENE, { parentId: null, fromPageId: "root", fromOnboardingStep: 2 });
        }
        return;
      }

      if (action === "publish") {
        const [content, warnings] = await Promise.all([
          services.menu.getFullPreviewContent(locale),
          services.menu.getPreviewWarnings(locale)
        ]);
        const title = services.i18n.t(locale, "preview_structure_title");
        const warningsBlock =
          warnings.length > 0
            ? "\n\n" + services.i18n.t(locale, "preview_warnings_header") + "\n" + warnings.join("\n")
            : "";
        const text = `${title}\n\n${content}${warningsBlock}`.slice(0, 4090);
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text },
          buildPublishConfirmKeyboard(locale, services.i18n, true)
        );
        return;
      }
      if (action === "publish_confirm") {
        await ctx.answerCbQuery?.();
        await services.permissions.ensurePermission(user.id, "canManageTemplates");
        await services.audit.log(user.id, "publish_template", "presentation_template", null, {});
        await services.users.setOnboardingStep(user.id, 6);
        const refreshed = await services.users.findById(user.id);
        if (refreshed) ctx.currentUser = refreshed;
        await ctx.reply(services.i18n.t(locale, "onboarding_step5_success"));
        const text =
          services.i18n.t(locale, "onboarding_step6_title") +
          "\n\n" +
          services.i18n.t(locale, "onboarding_step6_summary") +
          "\n\n" +
          services.i18n.t(locale, "onboarding_step6_next");
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text },
          buildOnboardingStep6Keyboard(locale, services.i18n)
        );
        return;
      }

      if (action === "finish") {
        await services.users.setOnboardingCompleted(user.id);
        const updated = await services.users.findById(user.id);
        if (updated) ctx.currentUser = updated;
        await ctx.reply(
          services.i18n.t(locale, "onboarding_step6_summary"),
          buildOnboardingStep6Keyboard(locale, services.i18n)
        );
        return;
      }
    }

    if (scope === "admin") {
      const adminLocale = services.i18n.resolveLanguage(user.selectedLanguage);
      if (isLanguageManagementAction(action)) {
        try {
          await services.permissions.ensurePermission(user.id, "canManageLanguages");
        } catch (err) {
          if (err instanceof ForbiddenError) {
            await ctx.answerCbQuery?.();
            await ctx.reply(services.i18n.t(user.selectedLanguage, "permissions.language_manage_denied"));
            return;
          }
          throw err;
        }
      }

      if (!isAdminRole(user.role)) {
        await ctx.reply(services.i18n.t(user.selectedLanguage, "permission_denied"));
        return;
      }

    const LANG_CODES = ["ru", "en"] as const;

    const formatUtcDateTime = (d: Date | null | undefined): { date: string; time: string } => {
      if (!d) return { date: "—", time: "—" };
      const iso = d.toISOString(); // always UTC
      const date = iso.slice(0, 10);
      const time = iso.slice(11, 16);
      return { date, time };
    };

    const formatBroadcastContentLanguageLabel = (localizations: Array<{ languageCode: string }>): string => {
      const codes = Array.from(new Set(localizations.map((l) => l.languageCode)));
      const hasAll = LANG_CODES.every((c) => codes.includes(c));
      if (codes.length >= 2 && hasAll) return "🌐 Все языки";
      const first = codes[0] ?? "ru";
      if (first === "en") return "English";
      return "Русский";
    };

    const formatBroadcastAudienceLabel = (
      audienceType: string,
      segmentQuery: Record<string, unknown> | null
    ): string => {
      if (audienceType === "OWN_FIRST_LINE") return "👥 Первая линия";
      if (audienceType === "OWN_STRUCTURE") return "🕸 Вся структура";
      if (audienceType === "LANGUAGE") {
        const languages = Array.isArray((segmentQuery as any)?.languages) ? ((segmentQuery as any)?.languages as string[]) : [];
        const hasAll = LANG_CODES.every((c) => languages.includes(c as unknown as string));
        if (hasAll) return "🌐 Все языки";
        const code = languages[0] ?? "ru";
        return code === "en" ? "🌍 По языку (English)" : "🌍 По языку (Русский)";
      }
      return "🗂 Все пользователи";
    };

    const formatBroadcastStatusLabel = (status: string): string => {
      switch (status) {
        case "SCHEDULED":
          return "🗓 Запланирована";
        case "RUNNING":
          return "⏳ В процессе";
        case "COMPLETED":
          return "✅ Завершена";
        case "FAILED":
          return "⚠️ Ошибка";
        case "CANCELLED":
          return "⛔ Остановлена";
        default:
          return status;
      }
    };

    const keycapNumber = (n: number): string => {
      // Telegram keycap digits: 1️⃣..9️⃣, 0️⃣.
      const map: Record<number, string> = {
        0: "0️⃣",
        1: "1️⃣",
        2: "2️⃣",
        3: "3️⃣",
        4: "4️⃣",
        5: "5️⃣",
        6: "6️⃣",
        7: "7️⃣",
        8: "8️⃣",
        9: "9️⃣",
        10: "🔟"
      };
      return map[n] ?? `${n}️⃣`;
    };

    const langvPendingKey = (languageCode: string, pageId: string): string =>
      `${services.i18n.normalizeLocalizationLanguageCode(languageCode)}:${pageId}`;

    const getLangvPendingForPage = (languageCode: string, pageId: string) => {
      const pending = getLangvPendingMap(ctx);
      return pending[langvPendingKey(languageCode, pageId)];
    };

    const clearLangvPendingForPage = (languageCode: string, pageId: string) => {
      const pending = { ...getLangvPendingMap(ctx) };
      delete pending[langvPendingKey(languageCode, pageId)];
      setLangvPendingMap(ctx, pending);
    };

    const applyPendingPatchToSnapshot = <T extends { contentText: string; mediaType: any; mediaFileId: any; externalUrl?: any }>(
      base: T,
      patch: {
        updateMode: "full" | "text_only" | "photo_only" | "video_only" | "document_only";
        contentText?: string;
        mediaType?: any;
        mediaFileId?: any;
        externalUrl?: any;
      } | null | undefined
    ): T => {
      if (!patch) return base;
      if (patch.updateMode === "full") {
        return {
          ...base,
          contentText: patch.contentText ?? "",
          mediaType: patch.mediaType ?? "NONE",
          mediaFileId: patch.mediaFileId ?? null,
          externalUrl: patch.externalUrl ?? null
        };
      }
      if (patch.updateMode === "text_only") {
        return {
          ...base,
          contentText: patch.contentText ?? ""
        };
      }
      return {
        ...base,
        mediaType: patch.mediaType ?? "NONE",
        mediaFileId: patch.mediaFileId ?? null
      };
    };

    const persistLangvPendingPatch = async (patch: NonNullable<ReturnType<typeof getLangvPendingForPage>>) => {
      if (patch.isRoot) {
        const rootBase = await services.menu.getEffectiveWelcomeLocalizationForLanguage(user.id, patch.languageCode);
        const merged = applyPendingPatchToSnapshot(
          {
            contentText: rootBase.welcomeText,
            mediaType: rootBase.welcomeMediaType,
            mediaFileId: rootBase.welcomeMediaFileId
          },
          {
            updateMode: patch.updateMode,
            contentText: patch.contentText,
            mediaType: patch.mediaType,
            mediaFileId: patch.mediaFileId
          }
        );
        await services.menu.patchWelcomeDraftLocalization(user.id, patch.languageCode, {
          welcomeText: merged.contentText,
          welcomeMediaType: merged.mediaType,
          welcomeMediaFileId: merged.mediaFileId
        });
      } else {
        const pageBase = await services.menu.getEffectiveMenuItemLocalizationForLanguage(patch.pageId, patch.languageCode);
        const merged = applyPendingPatchToSnapshot(
          {
            contentText: pageBase?.contentText ?? "",
            mediaType: pageBase?.mediaType ?? "NONE",
            mediaFileId: pageBase?.mediaFileId ?? null,
            externalUrl: pageBase?.externalUrl ?? null
          },
          {
            updateMode: patch.updateMode,
            contentText: patch.contentText,
            mediaType: patch.mediaType,
            mediaFileId: patch.mediaFileId,
            externalUrl: patch.externalUrl
          }
        );
        await services.menu.patchMenuItemDraftLocalization(patch.pageId, user.id, patch.languageCode, {
          contentText: merged.contentText,
          mediaType: merged.mediaType,
          mediaFileId: merged.mediaFileId,
          externalUrl: merged.externalUrl
        });
      }
    };

    const flushLangvPendingForPage = async (languageCode: string, pageId: string) => {
      const pending = getLangvPendingForPage(languageCode, pageId);
      if (!pending) return;
      await persistLangvPendingPatch(pending);
      clearLangvPendingForPage(languageCode, pageId);
    };

    const flushLangvPendingForLanguage = async (languageCode: string) => {
      const pendingMap = getLangvPendingMap(ctx);
      const keys = Object.keys(pendingMap).filter((k) => k.startsWith(`${services.i18n.normalizeLocalizationLanguageCode(languageCode)}:`));
      for (const key of keys) {
        const patch = pendingMap[key];
        if (!patch) continue;
        await persistLangvPendingPatch(patch);
      }
      const next = { ...pendingMap };
      for (const key of keys) delete next[key];
      setLangvPendingMap(ctx, next);
    };

    const renderLangvPagePreview = async (editingContentLanguageCode: string, pageId: string) => {
      const uiLocale = resolveAdminUiLanguageCode(user);
      const pending = getLangvPendingForPage(editingContentLanguageCode, pageId);
      if (pageId === "root") {
        const welcome = applyPendingPatchToSnapshot(
          await services.menu.getEffectiveWelcomeLocalizationForLanguage(user.id, editingContentLanguageCode).then((x) => ({
            contentText: x.welcomeText,
            mediaType: x.welcomeMediaType,
            mediaFileId: x.welcomeMediaFileId
          })),
          pending
        );
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          {
            text: renderPageContent(welcome.contentText ?? "", user),
            mediaType: welcome.mediaType,
            mediaFileId: welcome.mediaFileId
          },
          buildLanguageVersionPreviewConfirmKeyboard(uiLocale, services.i18n, editingContentLanguageCode, "root", { canManageLanguages: true })
        );
        return;
      }
      const row = applyPendingPatchToSnapshot(
        (await services.menu.getEffectiveMenuItemLocalizationForLanguage(pageId, editingContentLanguageCode)) ?? {
          contentText: "",
          mediaType: "NONE",
          mediaFileId: null,
          externalUrl: null
        },
        pending
      );
      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        {
          text: renderPageContent(row?.contentText ?? "", user),
          mediaType: (row?.mediaType ?? "NONE") as any,
          mediaFileId: row?.mediaFileId ?? null,
          externalUrl: row?.externalUrl ?? null
        },
        buildLanguageVersionPreviewConfirmKeyboard(uiLocale, services.i18n, editingContentLanguageCode, pageId, { canManageLanguages: true })
      );
    };

    const setLangvVersionPreviewState = (state: NonNullable<ExtendedNavSession["langvVersionPreview"]>) => {
      const s = ((ctx as unknown as { session?: ExtendedNavSession }).session ?? {}) as ExtendedNavSession;
      (ctx as unknown as { session: ExtendedNavSession }).session = {
        ...s,
        langvVersionPreview: state
      };
    };

    const getLangvVersionPreviewState = (): ExtendedNavSession["langvVersionPreview"] => {
      const s = ((ctx as unknown as { session?: ExtendedNavSession }).session ?? {}) as ExtendedNavSession;
      return s.langvVersionPreview;
    };

    const buildLangvVersionPreviewKeyboard = async (
      editingContentLanguageCode: string,
      uiLocale: string,
      currentPageId: string
    ) => {
      const parentId = currentPageId === "root" ? null : currentPageId;
      const children = await services.menu.getChildMenuItemsForAdmin(parentId);
      const rows: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
      for (const child of children.filter((c) => c.isActive)) {
        const title = await services.menu.getMenuItemTitleForLanguage(child.id, editingContentLanguageCode);
        const targetId = child.type === "SECTION_LINK" ? child.targetMenuItemId : child.id;
        if (!targetId) continue;
        rows.push([Markup.button.callback(title, makeCallbackData("admin", "langv_vp_open", targetId))]);
      }
      const state = getLangvVersionPreviewState();
      const canBack = Boolean(state && state.stack.length > 1);
      if (canBack) {
        rows.push([Markup.button.callback(services.i18n.t(uiLocale, "back"), makeCallbackData("admin", "langv_vp_back"))]);
      }
      rows.push([
        Markup.button.callback(
          "🛠 " + services.i18n.t(uiLocale, "langv_btn_return_editor"),
          makeCallbackData("admin", "edit_lang_version", editingContentLanguageCode)
        )
      ]);
      rows.push([Markup.button.callback(services.i18n.t(uiLocale, "to_main_menu"), NAV_ROOT_DATA)]);
      return Markup.inlineKeyboard(rows);
    };

    const renderLangvVersionPreviewCurrent = async () => {
      const state = getLangvVersionPreviewState();
      if (!state || state.stack.length === 0) return;
      const currentPageId = state.stack[state.stack.length - 1]!;
      const editingContentLanguageCode = state.languageCode;
      const uiLocale = state.uiLanguageCode;
      const pending = getLangvPendingForPage(editingContentLanguageCode, currentPageId);
      if (currentPageId === "root") {
        const welcome = applyPendingPatchToSnapshot(
          await services.menu.getEffectiveWelcomeLocalizationForLanguage(user.id, editingContentLanguageCode).then((x) => ({
            contentText: x.welcomeText,
            mediaType: x.welcomeMediaType,
            mediaFileId: x.welcomeMediaFileId
          })),
          pending
        );
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          {
            text: renderPageContent(welcome.contentText ?? "", user),
            mediaType: welcome.mediaType,
            mediaFileId: welcome.mediaFileId
          },
          await buildLangvVersionPreviewKeyboard(editingContentLanguageCode, uiLocale, "root")
        );
        return;
      }

      const page = await services.menu.findMenuItemById(currentPageId);
      if (!page) return;
      const loc = applyPendingPatchToSnapshot(
        (await services.menu.getEffectiveMenuItemLocalizationForLanguage(currentPageId, editingContentLanguageCode)) ?? {
          contentText: "",
          mediaType: "NONE",
          mediaFileId: null,
          externalUrl: null
        },
        pending
      );
      const title = await services.menu.getMenuItemTitleForLanguage(page.id, editingContentLanguageCode);
      const children = await services.menu.getChildMenuItemsForAdmin(currentPageId);
      const hasChildren = children.some((c) => c.isActive);
      if (page.type === "SUBMENU" || hasChildren) {
        const composedText = composeTitleBody(
          renderPageContent(title, user),
          renderPageContent(loc.contentText ?? "", user)
        );
        const hasMedia =
          (loc.mediaType === "PHOTO" || loc.mediaType === "VIDEO" || loc.mediaType === "DOCUMENT") &&
          Boolean(loc.mediaFileId);
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          hasMedia
            ? { text: composedText, mediaType: loc.mediaType as any, mediaFileId: loc.mediaFileId }
            : { text: composedText },
          await buildLangvVersionPreviewKeyboard(editingContentLanguageCode, uiLocale, currentPageId)
        );
        return;
      }
      await services.navigation.replaceScreen(
        user,
        ctx.telegram,
        ctx.chat?.id ?? user.telegramUserId,
        {
          text: renderPageContent(loc.contentText ?? "", user),
          mediaType: (loc.mediaType ?? "NONE") as any,
          mediaFileId: loc.mediaFileId ?? null,
          externalUrl: loc.externalUrl ?? null
        },
        await buildLangvVersionPreviewKeyboard(editingContentLanguageCode, uiLocale, currentPageId)
      );
    };

      if (action === "open") {
        setNavBeforeShow(ctx, "admin:open");
        const opts = await getAdminKeyboardOpts(user, resolveEffectiveRole(ctx));
        const adminText =
          services.i18n.t(adminLocale, "admin_panel") +
          "\n\n" +
          services.i18n.t(adminLocale, "changes_autosaved");
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text: adminText },
          buildAdminKeyboard(adminLocale, services.i18n, opts)
        );
        return;
      }

      if (action === "wipe") {
        await ctx.answerCbQuery?.();
        const warningText = services.i18n.t(adminLocale, "reset_warning");
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text: warningText },
          buildResetConfirmKeyboard(adminLocale, services.i18n)
        );
        return;
      }

      if (action === "wipe_confirm_yes") {
        await ctx.answerCbQuery?.();
        try {
          await services.menu.wipeBotStructure(user.id);
          await services.users.resetOnboarding(user.id);
          const refreshed = await services.users.findById(user.id);
          if (refreshed) ctx.currentUser = refreshed;
          await ctx.reply(services.i18n.t(adminLocale, "reset_done"));
          await sendRootWithWelcome(ctx);
        } catch (err) {
          logger.error({ userId: user.id, err }, "Full bot reset failed");
          await ctx.reply(services.i18n.t(adminLocale, "error_generic"));
          const opts = await getAdminKeyboardOpts(user, resolveEffectiveRole(ctx));
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: services.i18n.t(adminLocale, "admin_panel") },
            buildAdminKeyboard(adminLocale, services.i18n, opts)
          );
        }
        return;
      }

      if (action === "wipe_confirm_no") {
        await ctx.answerCbQuery?.();
        setNavBeforeShow(ctx, "admin:open");
        const opts = await getAdminKeyboardOpts(user, resolveEffectiveRole(ctx));
        const adminText =
          services.i18n.t(adminLocale, "admin_panel") +
          "\n\n" +
          services.i18n.t(adminLocale, "changes_autosaved");
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text: adminText },
          buildAdminKeyboard(adminLocale, services.i18n, opts)
        );
        return;
      }

      switch (action) {
        case "create_menu":
          await services.permissions.ensurePermission(user.id, "canEditMenu");
          // Replace the old confusing wizard with a simple hub that routes to existing flows.
          // "create_menu" currently has no page context, so we default to the main page ("root"),
          // matching the previous wizard behavior (it showed parent page = "Главная").
          {
            const fromPageId = value ? String(value) : "root";
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text: services.i18n.t(adminLocale, "menu_add_section_button_hub_text") },
              buildAddSectionButtonHubKeyboard(adminLocale, services.i18n, fromPageId)
            );
          }
          return;
        case "create_broadcast":
          await services.permissions.ensurePermission(user.id, "canSendBroadcasts");
          await ctx.scene.enter(CREATE_BROADCAST_SCENE);
          return;
        case "create_scheduled":
          await services.permissions.ensurePermission(user.id, "canScheduleMessages");
          await ctx.scene.enter(CREATE_SCHEDULED_BROADCAST_SCENE);
          return;
        case "scheduled_hub":
          await services.permissions.ensurePermission(user.id, "canScheduleMessages");
          setNavBeforeShow(ctx, "admin:scheduled_hub");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: "🗓 Отложенные\n\nВыберите действие:" },
            buildScheduledBroadcastHubKeyboard(adminLocale, services.i18n)
          );
          return;
        case "scheduled_list": {
          await services.permissions.ensurePermission(user.id, "canScheduleMessages");
          const broadcasts = await services.broadcasts.listScheduledBroadcasts(user.id);
          const items = broadcasts.map((b, idx) => {
            const { date, time } = formatUtcDateTime((b as any).sendAt);
            const audienceLabel = formatBroadcastAudienceLabel((b as any).audienceType, (b as any).segmentQuery ?? {});
            return {
              id: b.id,
              label: `${keycapNumber(idx + 1)} ${date} ${time} · ${audienceLabel}`
            };
          });

          const text =
            broadcasts.length === 0
              ? "Пока нет запланированных рассылок."
              : "📅 Запланированные рассылки:\n\n" +
                broadcasts
                  .slice(0, 20)
                  .map((b) => {
                    const contentLang = formatBroadcastContentLanguageLabel((b as any).localizations ?? []);
                    return `${b.id}\n• Аудитория: ${formatBroadcastAudienceLabel((b as any).audienceType, (b as any).segmentQuery ?? {})}\n• Язык контента: ${contentLang}\n• Статус: ${formatBroadcastStatusLabel(b.status)}\n`;
                  })
                  .join("\n");

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: text.slice(0, 4090) },
            buildScheduledBroadcastListKeyboard(adminLocale, services.i18n, items)
          );
          return;
        }
        case "scheduled_open": {
          await services.permissions.ensurePermission(user.id, "canScheduleMessages");
          if (!value) {
            await ctx.reply("Не удалось открыть рассылку: id не задан.");
            return;
          }
          try {
            const broadcast = await services.broadcasts.getScheduledBroadcastDetail(user.id, String(value));
            if (broadcast.status !== "SCHEDULED") {
              throw new Error(`Scheduled broadcast not in queue (status=${broadcast.status})`);
            }
            const audienceLabel = formatBroadcastAudienceLabel(broadcast.audienceType, (broadcast.segmentQuery as any) ?? {});
            const contentLang = formatBroadcastContentLanguageLabel((broadcast as any).localizations ?? []);
            const { date, time } = formatUtcDateTime((broadcast as any).sendAt);

            const text =
              `📌 ${broadcast.id}\n\n` +
              `Аудитория: ${audienceLabel}\n` +
              `Язык контента: ${contentLang}\n` +
              `Дата (UTC): ${date}\n` +
              `Время (UTC): ${time}\n` +
              `Режим: локально для каждого пользователя (fallback: ${env.APP_TIMEZONE}).\n` +
              `Статус: ${formatBroadcastStatusLabel(broadcast.status)}`;

            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text },
              buildScheduledBroadcastDetailKeyboard(adminLocale, services.i18n, broadcast.id)
            );
            return;
          } catch (err) {
            logger.warn({ userId: user.id, broadcastId: String(value), err }, "Scheduled broadcast open failed");
            const broadcasts = await services.broadcasts.listScheduledBroadcasts(user.id);
            const items = broadcasts.map((b, idx) => {
              const { date, time } = formatUtcDateTime((b as any).sendAt);
              const audienceLabel = formatBroadcastAudienceLabel((b as any).audienceType, (b as any).segmentQuery ?? {});
              return { id: b.id, label: `${keycapNumber(idx + 1)} ${date} ${time} · ${audienceLabel}` };
            });
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text: "Эта запланированная рассылка больше недоступна. Попробуйте открыть список ещё раз." },
              buildScheduledBroadcastListKeyboard(adminLocale, services.i18n, items)
            );
            return;
          }
        }
        case "scheduled_stop":
          await services.permissions.ensurePermission(user.id, "canScheduleMessages");
          if (!value) return;
          let stoppedBroadcast: { status: string } | null = null;
          try {
            stoppedBroadcast = await services.broadcasts.stopScheduledBroadcast(user.id, String(value));
          } catch (err) {
            logger.warn({ userId: user.id, broadcastId: String(value), err }, "Scheduled broadcast stop failed");
          }
          const broadcastsAfterStop = await services.broadcasts.listScheduledBroadcasts(user.id);
          const itemsAfterStop = broadcastsAfterStop.map((b, idx) => {
            const { date, time } = formatUtcDateTime((b as any).sendAt);
            const audienceLabel = formatBroadcastAudienceLabel((b as any).audienceType, (b as any).segmentQuery ?? {});
            return { id: b.id, label: `${keycapNumber(idx + 1)} ${date} ${time} · ${audienceLabel}` };
          });

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            {
              text: stoppedBroadcast?.status === "CANCELLED" ? "⛔ Рассылка остановлена.\n\n📅 Запланированные рассылки:" : "⛔ Не удалось остановить рассылку (возможно, она уже не в очереди).\n\n📅 Запланированные рассылки:"
            },
            buildScheduledBroadcastListKeyboard(adminLocale, services.i18n, itemsAfterStop)
          );
          return;
        case "scheduled_delete":
          await services.permissions.ensurePermission(user.id, "canScheduleMessages");
          if (!value) return;
          try {
            await services.broadcasts.deleteScheduledBroadcast(user.id, String(value));
          } catch (err) {
            logger.warn({ userId: user.id, broadcastId: String(value), err }, "Scheduled broadcast delete failed");
          }
          setNavBeforeShow(ctx, "admin:scheduled_list");
          const broadcasts = await services.broadcasts.listScheduledBroadcasts(user.id);
          const items = broadcasts.map((b, idx) => {
            const { date, time } = formatUtcDateTime((b as any).sendAt);
            const audienceLabel = formatBroadcastAudienceLabel((b as any).audienceType, (b as any).segmentQuery ?? {});
            return { id: b.id, label: `${keycapNumber(idx + 1)} ${date} ${time} · ${audienceLabel}` };
          });
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            {
              text: broadcasts.length === 0 ? "Пока нет запланированных рассылок." : "📅 Запланированные рассылки:"
            },
            buildScheduledBroadcastListKeyboard(adminLocale, services.i18n, items)
          );
          return;
        case "scheduled_edit":
          await services.permissions.ensurePermission(user.id, "canScheduleMessages");
          if (!value) return;
          try {
            const broadcast = await services.broadcasts.getScheduledBroadcastDetail(user.id, String(value));
            if (broadcast.status !== "SCHEDULED") {
              await ctx.reply("Эта запланированная рассылка уже не доступна для редактирования (статус изменился).");
              const broadcasts = await services.broadcasts.listScheduledBroadcasts(user.id);
              const items = broadcasts.map((b, idx) => {
                const { date, time } = formatUtcDateTime((b as any).sendAt);
                const audienceLabel = formatBroadcastAudienceLabel((b as any).audienceType, (b as any).segmentQuery ?? {});
                return { id: b.id, label: `${keycapNumber(idx + 1)} ${date} ${time} · ${audienceLabel}` };
              });
              await services.navigation.replaceScreen(
                user,
                ctx.telegram,
                ctx.chat?.id ?? user.telegramUserId,
                {
                  text: broadcasts.length === 0 ? "Пока нет запланированных рассылок." : "📅 Запланированные рассылки:"
                },
                buildScheduledBroadcastListKeyboard(adminLocale, services.i18n, items)
              );
              return;
            }
          } catch {
            const broadcasts = await services.broadcasts.listScheduledBroadcasts(user.id);
            const items = broadcasts.map((b, idx) => {
              const { date, time } = formatUtcDateTime((b as any).sendAt);
              const audienceLabel = formatBroadcastAudienceLabel((b as any).audienceType, (b as any).segmentQuery ?? {});
              return { id: b.id, label: `${keycapNumber(idx + 1)} ${date} ${time} · ${audienceLabel}` };
            });
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              {
                text: broadcasts.length === 0 ? "Пока нет запланированных рассылок." : "📅 Запланированные рассылки:"
              },
              buildScheduledBroadcastListKeyboard(adminLocale, services.i18n, items)
            );
            return;
          }

          const editToken = `${Date.now()}`;
          await ctx.scene.enter(CREATE_SCHEDULED_BROADCAST_SCENE, {
            editBroadcastId: String(value),
            editScheduleToken: editToken
          });
          return;
        case "scheduled_send_now": {
          await services.permissions.ensurePermission(user.id, "canScheduleMessages");
          if (!value) return;

          const broadcast = await services.broadcasts.getScheduledBroadcastDetail(user.id, String(value));
          if (broadcast.status !== "SCHEDULED") {
            await ctx.reply("Эта рассылка уже не в очереди и не доступна для «Отправить сейчас».");
            const broadcasts = await services.broadcasts.listScheduledBroadcasts(user.id);
            const items = broadcasts.map((b, idx) => {
              const { date, time } = formatUtcDateTime((b as any).sendAt);
              const audienceLabel = formatBroadcastAudienceLabel((b as any).audienceType, (b as any).segmentQuery ?? {});
              return { id: b.id, label: `${keycapNumber(idx + 1)} ${date} ${time} · ${audienceLabel}` };
            });
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text: broadcasts.length === 0 ? "Пока нет запланированных рассылок." : "📅 Запланированные рассылки:" },
              buildScheduledBroadcastListKeyboard(adminLocale, services.i18n, items)
            );
            return;
          }

          const chatId = ctx.chat?.id ?? user.telegramUserId;
          const normalizedChatId = typeof chatId === "bigint" ? Number(chatId) : chatId;
          const progressMsg = await ctx.reply("Рассылка запускается...");

          const render = (s: any) => {
            const total = s?.totalRecipients ?? 0;
            const processed = s?.processedCount ?? 0;
            const success = s?.successCount ?? 0;
            const failed = s?.failedCount ?? 0;
            const pending = s?.pendingCount ?? Math.max(0, total - processed);
            return [
              "Рассылка выполняется",
              `- Всего: ${total}`,
              `- Отправлено: ${processed}`,
              `- Доставлено: ${success}`,
              `- С ошибкой: ${failed}`,
              `- Осталось: ${pending}`
            ].join("\n");
          };

          const finalStats = await services.broadcasts.dispatchScheduledBroadcastNow(user.id, String(value), {
            onProgress: async (stats: any) => {
              try {
                await ctx.telegram.editMessageText(normalizedChatId, progressMsg.message_id, undefined, render(stats));
              } catch {
                // ignore edit errors
              }
            },
            progressEmitEvery: 20,
            progressEmitMinIntervalMs: 1200
          });

          const finalText = [
            "Рассылка завершена",
            `- Всего: ${finalStats.totalRecipients}`,
            `- Доставлено: ${finalStats.successCount}`,
            `- С ошибкой: ${finalStats.failedCount}`
          ].join("\n");

          try {
            await ctx.telegram.editMessageText(
              normalizedChatId,
              progressMsg.message_id,
              undefined,
              finalText,
              buildScheduledBroadcastDetailKeyboard(adminLocale, services.i18n, String(value))
            );
          } catch {
            // ignore
          }

          const broadcastsAfter = await services.broadcasts.listScheduledBroadcasts(user.id);
          const itemsAfter = broadcastsAfter.map((b, idx) => {
            const { date, time } = formatUtcDateTime((b as any).sendAt);
            const audienceLabel = formatBroadcastAudienceLabel((b as any).audienceType, (b as any).segmentQuery ?? {});
            return { id: b.id, label: `${keycapNumber(idx + 1)} ${date} ${time} · ${audienceLabel}` };
          });

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: broadcastsAfter.length === 0 ? "Пока нет запланированных рассылок." : "📅 Запланированные рассылки:" },
            buildScheduledBroadcastListKeyboard(adminLocale, services.i18n, itemsAfter)
          );
          return;
        }
        case "create_drip":
          await services.permissions.ensurePermission(user.id, "canSendBroadcasts");
          setNavBeforeShow(ctx, "admin:drip_hub");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: "✉️ Автосерия\n\nВыберите действие:" },
            Markup.inlineKeyboard([
              [Markup.button.callback("➕ Создать новую цепочку", makeCallbackData("admin", "drip_new"))],
              [Markup.button.callback("📚 Мои цепочки", makeCallbackData("dripm", "list"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "return_to_admin"), makeCallbackData("admin", "open"))],
              ...buildNavigationRow(services.i18n, adminLocale, { toMain: true }).map((btn) => [btn])
            ])
          );
          return;
        case "drip_new":
          await services.permissions.ensurePermission(user.id, "canSendBroadcasts");
          await ctx.scene.enter(CREATE_DRIP_SCENE);
          return;
        case "structure": {
          const title = services.i18n.t(adminLocale, "structure_title");
          const humanText = await services.menu.getHumanReadableStructure(adminLocale);
          const text = `${title}\n\n${humanText}`.slice(0, 4090);

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildStructureScreenKeyboard(adminLocale, services.i18n)
          );
          return;
        }
        case "preview_structure": {
          const locale = adminLocale;
          const [content, warnings] = await Promise.all([
            services.menu.getFullPreviewContent(locale),
            services.menu.getPreviewWarnings(locale)
          ]);
          const title = services.i18n.t(locale, "preview_structure_title");
          const warningsBlock =
            warnings.length > 0
              ? "\n\n" + services.i18n.t(locale, "preview_warnings_header") + "\n" + warnings.join("\n")
              : "";
          const text = `${title}\n\n${content}${warningsBlock}`.slice(0, 4090);
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildPreviewScreenKeyboard(locale, services.i18n)
          );
          return;
        }
        case "preview": {
          const preview = await services.menu.previewTree(user.selectedLanguage);
          await ctx.reply(preview);
          return;
        }
        case "export": {
          const effectiveRole = resolveEffectiveRole(ctx);
          const locale = services.i18n.resolveLanguage(user.selectedLanguage);
          const { buffer, totalCount, exportDate } = await services.exports.buildUsersHtmlReport(user, {
            effectiveRole: effectiveRole as any,
            languageCode: locale
          });
          const filename = services.exports.formatExportFilename("html", exportDate, "users");
          const captionTypeLabel = services.i18n.t(
            locale,
            effectiveRole === "ALPHA_OWNER" ? "export_type_users_html" : "export_type_first_line_html"
          );
          const caption = services.i18n
            .t(locale, "export_caption_with_type")
            .replace("{{type}}", captionTypeLabel)
            .replace("{{date}}", services.exports.formatExportDate(exportDate))
            .replace("{{count}}", String(totalCount));
          await ctx.replyWithDocument(
            { source: buffer, filename },
            { caption }
          );
          return;
        }
        case "export_xlsx": {
          // Excel export is removed from UI and entrypoints.
          // If a stale callback arrives, we fallback to HTML export so the bot never crashes.
          const effectiveRole = resolveEffectiveRole(ctx);
          const locale = services.i18n.resolveLanguage(user.selectedLanguage);
          const { buffer, totalCount, exportDate } = await services.exports.buildUsersHtmlReport(user, {
            effectiveRole: effectiveRole as any,
            languageCode: locale
          });
          const filename = services.exports.formatExportFilename("html", exportDate, "users");
          const captionTypeLabel = services.i18n.t(
            locale,
            effectiveRole === "ALPHA_OWNER" ? "export_type_users_html" : "export_type_first_line_html"
          );
          const caption = services.i18n
            .t(locale, "export_caption_with_type")
            .replace("{{type}}", captionTypeLabel)
            .replace("{{date}}", services.exports.formatExportDate(exportDate))
            .replace("{{count}}", String(totalCount));
          await ctx.replyWithDocument({ source: buffer, filename }, { caption });
          return;
        }
        case "publish": {
          const locale = adminLocale;
          const [content, warnings] = await Promise.all([
            services.menu.getFullPreviewContent(locale),
            services.menu.getPreviewWarnings(locale)
          ]);
          const title = services.i18n.t(locale, "preview_structure_title");
          const warningsBlock =
            warnings.length > 0
              ? "\n\n" + services.i18n.t(locale, "preview_warnings_header") + "\n" + warnings.join("\n")
              : "";
          const text = `${title}\n\n${content}${warningsBlock}`.slice(0, 4090);
          // Changes are autosaved; admin "Publish" button is removed.
          // If an old callback arrives, just show the preview again without confirmation.
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildPreviewScreenKeyboard(locale, services.i18n)
          );
          return;
        }
        case "publish_confirm":
          await ctx.answerCbQuery?.();
          await services.audit.log(user.id, "publish_template", "presentation_template", null, {});
          await ctx.reply(services.i18n.t(user.selectedLanguage, "publish_done"));
          setNavBeforeShow(ctx, "admin:open");
          const optsPublish = await getAdminKeyboardOpts(user, resolveEffectiveRole(ctx));
          const adminTextPublish =
            services.i18n.t(adminLocale, "admin_panel") + "\n\n" + services.i18n.t(adminLocale, "changes_autosaved");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: adminTextPublish },
            buildAdminKeyboard(adminLocale, services.i18n, optsPublish)
          );
          return;

        case "system_buttons": {
          await ctx.answerCbQuery?.();
          if (user.role !== "ALPHA_OWNER") {
            await ctx.reply(services.i18n.t(user.selectedLanguage, "permission_denied"));
            return;
          }

          const locale = services.i18n.resolveLanguage(user.selectedLanguage);
          const adminLocale = locale;

          const children = await services.menu.getChildMenuItemsForAdmin(null);
          const contentIdsOrdered = children.map((c) => c.id);
          const slotOrder = await services.menu.getEffectiveSlotOrder("root", contentIdsOrdered);
          const slotSet = new Set(slotOrder);

          const sysButtons: Array<{ slotId: string; label: string }> = [
            { slotId: MenuService.SYS_SLOT_LANGUAGE, label: services.i18n.t(adminLocale, "sys_btn_change_language") },
            { slotId: MenuService.SYS_SLOT_MY_CABINET, label: services.i18n.t(adminLocale, "sys_btn_my_cabinet") },
            { slotId: MenuService.SYS_SLOT_MENTOR_CONTACT, label: services.i18n.t(adminLocale, "sys_btn_mentor_contact") },
            { slotId: MenuService.SYS_SLOT_PARTNER_REGISTER, label: services.i18n.t(adminLocale, "sys_btn_partner_register") },
            { slotId: MenuService.SYS_SLOT_ADMIN_PANEL, label: services.i18n.t(adminLocale, "sys_btn_admin_panel") },
            { slotId: MenuService.SYS_SLOT_CONFIGURE_PAGE, label: services.i18n.t(adminLocale, "sys_btn_configure_page") }
          ];

          const text = services.i18n.t(adminLocale, "sys_buttons_title") + "\n\n" + services.i18n.t(adminLocale, "sys_buttons_hint");

          const kbRows: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
          for (const b of sysButtons) {
            const enabled = slotSet.has(b.slotId);
            kbRows.push([
              Markup.button.callback(
                `${enabled ? "➖" : "✅"} ${b.label}`,
                makeCallbackData("admin", "toggle_sys_button", b.slotId)
              )
            ]);
          }

          kbRows.push([Markup.button.callback(services.i18n.t(locale, "back"), makeCallbackData("admin", "open"))]);
          kbRows.push([Markup.button.callback(services.i18n.t(locale, "to_main_menu"), NAV_ROOT_DATA)]);

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            Markup.inlineKeyboard(kbRows)
          );

          return;
        }

        case "toggle_sys_button": {
          await ctx.answerCbQuery?.();
          if (user.role !== "ALPHA_OWNER") {
            await ctx.reply(services.i18n.t(user.selectedLanguage, "permission_denied"));
            return;
          }
          if (!value) return;

          const slotId = String(value);
          const allowed = new Set<string>([
            MenuService.SYS_SLOT_LANGUAGE,
            MenuService.SYS_SLOT_MY_CABINET,
            MenuService.SYS_SLOT_MENTOR_CONTACT,
            MenuService.SYS_SLOT_PARTNER_REGISTER,
            MenuService.SYS_SLOT_ADMIN_PANEL,
            MenuService.SYS_SLOT_CONFIGURE_PAGE
          ]);
          if (!allowed.has(slotId)) return;

          const children = await services.menu.getChildMenuItemsForAdmin(null);
          const contentIdsOrdered = children.map((c) => c.id);
          const slotOrder = await services.menu.getEffectiveSlotOrder("root", contentIdsOrdered);
          const has = slotOrder.includes(slotId);

          const next = has ? slotOrder.filter((s) => s !== slotId) : [...slotOrder, slotId];
          if (!next.includes(MenuService.SYS_SLOT_CONFIGURED_MARKER)) {
            next.push(MenuService.SYS_SLOT_CONFIGURED_MARKER);
          }

          await services.menu.setPageNavConfig("root", next, user.id);

          setNavBeforeShow(ctx, "admin:system_buttons");
          const locale = services.i18n.resolveLanguage(user.selectedLanguage);
          const adminLocale = locale;

          const children2 = await services.menu.getChildMenuItemsForAdmin(null);
          const contentIdsOrdered2 = children2.map((c) => c.id);
          const slotOrder2 = await services.menu.getEffectiveSlotOrder("root", contentIdsOrdered2);
          const slotSet2 = new Set(slotOrder2);

          const sysButtons: Array<{ slotId: string; label: string }> = [
            { slotId: MenuService.SYS_SLOT_LANGUAGE, label: services.i18n.t(adminLocale, "sys_btn_change_language") },
            { slotId: MenuService.SYS_SLOT_MY_CABINET, label: services.i18n.t(adminLocale, "sys_btn_my_cabinet") },
            { slotId: MenuService.SYS_SLOT_MENTOR_CONTACT, label: services.i18n.t(adminLocale, "sys_btn_mentor_contact") },
            { slotId: MenuService.SYS_SLOT_PARTNER_REGISTER, label: services.i18n.t(adminLocale, "sys_btn_partner_register") },
            { slotId: MenuService.SYS_SLOT_ADMIN_PANEL, label: services.i18n.t(adminLocale, "sys_btn_admin_panel") },
            { slotId: MenuService.SYS_SLOT_CONFIGURE_PAGE, label: services.i18n.t(adminLocale, "sys_btn_configure_page") }
          ];

          const text = services.i18n.t(adminLocale, "sys_buttons_title") + "\n\n" + services.i18n.t(adminLocale, "sys_buttons_hint");

          const kbRows: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
          for (const b of sysButtons) {
            const enabled = slotSet2.has(b.slotId);
            kbRows.push([
              Markup.button.callback(
                `${enabled ? "➖" : "✅"} ${b.label}`,
                makeCallbackData("admin", "toggle_sys_button", b.slotId)
              )
            ]);
          }

          kbRows.push([Markup.button.callback(services.i18n.t(locale, "back"), makeCallbackData("admin", "open"))]);
          kbRows.push([Markup.button.callback(services.i18n.t(locale, "to_main_menu"), NAV_ROOT_DATA)]);

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            Markup.inlineKeyboard(kbRows)
          );
          return;
        }

        case "languages": {
          await ctx.answerCbQuery?.();
          const existingLangCodes = await services.menu.getActiveTemplateLanguageCodes();
          const text = [
            `Языки`,
            ``,
            `🌐 Добавить язык — переведём тексты на AI`,
            existingLangCodes.length > 0 ? `📋 Уже добавлены: ${existingLangCodes.join(", ")}` : `📋 Пока нет добавленных языков`
          ].join("\n");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            Markup.inlineKeyboard([
              [Markup.button.callback(services.i18n.t(adminLocale, "admin_add_language_version"), makeCallbackData("admin", "add_lang"))],
              [Markup.button.callback("📋 Существующие языковые версии", makeCallbackData("admin", "list_langs"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "back"), makeCallbackData("admin", "open"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]
            ])
          );
          return;
        }
        case "list_langs": {
          await ctx.answerCbQuery?.();
          const existingLangCodes = await services.menu.getActiveTemplateLanguageCodes();
          const labelFor = (code: string) => services.i18n.availableLanguages().find((l) => l.code === code)?.label ?? code;
          const text = existingLangCodes.length
            ? ["📋 Существующие языковые версии", "", ...existingLangCodes.map((c) => `• ${labelFor(c)}`)].join("\n")
            : "Пока нет добавленных языков.";

          const rows: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
          for (const c of existingLangCodes) {
            rows.push([Markup.button.callback(`👁 ${labelFor(c)}`, makeCallbackData("admin", "lang_detail", c))]);
          }
          rows.push([Markup.button.callback(services.i18n.t(adminLocale, "back"), makeCallbackData("admin", "languages"))]);
          rows.push([Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]);

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            Markup.inlineKeyboard(rows)
          );
          return;
        }
        case "lang_detail": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const targetLanguageCode = String(value).toLowerCase();
          const label = services.i18n.availableLanguages().find((l) => l.code === targetLanguageCode)?.label ?? targetLanguageCode;

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: `Языковая версия ${label}` },
            Markup.inlineKeyboard([
              [Markup.button.callback(`👁 Открыть ${label}`, makeCallbackData("admin", "open_lang_version", targetLanguageCode))],
              [Markup.button.callback(`🛠 Редактировать ${label}`, makeCallbackData("admin", "edit_lang_version", targetLanguageCode))],
              [Markup.button.callback(`🔄 Перегенерировать AI-перевод`, makeCallbackData("admin", "regen_lang_prompt", targetLanguageCode))],
              [Markup.button.callback(`🗑 Удалить ${label}`, makeCallbackData("admin", "lang_delete_prompt", targetLanguageCode))],
              [Markup.button.callback(services.i18n.t(adminLocale, "back"), makeCallbackData("admin", "list_langs"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]
            ])
          );
          return;
        }
        case "lang_delete_prompt": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const targetLanguageCode = String(value).toLowerCase();
          const label = services.i18n.availableLanguages().find((l) => l.code === targetLanguageCode)?.label ?? targetLanguageCode;
          const baseLang = await services.menu.getBaseLanguage(user.id);
          const baseLabel = services.i18n.availableLanguages().find((l) => l.code === baseLang)?.label ?? baseLang;

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            {
              text: [
                `🗑 Удалить языковую версию: ${label}?`,
                ``,
                `Будут удалены:`,
                `• welcome-текст для ${label}`,
                `• переводы разделов/кнопок этого языка`,
                ``,
                `Базовый язык (${baseLabel}) удалить нельзя.`,
                `После удаления язык можно создать заново через "Добавить языковую версию".`
              ].join("\n")
            },
            Markup.inlineKeyboard([
              [Markup.button.callback("✅ Да, удалить", makeCallbackData("admin", "lang_delete_confirm", targetLanguageCode))],
              [Markup.button.callback(services.i18n.t(adminLocale, "back"), makeCallbackData("admin", "lang_detail", targetLanguageCode))],
              [Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]
            ])
          );
          return;
        }
        case "lang_delete_confirm": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const targetLanguageCode = String(value).toLowerCase();
          const label = services.i18n.availableLanguages().find((l) => l.code === targetLanguageCode)?.label ?? targetLanguageCode;

          try {
            const result = await services.menu.deleteLanguageVersion(user.id, targetLanguageCode);
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              {
                text: [
                  `✅ Языковая версия ${label} удалена.`,
                  ``,
                  `Удален welcome: ${result.deletedWelcome ? "да" : "нет"}`,
                  `Удалено переводов разделов/кнопок: ${result.deletedMenuItemLocalizations}`
                ].join("\n")
              },
              Markup.inlineKeyboard([
                [Markup.button.callback("📋 К списку языков", makeCallbackData("admin", "list_langs"))],
                [Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]
              ])
            );
          } catch (error) {
            const message =
              error instanceof Error
                ? error.message
                : "Не удалось удалить языковую версию";
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              {
                text: `⚠️ ${message}`
              },
              Markup.inlineKeyboard([
                [Markup.button.callback(services.i18n.t(adminLocale, "back"), makeCallbackData("admin", "lang_detail", targetLanguageCode))],
                [Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]
              ])
            );
          }
          return;
        }
        case "open_lang_version": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const targetLanguageCode = String(value).toLowerCase();
          const updated = await services.users.setLanguage(user.id, targetLanguageCode);
          if (updated) ctx.currentUser = updated;
          await sendRootWithWelcome(ctx);
          return;
        }
        case "edit_lang_version": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const targetLanguageCode = String(value).toLowerCase();
          const uiLocale = resolveAdminUiLanguageCode(user);
          const editingContentLanguageCode = services.i18n.normalizeLocalizationLanguageCode(targetLanguageCode);
          setEditingContentLanguageCode(ctx, editingContentLanguageCode);
          const editingLabel = services.i18n.availableLanguages().find((l) => l.code === editingContentLanguageCode)?.label ?? editingContentLanguageCode;
          const uiLabel = services.i18n.availableLanguages().find((l) => l.code === uiLocale)?.label ?? uiLocale;
          const status = await services.menu.getLanguageVersionStatus(user.id, editingContentLanguageCode);
          const statusText =
            status.status === "PUBLISHED"
              ? services.i18n.t(uiLocale, "langv_status_published")
              : services.i18n.t(uiLocale, "langv_status_draft");
          const text = [
            services.i18n.t(uiLocale, "langv_hub_title"),
            "",
            services.i18n.t(uiLocale, "langv_context_editing_language").replace("{{lang}}", editingLabel),
            services.i18n.t(uiLocale, "langv_context_ui_language").replace("{{lang}}", uiLabel),
            services.i18n.t(uiLocale, "langv_context_status").replace("{{status}}", statusText)
          ].join("\n");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            buildLanguageVersionHubKeyboard(uiLocale, services.i18n, editingContentLanguageCode, { canManageLanguages: true })
          );
          return;
        }
        case "langv_pages": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const editingContentLanguageCode = services.i18n.normalizeLocalizationLanguageCode(String(value));
          setEditingContentLanguageCode(ctx, editingContentLanguageCode);
          const uiLocale = resolveAdminUiLanguageCode(user);
          const all = await services.menu.getAllMenuItemsForAdmin();
          const pages = all.filter((p) => p.type !== "SECTION_LINK");
          const byParent = new Map<string | null, typeof pages>();
          for (const page of pages) {
            const pid = page.parentId ?? null;
            if (!byParent.has(pid)) byParent.set(pid, []);
            byParent.get(pid)!.push(page);
          }
          const rows: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
          const walk = async (parentId: string | null, depth: number) => {
            const children = byParent.get(parentId) ?? [];
            for (const c of children) {
              const title = await services.menu.getMenuItemTitleForLanguage(c.id, editingContentLanguageCode);
              const prefix = depth > 0 ? `${"  ".repeat(Math.min(depth, 3))}• ` : "";
              rows.push([Markup.button.callback(prefix + title, makeCallbackData("admin", "langv_page_open", editingContentLanguageCode, c.id))]);
              await walk(c.id, depth + 1);
            }
          };
          rows.push([Markup.button.callback("🏠 " + services.i18n.t(uiLocale, "page_root_title"), makeCallbackData("admin", "langv_page_open", editingContentLanguageCode, "root"))]);
          await walk(null, 0);
          rows.push([Markup.button.callback(services.i18n.t(uiLocale, "back"), makeCallbackData("admin", "edit_lang_version", editingContentLanguageCode))]);
          rows.push([Markup.button.callback(services.i18n.t(uiLocale, "to_main_menu"), NAV_ROOT_DATA)]);
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: services.i18n.t(uiLocale, "langv_pages_title") },
            Markup.inlineKeyboard(rows)
          );
          return;
        }
        case "langv_page_open": {
          await ctx.answerCbQuery?.();
          if (!value || !extra) return;
          const editingContentLanguageCode = services.i18n.normalizeLocalizationLanguageCode(String(value));
          const pageId = String(extra);
          setEditingContentLanguageCode(ctx, editingContentLanguageCode);
          const uiLocale = resolveAdminUiLanguageCode(user);
          const pageTitle =
            pageId === "root"
              ? services.i18n.t(uiLocale, "page_root_title")
              : await services.menu.getMenuItemTitleForLanguage(pageId, editingContentLanguageCode);
          const pending = getLangvPendingForPage(editingContentLanguageCode, pageId);
          const content =
            pageId === "root"
              ? await services.menu.getEffectiveWelcomeLocalizationForLanguage(user.id, editingContentLanguageCode).then((x) =>
                  applyPendingPatchToSnapshot(
                    {
                      contentText: x.welcomeText,
                      mediaType: x.welcomeMediaType,
                      mediaFileId: x.welcomeMediaFileId,
                      exactMatch: x.exactMatch
                    },
                    pending
                  )
                )
              : applyPendingPatchToSnapshot(
                  (await services.menu.getEffectiveMenuItemLocalizationForLanguage(pageId, editingContentLanguageCode)) ?? {
                    contentText: "",
                    mediaType: "NONE",
                    mediaFileId: null,
                    externalUrl: null,
                    exactMatch: false
                  },
                  pending
                );
          const mediaLabel =
            content?.mediaType === "PHOTO"
              ? services.i18n.t(uiLocale, "langv_media_photo")
              : content?.mediaType === "VIDEO"
                ? services.i18n.t(uiLocale, "langv_media_video")
                : content?.mediaType === "DOCUMENT"
                  ? services.i18n.t(uiLocale, "langv_media_document")
                  : content?.mediaType && content.mediaType !== "NONE"
                    ? services.i18n.t(uiLocale, "langv_media_other")
                    : services.i18n.t(uiLocale, "langv_media_none");
          const textPreview = (content?.contentText ?? "").trim() || "—";
          const text = [
            services.i18n.t(uiLocale, "langv_page_header"),
            "",
            services.i18n.t(uiLocale, "langv_context_editing_language").replace("{{lang}}", editingContentLanguageCode),
            services.i18n.t(uiLocale, "langv_context_ui_language").replace("{{lang}}", uiLocale),
            services.i18n.t(uiLocale, "langv_page_context_page").replace("{{title}}", pageTitle),
            !content?.exactMatch ? services.i18n.t(uiLocale, "langv_page_context_fallback") : "",
            pending ? services.i18n.t(uiLocale, "langv_pending_changes_hint") : "",
            "",
            services.i18n.t(uiLocale, "langv_page_text_preview").replace("{{text}}", textPreview.slice(0, 700)),
            services.i18n.t(uiLocale, "langv_page_media_preview").replace("{{media}}", mediaLabel)
          ]
            .filter(Boolean)
            .join("\n");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: text.slice(0, 4090) },
            buildLanguageVersionPageActionsKeyboard(uiLocale, services.i18n, editingContentLanguageCode, pageId, { canManageLanguages: true })
          );
          return;
        }
        case "langv_rtxt":
        case "langv_rpho":
        case "langv_rvid":
        case "langv_rdoc":
        case "langv_rfull": {
          await ctx.answerCbQuery?.();
          if (!value || !extra) return;
          const editingContentLanguageCode = services.i18n.normalizeLocalizationLanguageCode(String(value));
          const pageId = String(extra);
          setEditingContentLanguageCode(ctx, editingContentLanguageCode);
          const uiLocale = resolveAdminUiLanguageCode(user);
          const mode =
            action === "langv_rtxt"
              ? "text_only"
              : action === "langv_rpho"
                ? "photo_only"
                : action === "langv_rvid"
                  ? "video_only"
                  : action === "langv_rdoc"
                    ? "document_only"
                    : "full";
          await ctx.scene.enter(EDIT_PAGE_CONTENT_SCENE, {
            menuItemId: pageId,
            isRoot: pageId === "root",
            languageCode: editingContentLanguageCode,
            uiLanguageCode: uiLocale,
            updateMode: mode,
            returnPageId: pageId,
            returnScope: "langv"
          });
          return;
        }
        case "langv_page_preview": {
          await ctx.answerCbQuery?.();
          if (!value || !extra) return;
          const editingContentLanguageCode = services.i18n.normalizeLocalizationLanguageCode(String(value));
          const pageId = String(extra);
          await renderLangvPagePreview(editingContentLanguageCode, pageId);
          return;
        }
        case "langv_preview": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const editingContentLanguageCode = services.i18n.normalizeLocalizationLanguageCode(String(value));
          setLangvVersionPreviewState({
            languageCode: editingContentLanguageCode,
            uiLanguageCode: resolveAdminUiLanguageCode(user),
            stack: ["root"]
          });
          await renderLangvVersionPreviewCurrent();
          return;
        }
        case "langv_vp_open": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const targetPageId = String(value);
          const state = getLangvVersionPreviewState();
          if (!state) return;
          setLangvVersionPreviewState({
            ...state,
            stack: [...state.stack, targetPageId]
          });
          await renderLangvVersionPreviewCurrent();
          return;
        }
        case "langv_vp_back": {
          await ctx.answerCbQuery?.();
          const state = getLangvVersionPreviewState();
          if (!state) return;
          if (state.stack.length <= 1) {
            await renderLangvVersionPreviewCurrent();
            return;
          }
          const nextStack = state.stack.slice(0, -1);
          setLangvVersionPreviewState({
            ...state,
            stack: nextStack
          });
          await renderLangvVersionPreviewCurrent();
          return;
        }
        case "langv_publish": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const editingContentLanguageCode = services.i18n.normalizeLocalizationLanguageCode(String(value));
          const uiLocale = resolveAdminUiLanguageCode(user);
          await flushLangvPendingForLanguage(editingContentLanguageCode);
          await services.menu.publishLanguageVersion(user.id, editingContentLanguageCode);
          await ctx.reply(services.i18n.t(uiLocale, "langv_published"));
          return;
        }
        case "langv_post_preview": {
          await ctx.answerCbQuery?.();
          if (!value || !extra) return;
          const editingContentLanguageCode = services.i18n.normalizeLocalizationLanguageCode(String(value));
          const pageId = String(extra);
          await renderLangvPagePreview(editingContentLanguageCode, pageId);
          return;
        }
        case "langv_post_publish": {
          await ctx.answerCbQuery?.();
          if (!value || !extra) return;
          const editingContentLanguageCode = services.i18n.normalizeLocalizationLanguageCode(String(value));
          const pageId = String(extra);
          await flushLangvPendingForLanguage(editingContentLanguageCode);
          await services.menu.publishLanguageVersion(user.id, editingContentLanguageCode);
          await ctx.reply(services.i18n.t(resolveAdminUiLanguageCode(user), "langv_published"));
          await renderLangvPagePreview(editingContentLanguageCode, pageId);
          return;
        }
        case "regen_lang_prompt": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const targetLanguageCode = String(value).toLowerCase();
          const label = services.i18n.availableLanguages().find((l) => l.code === targetLanguageCode)?.label ?? targetLanguageCode;

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            {
              text: [
                `🔄 Перегенерировать AI-перевод: ${label}?`,
                ``,
                `Будут обновлены тексты welcome/root и MenuItemLocalization.`,
                `Видео и mediaFileId не меняются.`
              ].join("\n")
            },
            Markup.inlineKeyboard([
              [Markup.button.callback(services.i18n.t(adminLocale, "lang_gen_provider_auto"), makeCallbackData("admin", "regen_lang_start", targetLanguageCode, "auto"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "lang_gen_provider_ollama"), makeCallbackData("admin", "regen_lang_start", targetLanguageCode, "ollama"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "lang_gen_provider_workers_ai"), makeCallbackData("admin", "regen_lang_start", targetLanguageCode, "workers_ai"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "lang_gen_provider_cerebras"), makeCallbackData("admin", "regen_lang_start", targetLanguageCode, "cerebras"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "back"), makeCallbackData("admin", "lang_detail", targetLanguageCode))],
              [Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]
            ])
          );
          return;
        }
        case "regen_lang_start": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const targetLanguageCode = String(value).toLowerCase();
          const providerOverride = ((): string => {
            const raw = extra ? String(extra).toLowerCase() : "auto";
            if (raw === "ollama" || raw === "workers_ai" || raw === "cerebras" || raw === "auto") return raw;
            return "auto";
          })();

          const workersAiMissing =
            providerOverride === "workers_ai" &&
            (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_AI_API_TOKEN || !env.CLOUDFLARE_AI_MODEL);
          const cerebrasMissing = providerOverride === "cerebras" && !env.CEREBRAS_API_KEY;
          const ollamaMissing = providerOverride === "ollama" && !env.OLLAMA_BASE_URL;

          if (workersAiMissing || cerebrasMissing || ollamaMissing) {
            const label = services.i18n.availableLanguages().find((l) => l.code === targetLanguageCode)?.label ?? targetLanguageCode;
            const msg = workersAiMissing
              ? "Для `workers_ai` не заданы обязательные переменные Cloudflare (CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_API_TOKEN, CLOUDFLARE_AI_MODEL)."
              : cerebrasMissing
                ? "Для `cerebras` не задан CEREBRAS_API_KEY."
                : "Для `ollama` не задан OLLAMA_BASE_URL.";
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              {
                text: [
                  "AI-перевод недоступен.",
                  "",
                  msg,
                  "Добавьте переменные в `.env` и перезапустите сервер.",
                  "",
                  `Запрошено: ${label}`
                ].join("\n")
              },
              Markup.inlineKeyboard([
                [Markup.button.callback(services.i18n.t(adminLocale, "back"), makeCallbackData("admin", "lang_detail", targetLanguageCode))],
                [Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]
              ])
            );
            return;
          }
          const sourceLanguageCode = await services.menu.getBaseLanguage(user.id);

          const template = await services.menu.ensureActiveTemplate(user.id);
          const task = await services.languageGenerationTasks.createTask({
            templateId: template,
            startedByUserId: user.id,
            sourceLanguageCode,
            targetLanguageCode
          });

          await services.scheduler.schedule(
            "GENERATE_LANGUAGE_VERSION_AI",
            { taskId: task.id, providerOverride },
            new Date(),
            // Important: include task.id so repeated "regen" creates a fresh bullmq job.
            `langgen:${template}:${sourceLanguageCode}:${targetLanguageCode}:${task.id}`
          );

          const label = services.i18n.availableLanguages().find((l) => l.code === targetLanguageCode)?.label ?? targetLanguageCode;
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            {
              text: [`⏳ Создаём языковую версию: ${label}`, `Прогресс: 0%`, `Этап: root/welcome`, `Переводим структуру бота...`].join("\n")
            },
            Markup.inlineKeyboard([
              [Markup.button.callback("↩️ Назад", makeCallbackData("admin", "lang_detail", targetLanguageCode))],
              [Markup.button.callback("🗂 В главное меню", NAV_ROOT_DATA)]
            ])
          );
          return;
        }
        case "lang_gen_refresh": {
          await ctx.answerCbQuery?.();
          if (!value) return;
          const taskId = String(value);
          const task = await services.languageGenerationTasks.getTask(taskId);
          if (!task) {
            await ctx.reply("Задача не найдена.");
            return;
          }
          const label = services.i18n.availableLanguages().find((l) => l.code === task.targetLanguageCode)?.label ?? task.targetLanguageCode;
          const text = [
            `⏳ Создаём языковую версию: ${label}`,
            `Этап: ${task.status === "DONE" ? "завершение" : "в процессе"}`,
            `Прогресс: ${task.progressPercent}%`,
            `Переведено: ${task.completedItems} из ${task.totalItems || "?"}`
          ] as string[];
          if (task.status === "FAILED") {
            text.push("");
            text.push(`Ошибка: ${(task.errorMessage ?? "").slice(0, 600) || "неизвестная"}`);
          }
          const textFinal = text.join("\n");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: textFinal },
            Markup.inlineKeyboard([
              [Markup.button.callback("↩️ Назад", makeCallbackData("admin", "languages"))],
              [Markup.button.callback("🗂 В главное меню", NAV_ROOT_DATA)]
            ])
          );
          return;
        }
        case "add_lang": {
          const baseLang = await services.menu.getBaseLanguage(user.id);
          const existingLangCodes = await services.menu.getActiveTemplateLanguageCodes();
          const labelFor = (code: string) => services.i18n.availableLanguages().find((l) => l.code === code)?.label ?? code;
          const existingSet = new Set(existingLangCodes.map((c) => String(c).toLowerCase()));
          const availableToAdd = services.i18n
            .availableLanguages()
            .map((l) => l.code)
            .filter((code) => !existingSet.has(String(code).toLowerCase()));
          const baseLabel = labelFor(baseLang);

          const text = [
            `Языки`,
            ``,
            `Основной язык: ${baseLabel}`,
            existingLangCodes.length > 0 ? `Уже добавлены: ${existingLangCodes.map((c) => labelFor(c)).join(", ")}` : `Пока нет добавленных языков`,
            ``,
            availableToAdd.length > 0 ? `Выберите язык для добавления:` : `Новых языков для добавления нет`
          ].join("\n");

          const rows: Array<Array<ReturnType<typeof Markup.button.callback>>> = [];
          for (const c of availableToAdd) {
            rows.push([Markup.button.callback(`➕ ${labelFor(c)}`, makeCallbackData("admin", "add_lang_pick", String(c)))]);
          }

          rows.push([Markup.button.callback(services.i18n.t(adminLocale, "back"), makeCallbackData("admin", "languages"))]);
          rows.push([Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]);

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            Markup.inlineKeyboard(rows)
          );
          return;
        }
        case "add_lang_pick": {
          if (!value) return;
          const targetLanguageCode = String(value).toLowerCase();

          const baseLang = await services.menu.getBaseLanguage(user.id);
          const baseLabel =
            services.i18n.availableLanguages().find((l) => l.code === baseLang)?.label ?? baseLang;

          const targetLabel =
            services.i18n.availableLanguages().find((l) => l.code === targetLanguageCode)?.label ?? targetLanguageCode;

          const text = [
            "Подтверждение создания",
            "",
            `Будет создана новая языковая версия: ${targetLabel}`,
            `Основа: ${baseLabel}.`,
            "",
            "AI автоматически переведёт все тексты и названия кнопок.",
            "Видео и медиа вы сможете поправить вручную позже.",
            ""
          ].join("\n");

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text },
            Markup.inlineKeyboard([
              [Markup.button.callback(services.i18n.t(adminLocale, "lang_gen_provider_auto"), makeCallbackData("admin", "add_lang_confirm", targetLanguageCode, "auto"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "lang_gen_provider_ollama"), makeCallbackData("admin", "add_lang_confirm", targetLanguageCode, "ollama"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "lang_gen_provider_workers_ai"), makeCallbackData("admin", "add_lang_confirm", targetLanguageCode, "workers_ai"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "lang_gen_provider_cerebras"), makeCallbackData("admin", "add_lang_confirm", targetLanguageCode, "cerebras"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "back"), makeCallbackData("admin", "add_lang"))],
              [Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]
            ])
          );

          return;
        }
        case "add_lang_confirm": {
          if (!value) return;
          const targetLanguageCode = String(value).toLowerCase();
          const providerOverride = ((): string => {
            const raw = extra ? String(extra).toLowerCase() : "auto";
            if (raw === "ollama" || raw === "workers_ai" || raw === "cerebras" || raw === "auto") return raw;
            return "auto";
          })();

          const workersAiMissing =
            providerOverride === "workers_ai" &&
            (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_AI_API_TOKEN || !env.CLOUDFLARE_AI_MODEL);
          const cerebrasMissing = providerOverride === "cerebras" && !env.CEREBRAS_API_KEY;
          const ollamaMissing = providerOverride === "ollama" && !env.OLLAMA_BASE_URL;

          if (workersAiMissing || cerebrasMissing || ollamaMissing) {
            const msg = workersAiMissing
              ? "Для `workers_ai` не заданы Cloudflare-переменные."
              : cerebrasMissing
                ? "Для `cerebras` не задан CEREBRAS_API_KEY."
                : "Для `ollama` не задан OLLAMA_BASE_URL.";
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              {
                text: `AI-перевод недоступен. ${msg} Добавьте переменные в .env.`
              },
              Markup.inlineKeyboard([
                [Markup.button.callback(services.i18n.t(adminLocale, "back"), makeCallbackData("admin", "add_lang"))],
                [Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]
              ])
            );
            return;
          }
          const sourceLanguageCode = await services.menu.getBaseLanguage(user.id);

          const existingLangCodes = await services.menu.getActiveTemplateLanguageCodes();
          const alreadyExists = existingLangCodes.includes(targetLanguageCode);

          if (alreadyExists) {
            // Safe UX for stale callbacks / edge-cases: language already exists.
            const label =
              services.i18n.availableLanguages().find((l) => l.code === targetLanguageCode)?.label ?? targetLanguageCode;
            await services.navigation.replaceScreen(
              user,
              ctx.telegram,
              ctx.chat?.id ?? user.telegramUserId,
              { text: `Языковая версия ${label} уже существует.` },
              Markup.inlineKeyboard([
                [Markup.button.callback("🔄 Перегенерировать перевод (AI)", makeCallbackData("admin", "regen_lang_start", targetLanguageCode))],
                [Markup.button.callback("✏️ Редактировать вручную", makeCallbackData("admin", "edit_lang_version", targetLanguageCode))],
                [Markup.button.callback(services.i18n.t(adminLocale, "back"), makeCallbackData("admin", "add_lang"))],
                [Markup.button.callback(services.i18n.t(adminLocale, "to_main_menu"), NAV_ROOT_DATA)]
              ])
            );
            return;
          }

          const template = await services.menu.ensureActiveTemplate(user.id);
          const task = await services.languageGenerationTasks.createTask({
            templateId: template,
            startedByUserId: user.id,
            sourceLanguageCode,
            targetLanguageCode
          });

          await services.scheduler.schedule(
            "GENERATE_LANGUAGE_VERSION_AI",
            { taskId: task.id, providerOverride },
            new Date(),
            `langgen:${template}:${sourceLanguageCode}:${targetLanguageCode}:${task.id}`
          );

          const targetLabel =
            services.i18n.availableLanguages().find((l) => l.code === targetLanguageCode)?.label ?? targetLanguageCode;

          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            {
              text: [
                `⏳ Создаём языковую версию: ${targetLabel}`,
                "Этап: root/welcome",
                "Прогресс: 0%",
                "Переводим структуру бота..."
              ].join("\n")
            },
            Markup.inlineKeyboard([
              [Markup.button.callback("↩️ Назад", makeCallbackData("admin", "languages"))],
              [Markup.button.callback("🗂 В главное меню", NAV_ROOT_DATA)]
            ])
          );
          return;
        }
        default:
          return;
      }
    }

    if (scope === "dripm") {
      if (!isAdminRole(user.role)) {
        await ctx.reply(services.i18n.t(user.selectedLanguage, "permission_denied"));
        return;
      }

      const locale = services.i18n.resolveLanguage(user.selectedLanguage);
      await services.permissions.ensurePermission(user.id, "canSendBroadcasts");

      const renderList = async () => {
        setNavBeforeShow(ctx, "admin:drip_manage");
        const campaigns = await services.drips.listCampaigns(user.id);
        const lines =
          campaigns.length === 0
            ? ["Пока нет созданных цепочек."]
            : campaigns.map((c) => {
                const status = c.isActive ? "✅ Активна" : "⏸ Отключена";
                return `• ${c.title} — шагов: ${c.steps.length} · ${status}`;
              });
        const text = ["📚 Мои цепочки", "", ...lines].join("\n");
        const rows = campaigns.map((c) => [Markup.button.callback(`📬 ${c.title}`, makeCallbackData("dripm", "open", c.id))]);
        rows.push([Markup.button.callback(services.i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))]);
        for (const btn of buildNavigationRow(services.i18n, locale, { toMain: true })) rows.push([btn]);
        await services.navigation.replaceScreen(user, ctx.telegram, ctx.chat?.id ?? user.telegramUserId, { text }, Markup.inlineKeyboard(rows));
      };

      const formatDelay = (v: number, u: string): string => {
        const unitKey = u === "MINUTES" ? "drip_unit_minutes" : u === "HOURS" ? "drip_unit_hours" : "drip_unit_days";
        return `${v} ${services.i18n.t(locale, unitKey as any)}`;
      };

      if (action === "list") {
        await renderList();
        return;
      }

      if (action === "open" && value) {
        const campaign = await services.drips.getCampaign(user.id, value);
        if (!campaign) {
          await ctx.reply("Цепочка не найдена.");
          await renderList();
          return;
        }
        const status = campaign.isActive ? "✅ Активна" : "⏸ Отключена";
        const stepsLines =
          campaign.steps.length === 0
            ? ["(шагов нет)"]
            : campaign.steps.map((s) => {
                const loc = services.i18n.pickLocalized(s.localizations, locale) ?? s.localizations[0];
                const preview = (loc?.text ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
                const d = formatDelay(s.delayValue, String(s.delayUnit));
                return `${s.stepOrder}. через ${d}${preview ? ` — ${preview}${(loc?.text?.length ?? 0) > 60 ? "…" : ""}` : ""}`;
              });
        const text = [`📬 ${campaign.title}`, status, `Триггер: ${campaign.triggerType}`, "", "Шаги:", ...stepsLines].join("\n");

        const rows: ReturnType<typeof Markup.button.callback>[][] = [];
        rows.push([Markup.button.callback("➕ Добавить шаг", makeCallbackData("dripm", "add_step", campaign.id))]);
        rows.push([
          Markup.button.callback(
            campaign.isActive ? "⏸ Отключить цепочку" : "▶️ Включить цепочку",
            makeCallbackData("dripm", "toggle", campaign.id)
          )
        ]);
        rows.push([Markup.button.callback("❌ Удалить цепочку", makeCallbackData("dripm", "delete_confirm", campaign.id))]);
        if (campaign.steps.length > 0) {
          for (const s of campaign.steps) {
            rows.push([
              Markup.button.callback(`🔗 Кнопки`, makeCallbackData("dripm", "step_btns", s.id)),
              Markup.button.callback(`🗑 Удалить шаг ${s.stepOrder}`, makeCallbackData("dripm", "del_step", s.id))
            ]);
          }
        }
        rows.push([Markup.button.callback("↩️ К списку цепочек", makeCallbackData("dripm", "list"))]);
        rows.push([Markup.button.callback(services.i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))]);
        for (const btn of buildNavigationRow(services.i18n, locale, { toMain: true })) rows.push([btn]);

        await services.navigation.replaceScreen(user, ctx.telegram, ctx.chat?.id ?? user.telegramUserId, { text }, Markup.inlineKeyboard(rows));
        return;
      }

      if (action === "add_step" && value) {
        await ctx.scene.enter(ADD_DRIP_STEP_SCENE, { campaignId: value });
        return;
      }

      if (action === "add_buttons" && value) {
        const step = await services.drips.getStepWithCampaign(user.id, value);
        if (!step) {
          await ctx.reply("Шаг не найден.");
          await renderList();
          return;
        }
        await ctx.scene.enter(ADD_DRIP_STEP_BUTTONS_SCENE, {
          stepId: value,
          campaignId: step.campaignId,
          languageCode: services.i18n.resolveLanguage(user.selectedLanguage)
        });
        return;
      }

      if (action === "step_btns" && value) {
        const step = await services.drips.getStepWithCampaign(user.id, value);
        if (!step) {
          await ctx.reply("Шаг не найден.");
          await renderList();
          return;
        }
        await ctx.scene.enter(ADD_DRIP_STEP_BUTTONS_SCENE, {
          stepId: value,
          campaignId: step.campaignId,
          languageCode: services.i18n.resolveLanguage(user.selectedLanguage)
        });
        return;
      }

      if (action === "toggle" && value) {
        const updated = await services.drips.toggleCampaignActive(user.id, value);
        if (updated == null) {
          await ctx.reply("Цепочка не найдена.");
          await renderList();
          return;
        }
        await ctx.reply(updated ? "✅ Цепочка включена." : "⏸ Цепочка отключена.");
        const campaign = await services.drips.getCampaign(user.id, value);
        if (campaign) {
          const text = `📬 ${campaign.title}\n${campaign.isActive ? "✅ Активна" : "⏸ Отключена"}`;
          await ctx.reply(text, Markup.inlineKeyboard([[Markup.button.callback("Открыть", makeCallbackData("dripm", "open", campaign.id))]]));
        }
        return;
      }

      if (action === "delete_confirm" && value) {
        const text = "Удалить цепочку? Это действие нельзя отменить.";
        await services.navigation.replaceScreen(
          user,
          ctx.telegram,
          ctx.chat?.id ?? user.telegramUserId,
          { text },
          Markup.inlineKeyboard([
            [Markup.button.callback("🗑 Да, удалить", makeCallbackData("dripm", "delete", value))],
            [Markup.button.callback("↩️ Назад", makeCallbackData("dripm", "open", value))],
            [Markup.button.callback("↩️ К списку цепочек", makeCallbackData("dripm", "list"))],
            [Markup.button.callback(services.i18n.t(locale, "return_to_admin"), makeCallbackData("admin", "open"))],
            ...buildNavigationRow(services.i18n, locale, { toMain: true }).map((btn) => [btn])
          ])
        );
        return;
      }

      if (action === "delete" && value) {
        const ok = await services.drips.deleteCampaign(user.id, value);
        await ctx.reply(ok ? "🗑 Цепочка удалена." : "Цепочка не найдена.");
        await renderList();
        return;
      }

      if (action === "del_step" && value) {
        const res = await services.drips.deleteStepById(user.id, value);
        await ctx.reply(res.ok ? "🗑 Шаг удалён." : "Не удалось удалить шаг.");
        if (res.ok && res.campaignId) {
          await ctx.reply("Обновляю экран…");
          await services.navigation.replaceScreen(
            user,
            ctx.telegram,
            ctx.chat?.id ?? user.telegramUserId,
            { text: "Открываю цепочку…" },
            Markup.inlineKeyboard([[Markup.button.callback("Открыть", makeCallbackData("dripm", "open", res.campaignId))]])
          );
        } else {
          await renderList();
        }
        return;
      }

      await renderList();
      return;
    }
  });

  bot.hears(/^(menu|меню)$/i, async (ctx) => {
    await sendRootWithWelcome(ctx);
  });

  return bot;
};
