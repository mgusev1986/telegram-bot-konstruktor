import { describe, expect, it, vi } from "vitest";

import { UserService } from "../src/modules/users/user.service";

describe("UserService", () => {
  it("findByIdentifier resolves @username case-insensitively inside current bot", async () => {
    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: "u1" })
      }
    } as any;

    const service = new UserService(prisma, "bot1");
    const result = await service.findByIdentifier("@Test_User");

    expect(result).toEqual({ id: "u1" });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        username: { equals: "Test_User", mode: "insensitive" },
        botInstanceId: "bot1"
      }
    });
  });

  it("findByIdentifier resolves Telegram ID inside current bot", async () => {
    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue({ id: "u2" })
      }
    } as any;

    const service = new UserService(prisma, "bot1");
    const result = await service.findByIdentifier("123456789");

    expect(result).toEqual({ id: "u2" });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: {
        telegramUserId: BigInt("123456789"),
        botInstanceId: "bot1"
      }
    });
  });

  it("findByIdOrShort resolves full id first and falls back to 12-char short id", async () => {
    const prisma = {
      user: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: "11111111-1111-1111-1111-111111111111" })
      }
    } as any;

    const service = new UserService(prisma, "bot1");
    const result = await service.findByIdOrShort("11111111-111");

    expect(result).toEqual({ id: "11111111-1111-1111-1111-111111111111" });
    expect(prisma.user.findFirst).toHaveBeenNthCalledWith(1, {
      where: {
        id: "11111111-111",
        botInstanceId: "bot1"
      }
    });
    expect(prisma.user.findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        botInstanceId: "bot1",
        id: { startsWith: "11111111-111" }
      }
    });
  });
});
