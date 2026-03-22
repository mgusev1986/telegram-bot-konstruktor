import { getBanIdentifiers, getDisplayLinks } from "../../common/linked-chat-parser";

export type ReminderUnit = "days" | "minutes";

export interface ReminderScheduleEntry {
  value: number;
  unit: ReminderUnit;
  idempotencySuffix: string;
}

export interface ProductTimingLike {
  billingType?: string | null;
  durationDays?: number | null;
  durationMinutes?: number | null;
  linkedChats?: unknown;
}

const LIVE_REMINDER_DAYS = [3, 2, 1] as const;
const TEST_REMINDER_MINUTES = [3, 2, 1] as const;

export function isTestProduct(product: ProductTimingLike | null | undefined): boolean {
  return Number(product?.durationMinutes ?? 0) > 0;
}

export function isTemporaryAccessProduct(product: ProductTimingLike | null | undefined): boolean {
  return (
    Number(product?.durationMinutes ?? 0) > 0 ||
    Number(product?.durationDays ?? 0) > 0 ||
    String(product?.billingType ?? "").toUpperCase() === "TEMPORARY"
  );
}

export function getReminderSchedule(product: ProductTimingLike | null | undefined): ReminderScheduleEntry[] {
  if (isTestProduct(product)) {
    return TEST_REMINDER_MINUTES.map((value) => ({
      value,
      unit: "minutes" as const,
      idempotencySuffix: `${value}m`
    }));
  }

  return LIVE_REMINDER_DAYS.map((value) => ({
    value,
    unit: "days" as const,
    idempotencySuffix: `${value}d`
  }));
}

export function getProductModeLabel(product: ProductTimingLike | null | undefined): "TEST" | "LIVE" {
  return isTestProduct(product) ? "TEST" : "LIVE";
}

export function getLinkedChatDiagnostics(linkedChats: unknown): {
  hasLinkedChats: boolean;
  displayLinkCount: number;
  banIdentifierCount: number;
  removalReady: boolean;
  issue: string | null;
} {
  const displayLinkCount = getDisplayLinks(linkedChats).length;
  const banIdentifierCount = getBanIdentifiers(linkedChats).length;
  const hasLinkedChats = Array.isArray(linkedChats) && linkedChats.length > 0;
  const removalReady = !hasLinkedChats || banIdentifierCount > 0;
  const issue =
    hasLinkedChats && banIdentifierCount === 0
      ? "Есть только invite/display links без chat identifier. Кнопки доступа будут работать, но автоматическое удаление по expiry невозможно."
      : null;

  return {
    hasLinkedChats,
    displayLinkCount,
    banIdentifierCount,
    removalReady,
    issue
  };
}

export function validateLinkedChatsForExpiringAccess(product: ProductTimingLike | null | undefined): string | null {
  if (!isTemporaryAccessProduct(product)) return null;
  const diagnostics = getLinkedChatDiagnostics(product?.linkedChats);
  if (!diagnostics.hasLinkedChats) return null;
  if (diagnostics.removalReady) return null;
  return diagnostics.issue;
}
