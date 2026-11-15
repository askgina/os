import { describe, expect, it } from "vitest";
import { nextAllowedTime, reminderDueAt } from "../../src/notify/schedule.ts";

/** Unix seconds of an ISO 8601 instant. */
const at = (iso: string) => Date.parse(iso) / 1000;

describe("the reminder", () => {
  const created = at("2026-01-15T09:00:00Z");

  it("comes a quarter of the lifetime before the expiry, and at least ten minutes before", () => {
    // One hour: at 45 minutes.
    expect(reminderDueAt(created, created + 3_600)).toBe(created + 2_700);
    // A day: at 18 hours.
    expect(reminderDueAt(created, created + 86_400)).toBe(created + 64_800);
    // Forty minutes: a quarter is ten minutes, so at thirty.
    expect(reminderDueAt(created, created + 2_400)).toBe(created + 1_800);
    // Thirty minutes, the shortest that gets one: ten minutes before, not seven and a half.
    expect(reminderDueAt(created, created + 1_800)).toBe(created + 1_200);
    // A quarter of 3 601 seconds is 900.25: whole seconds, never after a quarter.
    expect(reminderDueAt(created, created + 3_601)).toBe(created + 2_701);
  });

  it("is not sent for a request that lives under thirty minutes", () => {
    expect(reminderDueAt(created, created + 600)).toBeNull();
    expect(reminderDueAt(created, created + 1_799)).toBeNull();
    expect(reminderDueAt(created, created + 60)).toBeNull();
  });
});

