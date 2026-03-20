import type { AccessRule, PrismaClient, User } from "@prisma/client";

import type { ReferralService } from "../referrals/referral.service";

export class AccessRuleService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly referrals: ReferralService
  ) {}

  public async evaluate(
    ruleId: string | null | undefined,
    user: User,
    opts?: { skipProductPurchase?: boolean }
  ): Promise<boolean> {
    if (!ruleId) {
      return true;
    }

    const rule = await this.prisma.accessRule.findUnique({
      where: { id: ruleId }
    });

    if (!rule || !rule.isActive) {
      return true;
    }

    return this.evaluateRule(rule, user, opts);
  }

  public async evaluateProduct(productId: string | null | undefined, userId: string): Promise<boolean> {
    if (!productId) {
      return true;
    }

    const access = await this.prisma.userAccessRight.findFirst({
      where: {
        userId,
        productId,
        status: "ACTIVE",
        OR: [
          {
            activeUntil: null
          },
          {
            activeUntil: {
              gt: new Date()
            }
          }
        ]
      }
    });

    return Boolean(access);
  }

  private async evaluateRule(rule: AccessRule, user: User, opts?: { skipProductPurchase?: boolean }): Promise<boolean> {
    const config = (rule.configJson ?? {}) as Record<string, unknown>;

    switch (rule.ruleType) {
      case "FREE":
        return true;
      case "PRODUCT_PURCHASE":
        if (opts?.skipProductPurchase) return true;
        return this.evaluateProduct(String(config.productId ?? ""), user.id);
      case "REFERRAL_COUNT": {
        const min = Number(config.min ?? 0);
        const total = await this.referrals.getTotalStructureCount(user.id);
        return total >= min;
      }
      case "MLM_LEVEL": {
        const level = Number(config.level ?? 1);
        const stats = await this.referrals.getLevelStats(user.id);
        return stats.some((row) => row.level >= level && row.count > 0);
      }
      case "SEGMENT":
      case "HAS_TAG": {
        const requiredTags = Array.isArray(config.tagCodes) ? (config.tagCodes as string[]) : [];
        if (requiredTags.length === 0) {
          return true;
        }
        const count = await this.prisma.userTag.count({
          where: {
            userId: user.id,
            tag: {
              code: {
                in: requiredTags
              }
            }
          }
        });
        return count >= requiredTags.length;
      }
      case "NOT_HAS_TAG": {
        const deniedTags = Array.isArray(config.tagCodes) ? (config.tagCodes as string[]) : [];
        const count = await this.prisma.userTag.count({
          where: {
            userId: user.id,
            tag: {
              code: {
                in: deniedTags
              }
            }
          }
        });
        return count === 0;
      }
      case "LANGUAGE":
        return user.selectedLanguage === String(config.languageCode ?? "");
      case "PREVIOUS_PROGRESS": {
        const menuItemId = String(config.menuItemId ?? "");
        const progress = await this.prisma.contentProgress.findUnique({
          where: {
            userId_menuItemId: {
              userId: user.id,
              menuItemId
            }
          }
        });
        return progress?.status === "COMPLETED";
      }
      case "CONTACT_SHARED":
        return Boolean(user.phone);
      case "REGISTERED_DAYS": {
        const minDays = Number(config.minDays ?? 0);
        const thresholdMs = minDays * 24 * 60 * 60 * 1000;
        return Date.now() - user.createdAt.getTime() >= thresholdMs;
      }
      case "USER_STATUS":
        return user.status === String(config.status ?? user.status);
      default:
        return true;
    }
  }
}
