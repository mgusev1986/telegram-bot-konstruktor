import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "/Users/maksimgusev/Desktop/Automatization/Telegram Bot - Konstruktor/src/http/backoffice/register-backoffice.ts";

describe("Backoffice NOWPayments owner wallet layout", () => {
  it("renders the owners table inside the standard table shell", () => {
    const src = readFileSync(FILE, "utf8");
    expect(src).toContain('<div class="bo-table-shell" style="margin-bottom:12px"><table class="paid-table">');
  });

  it("keeps the shared NOWPayments owner rail shrink-safe", () => {
    const src = readFileSync(FILE, "utf8");
    expect(src).toContain(".bo-stage-grid-rail > *,");
    expect(src).toContain(".bo-stage-grid-2 > *,");
    expect(src).toContain(".bo-subsection {");
    expect(src).toContain(".bo-form-cluster {");
    expect(src).toContain(".bo-table-shell,");
  });

  it("uses a shrink-safe owner wallet editor form inside the wallet cell", () => {
    const src = readFileSync(FILE, "utf8");
    expect(src).toContain('class="owner-wallet-cell"');
    expect(src).toContain('class="owner-wallet-form"');
    expect(src).toContain(".owner-wallet-form {");
    expect(src).toContain(".owner-wallet-form .field {");
  });

  it("renders owner reporting tables inside the standard table shell", () => {
    const src = readFileSync(FILE, "utf8");
    expect(src).toMatch(
      /<div class="bo-table-shell" style="margin-bottom:12px"><table class="paid-table">\s*<thead><tr><th>Владелец<\/th>/
    );
    expect(src).toMatch(
      /<div class="bo-table-shell" style="margin-bottom:12px"><table class="paid-table"><thead><tr><th>Когда \(батч\)<\/th>/
    );
  });
});
