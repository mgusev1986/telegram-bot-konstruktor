import { Markup, Scenes } from "telegraf";

import { makeCallbackData } from "../../common/callback-data";
import { logger } from "../../common/logger";
import { extractFormattedContentText, extractMessageContent, readTextMessage } from "../helpers/message-content";
import type { BotContext } from "../context";
import type { CreateMenuItemDraft } from "../context";
import type { AppServices } from "../../app/services";
import type { DictionaryKey } from "../../modules/i18n/static-dictionaries";
import {
  buildItemTypeSceneKeyboard,
  buildSceneCancelBackKeyboard,
  buildWizardStepKeyboard,
  buildCreateMenuPreviewKeyboard,
  buildReturnToAdminOrPageKeyboard,
  SCENE_CANCEL_DATA
} from "../keyboards";

export const CREATE_MENU_ITEM_SCENE = "create-menu-item-scene";

const CREATE_MENU_PREFIX = "create_menu";

type SceneState = BotContext["wizard"]["state"] & {
  draft?: CreateMenuItemDraft;
  fromPageId?: string;
};

const MENU_TYPES = ["TEXT", "PHOTO", "VIDEO", "DOCUMENT", "LINK", "SUBMENU"] as const;
const ALLOWED_MENU_CONTENT_MEDIA_TYPES = new Set(["PHOTO", "VIDEO", "DOCUMENT"] as const);

function getLocale(ctx: BotContext): string {
  return ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
}

async function getParentTitle(services: AppServices, locale: string, parentId: string | null): Promise<string> {
  if (parentId === null || parentId === "root") {
    return services.i18n.t(locale, "page_root_title");
  }
  const item = await services.menu.findMenuItemById(parentId);
  if (!item) return "—";
  const loc = services.i18n.pickLocalized(item.localizations, locale);
  return loc?.title ?? item.key ?? "—";
}

function getLangLabel(i18n: AppServices["i18n"], code: string): string {
  const list = i18n.availableLanguages();
  return list.find((l) => l.code === code)?.label ?? code;
}

function getTypeLabel(i18n: AppServices["i18n"], locale: string, type: string): string {
  const keys: Record<string, string> = {
    TEXT: "type_text",
    PHOTO: "type_photo",
    VIDEO: "type_video",
    DOCUMENT: "type_document",
    LINK: "type_link",
    SUBMENU: "item_type_section"
  };
  return i18n.t(locale, (keys[type] ?? "type_text") as DictionaryKey);
}

function formatWizardHeader(
  i18n: AppServices["i18n"],
  locale: string,
  draft: CreateMenuItemDraft,
  parentTitle: string,
  stepLabel: string,
  isSection: boolean
): string {
  const title = isSection ? i18n.t(locale, "wizard_creating_section") : i18n.t(locale, "wizard_creating_button");
  const lang = draft.languageCode ? getLangLabel(i18n, draft.languageCode) : "—";
  const type = draft.type ? getTypeLabel(i18n, locale, draft.type) : "—";
  return [
    title,
    `${i18n.t(locale, "wizard_parent")}: ${parentTitle}`,
    `${i18n.t(locale, "wizard_lang")}: ${lang}`,
    `${i18n.t(locale, "wizard_type")}: ${type}`,
    "",
    stepLabel
  ].join("\n");
}

function isValidUrl(s: string): boolean {
  const t = s.trim();
  if (!t.startsWith("http://") && !t.startsWith("https://")) return false;
  try {
    const u = new URL(t);
    return Boolean(u.hostname);
  } catch {
    return false;
  }
}

function handleBack(ctx: BotContext, stepIndex: number): boolean {
  if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
    const data = ctx.callbackQuery.data;
    const parts = data.split(":");
    if (parts[0] === CREATE_MENU_PREFIX && parts[1] === "back" && parts[2] === String(stepIndex)) {
      return true;
    }
  }
  return false;
}

