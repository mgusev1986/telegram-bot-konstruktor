import type { BotScopedRole, BotRoleAssignmentStatus, PrismaClient, UserRole } from "@prisma/client";

import { ForbiddenError, NotFoundError } from "../../common/errors";
import type { AuditService } from "../audit/audit.service";
import type { UserService } from "../users/user.service";
import { canManageLanguages, canManageAdmins } from "./capabilities";

export type AdminPermissionKey =
  | "canEditMenu"
  | "canSendBroadcasts"
  | "canScheduleMessages"
  | "canManageLanguages"
  | "canManagePayments"
  | "canManageSegments"
  | "canViewGlobalStats"
  | "canManageTemplates";

// Admins (role ADMIN) must NEVER get language management rights.
const FULL_ACCESS_ADMIN: Record<AdminPermissionKey, boolean> = {
  canEditMenu: true,
  canSendBroadcasts: true,
  canScheduleMessages: true,
  canManageLanguages: false,
  canManagePayments: true,
  canManageSegments: true,
  canViewGlobalStats: true,
  canManageTemplates: true
};

// ALPHA_OWNER is absolute access: PermissionService treats it as fully allowed in hasPermission().
const FULL_ACCESS_ALPHA: Record<AdminPermissionKey, boolean> = {
  canEditMenu: true,
  canSendBroadcasts: true,
  canScheduleMessages: true,
  canManageLanguages: true,
  canManagePayments: true,
  canManageSegments: true,
  canViewGlobalStats: true,
  canManageTemplates: true
};

