import { describe, expect, it, vi } from "vitest";

import { CabinetService } from "../src/modules/cabinet/cabinet.service";

function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: "user-self",
    telegramUserId: 1000n,
    externalReferralLink: null,
    invitedByUserId: null,
    mentorUserId: null,
    selectedLanguage: "ru",
    ...overrides
  } as any;
}

function createService(
  users: Record<
    string,
    {
      externalReferralLink: string | null;
      invitedByUserId: string | null;
      mentorUserId: string | null;
      telegramUserId?: bigint;
    }
  >
) {
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: any) => {
        const row = users[String(where.id)];
        if (!row) return null;
        return {
          telegramUserId: row.telegramUserId ?? 1n,
          ...row
        };
      })
    }
  };

  const service = new CabinetService(
    prisma as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    "arb_core_info_bot"
  );

  return { service, prisma };
}

describe("CabinetService partner register link resolution", () => {
  it("walks up the inviter chain until it finds a valid external link", async () => {
    const { service } = createService({
      leader: {
        externalReferralLink: "https://arbcore.app/register?ref=leader",
        invitedByUserId: null,
        mentorUserId: null
      },
      direct: {
        externalReferralLink: "not-a-valid-url",
        invitedByUserId: "leader",
        mentorUserId: "leader"
      }
    });

    const link = await service.getPartnerRegisterLinkForUser(
      makeUser({ id: "downline", invitedByUserId: "direct", mentorUserId: "direct" })
    );

    expect(link).toBe("https://arbcore.app/register?ref=leader");
  });

  it("falls back to the mentor chain when inviter chain has no external link", async () => {
    const { service } = createService({
      inviter: {
        externalReferralLink: null,
        invitedByUserId: null,
        mentorUserId: null
      },
      mentor1: {
        externalReferralLink: null,
        invitedByUserId: null,
        mentorUserId: "mentor2"
      },
      mentor2: {
        externalReferralLink: "https://arbcore.app/register?ref=mentor2",
        invitedByUserId: null,
        mentorUserId: null
      }
    });

    const link = await service.getPartnerRegisterLinkForUser(
      makeUser({ id: "downline", invitedByUserId: "inviter", mentorUserId: "mentor1" })
    );

    expect(link).toBe("https://arbcore.app/register?ref=mentor2");
  });

  it("keeps own external link for users without upliner", async () => {
    const { service } = createService({});

    const link = await service.getPartnerRegisterLinkForUser(
      makeUser({ externalReferralLink: "https://arbcore.app/register?ref=self" })
    );

    expect(link).toBe("https://arbcore.app/register?ref=self");
  });
});
