import type { PrismaClient, User } from "@prisma/client";

import { env } from "../../config/env";
import { ValidationError } from "../../common/errors";
import type { NotificationService } from "../notifications/notification.service";

interface LevelStatRow {
  level: number;
  count: number;
}

interface DownlineRow {
  id: string;
  telegram_user_id: bigint;
  username: string | null;
  first_name: string;
  last_name: string;
  full_name: string;
  phone: string | null;
  selected_language: string;
  role: string;
  status: string;
  level: number;
  invited_by_user_id: string | null;
  created_at: Date;
}

export class ReferralService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: NotificationService,
    private readonly botInstanceId?: string
  ) {}

  public parseReferralPayload(payload: string | undefined): string | null {
    if (!payload?.startsWith("ref_")) {
      return null;
    }

    return payload.replace(/^ref_/, "").trim() || null;
  }

  public async resolveInviterByCode(referralCode: string | null): Promise<User | null> {
    if (!referralCode) {
      return null;
    }

    return this.prisma.user.findUnique({
      where: { referralCode }
    });
  }

  public async validateInviter(userId: string, inviterUserId: string): Promise<void> {
    if (userId === inviterUserId) {
      throw new ValidationError("Self-referral is not allowed");
    }

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE downline AS (
        SELECT id, invited_by_user_id
        FROM users
        WHERE invited_by_user_id = ${userId}
        UNION ALL
        SELECT u.id, u.invited_by_user_id
        FROM users u
        INNER JOIN downline d ON u.invited_by_user_id = d.id
      )
      SELECT id
      FROM downline
      WHERE id = ${inviterUserId}
      LIMIT 1
    `;

    if (rows.length > 0) {
      throw new ValidationError("Referral cycle detected");
    }
  }

  public async registerReferral(inviter: User, invited: User): Promise<void> {
    await this.prisma.referralEvent.create({
      data: {
        inviterUserId: inviter.id,
        invitedUserId: invited.id,
        eventType: "registration",
        level: 1
      }
    });

    await this.refreshStatsForChain(invited.id);
    await this.notifications.notifyFirstLineRegistration(inviter, invited);

    const owner = await this.prisma.user.findFirst({
      where: {
        telegramUserId: env.SUPER_ADMIN_TELEGRAM_ID,
        ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {})
      }
    });

    if (owner && owner.id !== inviter.id) {
      await this.notifications.notifyGlobalRegistration(owner, invited, inviter);
    }
  }

  public async refreshStatsForChain(userId: string): Promise<void> {
    const chainRows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE uplink AS (
        SELECT id, invited_by_user_id
        FROM users
        WHERE id = ${userId}
        UNION ALL
        SELECT u.id, u.invited_by_user_id
        FROM users u
        INNER JOIN uplink up ON up.invited_by_user_id = u.id
      )
      SELECT id
      FROM uplink
    `;

    const targets = new Set(chainRows.map((row) => row.id));

    for (const targetId of targets) {
      const [firstLineCount, totalStructureCount] = await Promise.all([
        this.prisma.user.count({
          where: {
            invitedByUserId: targetId
          }
        }),
        this.getTotalStructureCount(targetId)
      ]);

      await this.prisma.referralStatsCache.upsert({
        where: { userId: targetId },
        update: {
          firstLineCount,
          totalStructureCount
        },
        create: {
          userId: targetId,
          firstLineCount,
          totalStructureCount
        }
      });
    }
  }

  public async getTotalStructureCount(userId: string): Promise<number> {
    const result = await this.prisma.$queryRaw<Array<{ count: bigint }>>`
      WITH RECURSIVE downline AS (
        SELECT id, invited_by_user_id, 1 AS level
        FROM users
        WHERE invited_by_user_id = ${userId}
        UNION ALL
        SELECT u.id, u.invited_by_user_id, d.level + 1
        FROM users u
        INNER JOIN downline d ON u.invited_by_user_id = d.id
      )
      SELECT COUNT(*)::bigint AS count
      FROM downline
    `;

    return Number(result[0]?.count ?? 0n);
  }

  public async getLevelStats(userId: string): Promise<LevelStatRow[]> {
    const rows = await this.prisma.$queryRaw<Array<{ level: number; count: bigint }>>`
      WITH RECURSIVE downline AS (
        SELECT id, invited_by_user_id, 1 AS level
        FROM users
        WHERE invited_by_user_id = ${userId}
        UNION ALL
        SELECT u.id, u.invited_by_user_id, d.level + 1
        FROM users u
        INNER JOIN downline d ON u.invited_by_user_id = d.id
      )
      SELECT level, COUNT(*)::bigint AS count
      FROM downline
      GROUP BY level
      ORDER BY level ASC
    `;

    return rows.map((row) => ({
      level: row.level,
      count: Number(row.count)
    }));
  }

  public async getDownline(userId: string): Promise<DownlineRow[]> {
    return this.prisma.$queryRaw<DownlineRow[]>`
      WITH RECURSIVE downline AS (
        SELECT
          id,
          telegram_user_id,
          username,
          first_name,
          last_name,
          full_name,
          phone,
          selected_language,
          role,
          status,
          invited_by_user_id,
          created_at,
          1 AS level
        FROM users
        WHERE invited_by_user_id = ${userId}
        UNION ALL
        SELECT
          u.id,
          u.telegram_user_id,
          u.username,
          u.first_name,
          u.last_name,
          u.full_name,
          u.phone,
          u.selected_language,
          u.role,
          u.status,
          u.invited_by_user_id,
          u.created_at,
          d.level + 1 AS level
        FROM users u
        INNER JOIN downline d ON u.invited_by_user_id = d.id
      )
      SELECT *
      FROM downline
      ORDER BY level ASC, created_at ASC
    `;
  }

  public async getStructureUserIdsByLevel(userId: string, exactLevel?: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE downline AS (
        SELECT id, invited_by_user_id, 1 AS level
        FROM users
        WHERE invited_by_user_id = ${userId}
        UNION ALL
        SELECT u.id, u.invited_by_user_id, d.level + 1
        FROM users u
        INNER JOIN downline d ON u.invited_by_user_id = d.id
      )
      SELECT id
      FROM downline
      WHERE ${exactLevel ?? null}::int IS NULL OR level = ${exactLevel ?? null}
    `;

    return rows.map((row) => row.id);
  }

  /** First-line users (level 1) ordered by registration date, newest first. For "recent invited" block. */
  public async getFirstLineRecent(userId: string, limit: number = 5): Promise<DownlineRow[]> {
    const rows = await this.prisma.user.findMany({
      where: { invitedByUserId: userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        telegramUserId: true,
        username: true,
        firstName: true,
        lastName: true,
        fullName: true,
        phone: true,
        selectedLanguage: true,
        role: true,
        status: true,
        invitedByUserId: true,
        createdAt: true
      }
    });
    return rows.map((u) => ({
      id: u.id,
      telegram_user_id: u.telegramUserId,
      username: u.username,
      first_name: u.firstName,
      last_name: u.lastName,
      full_name: u.fullName,
      phone: u.phone,
      selected_language: u.selectedLanguage,
      role: u.role,
      status: u.status,
      invited_by_user_id: u.invitedByUserId,
      created_at: u.createdAt,
      level: 1
    }));
  }
}
