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
        findMany: vi.fn().mockResolvedValue([]),
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

  it("getUserManagementTarget resolves USER role and allows assign/delete", async () => {
    const { service } = makeService({
      prisma: {
        user: {
          findFirst: vi.fn().mockResolvedValue({
            id: "u1",
            botInstanceId,
            telegramUserId: BigInt("100"),
            username: "user_one",
            firstName: "User",
            lastName: "One",
            fullName: "User One",
            role: "USER"
          })
        },
        botRoleAssignment: {
          findFirst: vi.fn().mockResolvedValue(null)
        }
      }
    });

    const target = await service.getUserManagementTarget("u1");

    expect(target?.role).toBe("USER");
    expect(target?.canAssignAdmin).toBe(true);
    expect(target?.canRevokeAdmin).toBe(false);
    expect(target?.canDeleteFromBase).toBe(true);
  });

  it("getUserManagementTarget resolves OWNER and protects delete/revoke", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "u2",
        botInstanceId,
        telegramUserId: BigInt("200"),
        username: "owner_user",
        firstName: "Owner",
        lastName: "User",
        fullName: "Owner User",
        role: "USER"
      })
      .mockResolvedValueOnce({
        id: "a-owner",
        role: "OWNER",
        status: "ACTIVE",
        telegramUsernameRaw: "owner_user",
        telegramUsernameNormalized: "owner_user"
      });

    const { service } = makeService({
      prisma: {
        user: { findFirst },
        botRoleAssignment: { findFirst }
      }
    });

    const target = await service.getUserManagementTarget("u2");

    expect(target?.role).toBe("OWNER");
    expect(target?.canAssignAdmin).toBe(false);
    expect(target?.canRevokeAdmin).toBe(false);
    expect(target?.canDeleteFromBase).toBe(false);
  });

  it("getUserManagementTarget resolves ALPHA_OWNER and protects delete/revoke", async () => {
    const { service } = makeService({
      prisma: {
        user: {
          findFirst: vi.fn().mockResolvedValue({
            id: "alpha-user",
            botInstanceId,
            telegramUserId: BigInt("999"),
            username: "alpha_owner",
            firstName: "Alpha",
            lastName: "Owner",
            fullName: "Alpha Owner",
            role: "ALPHA_OWNER"
          })
        },
        botRoleAssignment: {
          findFirst: vi.fn().mockResolvedValue(null)
        }
      }
    });

    const target = await service.getUserManagementTarget("alpha-user");

    expect(target?.role).toBe("ALPHA_OWNER");
    expect(target?.canAssignAdmin).toBe(false);
    expect(target?.canRevokeAdmin).toBe(false);
    expect(target?.canDeleteFromBase).toBe(false);
  });

  it("assignAdminToUser creates ACTIVE assignment even when user has no username", async () => {
    const userFindFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "u3",
        botInstanceId,
        telegramUserId: BigInt("333333"),
        username: null,
        firstName: "No",
        lastName: "Username",
        fullName: "No Username",
        role: "USER"
      })
      .mockResolvedValueOnce(null);

    const assignmentFindFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const { prisma, permissions, service } = makeService({
      prisma: {
        user: { findFirst: userFindFirst },
        botRoleAssignment: {
          findFirst: assignmentFindFirst,
          create: vi.fn().mockResolvedValue({ id: "a-no-username" })
        }
      }
    });

    await service.assignAdminToUser({ actorUserId: "owner", targetUserId: "u3" });

    expect(permissions.canAssignBotAdmin).toHaveBeenCalledWith("owner");
    expect(prisma.botRoleAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: "u3",
          role: "ADMIN",
          status: "ACTIVE",
          telegramUsernameRaw: null,
          telegramUsernameNormalized: "tgid_333333"
        })
      })
    );
  });

  it("revokeAdminFromUser revokes active ADMIN assignment", async () => {
    const userFindFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "u4",
        botInstanceId,
        telegramUserId: BigInt("444"),
        username: "admin_user",
        firstName: "Admin",
        lastName: "User",
        fullName: "Admin User",
        role: "USER"
      });

    const assignmentFindFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "a4",
        role: "ADMIN",
        status: "ACTIVE",
        telegramUsernameRaw: "admin_user",
        telegramUsernameNormalized: "admin_user"
      })
      .mockResolvedValueOnce({ id: "a4" });

    const { prisma, permissions, service } = makeService({
      prisma: {
        user: { findFirst: userFindFirst },
        botRoleAssignment: {
          findFirst: assignmentFindFirst,
          update: vi.fn().mockResolvedValue({ id: "a4" })
        }
      }
    });

    await service.revokeAdminFromUser({ actorUserId: "owner", targetUserId: "u4" });

    expect(permissions.canRevokeBotAdmin).toHaveBeenCalledWith("owner");
    expect(prisma.botRoleAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "a4" },
        data: expect.objectContaining({ status: "REVOKED" })
      })
    );
  });

  it("revokeAdminFromUser rejects OWNER target", async () => {
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce({
        id: "u5",
        botInstanceId,
        telegramUserId: BigInt("555"),
        username: "owner_user",
        firstName: "Owner",
        lastName: "User",
        fullName: "Owner User",
        role: "USER"
      })
      .mockResolvedValueOnce({
        id: "a5",
        role: "OWNER",
        status: "ACTIVE",
        telegramUsernameRaw: "owner_user",
        telegramUsernameNormalized: "owner_user"
      });

    const { service } = makeService({
      prisma: {
        user: { findFirst },
        botRoleAssignment: { findFirst }
      }
    });

    await expect(service.revokeAdminFromUser({ actorUserId: "alpha", targetUserId: "u5" })).rejects.toThrow();
  });

  it("listActiveAdmins returns bot admins including records without username", async () => {
    const { service } = makeService({
      prisma: {
        botRoleAssignment: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "a1",
              role: "ADMIN",
              status: "ACTIVE",
              telegramUsernameRaw: "alpha_admin",
              telegramUsernameNormalized: "alpha_admin",
              user: {
                id: "u1",
                botInstanceId,
                telegramUserId: BigInt("111"),
                username: "alpha_admin",
                firstName: "Alpha",
                lastName: "Admin",
                fullName: "Alpha Admin",
                role: "USER"
              }
            },
            {
              id: "a2",
              role: "ADMIN",
              status: "ACTIVE",
              telegramUsernameRaw: null,
              telegramUsernameNormalized: "tgid_222",
              user: {
                id: "u2",
                botInstanceId,
                telegramUserId: BigInt("222"),
                username: null,
                firstName: "No",
                lastName: "Username",
                fullName: "No Username",
                role: "USER"
              }
            }
          ])
        }
      }
    });

    const admins = await service.listActiveAdmins();

    expect(admins).toHaveLength(2);
    expect(admins[0]?.role).toBe("ADMIN");
    expect(admins[1]?.user.username).toBeNull();
  });
});
