export type ZonedDateParts = {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
};

export type LocalDateTimeParts = ZonedDateParts & {
  hour: number; // 0-23
  minute: number; // 0-59
};

const dtfForParts = (timeZone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

export const isValidTimeZone = (timeZone: string): boolean => {
  try {
    // Intl throws RangeError for invalid IANA names.
    dtfForParts(timeZone).format(new Date());
    return true;
  } catch {
    return false;
  }
};

export const getZonedDateParts = (dateUtc: Date, timeZone: string): ZonedDateParts => {
  const dtf = dtfForParts(timeZone);
  const parts = dtf.formatToParts(dateUtc);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  return { year: y, month: m, day: d };
};

/**
 * Convert a local "date+time in IANA timezone" to an absolute UTC timestamp (ms).
 * Uses Intl formatting offsets at computed guesses, and is resilient to DST changes.
 */
export const zonedTimeToUtcMs = (local: LocalDateTimeParts, timeZone: string): number => {
  // 1) Guess that local time is UTC.
  let utcGuess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, 0);
  // 2) Compute timezone offset at that guess.
  const offset1 = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  // 3) Shift by the offset and recompute once.
  const utc = utcGuess - offset1;
  const offset2 = getTimeZoneOffsetMs(new Date(utc), timeZone);
  return utcGuess - offset2;
};

const getTimeZoneOffsetMs = (dateUtc: Date, timeZone: string): number => {
  // offset = (asIfUtcFromLocalParts) - (actual UTC ms)
  const dtf = dtfForParts(timeZone);
  const parts = dtf.formatToParts(dateUtc);
  const y = Number(parts.find((p) => p.type === "year")?.value);
  const m = Number(parts.find((p) => p.type === "month")?.value);
  const d = Number(parts.find((p) => p.type === "day")?.value);
  const hh = Number(parts.find((p) => p.type === "hour")?.value);
  const mm = Number(parts.find((p) => p.type === "minute")?.value);
  const ss = Number(parts.find((p) => p.type === "second")?.value);

  const asIfUtc = Date.UTC(y, m - 1, d, hh, mm, ss);
  return asIfUtc - dateUtc.getTime();
};

export const addDaysToZonedDateParts = (base: ZonedDateParts, days: number, timeZone: string): ZonedDateParts => {
  // Use midday to avoid DST edge ambiguity at 00:00.
  const midLocal: LocalDateTimeParts = { ...base, hour: 12, minute: 0 };
  const midUtcMs = zonedTimeToUtcMs(midLocal, timeZone);
  const shiftedUtcMs = midUtcMs + days * 24 * 60 * 60 * 1000;
  return getZonedDateParts(new Date(shiftedUtcMs), timeZone);
};

