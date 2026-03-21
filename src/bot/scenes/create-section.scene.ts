import { Markup, Scenes } from "telegraf";

import { makeCallbackData } from "../../common/callback-data";
import { logger } from "../../common/logger";
import { extractFormattedContentText, extractMessageContent, readTextMessage } from "../helpers/message-content";
import type { BotContext } from "../context";
import { renderScreen } from "../helpers/screen-template";
import {
  buildSceneCancelBackKeyboard,
  buildReturnToAdminOrPageKeyboard,
  buildNavigationRow,
  buildOnboardingChoiceAfterSectionKeyboard,
  SCENE_CANCEL_DATA
} from "../keyboards";

export const CREATE_SECTION_SCENE = "create-section-scene";

const PREFIX = "create_sec";

type SceneState = BotContext["wizard"]["state"] & {
  parentId?: string | null;
  fromPageId?: string;
  fromOnboardingStep?: number;
  languageCode?: string;
  uiLanguageCode?: string;
  title?: string;
};

function getLocale(ctx: BotContext, state?: SceneState): string {
  return ctx.services.i18n.resolveLanguage(state?.uiLanguageCode ?? ctx.currentUser?.selectedLanguage);
}

async function resolveActorUserId(ctx: BotContext): Promise<string | null> {
  if (ctx.currentUser?.id) return ctx.currentUser.id;
  // Fallback: sometimes `currentUser` isn't bound for the wizard ctx,
  // but `ctx.from.id` is always present for Telegram updates.
  if (ctx.from?.id != null) {
    const u = await ctx.services.users.findByTelegramId(BigInt(ctx.from.id));
    return u?.id ?? null;
  }
  return null;
}

async function getParentPageTitle(
  ctx: BotContext,
  parentId: string | null,
  contentLanguageCode: string,
  uiLocale: string
): Promise<string> {
  if (parentId == null || parentId === "root") {
    return ctx.services.i18n.t(uiLocale, "page_root_title");
  }
  const item = await ctx.services.menu.findMenuItemById(parentId);
  if (!item) return parentId;
  const loc = ctx.services.i18n.pickLocalized(item.localizations, contentLanguageCode);
  return loc?.title ?? item.key ?? parentId;
}

async function buildSectionTitleIntro(ctx: BotContext, state: SceneState, locale: string): Promise<string> {
  const contentLanguageCode = ctx.services.i18n.normalizeLocalizationLanguageCode(state.languageCode ?? "ru");
  const parentTitle = await getParentPageTitle(ctx, state.parentId ?? null, contentLanguageCode, locale);
  const locationHint =
    state.parentId == null || state.parentId === "root"
      ? ctx.services.i18n.t(locale, "section_hint_on_root")
      : ctx.services.i18n.t(locale, "section_hint_inside_page").replace("{{title}}", parentTitle);
  if (state.fromOnboardingStep === 2) {
    const stepLabel = ctx.services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", "2");
    return renderScreen({
      header: stepLabel,
      explain: [ctx.services.i18n.t(locale, "onboarding_step2_intro"), locationHint],
      action: ctx.services.i18n.t(locale, "section_enter_button_title")
    });
  }
  if (state.fromOnboardingStep === 3) {
    const stepLabel = ctx.services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", "3");
    return renderScreen({
      header: stepLabel,
      explain: [ctx.services.i18n.t(locale, "onboarding_optional_second_section_intro"), locationHint],
      action: ctx.services.i18n.t(locale, "section_enter_button_title")
    });
  }
  const langLabel =
    ctx.services.i18n.availableLanguages().find((l) => l.code === (state.languageCode ?? "ru"))?.label ?? state.languageCode ?? "Русский";
  return renderScreen({
    header: "➕ " + ctx.services.i18n.t(locale, "wizard_creating_section"),
    explain: [
      ctx.services.i18n.t(locale, "section_intro_one_line"),
      locationHint,
      ctx.services.i18n.t(locale, "base_language_note").replace("{{lang}}", langLabel)
    ],
    action: ctx.services.i18n.t(locale, "section_enter_button_title")
  });
}

function inferContentType(
  content: { mediaType?: string; text?: string }
): "TEXT" | "PHOTO" | "VIDEO" | "DOCUMENT" {
  if (content.mediaType === "PHOTO") return "PHOTO";
  if (content.mediaType === "VIDEO") return "VIDEO";
  if (content.mediaType === "DOCUMENT") return "DOCUMENT";
  return "TEXT";
}

