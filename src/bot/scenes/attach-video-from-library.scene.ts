import { Markup, Scenes } from "telegraf";

import type { BotContext } from "../context";
import { readTextMessage } from "../helpers/message-content";
import { buildNavigationRow, SCENE_CANCEL_DATA } from "../keyboards";
import { makeCallbackData } from "../../common/callback-data";
import { parseTelegramMessageLink } from "../../modules/media-library/telegram-links";

export const ATTACH_VIDEO_FROM_LIBRARY_SCENE = "attach-video-from-library-scene";
const PREFIX = "medialib";

type State = {
  pageId: string;
  languageCode: string;
  uiLanguageCode: string;
  phase: "choose" | "await_link" | "pick";
};

const navKb = (i18n: BotContext["services"]["i18n"], locale: string, rows: ReturnType<typeof Markup.button.callback>[][]) =>
  Markup.inlineKeyboard([
    ...rows,
    [Markup.button.callback(i18n.t(locale, "cancel_btn"), SCENE_CANCEL_DATA)],
    ...buildNavigationRow(i18n, locale, { toMain: true }).map((btn) => [btn])
  ]);

const short = (s: string, max = 40) => {
  const t = (s ?? "").trim().replace(/\s+/g, " ");
  if (!t) return "—";
  return t.length <= max ? t : t.slice(0, max) + "…";
};

export const attachVideoFromLibraryScene = new Scenes.WizardScene<any>(
  ATTACH_VIDEO_FROM_LIBRARY_SCENE,
  async (ctx) => {
    const locale = ctx.services.i18n.resolveLanguage(ctx.currentUser?.selectedLanguage);
    const sceneState = ctx.scene.state as { pageId?: string; languageCode?: string; uiLanguageCode?: string };
    const pageId = sceneState.pageId;
    const languageCode = sceneState.languageCode ?? locale;
    const uiLanguageCode = sceneState.uiLanguageCode ?? locale;
    if (!pageId) {
      await ctx.reply(ctx.services.i18n.t(locale, "error_generic"));
      return ctx.scene.leave();
    }
    const s = ctx.scene.state as State;
    s.pageId = pageId;
    s.languageCode = languageCode;
    s.uiLanguageCode = uiLanguageCode;
    s.phase = "choose";

    await ctx.reply(
      ctx.services.i18n.t(uiLanguageCode, "attach_video_choose_mode"),
      navKb(ctx.services.i18n, uiLanguageCode, [
        [Markup.button.callback(ctx.services.i18n.t(uiLanguageCode, "attach_video_mode_link"), makeCallbackData(PREFIX, "mode", "link"))],
        [Markup.button.callback(ctx.services.i18n.t(uiLanguageCode, "attach_video_mode_list"), makeCallbackData(PREFIX, "mode", "list"))]
      ])
    );
    return ctx.wizard.next();
  },
  async (ctx) => {
    const state = ctx.wizard.state as State;
    const locale = ctx.services.i18n.resolveLanguage(state.uiLanguageCode ?? ctx.currentUser?.selectedLanguage);
    const i18n = ctx.services.i18n;

    if (ctx.callbackQuery && "data" in ctx.callbackQuery) {
      const parts = ctx.callbackQuery.data.split(":");
      if (parts[0] === PREFIX && parts[1] === "mode") {
        await ctx.answerCbQuery();
        if (parts[2] === "link") {
          state.phase = "await_link";
          await ctx.reply(
            i18n.t(locale, "attach_video_insert_link"),
            navKb(i18n, locale, [])
          );
          return;
        }
        if (parts[2] === "list") {
          state.phase = "pick";
          const assets = await ctx.services.mediaLibrary.listRecent("VIDEO", 20);
          if (assets.length === 0) {
            await ctx.reply(
              i18n.t(locale, "attach_video_empty_library"),
              navKb(i18n, locale, [])
            );
            return;
          }
          const rows = assets.map((a: { caption: string; messageId: number; channelId: bigint }) => {
            const label = `🎬 ${short(a.caption)} · #${a.messageId}`;
            return [Markup.button.callback(label, makeCallbackData(PREFIX, "pick", a.channelId.toString(), String(a.messageId)))];
          });
          await ctx.reply(i18n.t(locale, "attach_video_pick_recent"), navKb(i18n, locale, rows));
          return;
        }
      }

      if (parts[0] === PREFIX && parts[1] === "pick" && parts[2] && parts[3]) {
        await ctx.answerCbQuery();
        const channelId = BigInt(parts[2]);
        const messageId = Number(parts[3]);
        const asset = await ctx.services.mediaLibrary.findByChannelMessage(channelId, messageId);
        if (!asset) {
          await ctx.reply(
            i18n.t(locale, "attach_video_not_found"),
            navKb(i18n, locale, [])
          );
          return;
        }
        await ctx.services.menu.updateMenuItemContent(state.pageId, ctx.currentUser!.id, state.languageCode, {
          mediaType: "VIDEO",
          mediaFileId: asset.fileId
        });
        await ctx.reply(i18n.t(locale, "attach_video_saved"), navKb(i18n, locale, [
          [Markup.button.callback(i18n.t(locale, "attach_video_back_to_editor"), makeCallbackData("page_edit", "open", state.pageId))]
        ]));
        return ctx.scene.leave();
      }
    }

    if (state.phase === "await_link") {
      const linkText = readTextMessage(ctx).trim();
      const ref = parseTelegramMessageLink(linkText);
      if (!ref) {
        await ctx.reply(
          i18n.t(locale, "attach_video_bad_link"),
          { parse_mode: "Markdown" } as any
        );
        return;
      }
      if (ref.kind === "private") {
        const asset = await ctx.services.mediaLibrary.findByChannelMessage(ref.channelId, ref.messageId);
        if (!asset) {
          await ctx.reply(
            i18n.t(locale, "attach_video_not_found_channel"),
            navKb(i18n, locale, [])
          );
          return;
        }
        await ctx.services.menu.updateMenuItemContent(state.pageId, ctx.currentUser!.id, state.languageCode, {
          mediaType: "VIDEO",
          mediaFileId: asset.fileId
        });
        await ctx.reply(i18n.t(locale, "attach_video_saved_short"), navKb(i18n, locale, [
          [Markup.button.callback(i18n.t(locale, "attach_video_back_to_editor"), makeCallbackData("page_edit", "open", state.pageId))]
        ]));
        return ctx.scene.leave();
      }

      // public link: resolve channel username to chat id
      try {
        const chat = await ctx.telegram.getChat("@" + ref.username);
        const channelId = BigInt(chat.id);
        const asset = await ctx.services.mediaLibrary.findByChannelMessage(channelId, ref.messageId);
        if (!asset) {
          await ctx.reply(
            i18n.t(locale, "attach_video_not_found"),
            navKb(i18n, locale, [])
          );
          return;
        }
        await ctx.services.menu.updateMenuItemContent(state.pageId, ctx.currentUser!.id, state.languageCode, {
          mediaType: "VIDEO",
          mediaFileId: asset.fileId
        });
        await ctx.reply(i18n.t(locale, "attach_video_saved_short"), navKb(i18n, locale, [
          [Markup.button.callback(i18n.t(locale, "attach_video_back_to_editor"), makeCallbackData("page_edit", "open", state.pageId))]
        ]));
        return ctx.scene.leave();
      } catch {
        await ctx.reply(
          i18n.t(locale, "attach_video_channel_check_failed"),
          { parse_mode: "Markdown" } as any
        );
        return;
      }
    }

    await ctx.reply(i18n.t(locale, "choose_action_below"), navKb(i18n, locale, []));
  }
);

