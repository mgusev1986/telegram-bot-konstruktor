import type { PrismaClient } from "@prisma/client";

export type DepositorForAttribution =
  | {
      invitedByUserId: string | null;
      mentorUserId: string | null;
    }
  | null
  | undefined;

/** Resolve which OWNER user "owns" this accrual: inviter if they are OWNER, else mentor if OWNER, else pool (null). */
export function attributeOwnerUserIdFromDepositor(
  activeOwnerUserIds: Set<string>,
  depositor: DepositorForAttribution
): string | null {
  if (!depositor) return null;
  if (depositor.invitedByUserId && activeOwnerUserIds.has(depositor.invitedByUserId)) {
    return depositor.invitedByUserId;
  }
  if (depositor.mentorUserId && activeOwnerUserIds.has(depositor.mentorUserId)) {
    return depositor.mentorUserId;
  }
  return null;
}

export async function loadActiveOwnerUserIdsForBot(
  prisma: Pick<PrismaClient, "botRoleAssignment">,
  botInstanceId: string
): Promise<Set<string>> {
  const rows = await prisma.botRoleAssignment.findMany({
    where: { botInstanceId, role: "OWNER", status: "ACTIVE", userId: { not: null } },
    select: { userId: true }
  });
  return new Set(rows.map((r) => r.userId!).filter(Boolean));
}
