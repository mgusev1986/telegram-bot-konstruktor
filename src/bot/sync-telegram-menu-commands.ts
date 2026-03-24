import { env } from "../config/env";
import type { I18nService } from "../modules/i18n/i18n.service";
import type { MenuService } from "../modules/menu/menu.service";
import type { BotContext } from "./context";

const CMD_DESC_MAX = 256;

function clipCmdDescription(text: string): string {
  const t = text.trim();
  if (t.length <= CMD_DESC_MAX) return t;
  return t.slice(0, CMD_DESC_MAX - 1) + "…";
}

/** Как в register-bot: превью роли супер-админа влияет на видимость пунктов меню команд. */
export function resolveEffectiveRoleForMenuCommands(ctx: BotContext): string {
  const user = ctx.currentUser;
  if (!user) return "USER";
  const isSuperAdmin = user.telegramUserId === env.SUPER_ADMIN_TELEGRAM_ID;
  const previewRole = (ctx as { session?: { previewRole?: string } }).session?.previewRole;
  if (isSuperAdmin && previewRole) return previewRole;
  if (isSuperAdmin) return "ALPHA_OWNER";
  const eff = (user as { effectiveBotRole?: string | null }).effectiveBotRole;
  return eff ?? "USER";
}

const lastFingerprintByChatId = new Map<number, string>();

/** Синяя кнопка «Меню» в личке: команды с описаниями для текущего чата (скрываем /language и /admin по правилам). */
export async function syncTelegramMenuCommandsForPrivateChat(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  telegram: any,
  chatId: number,
  deps: { i18n: I18nService; menu: MenuService },
  opts: { locale: string; isAdmin: boolean }
): Promise<void> {
  const { i18n, menu } = deps;
  const locale = i18n.resolveLanguage(opts.locale);

  const rawLangCodes = await menu.getActiveTemplateLanguageCodes();
  const uniqueLangs = new Set(rawLangCodes.map((c) => String(c).toLowerCase()).filter(Boolean));
  const showLanguageCommand = uniqueLangs.size > 1;

  const commands: { command: string; description: string }[] = [
    { command: "start", description: clipCmdDescription(i18n.t(locale, "bot_cmd_start_desc")) },
    { command: "account", description: clipCmdDescription(i18n.t(locale, "bot_cmd_account_desc")) },
    { command: "invite", description: clipCmdDescription(i18n.t(locale, "bot_cmd_invite_desc")) }
  ];

  if (showLanguageCommand) {
    commands.push({
      command: "language",
      description: clipCmdDescription(i18n.t(locale, "bot_cmd_language_desc"))
    });
  }

  if (opts.isAdmin) {
    commands.push({
      command: "admin",
      description: clipCmdDescription(i18n.t(locale, "bot_cmd_admin_desc"))
    });
  }

  const fingerprint = JSON.stringify(commands);
  if (lastFingerprintByChatId.get(chatId) === fingerprint) {
    return;
  }
  lastFingerprintByChatId.set(chatId, fingerprint);

  await telegram.setMyCommands(commands, {
    scope: { type: "chat", chat_id: chatId }
  });
}
