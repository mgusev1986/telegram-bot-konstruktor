import type { AudienceType, PrismaClient, User } from "@prisma/client";

import type { ReferralService } from "../referrals/referral.service";

export interface AudienceQuery {
  audienceType: AudienceType;
  requesterUserId?: string;
  segmentQuery?: Record<string, unknown>;
}

export class SegmentService {
  public constructor(
    private readonly prisma: PrismaClient,
    private readonly referrals: ReferralService,
    private readonly botInstanceId?: string
  ) {}

  public async resolveAudience(query: AudienceQuery): Promise<User[]> {
    const segmentQuery = query.segmentQuery ?? {};

    switch (query.audienceType) {
      case "ALL_USERS":
        return this.prisma.user.findMany({
          where: this.botInstanceId ? { botInstanceId: this.botInstanceId } : undefined,
          orderBy: { createdAt: "asc" }
        });
      case "OWN_FIRST_LINE":
        return this.prisma.user.findMany({
          where: {
            ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}),
            invitedByUserId: query.requesterUserId ?? "__none__"
          },
          orderBy: { createdAt: "asc" }
        });
      case "OWN_STRUCTURE": {
        const ids = query.requesterUserId
          ? await this.referrals.getStructureUserIdsByLevel(query.requesterUserId)
          : [];
        return ids.length === 0
          ? []
          : this.prisma.user.findMany({
              where: {
                id: { in: ids },
                ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {})
              }
            });
      }
      case "SPECIFIC_LEVEL": {
        const level = Number(segmentQuery.level ?? 1);
        const ids =
          query.requesterUserId && level > 0
            ? await this.referrals.getStructureUserIdsByLevel(query.requesterUserId, level)
            : [];

        return ids.length === 0
          ? []
          : this.prisma.user.findMany({
              where: { id: { in: ids }, ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}) }
            });
      }
      case "LANGUAGE": {
        const languages = Array.isArray(segmentQuery.languages)
          ? (segmentQuery.languages as string[])
          : [String(segmentQuery.language ?? "")].filter(Boolean);
        return this.prisma.user.findMany({
          where: {
            ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}),
            selectedLanguage: {
              in: languages
            }
          }
        });
      }
      case "ROLE": {
        const roles = Array.isArray(segmentQuery.roles)
          ? (segmentQuery.roles as Array<"ALPHA_OWNER" | "OWNER" | "ADMIN" | "USER">)
          : [segmentQuery.role as "ALPHA_OWNER" | "OWNER" | "ADMIN" | "USER"];
        return this.prisma.user.findMany({
          where: {
            ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}),
            role: {
              in: roles
            }
          }
        });
      }
      case "TAGS": {
        const tagCodes = Array.isArray(segmentQuery.tagCodes) ? (segmentQuery.tagCodes as string[]) : [];
        return this.prisma.user.findMany({
          where: {
            ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}),
            userTags: {
              some: {
                tag: {
                  code: {
                    in: tagCodes
                  }
                }
              }
            }
          }
        });
      }
      case "PAYMENT_STATUS": {
        const paid = Boolean(segmentQuery.paid);
        return this.prisma.user.findMany({
          where: paid
            ? {
                ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}),
                accessRights: {
                  some: {
                    status: "ACTIVE"
                  }
                }
              }
            : {
                ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}),
                accessRights: {
                  none: {
                    status: "ACTIVE"
                  }
                }
              }
        });
      }
      case "ACTIVITY": {
        const inactiveDays = Number(segmentQuery.inactiveDays ?? 7);
        const threshold = new Date(Date.now() - inactiveDays * 24 * 60 * 60 * 1000);
        return this.prisma.user.findMany({
          where: {
            ...(this.botInstanceId ? { botInstanceId: this.botInstanceId } : {}),
            OR: [
              { lastSeenAt: null },
              {
                lastSeenAt: {
                  lt: threshold
                }
              }
            ]
          }
        });
      }
      case "CUSTOM":
      default:
        return this.prisma.user.findMany({
          where: this.botInstanceId ? { botInstanceId: this.botInstanceId } : undefined,
          orderBy: { createdAt: "asc" }
        });
    }
  }
}