describe("quiet hours", () => {
  const night = (timeZone: string) => ({ start: "22:00", end: "07:00", timeZone });

  it("let a notification go at once when there are none, or outside them", () => {
    const noon = at("2026-01-15T12:00:00Z");
    expect(nextAllowedTime(noon, null)).toBe(noon);
    expect(nextAllowedTime(noon, night("Europe/London"))).toBe(noon);
    // The end is not inside: 07:00 itself is allowed, 22:00 itself is not.
    expect(nextAllowedTime(at("2026-01-15T07:00:00Z"), night("Europe/London"))).toBe(
      at("2026-01-15T07:00:00Z"),
    );
    expect(nextAllowedTime(at("2026-01-15T22:00:00Z"), night("Europe/London"))).toBe(
      at("2026-01-16T07:00:00Z"),
    );
  });

  it("hold a 23:30 notification until 07:00 the next morning across midnight, in Europe/London", () => {
    // Winter: London is on UTC.
    const late = at("2026-01-15T23:30:00Z");
    const morning = at("2026-01-16T07:00:00Z");
    expect(nextAllowedTime(late, night("Europe/London"))).toBe(morning);
    // After midnight, still inside: the end is the same morning.
    expect(nextAllowedTime(at("2026-01-16T03:10:20Z"), night("Europe/London"))).toBe(morning);
    // A request that expires at 06:00 expires before the window ends: the caller drops it.
    expect(nextAllowedTime(late, night("Europe/London"))).toBeGreaterThanOrEqual(
      at("2026-01-16T06:00:00Z"),
    );
  });

  it("compute the real instant on the days the clocks change", () => {
    // 29 March 2026: London goes from GMT to BST at 01:00 UTC; 07:00 BST is 06:00 UTC.
    expect(nextAllowedTime(at("2026-03-28T23:30:00Z"), night("Europe/London"))).toBe(
      at("2026-03-29T06:00:00Z"),
    );
    // 25 October 2026: back from BST to GMT at 01:00 UTC; 23:30 BST is 22:30 UTC.
    expect(nextAllowedTime(at("2026-10-24T22:30:00Z"), night("Europe/London"))).toBe(
      at("2026-10-25T07:00:00Z"),
    );
    // 8 March 2026: New York skips 02:00 to 03:00 EST to EDT at 07:00 UTC. A window ending at
    // 02:30, a time that day never shows, ends when the clocks jump.
    const skipped = { start: "22:00", end: "02:30", timeZone: "America/New_York" };
    expect(nextAllowedTime(at("2026-03-08T05:00:00Z"), skipped)).toBe(at("2026-03-08T07:00:00Z"));
    // The same window on an ordinary night ends at 02:30 EST, 07:30 UTC.
    expect(nextAllowedTime(at("2026-03-01T05:00:00Z"), skipped)).toBe(at("2026-03-01T07:30:00Z"));
    // 25 October 2026 in London: 01:30 comes twice, at 00:30 UTC (BST) and 01:30 UTC (GMT). A
    // window ending at 01:30 ends the first time.
    const twice = { start: "22:00", end: "01:30", timeZone: "Europe/London" };
    expect(nextAllowedTime(at("2026-10-24T22:00:00Z"), twice)).toBe(at("2026-10-25T00:30:00Z"));
  });

  it("follow the person's zone east and west of UTC", () => {
    // Tokyo, UTC+9 all year: 23:00 JST is 14:00 UTC; 07:00 JST the next day is 22:00 UTC.
    expect(nextAllowedTime(at("2026-01-15T14:00:00Z"), night("Asia/Tokyo"))).toBe(
      at("2026-01-15T22:00:00Z"),
    );
    // Kolkata, UTC+5:30: 22:30 IST is 17:00 UTC; 07:00 IST the next day is 01:30 UTC.
    expect(nextAllowedTime(at("2026-01-15T17:00:00Z"), night("Asia/Kolkata"))).toBe(
      at("2026-01-16T01:30:00Z"),
    );
    // New York, UTC-5 in winter: 23:00 EST on the 14th is 04:00 UTC on the 15th.
    expect(nextAllowedTime(at("2026-01-15T04:00:00Z"), night("America/New_York"))).toBe(
      at("2026-01-15T12:00:00Z"),
    );
    // Los Angeles, UTC-7 in summer: 14:00 UTC is 07:00 PDT, already outside.
    expect(nextAllowedTime(at("2026-07-15T14:00:00Z"), night("America/Los_Angeles"))).toBe(
      at("2026-07-15T14:00:00Z"),
    );
    // Noon in Tokyo is 03:00 UTC: inside a UTC night window, outside the Tokyo one.
    expect(nextAllowedTime(at("2026-01-15T03:00:00Z"), night("Asia/Tokyo"))).toBe(
      at("2026-01-15T03:00:00Z"),
    );
    expect(nextAllowedTime(at("2026-01-15T03:00:00Z"), night("UTC"))).toBe(
      at("2026-01-15T07:00:00Z"),
    );
  });

  it("handle windows that start or end at midnight and windows within one day", () => {
    const evening = { start: "22:00", end: "00:00", timeZone: "Europe/London" };
    expect(nextAllowedTime(at("2026-01-15T23:00:00Z"), evening)).toBe(at("2026-01-16T00:00:00Z"));
    const small = { start: "00:00", end: "06:00", timeZone: "Europe/London" };
    expect(nextAllowedTime(at("2026-01-16T00:00:00Z"), small)).toBe(at("2026-01-16T06:00:00Z"));
    expect(nextAllowedTime(at("2026-01-15T23:59:00Z"), small)).toBe(at("2026-01-15T23:59:00Z"));
    // Lunch in London in summer, 12:00 to 14:00 BST: 12:30 BST is 11:30 UTC.
    const lunch = { start: "12:00", end: "14:00", timeZone: "Europe/London" };
    expect(nextAllowedTime(at("2026-07-01T11:30:00Z"), lunch)).toBe(at("2026-07-01T13:00:00Z"));
    expect(nextAllowedTime(at("2026-07-01T13:00:00Z"), lunch)).toBe(at("2026-07-01T13:00:00Z"));
    // Equal start and end is no window at all.
    const none = { start: "09:00", end: "09:00", timeZone: "UTC" };
    expect(nextAllowedTime(at("2026-07-01T09:00:00Z"), none)).toBe(at("2026-07-01T09:00:00Z"));
  });
});