export class PermissionService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly users: UserService,
    private readonly audit: AuditService,
    private readonly botInstanceId?: string
  ) {}

  public async getRole(userId: string): Promise<UserRole | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true }
    });

    return user?.role ?? null;
  }

  public async canManageAdminsOfUser(userId: string): Promise<boolean> {
    const role = await this.getRole(userId);
    return canManageAdmins(role as any);
  }

  public async ensureCanManageAdmins(userId: string): Promise<void> {
    if (!(await this.canManageAdminsOfUser(userId))) {
      throw new ForbiddenError();
    }
  }

  public async canManageLanguagesOfUser(userId: string): Promise<boolean> {
    const role = await this.getRole(userId);
    return canManageLanguages(role as any);
  }

  public async ensureCanManageLanguages(userId: string): Promise<void> {
    if (!(await this.canManageLanguagesOfUser(userId))) {
      throw new ForbiddenError();
    }
  }

  // Backwards-compatible name: grant_admin/revoke_admin were previously OWNER-only.
  // Now both OWNER and ALPHA_OWNER can manage admin permissions.
  public async ensureOwner(userId: string): Promise<void> {
    return this.ensureCanManageAdmins(userId);
  }

  public async ensureAlphaOwner(userId: string): Promise<void> {
    const role = await this.getRole(userId);
    if (role !== "ALPHA_OWNER") {
      throw new ForbiddenError();
    }
  }

  public async hasPermission(userId: string, permission: AdminPermissionKey): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true }
    });

    if (!user) {
      return false;
    }

    // ALPHA_OWNER has absolute access to all permissions.
    if (user.role === "ALPHA_OWNER") {
      return true;
    }

    // Language management is ALPHA_OWNER-only (global).
    if (permission === "canManageLanguages") return false;

    // Bot-scoped permissions:
    // If this service is created with botInstanceId, we resolve permissions from ACTIVE BotRoleAssignment.
    if (this.botInstanceId) {
      const assignment = await this.prisma.botRoleAssignment.findFirst({
        where: { botInstanceId: this.botInstanceId, userId, status: "ACTIVE" },
        select: { role: true, status: true }
      });

      if (!assignment) return false;

      // Policy: OWNER is broadly allowed; ADMIN is narrower (cannot manage templates).
      switch (assignment.role as BotScopedRole) {
        case "OWNER":
          return true; // we already handled canManageLanguages above
        case "ADMIN":
          return true; // keep bot-scoped ADMIN feature set broad (except language management)
        default:
          return false;
      }
    }

    // Fallback: without botInstanceId, default deny except ALPHA_OWNER.
    return false;
  }

  public async ensurePermission(userId: string, permission: AdminPermissionKey): Promise<void> {
    const allowed = await this.hasPermission(userId, permission);

    if (!allowed) {
      throw new ForbiddenError();
    }
  }

  public async grantAdmin(
    actorUserId: string,
    targetIdentifier: string,
    permissions?: Partial<Record<AdminPermissionKey, boolean>>
  ): Promise<void> {
    await this.ensureCanManageAdmins(actorUserId);
    const user = await this.users.findByIdentifier(targetIdentifier);

    if (!user) {
      throw new NotFoundError("Target user not found");
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: { role: "ADMIN" }
      }),
      this.prisma.adminPermission.upsert({
        where: { userId: user.id },
        update: {
          ...FULL_ACCESS_ADMIN,
          ...(permissions ?? {}),
          // Force language management off for ADMIN users.
          canManageLanguages: false
        },
        create: {
          userId: user.id,
          ...FULL_ACCESS_ADMIN,
          ...(permissions ?? {}),
          // Force language management off for ADMIN users.
          canManageLanguages: false
        }
      })
    ]);

    await this.audit.log(actorUserId, "grant_admin", "user", user.id, {
      targetIdentifier,
      permissions: permissions ?? FULL_ACCESS_ADMIN
    });
  }

  public async revokeAdmin(actorUserId: string, targetIdentifier: string): Promise<void> {
    await this.ensureCanManageAdmins(actorUserId);
    const user = await this.users.findByIdentifier(targetIdentifier);

    if (!user) {
      throw new NotFoundError("Target user not found");
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          role: "USER"
        }
      }),
      this.prisma.adminPermission.deleteMany({
        where: { userId: user.id }
      })
    ]);

    await this.audit.log(actorUserId, "revoke_admin", "user", user.id, {
      targetIdentifier
    });
  }

  public async isAlphaOwner(userId: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    return user?.role === "ALPHA_OWNER";
  }

  public async getActiveBotRole(userId: string): Promise<BotScopedRole | null> {
    if (!this.botInstanceId) return null;
    const row = await this.prisma.botRoleAssignment.findFirst({
      where: { botInstanceId: this.botInstanceId, userId, status: "ACTIVE" },
      select: { role: true }
    });
    return (row?.role as BotScopedRole | null) ?? null;
  }

  /**
   * Returns true if the user has a PENDING BotRoleAssignment for this bot (matched by telegram username).
   * Such users see an empty screen until the alpha owner activates them via backoffice "Сверить сейчас".
   */
  public async hasPendingOwnerAssignment(userId: string): Promise<boolean> {
    if (!this.botInstanceId) return false;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { username: true }
    });
    if (!user?.username?.trim()) return false;
    const normalized = user.username.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9_]{5,32}$/.test(normalized)) return false;
    const row = await this.prisma.botRoleAssignment.findFirst({
      where: {
        botInstanceId: this.botInstanceId,
        telegramUsernameNormalized: normalized,
        status: "PENDING"
      },
      select: { id: true }
    });
    return row != null;
  }

  public async canAssignBotOwner(actorUserId: string): Promise<boolean> {
    return this.isAlphaOwner(actorUserId);
  }

  public async canAssignBotAdmin(actorUserId: string): Promise<boolean> {
    if (await this.isAlphaOwner(actorUserId)) return true;
    const role = await this.getActiveBotRole(actorUserId);
    return role === "OWNER";
  }

  public async canRevokeBotOwner(actorUserId: string): Promise<boolean> {
    return this.isAlphaOwner(actorUserId);
  }

  public async canRevokeBotAdmin(actorUserId: string): Promise<boolean> {
    if (await this.isAlphaOwner(actorUserId)) return true;
    const role = await this.getActiveBotRole(actorUserId);
    return role === "OWNER";
  }
}
