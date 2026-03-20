import { describe, it, expect } from "vitest";

import { addDaysToZonedDateParts, getZonedDateParts, zonedTimeToUtcMs } from "../src/common/timezone";

const getZonedYMDHM = (utcDate: Date, timeZone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(utcDate);

  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const hh = Number(parts.find((p) => p.type === "hour")?.value);
  const mm = Number(parts.find((p) => p.type === "minute")?.value);

  return { y, m, d, hh, mm };
};

describe("Timezone helpers", () => {
  it("zonedTimeToUtcMs preserves local date+time for a timezone", () => {
    const local = { year: 2026, month: 3, day: 16, hour: 9, minute: 0 };
    const timeZones = ["America/New_York", "Europe/Warsaw", "Asia/Almaty"];

    for (const tz of timeZones) {
      const utcMs = zonedTimeToUtcMs(local, tz);
      const utcDate = new Date(utcMs);
      const zoned = getZonedYMDHM(utcDate, tz);

      expect(zoned.y).toBe(local.year);
      expect(zoned.m).toBe(local.month);
      expect(zoned.d).toBe(local.day);
      expect(zoned.hh).toBe(local.hour);
      expect(zoned.mm).toBe(local.minute);
    }
  });

  it("addDaysToZonedDateParts advances calendar day across DST change", () => {
    // For New York DST in 2026 starts on March 8.
    const tz = "America/New_York";
    const base = { year: 2026, month: 3, day: 7 };
    const next = addDaysToZonedDateParts(base, 1, tz);

    expect(next.year).toBe(2026);
    expect(next.month).toBe(3);
    expect(next.day).toBe(8);
  });

  it("getZonedDateParts returns expected zoned date for utc timestamp", () => {
    const tz = "UTC";
    const utcDate = new Date(Date.UTC(2026, 0, 2, 10, 0, 0));
    const parts = getZonedDateParts(utcDate, tz);
    expect(parts).toEqual({ year: 2026, month: 1, day: 2 });
  });
});

