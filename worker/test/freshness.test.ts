import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_SECONDS,
  describeClosed,
  describeReason,
  evaluateFreshness,
  formatDuration,
  marketSecondsBetween,
  regularSessionStatus,
} from "../src/freshness";

const d = (iso: string) => new Date(iso);
// Wed 2026-11-18 15:00Z = 10:00 EST
const OPEN = d("2026-11-18T15:00:00Z");
const MAX = 20 * 60;
const kinds = (r: ReturnType<typeof evaluateFreshness>) => r.reasons.map((x) => x.kind);

describe("regularSessionStatus", () => {
  it("is open mid-morning on a weekday", () => expect(regularSessionStatus(OPEN)).toBe("open"));
  it("is weekend on Saturday and Sunday", () => {
    expect(regularSessionStatus(d("2026-11-21T15:00:00Z"))).toBe("weekend");
    expect(regularSessionStatus(d("2026-11-22T15:00:00Z"))).toBe("weekend");
  });
  it("is outside hours at 08:00 ET", () => expect(regularSessionStatus(d("2026-11-18T13:00:00Z"))).toBe("outside-hours"));
  it("is outside hours at 09:29 ET", () => expect(regularSessionStatus(d("2026-11-18T14:29:00Z"))).toBe("outside-hours"));
  it("is open at 09:30 ET", () => expect(regularSessionStatus(d("2026-11-18T14:30:00Z"))).toBe("open"));
  it("is open at 15:59 ET", () => expect(regularSessionStatus(d("2026-11-18T20:59:00Z"))).toBe("open"));
  it("is closed at 16:00 ET", () => expect(regularSessionStatus(d("2026-11-18T21:00:00Z"))).toBe("outside-hours"));
  it("handles daylight saving: 13:30Z in July is 09:30 EDT", () => {
    expect(regularSessionStatus(d("2026-07-15T13:30:00Z"))).toBe("open");
    expect(regularSessionStatus(d("2026-07-15T13:29:00Z"))).toBe("outside-hours");
  });
  it("uses New York date, not UTC date: Fri 21:00Z-ish late evening stays a weekday", () => {
    // Sat 2026-11-21 02:00Z is Fri 21:00 ET: outside hours, not weekend
    expect(regularSessionStatus(d("2026-11-21T02:00:00Z"))).toBe("outside-hours");
  });
});

