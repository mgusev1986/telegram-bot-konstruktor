import type { PrismaClient } from "@prisma/client";

import { toJsonValue } from "../../common/json";

export class AuditService {
  public constructor(private readonly prisma: PrismaClient) {}

  public async log(
    userId: string,
    action: string,
    entityType: string,
    entityId: string | null,
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.prisma.adminActionLog.create({
      data: {
        userId,
        action,
        entityType,
        entityId: entityId ?? undefined,
        payloadJson: toJsonValue(payload)
      }
    });
  }
}
