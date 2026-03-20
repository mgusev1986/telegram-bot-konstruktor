import { describe, expect, it, vi } from "vitest";

import { PermissionService } from "../src/modules/permissions/permission.service";
import { canManageLanguages } from "../src/modules/permissions/capabilities";
import { ForbiddenError } from "../src/common/errors";

describe("Language management permissions", () => {
  it("capabilities: canManageLanguages(ALPHA_OWNER)=true, others=false", () => {
    expect(canManageLanguages("ALPHA_OWNER")).toBe(true);
    expect(canManageLanguages("OWNER")).toBe(false);
    expect(canManageLanguages("ADMIN")).toBe(false);
    expect(canManageLanguages("USER")).toBe(false);
  });

  it("PermissionService: hasPermission(canManageLanguages) is ALPHA_OWNER-only", async () => {
    const prisma = {
      user: {
        findUnique: vi.fn().mockImplementation(({ where }: any) => {
          const role =
            where?.id === "alpha"
              ? "ALPHA_OWNER"
              : where?.id === "owner"
                ? "OWNER"
                : where?.id === "admin"
                  ? "ADMIN"
                  : "USER";

          return {
            id: where.id,
            role,
            adminPermission: {
              // Intentionally allow languages on ADMIN to ensure clamping.
              canManageLanguages: role === "ADMIN"
            }
          };
        })
      }
    } as any;

    const users = {} as any;
    const audit = {} as any;

    const service = new PermissionService(prisma, users, audit);

    await expect(service.hasPermission("alpha", "canManageLanguages")).resolves.toBe(true);
    await expect(service.hasPermission("owner", "canManageLanguages")).resolves.toBe(false);
    await expect(service.hasPermission("admin", "canManageLanguages")).resolves.toBe(false);
    await expect(service.hasPermission("user", "canManageLanguages")).resolves.toBe(false);
  });

  it("PermissionService: ensureCanManageLanguages throws for non-alpha and succeeds for ALPHA_OWNER", async () => {
    const prisma = {
      user: {
        findUnique: vi.fn().mockImplementation(({ where }: any) => {
          const role =
            where?.id === "alpha"
              ? "ALPHA_OWNER"
              : where?.id === "owner"
                ? "OWNER"
                : where?.id === "user"
                  ? "USER"
                  : "ADMIN";
          return { id: where.id, role, adminPermission: { canManageLanguages: true } };
        })
      }
    } as any;

    const users = {} as any;
    const audit = {} as any;
    const service = new PermissionService(prisma, users, audit);

    await expect(service.ensureCanManageLanguages("alpha")).resolves.toBeUndefined();

    await expect(service.ensureCanManageLanguages("owner")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.ensureCanManageLanguages("admin")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(service.ensureCanManageLanguages("user")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

