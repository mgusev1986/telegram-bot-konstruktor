import type { Prisma, PrismaClient } from "@prisma/client";

export interface UserDirectoryFilters {
  botInstanceIds?: string[];
  search?: string;
  languageCode?: string;
}

export interface UserDirectoryPagination {
  page: number;
  perPage: number;
}

export interface UserDirectorySort {
  sortBy: "createdAt" | "lastSeenAt" | "fullName" | "telegramUserId";
  order: "asc" | "desc";
}

export interface UserDirectoryRow {
  id: string;
  telegramUserId: bigint;
  username: string | null;
  firstName: string;
  lastName: string;
  fullName: string;
  selectedLanguage: string;
  status: string;
  role: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  botInstanceId: string | null;
  botName: string | null;
  botUsername: string | null;
}

export interface UserDirectoryListResult {
  rows: UserDirectoryRow[];
  total: number;
  page: number;
  perPage: number;
}

export interface UserDirectorySummary {
  totalUsers: number;
  totalBots: number;
  usersByBot: Array<{ botId: string; botName: string; botUsername: string | null; userCount: number }>;
  multiBotUserCount: number;
}

export class UserDirectoryService {
  public constructor(private readonly prisma: PrismaClient) {}

  public async listUsersAcrossBots(
    filters: UserDirectoryFilters,
    pagination: UserDirectoryPagination,
    sort: UserDirectorySort
  ): Promise<UserDirectoryListResult> {
    const { page, perPage } = pagination;
    const skip = (page - 1) * perPage;

    const where: Prisma.UserWhereInput = {};

    if (filters.botInstanceIds?.length) {
      where.botInstanceId = { in: filters.botInstanceIds };
    }

    if (filters.languageCode) {
      where.selectedLanguage = filters.languageCode;
    }

    if (filters.search?.trim()) {
      const q = filters.search.trim();
      const numeric = /^\d+$/.test(q);
      if (numeric) {
        where.OR = [
          { telegramUserId: BigInt(q) },
          { username: { contains: q, mode: "insensitive" } },
          { fullName: { contains: q, mode: "insensitive" } },
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } }
        ];
      } else {
        where.OR = [
          { username: { contains: q, mode: "insensitive" } },
          { fullName: { contains: q, mode: "insensitive" } },
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } }
        ];
      }
    }

    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: { botInstance: true },
        orderBy: { [sort.sortBy]: sort.order },
        skip,
        take: perPage
      }),
      this.prisma.user.count({ where })
    ]);

    const userRows: UserDirectoryRow[] = rows.map((u) => ({
      id: u.id,
      telegramUserId: u.telegramUserId,
      username: u.username,
      firstName: u.firstName,
      lastName: u.lastName,
      fullName: u.fullName,
      selectedLanguage: u.selectedLanguage,
      status: u.status,
      role: u.role,
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt,
      botInstanceId: u.botInstanceId,
      botName: u.botInstance?.name ?? null,
      botUsername: u.botInstance?.telegramBotUsername ?? null
    }));

    return { rows: userRows, total, page, perPage };
  }

  public async getDirectorySummary(): Promise<UserDirectorySummary> {
    const [totalUsers, bots, usersByBotRaw, multiBotRaw] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.botInstance.findMany({
        where: { isArchived: false },
        select: { id: true, name: true, telegramBotUsername: true }
      }),
      this.prisma.user.groupBy({
        by: ["botInstanceId"],
        _count: { id: true },
        where: { botInstanceId: { not: null } }
      }),
      this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM (
          SELECT telegram_user_id
          FROM users
          WHERE bot_instance_id IS NOT NULL
          GROUP BY telegram_user_id
          HAVING COUNT(DISTINCT bot_instance_id) > 1
        ) multi
      `
    ]);

    const botMap = new Map(bots.map((b) => [b.id, b]));
    const usersByBot = usersByBotRaw
      .filter((r) => r.botInstanceId)
      .map((r) => {
        const bot = r.botInstanceId ? botMap.get(r.botInstanceId) : null;
        return {
          botId: r.botInstanceId!,
          botName: bot?.name ?? "—",
          botUsername: bot?.telegramBotUsername ?? null,
          userCount: r._count.id
        };
      })
      .sort((a, b) => b.userCount - a.userCount);

    const multiBotUserCount = Number(multiBotRaw[0]?.count ?? 0);

    return {
      totalUsers,
      totalBots: bots.length,
      usersByBot,
      multiBotUserCount
    };
  }

  public async getBotAudience(
    botId: string,
    filters: Omit<UserDirectoryFilters, "botInstanceIds">,
    pagination: UserDirectoryPagination,
    sort: UserDirectorySort
  ): Promise<UserDirectoryListResult> {
    return this.listUsersAcrossBots(
      { ...filters, botInstanceIds: [botId] },
      pagination,
      sort
    );
  }
}
