import type { BotRoleAssignmentStatus, BotScopedRole, PrismaClient, User } from "@prisma/client";
import { ForbiddenError, NotFoundError, ValidationError } from "../../common/errors";
import { AuditService } from "../audit/audit.service";
import { PermissionService } from "../permissions/permission.service";

export type NormalizedTelegramUsername = {
  telegramUsernameRaw: string; // without leading @, trimmed (original-ish)
  telegramUsernameNormalized: string; // lowercase, without leading @
};

export type BotRoleAssignmentFilters = {
  q?: string;
  role?: BotScopedRole | "ALL";
  status?: BotRoleAssignmentStatus | "ALL";
};

export type ManagedBotUserRole = "ALPHA_OWNER" | "OWNER" | "ADMIN" | "USER";

export type UserManagementTarget = {
  user: Pick<User, "id" | "botInstanceId" | "telegramUserId" | "username" | "firstName" | "lastName" | "fullName" | "role">;
  role: ManagedBotUserRole;
  canAssignAdmin: boolean;
  canRevokeAdmin: boolean;
  canDeleteFromBase: boolean;
};

type ManagedUserRecord = Pick<
  User,
  "id" | "botInstanceId" | "telegramUserId" | "username" | "firstName" | "lastName" | "fullName" | "role"
>;

type ActiveAssignmentRecord = {
  id: string;
  role: BotScopedRole;
  status: BotRoleAssignmentStatus;
  telegramUsernameRaw: string | null;
  telegramUsernameNormalized: string;
};

const TELEGRAM_ID_ASSIGNMENT_PREFIX = "tgid_";

function normalizeTelegramUsernameInput(input: string): NormalizedTelegramUsername {
  const raw = String(input ?? "").trim().replace(/^@/, "");
  const normalized = raw.toLowerCase();

  // Telegram usernames: 5-32 chars, letters/digits/underscore.
  if (!/^[a-z0-9_]{5,32}$/.test(normalized)) {
    throw new ValidationError("Некорректный Telegram username.");
  }

  return {
    telegramUsernameRaw: raw,
    telegramUsernameNormalized: normalized
  };
}

