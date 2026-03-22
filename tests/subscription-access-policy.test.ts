import { describe, expect, it } from "vitest";

import {
  getLinkedChatDiagnostics,
  getReminderSchedule,
  getProductModeLabel,
  isTestProduct,
  validateLinkedChatsForExpiringAccess
} from "../src/modules/subscription-channel/subscription-access-policy";

describe("subscription access policy", () => {
  it("treats durationMinutes products as TEST mode", () => {
    expect(isTestProduct({ durationMinutes: 5 })).toBe(true);
    expect(getProductModeLabel({ durationMinutes: 5 })).toBe("TEST");
    expect(getReminderSchedule({ durationMinutes: 5 })).toEqual([
      { value: 3, unit: "minutes", idempotencySuffix: "3m" },
      { value: 2, unit: "minutes", idempotencySuffix: "2m" },
      { value: 1, unit: "minutes", idempotencySuffix: "1m" }
    ]);
  });

  it("keeps live products on 3/2/1 day reminders", () => {
    expect(getProductModeLabel({ durationDays: 30, billingType: "TEMPORARY" })).toBe("LIVE");
    expect(getReminderSchedule({ durationDays: 30, billingType: "TEMPORARY" })).toEqual([
      { value: 3, unit: "days", idempotencySuffix: "3d" },
      { value: 2, unit: "days", idempotencySuffix: "2d" },
      { value: 1, unit: "days", idempotencySuffix: "1d" }
    ]);
  });

  it("flags invite-only linked chats as non-removable for expiring products", () => {
    const error = validateLinkedChatsForExpiringAccess({
      billingType: "TEMPORARY",
      durationDays: 30,
      linkedChats: [{ link: "https://t.me/+secretInvite" }]
    });

    expect(error).toContain("invite/display links");
    expect(getLinkedChatDiagnostics([{ link: "https://t.me/+secretInvite" }])).toEqual(
      expect.objectContaining({
        hasLinkedChats: true,
        removalReady: false,
        banIdentifierCount: 0
      })
    );
  });

  it("accepts expiring products that have ban-capable identifiers", () => {
    const error = validateLinkedChatsForExpiringAccess({
      billingType: "TEMPORARY",
      durationMinutes: 5,
      linkedChats: [{ link: "https://t.me/my_private_channel", identifier: "@my_private_channel" }]
    });

    expect(error).toBeNull();
  });
});
