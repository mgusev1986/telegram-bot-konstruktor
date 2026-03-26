import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "/Users/maksimgusev/Desktop/Automatization/Telegram Bot - Konstruktor/src/http/backoffice/register-backoffice.ts";

describe("Backoffice owner net reset UX & safety", () => {
  it("adds reset action form with explicit confirmation token", () => {
    const src = readFileSync(FILE, "utf8");

    expect(src).toContain('reset-owner-net');
    expect(src).toContain('name="confirmText"');
    expect(src).toContain('RESET_OWNER_NET');
    expect(src).toContain("Сбросит ТОЛЬКО текущее pending owner net");
    expect(src).toContain("Сбросить нетто");
    expect(src).toContain('К выплате нетто');
    expect(src).toContain("netAmountBeforePayoutFee");
    expect(src).toContain('placeholder="RESET_OWNER_NET"');
  });

  it("blocks execution on wrong confirmation", () => {
    const src = readFileSync(FILE, "utf8");

    expect(src).toContain('expectedNormalized = "RESETOWNERNET"');
    expect(src).toContain("Bad confirmation: expected RESET_OWNER_NET, got");
  });
});