describe("evaluateFreshness", () => {
  it("is fresh during regular hours with recent data", () => {
    const r = evaluateFreshness({ asOf: "2026-11-18T14:55:00Z", now: OPEN, maxAgeSeconds: MAX });
    expect(r.stale).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.ageSeconds).toBe(300);
  });

  it("is stale with too-old when older than the limit", () => {
    const r = evaluateFreshness({ asOf: "2026-11-18T14:39:59Z", now: OPEN, maxAgeSeconds: MAX });
    expect(r.stale).toBe(true);
    expect(r.reasons).toEqual([{ kind: "too-old", marketAgeSeconds: MAX + 1, maxAgeSeconds: MAX }]);
  });

  it("is not stale exactly at the limit", () => {
    const r = evaluateFreshness({ asOf: "2026-11-18T14:40:00Z", now: OPEN, maxAgeSeconds: MAX });
    expect(r.ageSeconds).toBe(MAX);
    expect(r.stale).toBe(false);
  });

  it("reports no-data when asOf is undefined", () => {
    const r = evaluateFreshness({ asOf: undefined, now: OPEN, maxAgeSeconds: MAX });
    expect(r.stale).toBe(true);
    expect(kinds(r)).toEqual(["no-data"]);
    expect(r.ageSeconds).toBeNull();
  });

  it("reports bad-time for an unparseable time", () => {
    const r = evaluateFreshness({ asOf: "not a date", now: OPEN, maxAgeSeconds: MAX });
    expect(kinds(r)).toEqual(["bad-time"]);
    expect(r.ageSeconds).toBeNull();
  });

  it("reports future for a time far ahead", () => {
    const r = evaluateFreshness({ asOf: "2026-11-18T16:00:00Z", now: OPEN, maxAgeSeconds: MAX });
    expect(r.stale).toBe(true);
    expect(r.reasons).toEqual([{ kind: "future", aheadSeconds: 3600 }]);
  });

  it("tolerates small clock skew", () => {
    const ahead = new Date(OPEN.getTime() + (CLOCK_SKEW_SECONDS - 1) * 1000).toISOString();
    expect(evaluateFreshness({ asOf: ahead, now: OPEN, maxAgeSeconds: MAX }).stale).toBe(false);
    const atLimit = new Date(OPEN.getTime() + CLOCK_SKEW_SECONDS * 1000).toISOString();
    expect(evaluateFreshness({ asOf: atLimit, now: OPEN, maxAgeSeconds: MAX }).stale).toBe(false);
  });

  it("never reports market-closed as a stale reason", () => {
    const now = d("2026-11-21T15:00:00Z"); // Saturday
    const r = evaluateFreshness({ asOf: "2026-11-21T14:59:00Z", now, maxAgeSeconds: MAX });
    expect(r.stale).toBe(false);
    expect(r.reasons).toEqual([]);
    expect(r.marketClosed).toBe("weekend");
  });

  it("reports marketClosed outside-hours at 08:00 ET and 16:00 ET, and null at 09:30", () => {
    const at = (iso: string) => evaluateFreshness({ asOf: iso, now: d(iso), maxAgeSeconds: MAX });
    expect(at("2026-11-18T13:00:00Z").marketClosed).toBe("outside-hours");
    expect(at("2026-11-18T21:00:00Z").marketClosed).toBe("outside-hours");
    expect(at("2026-11-18T14:29:00Z").marketClosed).toBe("outside-hours");
    expect(at("2026-11-18T14:30:00Z").marketClosed).toBeNull();
  });

  it("uses producer market_status for the notice during regular hours, without going stale", () => {
    const r = evaluateFreshness({ asOf: "2026-11-18T14:59:00Z", now: OPEN, maxAgeSeconds: MAX, marketStatus: "closed" });
    expect(r.marketClosed).toBe("closed");
    expect(r.stale).toBe(false);
  });

  it("prefers the clock reason when outside hours and producer says closed", () => {
    const now = d("2026-11-18T13:00:00Z");
    const r = evaluateFreshness({ asOf: now.toISOString(), now, maxAgeSeconds: MAX, marketStatus: "closed" });
    expect(r.marketClosed).toBe("outside-hours");
  });

  it("producer market_status closed does not stop a dead producer going stale", () => {
    // Monday 10:00 ET, last push Friday 14:00 ET saying closed.
    const r = evaluateFreshness({
      asOf: "2026-11-20T14:00:00-05:00",
      now: d("2026-11-23T15:00:00Z"),
      maxAgeSeconds: MAX,
      marketStatus: "closed",
    });
    expect(kinds(r)).toEqual(["too-old"]);
  });

  describe("counts only market hours toward age", () => {
    const SAT = d("2026-11-21T15:00:00Z"); // Sat 10:00 ET
    const SUMMARY_MAX = 7 * 3600;
    it("Saturday with Friday 15:55 ET trade data is not stale", () => {
      expect(evaluateFreshness({ asOf: "2026-11-20T15:55:00-05:00", now: SAT, maxAgeSeconds: MAX }).stale).toBe(false);
    });
    it("Saturday with Friday noon trade data is stale, reporting market-hours age", () => {
      const r = evaluateFreshness({ asOf: "2026-11-20T12:00:00-05:00", now: SAT, maxAgeSeconds: MAX });
      expect(r.reasons).toEqual([{ kind: "too-old", marketAgeSeconds: 4 * 3600, maxAgeSeconds: MAX }]);
    });
    it("Friday 15:55 ET data is fresh at Monday 09:44 ET and stale at 09:46 ET", () => {
      const asOf = "2026-11-20T15:55:00-05:00";
      expect(evaluateFreshness({ asOf, now: d("2026-11-23T14:44:00Z"), maxAgeSeconds: MAX }).stale).toBe(false);
      expect(evaluateFreshness({ asOf, now: d("2026-11-23T14:46:00Z"), maxAgeSeconds: MAX }).stale).toBe(true);
    });
    it("Monday 08:00 ET with Friday close data is not stale", () => {
      const r = evaluateFreshness({ asOf: "2026-11-20T15:59:00-05:00", now: d("2026-11-23T13:00:00Z"), maxAgeSeconds: MAX });
      expect(r.stale).toBe(false);
    });
    it("a Monday 16:30 ET summary is not stale at Tuesday 09:30 ET", () => {
      const r = evaluateFreshness({ asOf: "2026-11-23T16:30:00-05:00", now: d("2026-11-24T14:30:00Z"), maxAgeSeconds: SUMMARY_MAX });
      expect(r.stale).toBe(false);
    });
    it("a Friday 16:30 ET end-of-day summary is fresh all weekend", () => {
      expect(evaluateFreshness({ asOf: "2026-11-20T16:30:00-05:00", now: SAT, maxAgeSeconds: SUMMARY_MAX }).stale).toBe(false);
    });
    it("a pre-market summary stays fresh through its session, and goes stale 30 min into the next", () => {
      const premarket = "2026-11-18T08:45:00-05:00"; // Wed
      expect(evaluateFreshness({ asOf: premarket, now: d("2026-11-18T20:59:00Z"), maxAgeSeconds: SUMMARY_MAX }).stale).toBe(false);
      expect(evaluateFreshness({ asOf: premarket, now: d("2026-11-19T14:59:00Z"), maxAgeSeconds: SUMMARY_MAX }).stale).toBe(false);
      expect(evaluateFreshness({ asOf: premarket, now: d("2026-11-19T15:01:00Z"), maxAgeSeconds: SUMMARY_MAX }).stale).toBe(true);
    });
  });
});

