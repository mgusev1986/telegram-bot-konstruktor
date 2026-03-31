import type { PrismaClient, User } from "@prisma/client";
import { Markup } from "telegraf";

import { NAV_ROOT_DATA } from "../bot/keyboards";
import { makeCallbackData } from "./callback-data";
import type { CabinetService } from "../modules/cabinet/cabinet.service";

export type MessageActionButton =
  | { type: "url"; label: string; url: string }
  | { type: "system"; label: string; systemKind: MessageSystemKind }
  | { type: "section"; label: string; targetMenuItemId: string };

export const MESSAGE_SYSTEM_KINDS = ["partner_register", "mentor_contact", "main_menu"] as const;
export type MessageSystemKind = (typeof MESSAGE_SYSTEM_KINDS)[number];

export async function buildInlineButtonsReplyMarkup(
  buttonsJson: unknown,
  user: User,
  prisma: Pick<PrismaClient, "user">,
  cabinet?: Pick<CabinetService, "resolvePartnerRegisterActionUrlForUser">
): Promise<{ reply_markup: object } | Record<string, never>> {
  const arr = Array.isArray(buttonsJson) ? buttonsJson : [];
  if (arr.length === 0) return {};

  const rows: Array<Array<ReturnType<typeof Markup.button.url> | ReturnType<typeof Markup.button.callback>>> = [];

  for (const rawButton of arr) {
    if (!rawButton || typeof rawButton !== "object" || typeof (rawButton as any).label !== "string") continue;

    const button = rawButton as MessageActionButton;

    if (button.type === "url" && button.url) {
      rows.push([Markup.button.url(button.label, button.url)]);
      continue;
    }

    if (button.type === "system") {
      if (button.systemKind === "main_menu") {
        rows.push([Markup.button.callback(button.label, NAV_ROOT_DATA)]);
        continue;
      }

      if (button.systemKind === "partner_register" && cabinet) {
        const url = await cabinet.resolvePartnerRegisterActionUrlForUser(user);
        if (url) rows.push([Markup.button.url(button.label, url)]);
        continue;
      }

      if (button.systemKind === "mentor_contact") {
        const mentorUsername =
          user.mentorUserId
            ? (await prisma.user.findUnique({
                where: { id: user.mentorUserId },
                select: { username: true }
              }))?.username ?? null
            : null;
        if (mentorUsername?.trim()) {
          rows.push([Markup.button.url(button.label, `https://t.me/${mentorUsername.trim()}`)]);
        } else {
          rows.push([Markup.button.callback(button.label, makeCallbackData("mentor", "open"))]);
        }
        continue;
      }
    }

    if (button.type === "section" && button.targetMenuItemId) {
      rows.push([Markup.button.callback(button.label, makeCallbackData("menu", "open", button.targetMenuItemId))]);
    }
  }

  if (rows.length === 0) return {};
  return Markup.inlineKeyboard(rows);
}
