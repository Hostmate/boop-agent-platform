import { z } from "zod";

const VISIT_WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?:Z)?$/;

/**
 * Visits are stored by Product Data as Europe/Madrid wall-clock DATETIME
 * values. A legacy trailing Z is transport noise, not UTC authority.
 */
export function normalizeVisitWallClock(value: string): string | undefined {
  const match = value.trim().match(VISIT_WALL_CLOCK_RE);
  if (!match) return undefined;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const instant = new Date(Date.UTC(
    Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second),
  ));
  if (
    instant.getUTCFullYear() !== Number(year)
    || instant.getUTCMonth() !== Number(month) - 1
    || instant.getUTCDate() !== Number(day)
    || instant.getUTCHours() !== Number(hour)
    || instant.getUTCMinutes() !== Number(minute)
    || instant.getUTCSeconds() !== Number(second)
  ) return undefined;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

export const visitWallClockSchema = z.string().refine(
  (value) => normalizeVisitWallClock(value) === value,
  "Invalid visit wall-clock datetime",
);

export function formatVisitWallClock(value: string, locale = "es-ES"): string {
  const normalized = normalizeVisitWallClock(value);
  if (!normalized) throw new Error("INVALID_VISIT_DATE");
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(`${normalized}Z`));
}
