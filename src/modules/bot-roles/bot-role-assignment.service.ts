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

