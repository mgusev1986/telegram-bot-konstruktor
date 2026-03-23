import type { PrismaClient, User } from "@prisma/client";
import type { I18nService } from "../i18n/i18n.service";
import type { PaymentService } from "../payments/payment.service";
import type { BalanceService } from "../payments/balance.service";
import type { ReferralService } from "../referrals/referral.service";
import { isAdminAreaUser } from "../permissions/capabilities";

const LANG_LABELS: Record<string, string> = {
  ru: "Русский",
  en: "English"
};

export type NextStepKey =
  | "next_step_share_link"
  | "next_step_choose_language"
  | "next_step_contact_mentor"
  | "next_step_pay_access"
  | "next_step_invite_first"
  | "next_step_share_contact";

export class CabinetService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly referrals: ReferralService,
    private readonly payments: PaymentService,
    private readonly balance: BalanceService,
    private readonly i18n: I18nService,
    private readonly botUsername: string,
    private readonly botInstanceId?: string,
    private readonly paidAccessEnabled: boolean = true
  ) {}

  private botProductIdsCache: Set<string> | null = null;

  private async resolveBotProductIds(): Promise<Set<string>> {
    if (!this.botInstanceId) return new Set<string>();
    if (this.botProductIdsCache) return this.botProductIdsCache;

    const template = await this.prisma.presentationTemplate.findFirst({
      where: { botInstanceId: this.botInstanceId, isActive: true },
      select: { id: true }
    });

    if (!template) {
      this.botProductIdsCache = new Set<string>();
      return this.botProductIdsCache;
    }

    const rows = await this.prisma.menuItem.findMany({
      where: { templateId: template.id, productId: { not: null } },
      select: { productId: true },
      distinct: ["productId"]
    });

    this.botProductIdsCache = new Set(rows.map((r) => String(r.productId)));
    return this.botProductIdsCache;
  }

  public getReferralLink(user: User): string {
    const username = (this.botUsername || "").replace(/^@/, "").trim();
    return `https://t.me/${username}?start=${user.telegramUserId}`;
  }

  /**
   * External referral (partner) link that user adds via cabinet.
   * Normalizes and hides invalid data (so we don't render broken root button).
   */
  public getExternalReferralLink(user: User): string | null {
    const raw = user.externalReferralLink;
    return this.normalizeExternalReferralLink(raw);
  }

  /**
   * Ссылка «Зарегистрироваться / Стать партнёром» для меню пользователя.
   * У приглашённых: берётся от пригласившего. Если пригласивший не указал ссылку — кнопка не показывается.
   * У пользователей без пригласившего (владелец/верхние): своя ссылка.
   */
  public async getPartnerRegisterLinkForUser(user: User): Promise<string | null> {
    if (user.invitedByUserId) {
      const inviter = await this.prisma.user.findUnique({
        where: { id: user.invitedByUserId },
        select: { externalReferralLink: true }
      });
      return inviter ? this.normalizeExternalReferralLink(inviter.externalReferralLink) : null;
    }
    return this.getExternalReferralLink(user);
  }

  private normalizeExternalReferralLink(raw: string | null | undefined): string | null {
    const trimmed = raw?.trim();
    if (!trimmed) return null;
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return null;
    try {
      const u = new URL(trimmed);
      if (!u.hostname) return null;
      return trimmed;
    } catch {
      return null;
    }
  }

  public async upsertExternalReferralLink(userId: string, rawLink: string): Promise<string> {
    const normalized = this.normalizeExternalReferralLink(rawLink);
    if (!normalized) {
      // Scene already validates, so treat this as internal invariant.
      throw new Error("Invalid external referral link");
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        externalReferralLink: normalized
      }
    });
    return normalized;
  }

  public async buildCabinet(user: User): Promise<string> {
    const lang = this.i18n.resolveLanguage(user.selectedLanguage);
    const statsCache = await this.prisma.referralStatsCache.findUnique({
      where: { userId: user.id }
    });
    const nextStepKey = await this.getNextStepKey(user);
    const link = this.getReferralLink(user);
    const firstLine = statsCache?.firstLineCount ?? 0;
    const totalStructure = statsCache?.totalStructureCount ?? 0;

    const languageLabel = LANG_LABELS[lang] ?? lang;
    const nextStepText = this.i18n.t(lang, nextStepKey);

    let mentorBlock = this.i18n.t(lang, "cabinet_mentor_not_assigned");
    if (user.mentorUserId) {
      const mentor = await this.prisma.user.findUnique({
        where: { id: user.mentorUserId }
      });
      if (mentor) {
        const displayName = mentor.username ? `@${mentor.username}` : (mentor.fullName || mentor.firstName || mentor.id);
        mentorBlock = mentor.username
          ? displayName
          : displayName;
      }
    }

    const blocks: string[] = [
      "",
      this.i18n.t(lang, "my_cabinet"),
      ""
    ];
    const bal = await this.balance.getBalance(user.id);
    blocks.push(`💰 ${this.i18n.t(lang, "cabinet_balance")}: ${bal.toFixed(2)} USDT`);
    blocks.push("");
    blocks.push(
      `🔗 ${this.i18n.t(lang, "cabinet_my_link")}`,
      link,
      ""
    );
    blocks.push(
      `📈 ${this.i18n.t(lang, "first_line_count")}: ${firstLine}`,
      `👥 ${this.i18n.t(lang, "structure_count")}: ${totalStructure}`,
      "",
      `🌍 ${this.i18n.t(lang, "cabinet_language_label")}: ${languageLabel}`,
      `🧑‍🏫 ${this.i18n.t(lang, "cabinet_mentor")}: ${mentorBlock}`,
      "",
      `➡️ ${this.i18n.t(lang, "cabinet_next_step")}: ${nextStepText}`
    );

    if (isAdminAreaUser(user.role)) {
      const totalUsers = await this.prisma.user.count();
      blocks.push("");
      const roleLabel = user.role === "ALPHA_OWNER" ? this.i18n.t(lang, "role.alpha_owner") : user.role;
      blocks.push(
        `🔐 ${this.i18n.t(lang, "cabinet_admin_role")}: ${roleLabel}   ·   ${this.i18n.t(lang, "cabinet_admin_total_users")}: ${totalUsers}`
      );
    }

    return blocks.join("\n");
  }

  public async buildStructureScreen(user: User): Promise<string> {
    const lang = this.i18n.resolveLanguage(user.selectedLanguage);
    const statsCache = await this.prisma.referralStatsCache.findUnique({
      where: { userId: user.id }
    });
    const levels = await this.referrals.getLevelStats(user.id);
    const firstLine = statsCache?.firstLineCount ?? 0;
    const totalStructure = statsCache?.totalStructureCount ?? 0;

    const meaningfulLevels = levels.filter((l) => l.count > 0);
    const levelLines =
      meaningfulLevels.length > 0
        ? meaningfulLevels
            .map((l) => `  • ${this.i18n.t(lang, "level_label")} ${l.level}: ${l.count}`)
            .join("\n")
        : "  • —";

    const blocks: string[] = [
      "",
      `📊 ${this.i18n.t(lang, "my_structure")}`,
      "",
      `👥 ${this.i18n.t(lang, "first_line_count")}: ${firstLine}   ·   ${this.i18n.t(lang, "structure_count")}: ${totalStructure}`,
      "",
      `📈 ${this.i18n.t(lang, "stats_by_level")}:`,
      levelLines
    ];

    const recentFirstLine = await this.referrals.getFirstLineRecent(user.id, 5);
    if (recentFirstLine.length > 0) {
      blocks.push("");
      blocks.push(`🕐 ${this.i18n.t(lang, "cabinet_recent_invited")}:`);
      for (const u of recentFirstLine) {
        const label = u.username ? `@${u.username}` : u.full_name || u.first_name || String(u.telegram_user_id);
        blocks.push(`  • ${label}`);
      }
    }

    return blocks.join("\n");
  }

  public async shouldShowPayButton(user: User): Promise<boolean> {
    if (!this.paidAccessEnabled) return false;

    const summary = await this.payments.getAccessSummary(user.id);
    if (this.botInstanceId) {
      const botProductIds = await this.resolveBotProductIds();
      const hasBotAccess = summary.activeProducts.some((p) => botProductIds.has(p.id));
      return !hasBotAccess && botProductIds.size > 0;
    }

    // Fallback: legacy single-bot mode (bot scoping not available).
    if (summary.paidStatus) return false;
    const productCount = await this.prisma.product.count();
    return productCount > 0;
  }

  public async getNextStepKey(user: User): Promise<NextStepKey> {
    if (!user.selectedLanguage) {
      return "next_step_choose_language";
    }
    if (!user.phone) {
      return "next_step_share_contact";
    }
    const firstLineCount = await this.prisma.user.count({
      where: { invitedByUserId: user.id }
    });
    if (firstLineCount < 1) {
      return "next_step_invite_first";
    }
    const hasActiveAccess = await this.prisma.userAccessRight.findFirst({
      where: {
        userId: user.id,
        status: "ACTIVE",
        OR: [
          { activeUntil: null },
          { activeUntil: { gt: new Date() } }
        ]
      }
    });
    if (!hasActiveAccess) {
      return "next_step_pay_access";
    }
    return "next_step_share_link";
  }
}
