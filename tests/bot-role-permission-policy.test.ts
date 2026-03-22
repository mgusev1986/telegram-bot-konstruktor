import { describe, expect, it, vi } from "vitest";

import type { PermissionService } from "../src/modules/permissions/permission.service";
import { PermissionService as PermissionServiceImpl } from "../src/modules/permissions/permission.service";
import { ForbiddenError } from "../src/common/errors";

describe("Bot-scoped OWNER/ADMIN policy (PermissionService)", () => {
  const buildService = (opts: {
    actorUserRole: string;
    actorActiveBotRole: "OWNER" | "ADMIN" | null;
    botInstanceId?: string;
  }) => {
    const botInstanceId = opts.botInstanceId ?? "bot1";
    const prisma = {
      user: {
        findUnique: vi.fn().mockImplementation(({ where }: any) => {
          const role = where?.id === "actor" ? opts.actorUserRole : "USER";
          return { id: where.id, role, adminPermission: undefined };
        }),
        update: vi.fn().mockResolvedValue({ id: "target" })
      },
      botRoleAssignment: {
        findFirst: vi.fn().mockResolvedValue(
          opts.actorActiveBotRole ? { role: opts.actorActiveBotRole, status: "ACTIVE" } : null
        )
      },
      $transaction: vi.fn(async (ops: any[]) => Promise.all(ops))
    } as any;

    const users = {} as any;
    const audit = { log: vi.fn() } as any;

    const service = new PermissionServiceImpl(prisma, users, audit, botInstanceId);
    return { prisma, audit, service, botInstanceId };
  };

  it("ALPHA_OWNER canAssignBotOwner (OWNER assignment)", async () => {
    const { service } = buildService({ actorUserRole: "ALPHA_OWNER", actorActiveBotRole: null });
    await expect(service.canAssignBotOwner("actor")).resolves.toBe(true);
  });

  it("OWNER cannot canAssignBotOwner (only ALPHA_OWNER)", async () => {
    const { service } = buildService({ actorUserRole: "USER", actorActiveBotRole: "OWNER" });
    await expect(service.canAssignBotOwner("actor")).resolves.toBe(false);
  });

  it("bot OWNER can canAssignBotAdmin", async () => {
    const { service } = buildService({ actorUserRole: "USER", actorActiveBotRole: "OWNER" });
    await expect(service.canAssignBotAdmin("actor")).resolves.toBe(true);
  });

  it("ALPHA_OWNER can canAssignBotAdmin", async () => {
    const { service } = buildService({ actorUserRole: "ALPHA_OWNER", actorActiveBotRole: null });
    await expect(service.canAssignBotAdmin("actor")).resolves.toBe(true);
  });

  it("bot ADMIN cannot canAssignBotAdmin", async () => {
    const { service } = buildService({ actorUserRole: "USER", actorActiveBotRole: "ADMIN" });
    await expect(service.canAssignBotAdmin("actor")).resolves.toBe(false);
  });

  it("canRevokeBotOwner is ALPHA_OWNER-only", async () => {
    const { service: alphaSvc } = buildService({ actorUserRole: "ALPHA_OWNER", actorActiveBotRole: null });
    const { service: ownerSvc } = buildService({ actorUserRole: "USER", actorActiveBotRole: "OWNER" });
    await expect(alphaSvc.canRevokeBotOwner("actor")).resolves.toBe(true);
    await expect(ownerSvc.canRevokeBotOwner("actor")).resolves.toBe(false);
  });
});
