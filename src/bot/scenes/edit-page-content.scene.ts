import { Scenes } from "telegraf";
import { Markup } from "telegraf";

import { ForbiddenError } from "../../common/errors";
import { makeCallbackData } from "../../common/callback-data";
import { extractFormattedContentText, extractMessageContent } from "../helpers/message-content";
import type { BotContext } from "../context";
import { buildCancelKeyboard, buildReturnToAdminOrPageKeyboard } from "../keyboards";
import { renderScreen } from "../helpers/screen-template";

export const EDIT_PAGE_CONTENT_SCENE = "edit-page-content-scene";

interface EditPageContentState {
  menuItemId?: string;
  isRoot?: boolean;
  languageCode?: string;
  uiLanguageCode?: string;
  updateMode?: "full" | "text_only" | "photo_only" | "video_only" | "document_only";
  returnPageId?: string;
  returnScope?: "page_edit" | "langv";
}

interface LangvPendingDraftPatch {
  pageId: string;
  isRoot: boolean;
  languageCode: string;
  updateMode: "full" | "text_only" | "photo_only" | "video_only" | "document_only";
  contentText?: string;
  mediaType?: string;
  mediaFileId?: string | null;
  externalUrl?: string | null;
  updatedAt: number;
}

export const editPageContentScene = new Scenes.WizardScene<any>(
  EDIT_PAGE_CONTENT_SCENE,
  async (ctx) => {
    const state = ctx.scene.state as EditPageContentState;
    (ctx.wizard.state as EditPageContentState).menuItemId = state.menuItemId;
    (ctx.wizard.state as EditPageContentState).isRoot = state.isRoot ?? state.menuItemId === "root";

    // Language-version editor is ALPHA_OWNER-only.
    if (state.returnScope === "langv") {
      const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
      try {
        await ctx.services.permissions.ensurePermission(ctx.currentUser!.id, "canManageLanguages");
      } catch (err) {
        if (err instanceof ForbiddenError) {
          await ctx.reply(ctx.services.i18n.t(locale, "permissions.language_manage_denied"), buildCancelKeyboard(ctx.services.i18n, locale));
          return ctx.scene.leave();
        }
        throw err;
      }
    }

    const dbLanguageCode = ctx.services.i18n.normalizeLocalizationLanguageCode(
      (ctx.wizard.state as EditPageContentState).languageCode ?? ctx.currentUser?.selectedLanguage
    );
    const uiLocale = ctx.services.i18n.resolveLanguage(
      (ctx.wizard.state as EditPageContentState).uiLanguageCode ?? ctx.currentUser?.selectedLanguage
    );
    const isRoot = (ctx.wizard.state as EditPageContentState).isRoot ?? false;
    const mode = (ctx.wizard.state as EditPageContentState).updateMode ?? "full";
    const actionByMode = {
      full: isRoot
        ? ctx.services.i18n.t(uiLocale, "send_content_root")
        : ctx.services.i18n.t(uiLocale, "send_content_for_page"),
      text_only: ctx.services.i18n.t(uiLocale, "langv_replace_text_prompt"),
      photo_only: ctx.services.i18n.t(uiLocale, "langv_replace_photo_prompt"),
      video_only: ctx.services.i18n.t(uiLocale, "langv_replace_video_prompt"),
      document_only: ctx.services.i18n.t(uiLocale, "langv_replace_document_prompt")
    } as const;
    const text = renderScreen({
      header: "✏️ " + ctx.services.i18n.t(uiLocale, "screen_header_page_editor").replace(/^✏️\s*/, ""),
      explain: [ctx.services.i18n.t(uiLocale, "page_edit_content")],
      action: actionByMode[mode],
      hint: ctx.services.i18n.t(uiLocale, "personalization_hint") + "\n\n" + ctx.services.i18n.t(uiLocale, "content_formatting_hint")
    });
    await ctx.replyWithHTML(text, buildCancelKeyboard(ctx.services.i18n, uiLocale));
    return ctx.wizard.next();
  },
  async (ctx) => {
    const { menuItemId, isRoot, updateMode, returnPageId, returnScope } = ctx.wizard.state as EditPageContentState;
    if (!menuItemId || !ctx.currentUser) {
      await ctx.scene.leave();
      return;
    }

    // Guard again in the mutation step to protect against direct scene invocation.
    if (returnScope === "langv") {
      const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser.selectedLanguage);
      try {
        await ctx.services.permissions.ensurePermission(ctx.currentUser.id, "canManageLanguages");
      } catch (err) {
        if (err instanceof ForbiddenError) {
          await ctx.reply(ctx.services.i18n.t(locale, "permissions.language_manage_denied"), buildCancelKeyboard(ctx.services.i18n, locale));
          return ctx.scene.leave();
        }
        throw err;
      }
    }

    const content = extractMessageContent(ctx);
    const contentTextForStorage = extractFormattedContentText(content);
    const dbLanguageCode = ctx.services.i18n.normalizeLocalizationLanguageCode(
      (ctx.wizard.state as EditPageContentState).languageCode ?? ctx.currentUser.selectedLanguage
    );
    const uiLocale = ctx.services.i18n.resolveLanguage(
      (ctx.wizard.state as EditPageContentState).uiLanguageCode ?? ctx.currentUser.selectedLanguage
    );
    const mode = updateMode ?? "full";
    if (!content.text && !content.mediaFileId && !content.externalUrl) {
      await ctx.reply(ctx.services.i18n.t(uiLocale, "send_text_or_media"), buildCancelKeyboard(ctx.services.i18n, uiLocale));
      return;
    }
    if (mode === "text_only" && !content.text) {
      await ctx.reply(ctx.services.i18n.t(uiLocale, "langv_replace_text_only_error"), buildCancelKeyboard(ctx.services.i18n, uiLocale));
      return;
    }
    if (mode === "photo_only" && content.mediaType !== "PHOTO") {
      await ctx.reply(ctx.services.i18n.t(uiLocale, "langv_replace_photo_only_error"), buildCancelKeyboard(ctx.services.i18n, uiLocale));
      return;
    }
    if (mode === "video_only" && content.mediaType !== "VIDEO") {
      await ctx.reply(ctx.services.i18n.t(uiLocale, "langv_replace_video_only_error"), buildCancelKeyboard(ctx.services.i18n, uiLocale));
      return;
    }
    if (mode === "document_only" && content.mediaType !== "DOCUMENT") {
      await ctx.reply(ctx.services.i18n.t(uiLocale, "langv_replace_document_only_error"), buildCancelKeyboard(ctx.services.i18n, uiLocale));
      return;
    }
    const root = isRoot ?? menuItemId === "root";
    try {
      if (returnScope === "langv") {
        const session = ((ctx as unknown as { session?: Record<string, unknown> }).session ?? {}) as Record<string, unknown>;
        const pending = (session.langvPending as Record<string, LangvPendingDraftPatch> | undefined) ?? {};
        const pageId = returnPageId ?? menuItemId;
        const key = `${dbLanguageCode}:${pageId}`;
        pending[key] = {
          pageId,
          isRoot: root,
          languageCode: dbLanguageCode,
          updateMode: mode,
          contentText: contentTextForStorage,
          mediaType: content.mediaType,
          mediaFileId: content.mediaFileId ?? null,
          externalUrl: content.externalUrl ?? null,
          updatedAt: Date.now()
        };
        (ctx as unknown as { session: Record<string, unknown> }).session = {
          ...session,
          langvPending: pending
        };
        const text = ctx.services.i18n.t(uiLocale, "langv_changes_prepared");
        const keyboard = Markup.inlineKeyboard([
          [Markup.button.callback("👁 " + ctx.services.i18n.t(uiLocale, "langv_btn_preview"), makeCallbackData("admin", "langv_post_preview", dbLanguageCode, pageId))],
          [Markup.button.callback("✅ " + ctx.services.i18n.t(uiLocale, "langv_btn_publish"), makeCallbackData("admin", "langv_post_publish", dbLanguageCode, pageId))],
          [Markup.button.callback(ctx.services.i18n.t(uiLocale, "back"), makeCallbackData("admin", "langv_page_open", dbLanguageCode, pageId))],
          [Markup.button.callback(ctx.services.i18n.t(uiLocale, "to_main_menu"), "nav:root")]
        ]);
        await ctx.reply(text, keyboard);
        return ctx.scene.leave();
      }

      if (root) {
        if (mode === "full") {
          await ctx.services.menu.setWelcome(
            ctx.currentUser.id,
            dbLanguageCode,
            contentTextForStorage,
            content.mediaType ?? "NONE",
            content.mediaFileId ?? null
          );
        } else if (mode === "text_only") {
          await ctx.services.menu.patchWelcomeLocalization(ctx.currentUser.id, dbLanguageCode, { welcomeText: contentTextForStorage });
        } else {
          await ctx.services.menu.patchWelcomeLocalization(ctx.currentUser.id, dbLanguageCode, {
            welcomeMediaType: content.mediaType ?? "NONE",
            welcomeMediaFileId: content.mediaFileId ?? null
          });
        }
      } else {
        if (mode === "full") {
          await ctx.services.menu.updateMenuItemContent(
            menuItemId,
            ctx.currentUser.id,
            dbLanguageCode,
            {
              contentText: contentTextForStorage,
              mediaType: content.mediaType,
              mediaFileId: content.mediaFileId,
              externalUrl: content.externalUrl
            }
          );
        } else if (mode === "text_only") {
          await ctx.services.menu.patchMenuItemLocalization(menuItemId, ctx.currentUser.id, dbLanguageCode, {
            contentText: contentTextForStorage
          });
        } else {
          await ctx.services.menu.patchMenuItemLocalization(menuItemId, ctx.currentUser.id, dbLanguageCode, {
            mediaType: content.mediaType ?? "NONE",
            mediaFileId: content.mediaFileId ?? null
          });
        }
      }
      const successKey =
        mode === "text_only"
          ? "langv_text_replaced"
          : mode === "photo_only"
            ? "langv_photo_replaced"
            : mode === "video_only"
              ? "langv_video_replaced"
              : mode === "document_only"
                ? "langv_document_replaced"
                : root
                  ? "root_page_updated"
                  : "page_content_updated";
      const backPageId = returnPageId ?? menuItemId;
      const backKeyboard = buildReturnToAdminOrPageKeyboard(menuItemId, ctx.services.i18n, uiLocale);
      await ctx.reply(
        ctx.services.i18n.t(uiLocale, successKey),
        backKeyboard as any
      );
    } catch (err) {
      await ctx.reply(ctx.services.i18n.t(uiLocale, "error_save_step"), buildCancelKeyboard(ctx.services.i18n, uiLocale));
      return;
    }
    return ctx.scene.leave();
  }
);
