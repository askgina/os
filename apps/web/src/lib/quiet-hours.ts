import { QuietHours } from "@askgina/os-api";

/**
 * The quiet hours form: what it starts with, what it sends, and the sentence that says what the
 * saved window does. Nothing here talks to the server.
 */

/** The form as typed: times as `<input type="time">` gives them, the zone as chosen. */
export interface QuietHoursForm {
  enabled: boolean;
  start: string;
  end: string;
  timeZone: string;
}

/** Why the form cannot be sent, and the field to fix. */
export interface QuietHoursProblem {
  field: "start" | "end" | "timeZone";
  message: string;
}

export type ParsedQuietHours =
  | { ok: true; value: QuietHours | null }
  | { ok: false; problem: QuietHoursProblem };

/** The form for saved quiet hours, or, with none saved, 22:00 to 07:00 in this device's zone. */
export function quietHoursForm(saved: QuietHours | null, deviceZone: string): QuietHoursForm {
  return saved
    ? { enabled: true, ...saved }
    : { enabled: false, start: "22:00", end: "07:00", timeZone: deviceZone };
}

/**
 * `HH:MM` from a time field's value. Browsers give `HH:MM`, or `HH:MM:SS` when seconds show;
 * quiet hours count in minutes. Null for an empty or malformed value.
 */
function clockTime(value: string): string | null {
  const match = /^((?:[01]\d|2[0-3]):[0-5]\d)(?::[0-5]\d(?:\.\d+)?)?$/.exec(value.trim());

  return match?.[1] ?? null;
}

/**
 * What the form sends: null when quiet hours are off, the window otherwise; or the first field
 * to fix, in words. The times are checked here; the API's own schema checks the rest (a zone
 * the browser knows), so what passes here the server takes.
 */
export function parseQuietHours(form: QuietHoursForm): ParsedQuietHours {
  if (!form.enabled) return { ok: true, value: null };

  const fail = (field: QuietHoursProblem["field"], message: string): ParsedQuietHours => ({
    ok: false,
    problem: { field, message },
  });

  const start = clockTime(form.start);

  if (start === null) return fail("start", "Choose when quiet hours start, as hours and minutes.");
  const end = clockTime(form.end);

  if (end === null) return fail("end", "Choose when quiet hours end, as hours and minutes.");

  if (start === end) return fail("end", "Quiet hours must end at another time than they start.");
  const parsed = QuietHours.safeParse({ start, end, timeZone: form.timeZone.trim() });

  if (!parsed.success) return fail("timeZone", "Choose a time zone from the list.");

  return { ok: true, value: parsed.data };
}

/**
 * What saved quiet hours do, in one sentence: "From 22:00 to 07:00 the next morning,
 * Europe/London time, notifications wait until the quiet hours end."
 */
export function describeQuietHours(quiet: QuietHours): string {
  const nextDay = quiet.end < quiet.start ? " the next morning" : "";

  return `From ${quiet.start} to ${quiet.end}${nextDay}, ${quiet.timeZone} time, notifications wait until the quiet hours end.`;
}

/**
 * The time zones to choose from: every zone this browser knows, plus the device's own and the
 * saved one when the browser lists them under other names, sorted.
 */
export function timeZoneChoices(known: readonly string[], ...also: string[]): string[] {
  return [...new Set([...known, ...also.filter((zone) => zone !== "")])].sort();
}