export const createMenuItemScene = new Scenes.WizardScene<any>(
  CREATE_MENU_ITEM_SCENE,
  // Step 0: Set base language and redirect to type (or title for section)
  async (ctx) => {
    const sceneState = ctx.scene.state as { parentId?: string | null; addSection?: boolean; fromPageId?: string };
    const state = ctx.wizard.state as SceneState;
    state.draft = state.draft ?? {};
    state.fromPageId = sceneState.fromPageId ?? (sceneState.parentId != null ? String(sceneState.parentId) : "root");
    const draft = state.draft;
    const locale = getLocale(ctx);
    const i18n = ctx.services.i18n;

    if (ctx.currentUser) {
      draft.languageCode = await ctx.services.menu.getBaseLanguage(ctx.currentUser.id);
    } else {
      draft.languageCode = draft.languageCode ?? "ru";
    }

    if (sceneState.parentId !== undefined) {
      draft.parentId = sceneState.parentId ?? null;
      if (sceneState.addSection) {
        draft.type = "SUBMENU";
      }
      const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
      const isSection = draft.type === "SUBMENU";
      if (draft.type === "SUBMENU") {
        ctx.wizard.selectStep(2);
        const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_title"), true);
        await ctx.reply(
          header,
          buildWizardStepKeyboard(i18n, locale, {
            backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "1"),
            fromPageId: state.fromPageId
          })
        );
        return;
      }
      ctx.wizard.selectStep(1);
      const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_type"), false);
      await ctx.reply(
        header,
        buildItemTypeSceneKeyboard(i18n, locale, CREATE_MENU_PREFIX, makeCallbackData(CREATE_MENU_PREFIX, "back", "0"))
      );
      return;
    }

    draft.parentId = null;
    ctx.wizard.selectStep(1);
    const parentTitle = await getParentTitle(ctx.services, locale, null);
    const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_type"), false);
    await ctx.reply(
      header,
      buildItemTypeSceneKeyboard(i18n, locale, CREATE_MENU_PREFIX, makeCallbackData(CREATE_MENU_PREFIX, "back", "0"))
    );
  },
  // Step 1: Type
  async (ctx, next) => {
    const state = ctx.wizard.state as SceneState;
    const draft = state.draft ?? {};
    const locale = getLocale(ctx);
    const i18n = ctx.services.i18n;

    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      if (data === SCENE_CANCEL_DATA) {
        // Отдаём отмену в общий обработчик, чтобы он вывел стандартный экран отмены.
        return next();
      }
      const parts = data.split(":");
      if (parts[0] === CREATE_MENU_PREFIX && parts[1] === "type" && MENU_TYPES.includes(parts[2] as (typeof MENU_TYPES)[number])) {
        await ctx.answerCbQuery();
        draft.type = parts[2] as (typeof MENU_TYPES)[number];
        const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
        const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_title"), draft.type === "SUBMENU");
        await ctx.reply(
          header,
          buildWizardStepKeyboard(i18n, locale, {
            backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "0"),
            fromPageId: state.fromPageId
          })
        );
        return ctx.wizard.next();
      }
    }

    if (handleBack(ctx, 0)) {
      await ctx.answerCbQuery();
      const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
      const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_type"), false);
      await ctx.reply(
        header,
        buildItemTypeSceneKeyboard(i18n, locale, CREATE_MENU_PREFIX, makeCallbackData(CREATE_MENU_PREFIX, "back", "0"))
      );
      return;
    }

    const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
    const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_type"), false);
    await ctx.reply(
      header,
      buildItemTypeSceneKeyboard(i18n, locale, CREATE_MENU_PREFIX, makeCallbackData(CREATE_MENU_PREFIX, "back", "0"))
    );
    return;
  },
  // Step 2: Title
  async (ctx) => {
    const state = ctx.wizard.state as SceneState;
    const draft = state.draft ?? {};
    const locale = getLocale(ctx);
    const i18n = ctx.services.i18n;

    if (handleBack(ctx, 1)) {
      await ctx.answerCbQuery();
      const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
      const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_type"), draft.type === "SUBMENU");
      await ctx.reply(
        header,
        buildItemTypeSceneKeyboard(i18n, locale, CREATE_MENU_PREFIX, makeCallbackData(CREATE_MENU_PREFIX, "back", "0"))
      );
      return ctx.wizard.selectStep(1);
    }

    const text = readTextMessage(ctx).trim();
    if (!text) {
      const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
      const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_title"), draft.type === "SUBMENU");
      await ctx.reply(
        header + "\n\nЗаголовок не может быть пустым. Введите название.",
        buildWizardStepKeyboard(i18n, locale, {
          backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "1"),
          fromPageId: state.fromPageId
        })
      );
      return;
    }
    draft.title = text;

    const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
    const contentPrompt =
      draft.type === "LINK"
        ? "Введите URL ссылки (например https://example.com). Можно добавить описание через | : URL | Описание"
        : draft.type === "SUBMENU"
          ? "Введите текст или медиа для экрана раздела (или нажмите Пропустить)."
          : "Отправьте текст или медиа (фото, видео, документ) с подписью для контента (или Пропустить).";
    const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_content"), draft.type === "SUBMENU");
    await ctx.reply(
      header + "\n\n" + contentPrompt,
      buildWizardStepKeyboard(i18n, locale, {
        backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "2"),
        skip: true,
        fromPageId: state.fromPageId
      })
    );
    return ctx.wizard.next();
  },
  // Step 3: Content
  async (ctx, next) => {
    const state = ctx.wizard.state as SceneState;
    const draft = state.draft ?? {};
    const locale = getLocale(ctx);
    const i18n = ctx.services.i18n;

    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      if (data === SCENE_CANCEL_DATA) {
        return next();
      }
      if (data === makeCallbackData(CREATE_MENU_PREFIX, "skip", "content")) {
        await ctx.answerCbQuery();
        draft.contentText = "";
        draft.mediaType = undefined;
        draft.mediaFileId = undefined;
        draft.externalUrl = undefined;
        const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
        const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_preview"), draft.type === "SUBMENU");
        const summary = [
          `${i18n.t(locale, "wizard_lang")}: ${getLangLabel(i18n, draft.languageCode ?? "ru")}`,
          `${i18n.t(locale, "wizard_type")}: ${getTypeLabel(i18n, locale, draft.type ?? "TEXT")}`,
          `${i18n.t(locale, "wizard_title")}: ${draft.title ?? ""}`,
          `${i18n.t(locale, "wizard_content")}: ${draft.contentText ? draft.contentText.slice(0, 80) + (draft.contentText.length > 80 ? "…" : "") : draft.externalUrl ?? "—"}`
        ].join("\n");
        await ctx.reply(header + "\n\n" + summary, buildCreateMenuPreviewKeyboard(i18n, locale, state.fromPageId));
        return ctx.wizard.next();
      }
    }

    if (handleBack(ctx, 2)) {
      await ctx.answerCbQuery();
      const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
      const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_title"), draft.type === "SUBMENU");
      await ctx.reply(
        header,
        buildWizardStepKeyboard(i18n, locale, {
          backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "1"),
          fromPageId: state.fromPageId
        })
      );
      return ctx.wizard.selectStep(2);
    }

    const content = extractMessageContent(ctx);

    if (draft.type === "LINK") {
      const raw = readTextMessage(ctx).trim();
      const sep = raw.indexOf("|");
      const urlPart = sep < 0 ? raw : raw.slice(0, sep).trim();
      const descPart = sep < 0 ? "" : raw.slice(sep + 1).trim();
      if (!urlPart) {
        const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
        const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_content"), false);
        await ctx.reply(
          header + "\n\nВведите корректный URL (начинается с http:// или https://).",
          buildWizardStepKeyboard(i18n, locale, {
            backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "2"),
            skip: true,
            fromPageId: state.fromPageId
          })
        );
        return;
      }
      if (!isValidUrl(urlPart)) {
        const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
        const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_content"), false);
        await ctx.reply(
          header + "\n\nНекорректный URL. Введите ссылку вида https://example.com",
          buildWizardStepKeyboard(i18n, locale, {
            backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "2"),
            skip: true,
            fromPageId: state.fromPageId
          })
        );
        return;
      }
      draft.externalUrl = urlPart;
      draft.contentText = descPart || "";
      draft.mediaType = "LINK";
    } else {
      if (!content.text && !content.mediaFileId) {
        const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
        const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_content"), draft.type === "SUBMENU");
        await ctx.reply(
          header + "\n\nОтправьте текст или медиа (фото, видео, документ) или нажмите Пропустить.",
          buildWizardStepKeyboard(i18n, locale, {
            backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "2"),
            skip: true,
            fromPageId: state.fromPageId
          })
        );
        return;
      }
      if (content.mediaType && !ALLOWED_MENU_CONTENT_MEDIA_TYPES.has(content.mediaType as any)) {
        const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
        const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_content"), draft.type === "SUBMENU");
        await ctx.reply(
          header + "\n\nПоддерживаются только текст, фото, видео и документ.",
          buildWizardStepKeyboard(i18n, locale, {
            backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "2"),
            skip: true,
            fromPageId: state.fromPageId
          })
        );
        return;
      }
      draft.contentText = extractFormattedContentText(content);
      draft.mediaType = content.mediaType;
      draft.mediaFileId = content.mediaFileId ?? undefined;
      draft.externalUrl = content.externalUrl ?? undefined;
    }

    const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
    const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_preview"), draft.type === "SUBMENU");
    const contentPreview = draft.externalUrl
      ? draft.externalUrl + (draft.contentText ? " | " + draft.contentText.slice(0, 60) + (draft.contentText.length > 60 ? "…" : "") : "")
      : draft.contentText
        ? draft.contentText.slice(0, 80) + (draft.contentText.length > 80 ? "…" : "")
        : draft.mediaFileId
          ? "[медиа]"
          : "—";
    const summary = [
      `${i18n.t(locale, "wizard_lang")}: ${getLangLabel(i18n, draft.languageCode ?? "ru")}`,
      `${i18n.t(locale, "wizard_type")}: ${getTypeLabel(i18n, locale, draft.type ?? "TEXT")}`,
      `${i18n.t(locale, "wizard_title")}: ${draft.title ?? ""}`,
      `${i18n.t(locale, "wizard_content")}: ${contentPreview}`
    ].join("\n");
    await ctx.reply(header + "\n\n" + summary, buildCreateMenuPreviewKeyboard(i18n, locale, state.fromPageId));
    return ctx.wizard.next();
  },
  // Step 4: Preview
  async (ctx, next) => {
    const state = ctx.wizard.state as SceneState;
    const draft = state.draft ?? {};
    const locale = getLocale(ctx);
    const i18n = ctx.services.i18n;

    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const data = ctx.callbackQuery.data;
      if (data === SCENE_CANCEL_DATA) {
        return next();
      }
      const parts = data.split(":");
      if (parts[0] === CREATE_MENU_PREFIX && parts[1] === "preview" && parts[2]) {
        await ctx.answerCbQuery();
        const action = parts[2];
        if (action === "edit_title") {
          const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
          const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_title"), draft.type === "SUBMENU");
          await ctx.reply(
            header,
            buildWizardStepKeyboard(i18n, locale, {
              backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "1"),
              fromPageId: state.fromPageId
            })
          );
          return ctx.wizard.selectStep(2);
        }
        if (action === "edit_type") {
          const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
          const header = formatWizardHeader(i18n, locale, { ...draft, type: undefined }, parentTitle, i18n.t(locale, "wizard_step_type"), false);
          await ctx.reply(
            header,
            buildItemTypeSceneKeyboard(i18n, locale, CREATE_MENU_PREFIX, makeCallbackData(CREATE_MENU_PREFIX, "back", "3"))
          );
          return ctx.wizard.selectStep(1);
        }
        if (action === "edit_content") {
          const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
          const contentPrompt =
            draft.type === "LINK"
              ? "Введите URL ссылки (можно добавить описание через | )."
              : "Отправьте текст или медиа или нажмите Пропустить.";
          const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_content"), draft.type === "SUBMENU");
          await ctx.reply(
            header + "\n\n" + contentPrompt,
            buildWizardStepKeyboard(i18n, locale, {
              backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "2"),
              skip: true,
              fromPageId: state.fromPageId
            })
          );
          return ctx.wizard.selectStep(3);
        }
        if (action === "save") {
          try {
            const menuItem = await ctx.services.menu.createMenuItem({
              actorUserId: ctx.currentUser!.id,
              languageCode: draft.languageCode ?? "ru",
              parentId: draft.parentId ?? null,
              title: draft.title ?? "Menu item",
              type: draft.type ?? "TEXT",
              contentText: draft.contentText ?? "",
              mediaType: draft.mediaType,
              mediaFileId: draft.mediaFileId,
              externalUrl: draft.externalUrl
            });
            const fromPageId = state.fromPageId ?? "root";
            await ctx.reply(i18n.t(locale, "item_created_short"), buildReturnToAdminOrPageKeyboard(fromPageId, i18n, locale));
          } catch (err) {
            logger.error({ err }, "createMenuItem failed");
            await ctx.reply(i18n.t(locale, "error_save_step"), buildCreateMenuPreviewKeyboard(i18n, locale, state.fromPageId));
            return;
          }
          state.draft = undefined;
          return ctx.scene.leave();
        }
      }
    }

    if (handleBack(ctx, 3)) {
      await ctx.answerCbQuery();
      const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
      const contentPrompt =
        draft.type === "LINK"
          ? "Введите URL ссылки."
          : "Отправьте текст или медиа или нажмите Пропустить.";
      const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_content"), draft.type === "SUBMENU");
      await ctx.reply(
        header + "\n\n" + contentPrompt,
        buildWizardStepKeyboard(i18n, locale, {
          backData: makeCallbackData(CREATE_MENU_PREFIX, "back", "2"),
          skip: true,
          fromPageId: state.fromPageId
        })
      );
      return ctx.wizard.selectStep(3);
    }

    const parentTitle = await getParentTitle(ctx.services, locale, draft.parentId ?? null);
    const header = formatWizardHeader(i18n, locale, draft, parentTitle, i18n.t(locale, "wizard_step_preview"), draft.type === "SUBMENU");
    const contentPreview = draft.externalUrl
      ? draft.externalUrl + (draft.contentText ? " | " + draft.contentText.slice(0, 60) : "")
      : draft.contentText?.slice(0, 80) ?? (draft.mediaFileId ? "[медиа]" : "—");
    const summary = [
      `${i18n.t(locale, "wizard_lang")}: ${getLangLabel(i18n, draft.languageCode ?? "ru")}`,
      `${i18n.t(locale, "wizard_type")}: ${getTypeLabel(i18n, locale, draft.type ?? "TEXT")}`,
      `${i18n.t(locale, "wizard_title")}: ${draft.title ?? ""}`,
      `${i18n.t(locale, "wizard_content")}: ${contentPreview}`
    ].join("\n");
    await ctx.reply(header + "\n\n" + summary, buildCreateMenuPreviewKeyboard(i18n, locale, state.fromPageId));
    return;
  }
);
