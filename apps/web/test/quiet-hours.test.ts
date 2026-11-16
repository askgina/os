import { describe, expect, it } from "vitest";
import {
  describeQuietHours,
  parseQuietHours,
  type QuietHoursForm,
  quietHoursForm,
  timeZoneChoices,
} from "../src/lib/quiet-hours.ts";

const form = (changes: Partial<QuietHoursForm> = {}): QuietHoursForm => ({
  enabled: true,
  start: "22:00",
  end: "07:00",
  timeZone: "Europe/London",
  ...changes,
});

describe("quietHoursForm", () => {
  it("starts from the saved window", () => {
    const saved = { start: "23:30", end: "06:15", timeZone: "Asia/Tokyo" };
    expect(quietHoursForm(saved, "Europe/Berlin")).toEqual({ enabled: true, ...saved });
  });

  it("starts off, from 22:00 to 07:00 in the device's zone, with nothing saved", () => {
    expect(quietHoursForm(null, "Europe/Berlin")).toEqual({
      enabled: false,
      start: "22:00",
      end: "07:00",
      timeZone: "Europe/Berlin",
    });
  });
});

describe("parseQuietHours", () => {
  it("sends nothing when off, whatever the fields say", () => {
    expect(parseQuietHours(form({ enabled: false, start: "", end: "x" }))).toEqual({
      ok: true,
      value: null,
    });
  });

  it.each([
    ["a window across midnight", form(), { start: "22:00", end: "07:00" }],
    [
      "a window within one day",
      form({ start: "12:00", end: "13:30" }),
      { start: "12:00", end: "13:30" },
    ],
    [
      "seconds from a time field",
      form({ start: "22:00:00", end: "07:00:59.5" }),
      { start: "22:00", end: "07:00" },
    ],
    [
      "midnight to the end of the day",
      form({ start: "00:00", end: "23:59" }),
      { start: "00:00", end: "23:59" },
    ],
  ])("sends %s", (_name, input, times) => {
    expect(parseQuietHours(input)).toEqual({
      ok: true,
      value: { ...times, timeZone: "Europe/London" },
    });
  });

  it("trims the zone it sends", () => {
    expect(parseQuietHours(form({ timeZone: " UTC " }))).toEqual({
      ok: true,
      value: { start: "22:00", end: "07:00", timeZone: "UTC" },
    });
  });

  it.each<[string, Partial<QuietHoursForm>, "start" | "end" | "timeZone", RegExp]>([
    ["an empty start", { start: "" }, "start", /when quiet hours start/],
    ["a start past the day", { start: "24:00" }, "start", /when quiet hours start/],
    ["a start without minutes", { start: "22" }, "start", /when quiet hours start/],
    ["an empty end", { end: "" }, "end", /when quiet hours end/],
    ["a twelve-hour end", { end: "7:00 AM" }, "end", /when quiet hours end/],
    ["the same start and end", { end: "22:00" }, "end", /another time than they start/],
    ["the same start and end, one with seconds", { end: "22:00:30" }, "end", /another time/],
    ["no zone", { timeZone: "" }, "timeZone", /time zone from the list/],
    ["an unknown zone", { timeZone: "Mars/Olympus_Mons" }, "timeZone", /time zone from the list/],
  ])("asks to fix %s", (_name, changes, field, message) => {
    const parsed = parseQuietHours(form(changes));
    expect(parsed.ok).toBe(false);

    if (parsed.ok) return;
    expect(parsed.problem.field).toBe(field);
    expect(parsed.problem.message).toMatch(message);
  });
});

describe("describeQuietHours", () => {
  it("says when a window ends the next morning", () => {
    expect(describeQuietHours({ start: "22:00", end: "07:00", timeZone: "Europe/London" })).toBe(
      "From 22:00 to 07:00 the next morning, Europe/London time, notifications wait until the quiet hours end.",
    );
  });

  it("says nothing of mornings for a window within one day", () => {
    expect(describeQuietHours({ start: "12:00", end: "13:00", timeZone: "UTC" })).toBe(
      "From 12:00 to 13:00, UTC time, notifications wait until the quiet hours end.",
    );
  });
});

describe("timeZoneChoices", () => {
  it("adds the device's and the saved zone when the list lacks them, once, sorted", () => {
    expect(
      timeZoneChoices(["Europe/London", "Asia/Tokyo"], "Europe/Kiev", "Asia/Tokyo", ""),
    ).toEqual(["Asia/Tokyo", "Europe/Kiev", "Europe/London"]);
  });
});