function getSectionCreatedTypeKey(
  type: "TEXT" | "PHOTO" | "VIDEO" | "DOCUMENT",
  content: { text?: string }
): import("../../modules/i18n/static-dictionaries").DictionaryKey {
  if (type === "TEXT") return "section_created_type_text";
  if (type === "PHOTO") return "section_created_type_photo";
  if (type === "VIDEO") return "section_created_type_video";
  if (type === "DOCUMENT") return content.text ? "section_created_type_document" : "section_created_type_document_only";
  return "section_created_type_text";
}

function getIncomingMessageType(ctx: BotContext): string {
  if (!ctx.message) return "none";
  if ("text" in ctx.message) return "text";
  if ("photo" in ctx.message) return "photo";
  if ("video" in ctx.message) return "video";
  if ("document" in ctx.message) return "document";
  if ("voice" in ctx.message) return "voice";
  if ("video_note" in ctx.message) return "video_note";
  return "unknown";
}

const TITLE_MAX_LENGTH = 64;
const SECTION_FORMATS = ["текст", "фото с подписью", "видео с подписью", "документ с подписью", "или только документ"];

export const createSectionScene = new Scenes.WizardScene<any>(
  CREATE_SECTION_SCENE,
  async (ctx) => {
    const sceneState = ctx.scene.state as {
      parentId?: string | null;
      fromPageId?: string;
      fromOnboardingStep?: number;
      languageCode?: string;
      uiLanguageCode?: string;
    };
    const state = ctx.wizard.state as SceneState;
    state.parentId = sceneState.parentId ?? null;
    state.fromPageId = sceneState.fromPageId ?? (sceneState.parentId != null ? String(sceneState.parentId) : "root");
    state.fromOnboardingStep = sceneState.fromOnboardingStep;
    state.uiLanguageCode = sceneState.uiLanguageCode ?? state.uiLanguageCode;
    if (sceneState.languageCode) {
      state.languageCode = ctx.services.i18n.normalizeLocalizationLanguageCode(sceneState.languageCode);
    } else if (ctx.currentUser && state.languageCode == null) {
      state.languageCode = await ctx.services.menu.getBaseLanguage(ctx.currentUser.id);
    }
    const locale = getLocale(ctx, state);
    if (state.fromOnboardingStep === 2 || state.fromOnboardingStep === 3) {
      logger.info({ userId: ctx.currentUser?.id }, "Onboarding: entered section creation (step 2 or optional step 3)");
    }

    const showTitlePrompt = async () => {
      const intro = await buildSectionTitleIntro(ctx, state, locale);
      return ctx.replyWithHTML(intro, buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "0")));
    };

    if (ctx.callbackQuery && "data" in ctx.callbackQuery && ctx.callbackQuery.data === makeCallbackData(PREFIX, "back", "0")) {
      await ctx.answerCbQuery();
      logger.info({ userId: ctx.currentUser?.id }, "Create section: entered sub-step 2.1 (title input) from back");
      await showTitlePrompt();
      return;
    }

    const rawTitle = readTextMessage(ctx).trim();
    if (ctx.message && "text" in ctx.message) {
      logger.info({ userId: ctx.currentUser?.id, titleLength: rawTitle.length }, "Create section: title text received");
      if (!rawTitle) {
        await ctx.reply(
          ctx.services.i18n.t(locale, "error_empty_title"),
          buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "0"))
        );
        return;
      }
      if (rawTitle.startsWith("/")) {
        await ctx.reply(
          ctx.services.i18n.t(locale, "error_title_cannot_start_with_slash"),
          buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "0"))
        );
        return;
      }
      if (rawTitle.length > TITLE_MAX_LENGTH) {
        await ctx.reply(
          ctx.services.i18n.t(locale, "error_title_too_long"),
          buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "0"))
        );
        return;
      }
      state.title = rawTitle;
      logger.info({ userId: ctx.currentUser?.id, title: state.title }, "Create section: title validation passed, title saved, moving to sub-step 2.2");
      const header =
        state.fromOnboardingStep === 2
          ? ctx.services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", "2")
          : state.fromOnboardingStep === 3
            ? ctx.services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", "3")
            : "➕ " + ctx.services.i18n.t(locale, "wizard_creating_section");
      const titleSavedMsg = ctx.services.i18n.t(locale, "section_title_saved").replace("{{title}}", state.title);
      const contentIntro = renderScreen({
        header,
        explain: [titleSavedMsg],
        action: ctx.services.i18n.t(locale, "section_send_content_one_message"),
        formats: SECTION_FORMATS,
        hint: ctx.services.i18n.t(locale, "personalization_hint")
      });
      await ctx.replyWithHTML(
        contentIntro,
        (state.fromOnboardingStep === 2 || state.fromOnboardingStep === 3)
          ? Markup.inlineKeyboard([
              [
                Markup.button.callback(ctx.services.i18n.t(locale, "back"), makeCallbackData(PREFIX, "back", "1")),
                Markup.button.callback(ctx.services.i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)
              ],
              buildNavigationRow(ctx.services.i18n, locale, { toMain: true })
            ])
          : buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "1"))
      );
      return ctx.wizard.next();
    }

    if (!state.title) {
      logger.info({ userId: ctx.currentUser?.id }, "Create section: entered sub-step 2.1 (title input), showing title prompt");
      await showTitlePrompt();
      return;
    }

    logger.info({ userId: ctx.currentUser?.id }, "Create section scene: showing title prompt (no text message)");
    await showTitlePrompt();
    return;
  },
  async (ctx) => {
    const state = ctx.wizard.state as SceneState;
    const locale = getLocale(ctx, state);
    const contentStepKb = () =>
      (state.fromOnboardingStep === 2 || state.fromOnboardingStep === 3)
        ? Markup.inlineKeyboard([
            [
              Markup.button.callback(ctx.services.i18n.t(locale, "back"), makeCallbackData(PREFIX, "back", "1")),
              Markup.button.callback(ctx.services.i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)
            ],
            buildNavigationRow(ctx.services.i18n, locale, { toMain: true })
          ])
        : buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "1"));

    if (ctx.callbackQuery && "data" in ctx.callbackQuery && ctx.callbackQuery.data === makeCallbackData(PREFIX, "back", "1")) {
      await ctx.answerCbQuery();
      logger.info({ userId: ctx.currentUser?.id }, "Create section: back from content to title (sub-step 2.1)");
      const intro = await buildSectionTitleIntro(ctx, state, locale);
      const kb = buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "0"));
      // При нажатии «Назад» обновляем экран на месте, чтобы не дублировать сообщения.
      if (ctx.callbackQuery.message && "message_id" in ctx.callbackQuery.message) {
        try {
          await ctx.editMessageText(intro, { parse_mode: "HTML", ...(kb as any) });
        } catch {
          await ctx.replyWithHTML(intro, kb);
        }
      } else {
        await ctx.replyWithHTML(intro, kb);
      }
      return ctx.wizard.selectStep(0);
    }

    const msgType = getIncomingMessageType(ctx);
    logger.info(
      { userId: ctx.currentUser?.id, subStep: "2.2", titleSaved: state.title, incomingMessageType: msgType },
      "Create section: section creation flow entered (content sub-step)"
    );

    const content = extractMessageContent(ctx);
    const hasContent = Boolean(content.text || content.mediaFileId);
    const normalizedPayload = {
      hasText: Boolean(content.text),
      textLength: (content.text ?? "").length,
      mediaType: content.mediaType ?? null,
      hasMediaFileId: Boolean(content.mediaFileId)
    };
    logger.info({ userId: ctx.currentUser?.id, normalizedPayload }, "Create section: normalized media payload");

    if (!hasContent) {
      return;
    }

    const unsupportedMedia = content.mediaType === "VOICE" || content.mediaType === "VIDEO_NOTE";
    const type = inferContentType(content);
    if (unsupportedMedia || (type !== "TEXT" && type !== "PHOTO" && type !== "VIDEO" && type !== "DOCUMENT")) {
      logger.info(
        { userId: ctx.currentUser?.id, mediaType: content.mediaType, detectedType: type },
        "Create section: content type not supported for section, validation path"
      );
      await ctx.reply(ctx.services.i18n.t(locale, "error_section_content_not_recognized"), contentStepKb());
      return;
    }

    logger.info(
      { userId: ctx.currentUser?.id, type, title: state.title },
      "Create section: DB save attempt started (section + linked button)"
    );
    try {
      const actorUserId = await resolveActorUserId(ctx);
      if (!actorUserId) {
        logger.error(
          { userId: ctx.currentUser?.id, fromId: ctx.from?.id, title: state.title, type },
          "Create section: cannot resolve actorUserId, staying on content step"
        );
        await ctx.reply(ctx.services.i18n.t(locale, "error_save_step"), contentStepKb());
        return;
      }
      const contentTextForStorage = extractFormattedContentText(content);
      const created = await ctx.services.menu.createMenuItem({
        actorUserId,
        languageCode: state.languageCode ?? "ru",
        parentId: state.parentId ?? null,
        title: state.title ?? "Раздел",
        type,
        contentText: contentTextForStorage,
        mediaType: content.mediaType ?? undefined,
        mediaFileId: content.mediaFileId ?? undefined,
        externalUrl: content.externalUrl ?? undefined
      });
      logger.info(
        { userId: ctx.currentUser?.id, menuItemId: created.id, type },
        "Create section: DB save success, button created (same item on parent)"
      );
      const fromPageId = state.fromPageId ?? "root";
      const typeLabel = ctx.services.i18n.t(locale, getSectionCreatedTypeKey(type, content));
      const successBase = ctx.services.i18n.t(locale, "section_created_button_added").replace("{{title}}", state.title ?? "");
      const successText = `${successBase}\n\n${typeLabel}`;
      if (state.fromOnboardingStep === 2) {
        await ctx.services.users.setOnboardingStep(actorUserId, 3);
        const refreshed = await ctx.services.users.findById(actorUserId);
        if (refreshed) ctx.currentUser = refreshed;
        logger.info({ userId: refreshed?.id ?? ctx.currentUser?.id }, "Create section: first section created, showing choice (add another / preview)");
        await ctx.reply(
          ctx.services.i18n.t(locale, "onboarding_step2_success") + "\n" + typeLabel + "\n\n" + ctx.services.i18n.t(locale, "onboarding_choice_after_section"),
          buildOnboardingChoiceAfterSectionKeyboard(locale, ctx.services.i18n)
        );
      } else if (state.fromOnboardingStep === 3) {
        await ctx.services.users.setOnboardingStep(actorUserId, 3);
        const refreshed = await ctx.services.users.findById(actorUserId);
        if (refreshed) ctx.currentUser = refreshed;
        logger.info({ userId: refreshed?.id ?? ctx.currentUser?.id }, "Create section: optional section created, showing choice (add another / main menu)");
        await ctx.reply(
          ctx.services.i18n.t(locale, "onboarding_step2_success") + "\n" + typeLabel + "\n\n" + ctx.services.i18n.t(locale, "onboarding_choice_after_section"),
          buildOnboardingChoiceAfterSectionKeyboard(locale, ctx.services.i18n)
        );
      } else {
        await ctx.reply(successText, buildReturnToAdminOrPageKeyboard(fromPageId, ctx.services.i18n, locale));
      }
      logger.info({ userId: ctx.currentUser?.id, fromOnboardingStep: state.fromOnboardingStep }, "Create section: section created successfully");
    } catch (err) {
      const errObj = err as Error & { code?: string; meta?: unknown };
      const errMessage = errObj?.message ?? String(err);
      const errStack = errObj?.stack;
      logger.error(
        {
          userId: ctx.currentUser?.id,
          err,
          name: errObj?.name,
          message: errMessage,
          code: errObj?.code,
          meta: errObj?.meta,
          stack: errStack
        },
        "Create section: step 2 save failed (real exception)"
      );
      const saveErrorText = ctx.services.i18n.t(locale, "error_save_step");
      const devHint =
        process.env.NODE_ENV === "development" && errMessage
          ? `\n\n[DEV] ${errMessage}`
          : "";
      await ctx.reply(saveErrorText + devHint, contentStepKb());
      return;
    }
    return ctx.scene.leave();
  },
  async (ctx) => {
    const state = ctx.wizard.state as SceneState;
    const locale = getLocale(ctx, state);

    if (ctx.callbackQuery && "data" in ctx.callbackQuery && ctx.callbackQuery.data === makeCallbackData(PREFIX, "back", "1")) {
      await ctx.answerCbQuery();
      const contentIntro = ctx.services.i18n.t(locale, "section_content_intro") + "\n\n" + ctx.services.i18n.t(locale, "personalization_hint") + "\n\n" + ctx.services.i18n.t(locale, "content_formatting_hint");
      await ctx.reply(
        contentIntro,
        (state.fromOnboardingStep === 2 || state.fromOnboardingStep === 3)
          ? Markup.inlineKeyboard([
              [
                Markup.button.callback(ctx.services.i18n.t(locale, "back"), makeCallbackData(PREFIX, "back", "1")),
                Markup.button.callback(ctx.services.i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)
              ],
              buildNavigationRow(ctx.services.i18n, locale, { toMain: true })
            ])
          : buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "1"))
      );
      return ctx.wizard.selectStep(1);
    }

    const content = extractMessageContent(ctx);
    const hasContent = Boolean(content.text || content.mediaFileId);
    if (!hasContent) {
      logger.info({ userId: ctx.currentUser?.id }, "Onboarding step 2 validation failed: no content");
      await ctx.reply(
        ctx.services.i18n.t(locale, "section_content_intro"),
        buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "1"))
      );
      return;
    }

    const unsupportedMedia = content.mediaType === "VOICE" || content.mediaType === "VIDEO_NOTE";
    const type = inferContentType(content);
    if (unsupportedMedia || (type !== "TEXT" && type !== "PHOTO" && type !== "VIDEO" && type !== "DOCUMENT")) {
      logger.info({ userId: ctx.currentUser?.id, mediaType: content.mediaType }, "Create section (step 2 fallback): content type not supported");
      await ctx.reply(
        ctx.services.i18n.t(locale, "error_section_content_not_recognized"),
        buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "1"))
      );
      return;
    }
    try {
      logger.info({ userId: ctx.currentUser?.id, type }, "Create section (fallback): DB save attempt started");
      const actorUserId = await resolveActorUserId(ctx);
      if (!actorUserId) {
        logger.error(
          { userId: ctx.currentUser?.id, fromId: ctx.from?.id, title: state.title, type },
          "Create section (fallback): cannot resolve actorUserId, staying on content step"
        );
        await ctx.reply(ctx.services.i18n.t(locale, "error_save_step"), buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "1")));
        return;
      }
      const contentTextForStorage = extractFormattedContentText(content);
      await ctx.services.menu.createMenuItem({
        actorUserId,
        languageCode: state.languageCode ?? "ru",
        parentId: state.parentId ?? null,
        title: state.title ?? "Раздел",
        type,
        contentText: contentTextForStorage,
        mediaType: content.mediaType ?? undefined,
        mediaFileId: content.mediaFileId ?? undefined,
        externalUrl: content.externalUrl ?? undefined
      });
      const fromPageId = state.fromPageId ?? "root";
      if (state.fromOnboardingStep === 2) {
        await ctx.services.users.setOnboardingStep(actorUserId, 3);
        const refreshed = await ctx.services.users.findById(actorUserId);
        if (refreshed) ctx.currentUser = refreshed;
        logger.info({ userId: ctx.currentUser?.id }, "Onboarding first section created (fallback), showing choice");
        await ctx.reply(
          ctx.services.i18n.t(locale, "onboarding_step2_success") + "\n\n" + ctx.services.i18n.t(locale, "onboarding_choice_after_section"),
          buildOnboardingChoiceAfterSectionKeyboard(locale, ctx.services.i18n)
        );
      } else if (state.fromOnboardingStep === 3) {
        await ctx.services.users.setOnboardingStep(actorUserId, 3);
        const refreshed = await ctx.services.users.findById(actorUserId);
        if (refreshed) ctx.currentUser = refreshed;
        logger.info({ userId: ctx.currentUser?.id }, "Onboarding optional section created (fallback), showing choice");
        await ctx.reply(
          ctx.services.i18n.t(locale, "onboarding_step2_success") + "\n\n" + ctx.services.i18n.t(locale, "onboarding_choice_after_section"),
          buildOnboardingChoiceAfterSectionKeyboard(locale, ctx.services.i18n)
        );
      } else {
        const successText = ctx.services.i18n
          .t(locale, "section_created_button_added")
          .replace("{{title}}", state.title ?? "");
        await ctx.reply(successText, buildReturnToAdminOrPageKeyboard(fromPageId, ctx.services.i18n, locale));
      }
      logger.info({ userId: ctx.currentUser?.id, fromOnboardingStep: state.fromOnboardingStep }, "Section created successfully");
    } catch (err) {
      const errObj = err as Error & { code?: string; meta?: unknown };
      const errMessage = errObj?.message ?? String(err);
      logger.error(
        {
          userId: ctx.currentUser?.id,
          err,
          name: errObj?.name,
          message: errMessage,
          code: errObj?.code,
          meta: errObj?.meta,
          stack: errObj?.stack
        },
        "Create section (fallback): step 2 save failed"
      );
      const saveErrorText = ctx.services.i18n.t(locale, "error_save_step");
      const devHint =
        process.env.NODE_ENV === "development" && errMessage
          ? `\n\n[DEV] ${errMessage}`
          : "";
      await ctx.reply(
        saveErrorText + devHint,
        buildSceneCancelBackKeyboard(ctx.services.i18n, locale, makeCallbackData(PREFIX, "back", "1"))
      );
      return;
    }
    return ctx.scene.leave();
  }
);
