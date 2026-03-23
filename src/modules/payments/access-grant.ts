import type { AccessType } from "@prisma/client";

import { isTemporaryAccessProduct, type ProductTimingLike } from "../subscription-channel/subscription-access-policy";

type AccessGrantProduct = ProductTimingLike & {
  billingType?: string | null;
};

type AccessRightRecord = {
  id: string;
  activeUntil: Date | null;
};

type AccessRightStore = {
  findFirst(args: {
    where: Record<string, unknown>;
    orderBy?: Record<string, "asc" | "desc">;
  }): Promise<AccessRightRecord | null>;
  create(args: {
    data: {
      userId: string;
      productId: string;
      accessType: AccessType;
      activeFrom: Date;
      activeUntil: Date | null;
    };
  }): Promise<AccessRightRecord>;
  update(args: {
    where: { id: string };
    data: {
      accessType: AccessType;
      activeUntil: Date | null;
    };
  }): Promise<AccessRightRecord>;
};

function resolveAccessType(product: AccessGrantProduct): AccessType {
  if (isTemporaryAccessProduct(product)) {
    return "TEMPORARY";
  }
  return product.billingType === "ONE_TIME" ? "LIFETIME" : "SUBSCRIPTION";
}

export function calculateAccessActiveUntil(
  product: AccessGrantProduct,
  baseFrom: Date
): Date | null {
  const durationMinutes = Number(product.durationMinutes ?? 0);
  if (durationMinutes > 0) {
    return new Date(baseFrom.getTime() + durationMinutes * 60 * 1000);
  }

  const durationDays = Number(product.durationDays ?? 0);
  if (durationDays > 0) {
    return new Date(baseFrom.getTime() + durationDays * 24 * 60 * 60 * 1000);
  }

  return null;
}

export async function grantOrExtendAccess(
  accessRights: AccessRightStore,
  params: {
    userId: string;
    productId: string;
    product: AccessGrantProduct;
    now?: Date;
  }
): Promise<{
  accessRight: AccessRightRecord;
  activeUntil: Date | null;
  extendedExisting: boolean;
  reusedLifetime: boolean;
}> {
  const now = params.now ?? new Date();
  const accessType = resolveAccessType(params.product);

  const lifetimeAccess = await accessRights.findFirst({
    where: {
      userId: params.userId,
      productId: params.productId,
      status: "ACTIVE",
      activeUntil: null
    },
    orderBy: { updatedAt: "desc" }
  });

  if (lifetimeAccess) {
    return {
      accessRight: lifetimeAccess,
      activeUntil: null,
      extendedExisting: false,
      reusedLifetime: true
    };
  }

  const extendableAccess = await accessRights.findFirst({
    where: {
      userId: params.userId,
      productId: params.productId,
      status: "ACTIVE",
      activeUntil: { gt: now }
    },
    orderBy: { activeUntil: "desc" }
  });

  if (extendableAccess) {
    const activeUntil = calculateAccessActiveUntil(params.product, extendableAccess.activeUntil ?? now);
    const updatedAccess = await accessRights.update({
      where: { id: extendableAccess.id },
      data: {
        accessType,
        activeUntil
      }
    });

    return {
      accessRight: updatedAccess,
      activeUntil,
      extendedExisting: true,
      reusedLifetime: false
    };
  }

  const activeUntil = calculateAccessActiveUntil(params.product, now);
  const createdAccess = await accessRights.create({
    data: {
      userId: params.userId,
      productId: params.productId,
      accessType,
      activeFrom: now,
      activeUntil
    }
  });

  return {
    accessRight: createdAccess,
    activeUntil,
    extendedExisting: false,
    reusedLifetime: false
  };
}
