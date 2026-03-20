import { describe, expect, it, vi } from "vitest";

import { ExportService } from "../src/modules/exports/export.service";

describe("ExportService: effective role scope", () => {
  it("ALPHA_OWNER uses full structure query (no first-line WHERE)", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([])
    } as any;
    const referrals = {} as any;
    const service = new ExportService(prisma, referrals);

    const requester = { id: "u1", role: "OWNER" } as any;

    await service.buildUsersHtmlReport(requester, { effectiveRole: "ALPHA_OWNER" as any });

    const call = prisma.$queryRaw.mock.calls[0];
    const rawStrings = call?.[0];
    const joined = Array.isArray(rawStrings) ? rawStrings.join("") : String(rawStrings);

    expect(joined).toContain("FROM users");
    expect(joined).toContain("0 AS level");
    expect(joined).not.toContain("WHERE invited_by_user_id =");
  });

  it("ADMIN uses first-line query (direct referrals only)", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([])
    } as any;
    const referrals = {} as any;
    const service = new ExportService(prisma, referrals);

    const requester = { id: "u1", role: "OWNER" } as any;

    await service.buildUsersHtmlReport(requester, { effectiveRole: "ADMIN" as any });

    const call = prisma.$queryRaw.mock.calls[0];
    const rawStrings = call?.[0];
    const joined = Array.isArray(rawStrings) ? rawStrings.join("") : String(rawStrings);

    expect(joined).toContain("FROM users");
    expect(joined).toContain("1 AS level");
    expect(joined).toContain("WHERE invited_by_user_id =");
  });

  it("OWNER uses first-line query (direct referrals only)", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([])
    } as any;
    const referrals = {} as any;
    const service = new ExportService(prisma, referrals);

    const requester = { id: "u1", role: "OWNER" } as any;

    await service.buildUsersHtmlReport(requester, { effectiveRole: "OWNER" as any });

    const call = prisma.$queryRaw.mock.calls[0];
    const rawStrings = call?.[0];
    const joined = Array.isArray(rawStrings) ? rawStrings.join("") : String(rawStrings);

    expect(joined).toContain("FROM users");
    expect(joined).toContain("1 AS level");
    expect(joined).toContain("WHERE invited_by_user_id =");
  });

  it("USER uses first-line query (direct referrals only)", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([])
    } as any;
    const referrals = {} as any;
    const service = new ExportService(prisma, referrals);

    const requester = { id: "u1", role: "OWNER" } as any;

    await service.buildUsersHtmlReport(requester, { effectiveRole: "USER" as any });

    const call = prisma.$queryRaw.mock.calls[0];
    const rawStrings = call?.[0];
    const joined = Array.isArray(rawStrings) ? rawStrings.join("") : String(rawStrings);

    expect(joined).toContain("FROM users");
    expect(joined).toContain("1 AS level");
    expect(joined).toContain("WHERE invited_by_user_id =");
  });
});

