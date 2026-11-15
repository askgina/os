import type { QuietHours } from "@askgina/os-api";

/**
 * When notifications go out: one reminder before a request expires, and never inside a person's
 * quiet hours. Pure functions of Unix seconds; time zones come from the platform's IANA data.
 */

/** A request that lives less than this gets no reminder: the first notification is enough. */
const SHORTEST_REMINDED_SECONDS = 1_800;
/** The reminder comes at least this long before the expiry. */
const LEAST_REMINDER_LEAD_SECONDS = 600;
const DAY = 86_400;

/**
 * When to remind people of a request that is still waiting: a quarter of its lifetime before it
 * expires, and at least ten minutes before. Null when it lives under thirty minutes.
 */
export function reminderDueAt(createdAt: number, expiresAt: number): number | null {
  const lifetime = expiresAt - createdAt;
  if (lifetime < SHORTEST_REMINDED_SECONDS) return null;
  return expiresAt - Math.max(LEAST_REMINDER_LEAD_SECONDS, Math.floor(lifetime / 4));
}

/**
 * The first instant at or after `now` that is outside the quiet hours: `now` itself outside
 * them, else the moment the window ends in the person's time zone. A window may cross
 * midnight. On a daylight-saving change it is the real instant: an end the clocks skip over is
 * reached when they jump past it, and an end the clocks pass twice is reached the first time.
 */
export function nextAllowedTime(now: number, quietHours: QuietHours | null): number {
  if (quietHours === null) return now;
  const start = minutes(quietHours.start);
  const end = minutes(quietHours.end);
  if (start === end) return now;
  const local = wallClock(now, quietHours.timeZone);
  const minute = local.hour * 60 + local.minute;
  const inside = start < end ? minute >= start && minute < end : minute >= start || minute < end;
  if (!inside) return now;
  // Past midnight in a window that crosses it, or in one that does not, the end is today;
  // before midnight in one that crosses it, the end is tomorrow.
  const days = start > end && minute >= start ? 1 : 0;
  const ends = instantOf(
    { year: local.year, month: local.month, day: local.day + days, hour: 0, minute: end },
    quietHours.timeZone,
  );
  return Math.max(now, ends);
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function minutes(time: string): number {
  const [hours = "0", mins = "0"] = time.split(":");
  return Number(hours) * 60 + Number(mins);
}

const formats = new Map<string, Intl.DateTimeFormat>();

function format(timeZone: string): Intl.DateTimeFormat {
  let found = formats.get(timeZone);
  if (found === undefined) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formats.set(timeZone, found);
  }
  return found;
}

/** The date and time a clock in `timeZone` shows at `instant`. */
function wallClock(instant: number, timeZone: string): WallClock & { second: number } {
  const parts: Record<string, number> = {};
  for (const part of format(timeZone).formatToParts(new Date(instant * 1000))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 0,
    month: parts.month ?? 0,
    day: parts.day ?? 0,
    hour: parts.hour ?? 0,
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  };
}

/** A wall-clock time read as if it were UTC, in Unix seconds; normalizes overflowing fields. */
function asUtc(time: WallClock & { second?: number }): number {
  return (
    Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second ?? 0) / 1000
  );
}

/** How far ahead of UTC the clock in `timeZone` is at `instant`, in seconds. */
function offsetAt(instant: number, timeZone: string): number {
  return asUtc(wallClock(instant, timeZone)) - instant;
}

/**
 * The first instant at which a clock in `timeZone` shows `time` or later. Each offset in force
 * around that day gives a candidate; one whose clock agrees is a real occurrence (two when the
 * clocks go back: the earlier is taken). When none agrees, the clocks skip the time, and the
 * answer is the jump, found by bisection between the candidates.
 */
function instantOf(time: WallClock, timeZone: string): number {
  const wall = asUtc(time);
  const offsets = new Set([wall - DAY, wall, wall + DAY].map((probe) => offsetAt(probe, timeZone)));
  const candidates = [...offsets].map((offset) => wall - offset);
  const exact = candidates.filter((instant) => offsetAt(instant, timeZone) === wall - instant);
  if (exact.length > 0) return Math.min(...exact);
  // In the gap: the clock reads earlier than `time` at `low` and later at `high`.
  let low = Math.min(...candidates);
  let high = Math.max(...candidates);
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (asUtc(wallClock(middle, timeZone)) >= wall) high = middle;
    else low = middle;
  }
  return high;
}
