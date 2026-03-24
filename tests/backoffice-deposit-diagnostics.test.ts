import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "/Users/maksimgusev/Desktop/Automatization/Telegram Bot - Konstruktor/src/http/backoffice/register-backoffice.ts";

describe("Backoffice deposit diagnostics visibility", () => {
  it("shows wallet address column for payment events", () => {
    const src = readFileSync(FILE, "utf8");
    expect(src).toContain("<th>Wallet</th>");
    expect(src).toContain("deposit.providerPayAddress");
  });

  it("renders deposit diagnostics section with reason", () => {
    const src = readFileSync(FILE, "utf8");
    expect(src).toContain("Deposit diagnostics (this bot only)");
    expect(src).toContain("diagnoseDepositReason");
  });
});

