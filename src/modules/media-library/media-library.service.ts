import type { MediaType, PrismaClient, TelegramMediaAsset } from "@prisma/client";

export type IngestedAsset = Pick<
  TelegramMediaAsset,
  "id" | "channelId" | "messageId" | "mediaType" | "fileId" | "fileUniqueId" | "caption" | "createdAt"
>;

export class MediaLibraryService {
  public constructor(private readonly prisma: PrismaClient) {}

  public async upsertAsset(input: {
    channelId: bigint;
    messageId: number;
    mediaType: MediaType;
    fileId: string;
    fileUniqueId?: string | null;
    caption?: string | null;
    createdAt?: Date | null;
  }): Promise<IngestedAsset> {
    const createdAt = input.createdAt ?? new Date();
    const caption = input.caption ?? "";
    return await this.prisma.telegramMediaAsset.upsert({
      where: {
        channelId_messageId: {
          channelId: input.channelId,
          messageId: input.messageId
        }
      },
      update: {
        mediaType: input.mediaType,
        fileId: input.fileId,
        fileUniqueId: input.fileUniqueId ?? undefined,
        caption,
        createdAt
      },
      create: {
        channelId: input.channelId,
        messageId: input.messageId,
        mediaType: input.mediaType,
        fileId: input.fileId,
        fileUniqueId: input.fileUniqueId ?? undefined,
        caption,
        createdAt
      },
      select: {
        id: true,
        channelId: true,
        messageId: true,
        mediaType: true,
        fileId: true,
        fileUniqueId: true,
        caption: true,
        createdAt: true
      }
    });
  }

  public async findByChannelMessage(channelId: bigint, messageId: number): Promise<IngestedAsset | null> {
    return await this.prisma.telegramMediaAsset.findUnique({
      where: {
        channelId_messageId: {
          channelId,
          messageId
        }
      },
      select: {
        id: true,
        channelId: true,
        messageId: true,
        mediaType: true,
        fileId: true,
        fileUniqueId: true,
        caption: true,
        createdAt: true
      }
    });
  }

  public async listRecent(mediaType: MediaType = "VIDEO", limit: number = 20): Promise<IngestedAsset[]> {
    return await this.prisma.telegramMediaAsset.findMany({
      where: { mediaType },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        channelId: true,
        messageId: true,
        mediaType: true,
        fileId: true,
        fileUniqueId: true,
        caption: true,
        createdAt: true
      }
    });
  }
}

