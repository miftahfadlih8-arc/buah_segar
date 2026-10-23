/**
 * Asia/Jakarta (WIB, UTC+7, no DST) date helpers.
 * Timestamps are stored as timestamptz (UTC). The "business date" is the calendar date in Jakarta.
 */
export const BUSINESS_TZ = "Asia/Jakarta";

const ymdFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "2026-10-20" for the Jakarta calendar date of the instant. */
export function businessDate(at: Date = new Date()): string {
  return ymdFormatter.format(at);
}

/** Jakarta calendar date offset by `days` from the reference instant. */
export function businessDateOffsetDays(days: number, at: Date = new Date()): string {
  const shifted = new Date(at.getTime() + days * 24 * 60 * 60 * 1000);
  return ymdFormatter.format(shifted);
}

/** "2610" (YYMM) — used in document numbers. */
export function periodKey(at: Date = new Date()): string {
  const [y, m] = businessDate(at).split("-");
  return `${y!.slice(2)}${m}`;
}

const dateFormatter = new Intl.DateTimeFormat("id-ID", {
  timeZone: BUSINESS_TZ,
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const timeFormatter = new Intl.DateTimeFormat("id-ID", {
  timeZone: BUSINESS_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** "20/10/2026" */
export function formatDate(at: Date | string): string {
  return dateFormatter.format(new Date(at));
}

/** "20/10/2026 23.38 WIB" */
export function formatDateTime(at: Date | string): string {
  const d = new Date(at);
  return `${dateFormatter.format(d)} ${timeFormatter.format(d)} WIB`;
}
