import { Prisma } from "@prisma/client";

export const toJsonValue = (value: Record<string, unknown> | Array<unknown>): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;
