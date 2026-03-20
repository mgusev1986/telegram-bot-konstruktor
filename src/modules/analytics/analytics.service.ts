import type { PrismaClient } from "@prisma/client";

export class AnalyticsService {
  public constructor(private readonly prisma: PrismaClient) {}

  public async recordMenuClick(userId: string, menuItemId: string, languageCode: string): Promise<void> {
    await this.prisma.buttonClickEvent.create({
      data: {
        userId,
        menuItemId,
        languageCode
      }
    });
  }

  public async getTopMenuItems(limit = 10): Promise<Array<{ menuItemId: string; clicks: number }>> {
    const rows = await this.prisma.buttonClickEvent.groupBy({
      by: ["menuItemId"],
      _count: {
        _all: true
      },
      orderBy: {
        _count: {
          menuItemId: "desc"
        }
      },
      take: limit
    });

    return rows.map((row) => ({
      menuItemId: row.menuItemId,
      clicks: row._count._all
    }));
  }
}
