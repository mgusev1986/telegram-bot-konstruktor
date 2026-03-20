import { describe, expect, it, vi } from "vitest";

import type { BotRoleAssignmentStatus, BotScopedRole } from "@prisma/client";

import { BotRoleAssignmentService } from "../src/modules/bot-roles/bot-role-assignment.service";

describe("BotRoleAssignmentService", () => {
  const botInstanceId = "bot1";

  const makeService = (overrides?: Partial<any>) => {
    const prisma = {
      user: {
        findFirst: vi.fn().mockResolvedValue(null)
      },
      botRoleAssignment: {
        findFirst: vi.fn().mockResolvedValue(null),
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "a1" }),
        update: vi.fn().mockResolvedValue({ id: "a1" })
      }
    };

    const permissions = {
      canAssignBotOwner: vi.fn().mockResolvedValue(true),
      canAssignBotAdmin: vi.fn().mockResolvedValue(true),
      canRevokeBotOwner: vi.fn().mockResolvedValue(true),
      canRevokeBotAdmin: vi.fn().mockResolvedValue(true)
    };

    const audit = { log: vi.fn().mockResolvedValue(undefined) };

    const mergedPrisma = { ...prisma, ...(overrides?.prisma ?? {}) };
    const mergedPermissions = { ...permissions, ...(overrides?.permissions ?? {}) };
    const mergedAudit = { ...audit, ...(overrides?.audit ?? {}) };

    return {
      prisma: mergedPrisma,
      permissions: mergedPermissions,
      audit: mergedAudit,
      service: new BotRoleAssignmentService(mergedPrisma as any, botInstanceId, mergedPermissions as any, mergedAudit as any)
    };
  };

  it("creates PENDING assignment when user not found", async () => {
    const { prisma, permissions, audit, service } = makeService();

    await service.assignRoleByTelegramUsername({
      actorUserId: "alpha",
      telegramUsername: "@User_Name",
      role: "ADMIN" as BotScopedRole
    });

    expect(permissions.canAssignBotAdmin).toHaveBeenCalledWith("alpha");
    expect(prisma.botRoleAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          botInstanceId,
          telegramUsernameNormalized: "user_name",
          role: "ADMIN",
          status: "PENDING",
          userId: null
        })
      })
    );
    expect(audit.log).toHaveBeenCalled();
  });

  it("activates assignment when user exists", async () => {
    const { prisma, permissions, service } = makeService({
      prisma: {
        user: {
          findFirst: vi.fn().mockResolvedValue({ id: "u1", role: "USER" })
        }
      }
    });

    await service.assignRoleByTelegramUsername({
      actorUserId: "alpha",
      telegramUsername: "user_name",
      role: "OWNER" as BotScopedRole
    });

    expect(permissions.canAssignBotOwner).toHaveBeenCalledWith("alpha");
    expect(prisma.botRoleAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          role: "OWNER",
          status: "ACTIVE",
          userId: "u1"
        })
      })
    );
  });

  it("changes role for PENDING assignment without touching permissions", async () => {
    const assignment = {
      id: "a1",
      botInstanceId,
      userId: null,
      role: "ADMIN",
      status: "PENDING"
    };

    const { prisma, permissions, service } = makeService({
      prisma: {
        botRoleAssignment: {
          findUnique: vi.fn().mockResolvedValue(assignment),
          update: vi.fn().mockResolvedValue(assignment)
        }
      }
    });

    await service.changeRoleByAssignmentId({
      actorUserId: "alpha",
      assignmentId: "a1",
      newRole: "OWNER" as BotScopedRole
    });

    expect(permissions.canAssignBotOwner).toHaveBeenCalledWith("alpha");
    expect(prisma.botRoleAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a1" },
        data: expect.objectContaining({
          role: "OWNER",
          status: "PENDING"
        })
      })
    );
  });

  it("rechecks pending assignment: links user -> ACTIVE and calls grantBotAdmin", async () => {
    const assignment: any = {
      id: "a1",
      botInstanceId,
      status: "PENDING",
      telegramUsernameNormalized: "user_name",
      role: "ADMIN",
      userId: null
    };

    const { prisma, permissions, audit, service } = makeService({
      prisma: {
        botRoleAssignment: {
          findUnique: vi.fn().mockResolvedValue(assignment),
          update: vi.fn().mockResolvedValue(assignment)
        },
        user: {
          findFirst: vi.fn().mockResolvedValue({ id: "u1" })
        }
      }
    });

    await service.recheckPendingByAssignmentId({
      actorUserId: "alpha",
      assignmentId: "a1"
    });

    expect(permissions.canAssignBotAdmin).toHaveBeenCalledWith("alpha");
    expect(prisma.botRoleAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a1" },
        data: expect.objectContaining({
          status: "ACTIVE",
          userId: "u1"
        })
      })
    );
    expect(audit.log).toHaveBeenCalled();
  });
});

