import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE = "/Users/maksimgusev/Desktop/Automatization/Telegram Bot - Konstruktor/src/bot/register-bot.ts";

describe("Checkout invoice UX template", () => {
  it("does not render pay-from-balance button on invoice keyboard", () => {
    const src = readFileSync(FILE, "utf8");
    const keyboardBlock = src.slice(
      src.indexOf("const buildCheckoutScreenKeyboard"),
      src.indexOf("const showLockedSectionScreen")
    );
    expect(keyboardBlock).not.toContain('makeCallbackData("pay", "balance", productId)');
    expect(keyboardBlock).toContain('makeCallbackData("pay", "check", depositId)');
  });

  it("renders CTA as bold in invoice text", () => {
    const src = readFileSync(FILE, "utf8");
    const checkoutBlock = src.slice(
      src.indexOf("const buildCheckoutText"),
      src.indexOf("const buildCheckoutScreenKeyboard")
    );
    expect(checkoutBlock).toContain("<b>👇 ");
    expect(checkoutBlock).toContain('invoice_cta_copy_and_transfer');
  });
});

