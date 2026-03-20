import { createHash } from "node:crypto";

import type { PrismaClient } from "@prisma/client";

export class AbTestService {
  public constructor(private readonly prisma: PrismaClient) {}

  public async resolveVariant(code: string, userId: string): Promise<Record<string, unknown> | null> {
    const test = await this.prisma.abTest.findUnique({
      where: { code },
      include: {
        variants: {
          orderBy: {
            createdAt: "asc"
          }
        }
      }
    });

    if (!test || test.status !== "ACTIVE" || test.variants.length === 0) {
      return null;
    }

    const existingAssignment = await this.prisma.abTestAssignment.findUnique({
      where: {
        abTestId_userId: {
          abTestId: test.id,
          userId
        }
      }
    });

    if (existingAssignment) {
      return (test.variants.find((variant) => variant.variantKey === existingAssignment.variantKey)?.configJson ??
        null) as Record<string, unknown> | null;
    }

    const totalWeight = test.variants.reduce((sum, variant) => sum + variant.weight, 0);
    const hash = createHash("sha256").update(`${code}:${userId}`).digest("hex");
    const bucket = parseInt(hash.slice(0, 8), 16) % totalWeight;

    let cursor = 0;
    const pickedVariant =
      test.variants.find((variant) => {
        cursor += variant.weight;
        return bucket < cursor;
      }) ?? test.variants[0];

    if (!pickedVariant) {
      return null;
    }

    await this.prisma.abTestAssignment.create({
      data: {
        abTestId: test.id,
        userId,
        variantKey: pickedVariant.variantKey
      }
    });

    return pickedVariant.configJson as Record<string, unknown>;
  }
}
