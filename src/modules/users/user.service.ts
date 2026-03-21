import { randomBytes } from "node:crypto";

import type { Prisma, PrismaClient, User } from "@prisma/client";
import type { User as TelegramUser } from "telegraf/types";

import { env } from "../../config/env";
import { ValidationError } from "../../common/errors";
import type { AuditService } from "../audit/audit.service";

const FULL_ACCESS_ADMIN = {
  canEditMenu: true,
  canSendBroadcasts: true,
  canScheduleMessages: true,
  canManageLanguages: false,
  canManagePayments: true,
  canManageSegments: true,
  canViewGlobalStats: true,
  canManageTemplates: true
};

function normalizeTelegramUsername(input: string): string | null {
  const raw = String(input ?? "").trim().replace(/^@/, "");
  const normalized = raw.toLowerCase();

  // Telegram usernames: 5-32 chars, letters/digits/underscore.
  if (!/^[a-z0-9_]{5,32}$/.test(normalized)) return null;
  return normalized;
}

export interface EnsureUserResult {
  user: User;
  isNew: boolean;
}

const createReferralCode = (): string => randomBytes(5).toString("hex");

const buildFullName = (firstName: string | null | undefined, lastName: string | null | undefined): string =>
  [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ").trim();

export class UserService {
  public constructor(private readonly prisma: PrismaClient, private readonly botInstanceId?: string, private readonly audit?: AuditService) {}

  public async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  public async findByTelegramId(telegramUserId: bigint): Promise<User | null> {
    return this.prisma.user.findFirst({
      where: this.botInstanceId ? { telegramUserId, botInstanceId: this.botInstanceId } : { telegramUserId }
    });
  }

  public async findByIdentifier(identifier: string): Promise<User | null> {
    const normalized = identifier.trim();

    if (/^@\w+$/i.test(normalized)) {
      const username = normalized.slice(1);
      return this.prisma.user.findFirst({
        where: this.botInstanceId ? { username, botInstanceId: this.botInstanceId } : { username }
      });
    }

    if (/^\d+$/.test(normalized)) {
      const telegramUserId = BigInt(normalized);
      return this.prisma.user.findFirst({
        where: this.botInstanceId ? { telegramUserId, botInstanceId: this.botInstanceId } : { telegramUserId }
      });
    }

    throw new ValidationError("Admin identifier must be Telegram ID or @username");
  }

  /**
   * @param preferredLanguageForNewUser — язык для нового пользователя (напр. из ctx.from.language_code).
   * Если передан — при создании будет использован вместо DEFAULT_LANGUAGE.
   * Должен быть уже разрешён через I18nService.resolveLanguage (поддерживаемый код или fallback на ru).
   */
  public async ensureTelegramUser(
    telegramUser: TelegramUser,
    inviterUserId?: string | null,
    preferredLanguageForNewUser?: string | null
  ): Promise<EnsureUserResult> {
    const existing = await this.findByTelegramId(BigInt(telegramUser.id));
    const fullName = buildFullName(telegramUser.first_name, telegramUser.last_name) || telegramUser.first_name;

    const updatePayload: Prisma.UserUncheckedUpdateInput = {
      username: telegramUser.username ?? undefined,
      firstName: telegramUser.first_name ?? "",
      lastName: telegramUser.last_name ?? "",
      fullName,
      lastSeenAt: new Date()
    };

    if (existing) {
      if (!existing.invitedByUserId && inviterUserId && existing.id !== inviterUserId) {
        updatePayload.invitedByUserId = inviterUserId;
        updatePayload.mentorUserId = inviterUserId;
      }

      // GLOBAL policy:
      // - SUPER_ADMIN_TELEGRAM_ID is ALPHA_OWNER
      // - OWNER/ADMIN are bot-scoped and must NOT be stored in user.role.
      const isSuperAdmin = BigInt(telegramUser.id) === env.SUPER_ADMIN_TELEGRAM_ID;
      const desiredRole: User["role"] = isSuperAdmin ? "ALPHA_OWNER" : "USER";

      const updated = await this.prisma.user.update({
        where: { id: existing.id },
        data: {
          ...updatePayload,
          ...(desiredRole !== existing.role ? { role: desiredRole } : {})
        }
      });

      if (desiredRole === "ALPHA_OWNER") {
        await this.prisma.adminPermission.upsert({
          where: { userId: updated.id },
          update: {
            ...FULL_ACCESS_ADMIN,
            canManageLanguages: true
          },
          create: {
            userId: updated.id,
            ...FULL_ACCESS_ADMIN,
            canManageLanguages: true
          }
        });
      } else {
        // Clamp: non-alpha users must not keep global admin permission flags.
        await this.prisma.adminPermission.deleteMany({
          where: { userId: updated.id }
        });
      }

      // PENDING assignments are NOT auto-activated here. Alpha owner must activate via backoffice "Сверить сейчас".
      // Until then, the user sees an empty screen (no system buttons).

      return {
        user: updated,
        isNew: false
      };
    }

    let referralCode = createReferralCode();

    while (await this.prisma.user.findUnique({ where: { referralCode } })) {
      referralCode = createReferralCode();
    }

    const isSuperAdmin = BigInt(telegramUser.id) === env.SUPER_ADMIN_TELEGRAM_ID;
    const role: User["role"] = isSuperAdmin ? "ALPHA_OWNER" : "USER";

    const initialLanguage =
      preferredLanguageForNewUser && preferredLanguageForNewUser.trim()
        ? preferredLanguageForNewUser.trim().toLowerCase()
        : env.DEFAULT_LANGUAGE;

    const created = await this.prisma.user.create({
      data: {
        telegramUserId: BigInt(telegramUser.id),
        botInstanceId: this.botInstanceId ?? undefined,
        username: telegramUser.username ?? undefined,
        firstName: telegramUser.first_name ?? "",
        lastName: telegramUser.last_name ?? "",
        fullName,
        selectedLanguage: initialLanguage,
        role,
        referralCode,
        invitedByUserId: inviterUserId ?? undefined,
        mentorUserId: inviterUserId ?? undefined,
        lastSeenAt: new Date()
      }
    });

    if (role === "ALPHA_OWNER") {
      await this.prisma.adminPermission.upsert({
        where: { userId: created.id },
        update: {
          ...FULL_ACCESS_ADMIN,
          canManageLanguages: true
        },
        create: {
          userId: created.id,
          ...FULL_ACCESS_ADMIN,
          canManageLanguages: true
        }
      });
    }
    if (role !== "ALPHA_OWNER") {
      await this.prisma.adminPermission.deleteMany({
        where: { userId: created.id }
      });
    }

    // PENDING assignments are NOT auto-activated here. Alpha owner must activate via backoffice "Сверить сейчас".
    // Until then, the user sees an empty screen (no system buttons).

    return {
      user: created,
      isNew: true
    };
  }

  public async setLanguage(userId: string, languageCode: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { selectedLanguage: languageCode }
    });
  }

  public async setTimeZone(userId: string, timeZone: string | null): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { timeZone: timeZone ?? undefined }
    });
  }

  public async saveContact(userId: string, phone: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.contact.create({
        data: {
          userId,
          phone
        }
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          phone
        }
      })
    ]);
  }

  /** Set current onboarding step (0–6). null = not started or reset. */
  public async setOnboardingStep(userId: string, step: number | null): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { onboardingStep: step }
    });
  }

  /** Mark onboarding as completed. */
  public async setOnboardingCompleted(userId: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { onboardingStep: null, onboardingCompletedAt: new Date() }
    });
  }

  /** Reset onboarding so it can be run again. */
  public async resetOnboarding(userId: string): Promise<User> {
    return this.prisma.user.update({
      where: { id: userId },
      data: { onboardingStep: null, onboardingCompletedAt: null }
    });
  }

  /** Delete user completely from the bot base. Enables re-registration via referral link. */
  public async deleteUser(userId: string): Promise<void> {
    await this.prisma.user.delete({ where: { id: userId } });
  }
}
