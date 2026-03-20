import type { PrismaClient } from "@prisma/client";

export class CrmService {
  public constructor(private readonly prisma: PrismaClient) {}

  public async assignTag(userId: string, tagCode: string, assignedByUserId?: string): Promise<void> {
    const tag = await this.prisma.tag.upsert({
      where: {
        code: tagCode
      },
      update: {},
      create: {
        code: tagCode,
        name: tagCode
      }
    });

    await this.prisma.userTag.upsert({
      where: {
        userId_tagId: {
          userId,
          tagId: tag.id
        }
      },
      update: {},
      create: {
        userId,
        tagId: tag.id,
        assignedByUserId
      }
    });
  }

  public async addNote(userId: string, authorUserId: string, noteText: string): Promise<void> {
    await this.prisma.userNote.create({
      data: {
        userId,
        authorUserId,
        noteText
      }
    });
  }

  public async getUserProfile(userId: string) {
    return this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        userTags: {
          include: {
            tag: true
          }
        },
        notes: {
          orderBy: {
            createdAt: "desc"
          }
        },
        accessRights: {
          where: {
            status: "ACTIVE"
          }
        }
      }
    });
  }
}
