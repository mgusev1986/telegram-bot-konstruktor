import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "/Users/maksimgusev/Desktop/Automatization/Telegram Bot - Konstruktor/src/modules/payments/balance.service.ts";

describe("Owner net reset - future accruals", () => {
  it("future owner settlement entries are still created as PENDING", () => {
    const src = readFileSync(FILE, "utf8");

    expect(src).toContain("ownerSettlementEntry.create");
    expect(src).toContain('status: "PENDING"');
  });
});