describe("marketSecondsBetween", () => {
  const between = (a: string, b: string) => marketSecondsBetween(d(a), d(b));
  it("is 0 when to is not after from", () => expect(between("2026-11-18T16:00:00Z", "2026-11-18T15:00:00Z")).toBe(0));
  it("counts wall time inside one session", () => expect(between("2026-11-18T15:00:00Z", "2026-11-18T15:20:00Z")).toBe(1200));
  it("counts a full session as 6.5 h", () => expect(between("2026-11-18T12:00:00Z", "2026-11-19T01:00:00Z")).toBe(23400));
  it("counts nothing overnight", () => expect(between("2026-11-18T21:30:00Z", "2026-11-19T14:30:00Z")).toBe(0));
  it("counts nothing over a weekend", () => expect(between("2026-11-20T21:00:00Z", "2026-11-23T14:30:00Z")).toBe(0));
  it("adds partial sessions across days", () =>
    // Fri 15:50 ET -> Mon 09:40 ET: 10 min + 10 min
    expect(between("2026-11-20T20:50:00Z", "2026-11-23T14:40:00Z")).toBe(1200));
  it("handles daylight saving (EDT session is 13:30Z-20:00Z)", () =>
    expect(between("2026-07-15T13:00:00Z", "2026-07-15T14:00:00Z")).toBe(1800));
  it("handles the DST change weekend (Fri EDT close -> Mon EST open)", () =>
    // Fri 2026-10-30 15:50 EDT (19:50Z) -> Mon 2026-11-02 09:40 EST (14:40Z)
    expect(between("2026-10-30T19:50:00Z", "2026-11-02T14:40:00Z")).toBe(1200));
  it("stops early once past the cap", () =>
    expect(marketSecondsBetween(d("2026-01-05T12:00:00Z"), d("2026-11-18T12:00:00Z"), 3600)).toBeGreaterThan(3600));
});

describe("formatDuration", () => {
  it.each([
    [0, "0 s"],
    [89, "89 s"],
    [90, "2 min"],
    [1200, "20 min"],
    [5340, "89 min"],
    [5400, "1 h 30 min"],
    [3 * 3600, "3 h"],
    [3 * 3600 + 600, "3 h 10 min"],
    [48 * 3600, "2 days"],
    [-120, "2 min"],
  ])("formats %i seconds as %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe("describeReason", () => {
  it("describes every kind with non-empty text", () => {
    expect(describeReason({ kind: "no-data" })).toMatch(/no data/i);
    expect(describeClosed("weekend")).toBe("weekend");
    expect(describeReason({ kind: "too-old", marketAgeSeconds: 3600, maxAgeSeconds: 1200 })).toBe(
      "60 min old in market hours (limit 20 min)",
    );
  });
});