export class BotRoleAssignmentService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly botInstanceId: string,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService
  ) {}

  public async listAssignments(filters: BotRoleAssignmentFilters): Promise<
    Array<{
      id: string;
      role: BotScopedRole;
      status: BotRoleAssignmentStatus;
      telegramUsernameRaw: string | null;
      telegramUsernameNormalized: string;
      userId: string | null;
      user: Pick<User, "id" | "telegramUserId" | "username"> | null;
      createdAt: Date;
      updatedAt: Date;
      revokedAt: Date | null;
      activatedAt: Date | null;
    }>
  > {
    const q = String(filters.q ?? "").trim().toLowerCase();
    const roleFilter = filters.role && filters.role !== "ALL" ? filters.role : null;
    const statusFilter = filters.status && filters.status !== "ALL" ? filters.status : null;

    const where: any = {
      botInstanceId: this.botInstanceId
    };

    if (q) {
      where.telegramUsernameNormalized = { contains: q };
    }
    if (roleFilter) where.role = roleFilter;
    if (statusFilter) where.status = statusFilter;

    const rows = await this.prisma.botRoleAssignment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: {
            id: true,
            telegramUserId: true,
            username: true
          }
        }
      }
    });

    return rows.map((r: any) => ({
      id: r.id,
      role: r.role,
      status: r.status,
      telegramUsernameRaw: r.telegramUsernameRaw,
      telegramUsernameNormalized: r.telegramUsernameNormalized,
      userId: r.userId,
      user: r.user,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      revokedAt: r.revokedAt,
      activatedAt: r.activatedAt
    }));
  }

  private normalizeAssignmentIdentity(
    user: Pick<User, "username" | "telegramUserId">,
    existingAssignment?: Pick<ActiveAssignmentRecord, "telegramUsernameRaw" | "telegramUsernameNormalized"> | null
  ): {
    telegramUsernameRaw: string | null;
    telegramUsernameNormalized: string;
  } {
    if (existingAssignment?.telegramUsernameNormalized?.trim()) {
      return {
        telegramUsernameRaw: existingAssignment.telegramUsernameRaw ?? user.username ?? null,
        telegramUsernameNormalized: existingAssignment.telegramUsernameNormalized
      };
    }

    const rawUsername = String(user.username ?? "").trim().replace(/^@/, "");
    if (rawUsername) {
      return {
        telegramUsernameRaw: rawUsername,
        telegramUsernameNormalized: rawUsername.toLowerCase()
      };
    }

    return {
      telegramUsernameRaw: null,
      telegramUsernameNormalized: `${TELEGRAM_ID_ASSIGNMENT_PREFIX}${String(user.telegramUserId)}`
    };
  }

  private buildManagedRole(
    user: Pick<User, "role">,
    activeAssignment: Pick<ActiveAssignmentRecord, "role"> | null
  ): ManagedBotUserRole {
    if (user.role === "ALPHA_OWNER") return "ALPHA_OWNER";
    if (activeAssignment?.role === "OWNER") return "OWNER";
    if (activeAssignment?.role === "ADMIN") return "ADMIN";
    return "USER";
  }

  private buildUserManagementTarget(
    user: ManagedUserRecord,
    activeAssignment: ActiveAssignmentRecord | null
  ): UserManagementTarget {
    const role = this.buildManagedRole(user, activeAssignment);
    return {
      user,
      role,
      canAssignAdmin: role === "USER",
      canRevokeAdmin: role === "ADMIN",
      canDeleteFromBase: role === "USER"
    };
  }

  public async getUserManagementTarget(userId: string): Promise<UserManagementTarget | null> {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        botInstanceId: this.botInstanceId
      },
      select: {
        id: true,
        botInstanceId: true,
        telegramUserId: true,
        username: true,
        firstName: true,
        lastName: true,
        fullName: true,
        role: true
      }
    });

    if (!user) return null;

    const activeAssignment = await this.prisma.botRoleAssignment.findFirst({
      where: {
        botInstanceId: this.botInstanceId,
        userId: user.id,
        status: "ACTIVE"
      },
      select: {
        id: true,
        role: true,
        status: true,
        telegramUsernameRaw: true,
        telegramUsernameNormalized: true
      }
    });

    return this.buildUserManagementTarget(user, activeAssignment);
  }

  public async listActiveAdmins(): Promise<UserManagementTarget[]> {
    const rows = await this.prisma.botRoleAssignment.findMany({
      where: {
        botInstanceId: this.botInstanceId,
        status: "ACTIVE",
        role: "ADMIN"
      },
      orderBy: { updatedAt: "asc" },
      include: {
        user: {
          select: {
            id: true,
            botInstanceId: true,
            telegramUserId: true,
            username: true,
            firstName: true,
            lastName: true,
            fullName: true,
            role: true
          }
        }
      }
    });

    return rows
      .filter((row): row is typeof row & { user: ManagedUserRecord } => row.user != null)
      .map((row) => this.buildUserManagementTarget(row.user, {
        id: row.id,
        role: row.role,
        status: row.status,
        telegramUsernameRaw: row.telegramUsernameRaw,
        telegramUsernameNormalized: row.telegramUsernameNormalized
      }))
      .sort((left, right) => {
        const leftLabel = left.user.username ?? left.user.fullName ?? String(left.user.telegramUserId);
        const rightLabel = right.user.username ?? right.user.fullName ?? String(right.user.telegramUserId);
        return leftLabel.localeCompare(rightLabel, "en", { sensitivity: "base" });
      });
  }

  public async assignAdminToUser(input: { actorUserId: string; targetUserId: string }): Promise<void> {
    const { actorUserId, targetUserId } = input;
    if (!(await this.permissions.canAssignBotAdmin(actorUserId))) {
      throw new ForbiddenError();
    }

    const target = await this.getUserManagementTarget(targetUserId);
    if (!target) throw new NotFoundError("User not found");
    if (target.role === "ALPHA_OWNER" || target.role === "OWNER") {
      throw new ForbiddenError("Protected users cannot be downgraded to ADMIN.");
    }
    if (target.role === "ADMIN") return;

    const existingAssignment = await this.prisma.botRoleAssignment.findFirst({
      where: {
        botInstanceId: this.botInstanceId,
        OR: [
          { userId: target.user.id },
          { telegramUsernameNormalized: this.normalizeAssignmentIdentity(target.user).telegramUsernameNormalized }
        ]
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        telegramUsernameRaw: true,
        telegramUsernameNormalized: true
      }
    });

    const identity = this.normalizeAssignmentIdentity(target.user, existingAssignment);
    const now = new Date();

    const assignment = existingAssignment
      ? await this.prisma.botRoleAssignment.update({
          where: { id: existingAssignment.id },
          data: {
            telegramUsernameRaw: identity.telegramUsernameRaw,
            telegramUsernameNormalized: identity.telegramUsernameNormalized,
            role: "ADMIN",
            status: "ACTIVE",
            userId: target.user.id,
            revokedAt: null,
            activatedAt: now
          }
        })
      : await this.prisma.botRoleAssignment.create({
          data: {
            botInstanceId: this.botInstanceId,
            telegramUsernameRaw: identity.telegramUsernameRaw,
            telegramUsernameNormalized: identity.telegramUsernameNormalized,
            role: "ADMIN",
            status: "ACTIVE",
            userId: target.user.id,
            activatedAt: now
          }
        });

    await this.audit.log(actorUserId, "bot_role_assignment_admin_granted_by_user", "bot_role_assignment", assignment.id, {
      targetUserId: target.user.id
    });
  }

  public async revokeAdminFromUser(input: { actorUserId: string; targetUserId: string }): Promise<void> {
    const { actorUserId, targetUserId } = input;
    if (!(await this.permissions.canRevokeBotAdmin(actorUserId))) {
      throw new ForbiddenError();
    }

    const target = await this.getUserManagementTarget(targetUserId);
    if (!target) throw new NotFoundError("User not found");
    if (target.role === "ALPHA_OWNER" || target.role === "OWNER") {
      throw new ForbiddenError("Protected users cannot be demoted.");
    }
    if (target.role !== "ADMIN") return;

    const activeAssignment = await this.prisma.botRoleAssignment.findFirst({
      where: {
        botInstanceId: this.botInstanceId,
        userId: target.user.id,
        status: "ACTIVE",
        role: "ADMIN"
      },
      select: { id: true }
    });

    if (!activeAssignment) return;

    await this.prisma.botRoleAssignment.update({
      where: { id: activeAssignment.id },
      data: {
        status: "REVOKED",
        revokedAt: new Date()
      }
    });

    await this.audit.log(actorUserId, "bot_role_assignment_admin_revoked_by_user", "bot_role_assignment", activeAssignment.id, {
      targetUserId: target.user.id
    });
  }

  public async assignRoleByTelegramUsername(input: {
    actorUserId: string;
    telegramUsername: string;
    role: BotScopedRole;
  }): Promise<{ assignmentId: string }> {
    const { actorUserId, telegramUsername, role } = input;
    const { telegramUsernameRaw, telegramUsernameNormalized } = normalizeTelegramUsernameInput(telegramUsername);

    // Authorization: centralized, bot-scoped.
    if (role === "OWNER") {
      if (!(await this.permissions.canAssignBotOwner(actorUserId))) {
        throw new ForbiddenError();
      }
    } else {
      if (!(await this.permissions.canAssignBotAdmin(actorUserId))) {
        throw new ForbiddenError();
      }
    }

    const existingUser = await this.prisma.user.findFirst({
      where: {
        botInstanceId: this.botInstanceId,
        username: {
          equals: telegramUsernameNormalized,
          mode: "insensitive"
        }
      },
      select: { id: true, role: true }
    });

    // Find current assignment (single row per bot+username via @@unique).
    const existingAssignment = await this.prisma.botRoleAssignment.findFirst({
      where: {
        botInstanceId: this.botInstanceId,
        telegramUsernameNormalized
      }
    });

    if (existingUser) {
      const assignment = existingAssignment
        ? await this.prisma.botRoleAssignment.update({
            where: { id: existingAssignment.id },
            data: {
              telegramUsernameRaw,
              role,
              status: "ACTIVE",
              userId: existingUser.id,
              revokedAt: null,
              activatedAt: new Date()
            }
          })
        : await this.prisma.botRoleAssignment.create({
            data: {
              botInstanceId: this.botInstanceId,
              telegramUsernameRaw,
              telegramUsernameNormalized,
              role,
              status: "ACTIVE",
              userId: existingUser.id,
              activatedAt: new Date()
            }
          });

      await this.audit.log(actorUserId, "bot_role_assignment_activated", "bot_role_assignment", assignment.id, {
        role
      });

      return { assignmentId: assignment.id };
    }

    if (existingAssignment) {
      const assignment = await this.prisma.botRoleAssignment.update({
        where: { id: existingAssignment.id },
        data: {
          telegramUsernameRaw,
          telegramUsernameNormalized,
          role,
          status: "PENDING",
          userId: null,
          revokedAt: null
        }
      });

      await this.audit.log(actorUserId, "bot_role_assignment_pending_updated", "bot_role_assignment", assignment.id, {
        role
      });

      return { assignmentId: assignment.id };
    }

    const assignment = await this.prisma.botRoleAssignment.create({
      data: {
        botInstanceId: this.botInstanceId,
        telegramUsernameRaw,
        telegramUsernameNormalized,
        role,
        status: "PENDING",
        userId: null
      }
    });

    await this.audit.log(actorUserId, "bot_role_assignment_pending_created", "bot_role_assignment", assignment.id, { role });
    return { assignmentId: assignment.id };
  }

  public async changeRoleByAssignmentId(input: {
    actorUserId: string;
    assignmentId: string;
    newRole: BotScopedRole;
  }): Promise<void> {
    const { actorUserId, assignmentId, newRole } = input;

    const assignment = await this.prisma.botRoleAssignment.findUnique({
      where: { id: assignmentId }
    });
    if (!assignment) throw new NotFoundError("Assignment not found");
    if (assignment.botInstanceId !== this.botInstanceId) throw new ForbiddenError();

    if (newRole === "OWNER") {
      if (!(await this.permissions.canAssignBotOwner(actorUserId))) throw new ForbiddenError();
    } else {
      if (!(await this.permissions.canAssignBotAdmin(actorUserId))) throw new ForbiddenError();
    }

    await this.prisma.botRoleAssignment.update({
      where: { id: assignmentId },
      data: {
        role: newRole,
        status: assignment.userId ? "ACTIVE" : "PENDING",
        revokedAt: null,
        activatedAt: assignment.userId ? new Date() : null
      }
    });

    await this.audit.log(actorUserId, "bot_role_assignment_changed", "bot_role_assignment", assignmentId, { from: assignment.role, to: newRole });
  }

  public async revokeByAssignmentId(input: { actorUserId: string; assignmentId: string }): Promise<void> {
    const { actorUserId, assignmentId } = input;

    const assignment = await this.prisma.botRoleAssignment.findUnique({
      where: { id: assignmentId }
    });
    if (!assignment) throw new NotFoundError("Assignment not found");
    if (assignment.botInstanceId !== this.botInstanceId) throw new ForbiddenError();

    if (assignment.role === "OWNER") {
      if (!(await this.permissions.canRevokeBotOwner(actorUserId))) throw new ForbiddenError();
    } else {
      if (!(await this.permissions.canRevokeBotAdmin(actorUserId))) throw new ForbiddenError();
    }

    await this.prisma.botRoleAssignment.update({
      where: { id: assignmentId },
      data: {
        status: "REVOKED",
        revokedAt: new Date()
      }
    });

    await this.audit.log(actorUserId, "bot_role_assignment_revoked", "bot_role_assignment", assignmentId, { role: assignment.role });
  }

  public async recheckPendingByAssignmentId(input: { actorUserId: string; assignmentId: string }): Promise<void> {
    const { actorUserId, assignmentId } = input;

    const assignment = await this.prisma.botRoleAssignment.findUnique({
      where: { id: assignmentId }
    });
    if (!assignment) throw new NotFoundError("Assignment not found");
    if (assignment.botInstanceId !== this.botInstanceId) throw new ForbiddenError();
    if (assignment.status !== "PENDING") return;

    if (assignment.role === "OWNER") {
      if (!(await this.permissions.canAssignBotOwner(actorUserId))) throw new ForbiddenError();
    } else {
      if (!(await this.permissions.canAssignBotAdmin(actorUserId))) throw new ForbiddenError();
    }

    const existingUser = await this.prisma.user.findFirst({
      where: {
        botInstanceId: this.botInstanceId,
        username: {
          equals: assignment.telegramUsernameNormalized,
          mode: "insensitive"
        }
      },
      select: { id: true }
    });

    if (!existingUser) return;

    await this.prisma.botRoleAssignment.update({
      where: { id: assignmentId },
      data: {
        status: "ACTIVE",
        userId: existingUser.id,
        revokedAt: null,
        activatedAt: new Date()
      }
    });

    await this.audit.log(actorUserId, "bot_role_assignment_pending_linked", "bot_role_assignment", assignmentId, {});
  }

  /**
   * Activates a PENDING assignment by Telegram user ID when Recheck fails (e.g. user has no username).
   */
  public async activatePendingByTelegramId(input: {
    actorUserId: string;
    assignmentId: string;
    telegramUserId: string;
  }): Promise<void> {
    const { actorUserId, assignmentId, telegramUserId } = input;

    const assignment = await this.prisma.botRoleAssignment.findUnique({
      where: { id: assignmentId }
    });
    if (!assignment) throw new NotFoundError("Assignment not found");
    if (assignment.botInstanceId !== this.botInstanceId) throw new ForbiddenError();
    if (assignment.status !== "PENDING") return;

    if (assignment.role === "OWNER") {
      if (!(await this.permissions.canAssignBotOwner(actorUserId))) throw new ForbiddenError();
    } else {
      if (!(await this.permissions.canAssignBotAdmin(actorUserId))) throw new ForbiddenError();
    }

    const telegramId = BigInt(telegramUserId);
    const existingUser = await this.prisma.user.findFirst({
      where: {
        botInstanceId: this.botInstanceId,
        telegramUserId: telegramId
      },
      select: { id: true }
    });

    if (!existingUser) throw new NotFoundError("Пользователь с таким Telegram ID не найден в этом боте. Попросите его написать боту /start.");

    await this.prisma.botRoleAssignment.update({
      where: { id: assignmentId },
      data: {
        status: "ACTIVE",
        userId: existingUser.id,
        revokedAt: null,
        activatedAt: new Date()
      }
    });

    await this.audit.log(actorUserId, "bot_role_assignment_activated_by_telegram_id", "bot_role_assignment", assignmentId, {
      telegramUserId: telegramUserId
    });
  }

  /**
   * Activates a PENDING assignment by Telegram username. Useful when Recheck fails or assignment has wrong username.
   */
  public async activatePendingByUsername(input: {
    actorUserId: string;
    assignmentId: string;
    telegramUsername: string;
  }): Promise<void> {
    const { actorUserId, assignmentId, telegramUsername } = input;

    const assignment = await this.prisma.botRoleAssignment.findUnique({
      where: { id: assignmentId }
    });
    if (!assignment) throw new NotFoundError("Assignment not found");
    if (assignment.botInstanceId !== this.botInstanceId) throw new ForbiddenError();
    if (assignment.status !== "PENDING") return;

    if (assignment.role === "OWNER") {
      if (!(await this.permissions.canAssignBotOwner(actorUserId))) throw new ForbiddenError();
    } else {
      if (!(await this.permissions.canAssignBotAdmin(actorUserId))) throw new ForbiddenError();
    }

    const raw = String(telegramUsername ?? "").trim().replace(/^@/, "");
    const normalized = raw.toLowerCase();
    if (!raw || !/^[a-z0-9_]{5,32}$/.test(normalized)) {
      throw new ValidationError("Некорректный Telegram username (5–32 символа, буквы/цифры/подчёркивание).");
    }

    const existingUser = await this.prisma.user.findFirst({
      where: {
        botInstanceId: this.botInstanceId,
        username: { equals: normalized, mode: "insensitive" }
      },
      select: { id: true }
    });

    if (!existingUser) throw new NotFoundError("Пользователь с таким username не найден в этом боте. Попросите его написать боту /start.");

    await this.prisma.botRoleAssignment.update({
      where: { id: assignmentId },
      data: {
        telegramUsernameRaw: raw,
        telegramUsernameNormalized: normalized,
        status: "ACTIVE",
        userId: existingUser.id,
        revokedAt: null,
        activatedAt: new Date()
      }
    });

    await this.audit.log(actorUserId, "bot_role_assignment_activated_by_username", "bot_role_assignment", assignmentId, {
      telegramUsername: normalized
    });
  }
}
