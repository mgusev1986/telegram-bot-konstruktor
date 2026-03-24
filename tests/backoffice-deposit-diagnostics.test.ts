import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "/Users/maksimgusev/Desktop/Automatization/Telegram Bot - Konstruktor/src/http/backoffice/register-backoffice.ts";

describe("Backoffice deposit diagnostics visibility", () => {
  it("shows wallet address column for payment events", () => {
    const src = readFileSync(FILE, "utf8");
    expect(src).toContain("<th>Кошелёк</th>");
    expect(src).toContain("deposit.providerPayAddress");
  });

  it("renders deposit diagnostics section with depositor columns and reason", () => {
    const src = readFileSync(FILE, "utf8");
    expect(src).toContain("Диагностика депозитов (только этот бот)");
    expect(src).toContain("diagnoseDepositReason");
    expect(src).toContain("<th>Имя</th>");
    expect(src).toContain("<th>Фамилия</th>");
    expect(src).toContain("<th>Логин Telegram</th>");
    expect(src).toContain("depositDiagnosticsTelegramLoginCell");
  });
});

