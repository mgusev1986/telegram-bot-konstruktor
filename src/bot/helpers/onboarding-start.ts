import { Markup } from "telegraf";
import type { User } from "@prisma/client";

import type { AppServices } from "../../app/services";
import type { BotContext } from "../context";
import { buildNavigationRow } from "../keyboards";

export const DEFAULT_ONBOARDING_BASE_LANGUAGE = "ru";

export async function startOnboardingWithBaseLanguage(
  ctx: BotContext,
  services: AppServices,
  user: User,
  baseLanguageCode: string = DEFAULT_ONBOARDING_BASE_LANGUAGE
): Promise<void> {
  const locale = services.i18n.resolveLanguage(user.selectedLanguage);
  const normalizedBaseLanguageCode = services.i18n.normalizeLocalizationLanguageCode(baseLanguageCode);
  const stepLabel = (step: number) =>
    services.i18n.t(locale, "onboarding_step_of").replace("{{step}}", String(step));

  await services.menu.ensureActiveTemplate(user.id, normalizedBaseLanguageCode);
  await services.users.setOnboardingStep(user.id, 1);

  const refreshed = await services.users.findById(user.id);
  if (refreshed) {
    ctx.currentUser = refreshed;
  }

  const text =
    stepLabel(1) +
    "\n\n" +
    services.i18n.t(locale, "onboarding_step1_intro") +
    "\n\n" +
    services.i18n.t(locale, "personalization_hint");

  await services.navigation.replaceScreen(
    ctx.currentUser ?? user,
    ctx.telegram,
    ctx.chat?.id ?? user.telegramUserId,
    { text, resolvePlaceholders: false },
    Markup.inlineKeyboard([buildNavigationRow(services.i18n, locale, { toMain: true })])
  );
}
