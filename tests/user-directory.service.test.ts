import { beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { UserDirectoryService } from "../src/modules/users/user-directory.service";

describe("UserDirectoryService", () => {
  let prisma: PrismaClient;
  let service: UserDirectoryService;

  beforeEach(async () => {
    prisma = new PrismaClient();
    service = new UserDirectoryService(prisma);
  });

  it("listUsersAcrossBots returns paginated results", async () => {
    const result = await service.listUsersAcrossBots(
      {},
      { page: 1, perPage: 10 },
      { sortBy: "createdAt", order: "desc" }
    );
    expect(result).toHaveProperty("rows");
    expect(result).toHaveProperty("total");
    expect(result).toHaveProperty("page", 1);
    expect(result).toHaveProperty("perPage", 10);
    expect(Array.isArray(result.rows)).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it("getDirectorySummary returns summary with totals", async () => {
    const summary = await service.getDirectorySummary();
    expect(summary).toHaveProperty("totalUsers");
    expect(summary).toHaveProperty("totalBots");
    expect(summary).toHaveProperty("usersByBot");
    expect(summary).toHaveProperty("multiBotUserCount");
    expect(Array.isArray(summary.usersByBot)).toBe(true);
    expect(summary.totalUsers).toBeGreaterThanOrEqual(0);
    expect(summary.totalBots).toBeGreaterThanOrEqual(0);
    expect(summary.multiBotUserCount).toBeGreaterThanOrEqual(0);
  });

  it("filters by botInstanceIds when provided", async () => {
    const bots = await prisma.botInstance.findMany({ take: 1 });
    if (bots.length === 0) {
      const result = await service.listUsersAcrossBots(
        { botInstanceIds: ["non-existent-id"] },
        { page: 1, perPage: 10 },
        { sortBy: "createdAt", order: "desc" }
      );
      expect(result.rows).toHaveLength(0);
      expect(result.total).toBe(0);
      return;
    }
    const result = await service.listUsersAcrossBots(
      { botInstanceIds: [bots[0]!.id] },
      { page: 1, perPage: 10 },
      { sortBy: "createdAt", order: "desc" }
    );
    for (const row of result.rows) {
      expect(row.botInstanceId).toBe(bots[0]!.id);
    }
  });
});
