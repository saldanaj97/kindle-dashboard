/** Market state as reported by a producer (see contract/). */
export type MarketStatus = "pre-market" | "open" | "after-hours" | "closed";

/** Data problems. Any of these shows the black STALE banner. */
export type StaleReason =
  | { kind: "no-data" }
  | { kind: "bad-time" }
  | { kind: "too-old"; marketAgeSeconds: number; maxAgeSeconds: number }
  | { kind: "future"; aheadSeconds: number };

/** Why the market is closed. Shown as a quieter notice, never as STALE. */
export type ClosedReason = MarketStatus | "weekend" | "outside-hours";

export interface Freshness {
  /** True when the data has a problem and the screen must show the STALE banner. */
  stale: boolean;
  reasons: StaleReason[];
  /** Age of the data in seconds at `now`; null when there is no valid time. */
  ageSeconds: number | null;
  /** Null while the market is open; otherwise why it is closed. */
  marketClosed: ClosedReason | null;
}

/** Data timestamps up to this far ahead of the Worker clock are tolerated. */
export const CLOCK_SKEW_SECONDS = 5 * 60;

const NY = "America/New_York";
const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: NY,
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function nyParts(t: Date) {
  const p = Object.fromEntries(NY_PARTS.formatToParts(t).map((x) => [x.type, x.value]));
  return {
    weekday: p.weekday!,
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

const isWeekend = (weekday: string) => weekday === "Sat" || weekday === "Sun";
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

/**
 * Regular US equity session by the New York clock: Mon-Fri 09:30-16:00.
 * There is no holiday or half-day calendar here; producers cover those by
 * sending `market_status`.
 */
export function regularSessionStatus(now: Date): "open" | "weekend" | "outside-hours" {
  const { weekday, minutes } = nyParts(now);
  if (isWeekend(weekday)) return "weekend";
  return minutes >= OPEN_MIN && minutes < CLOSE_MIN ? "open" : "outside-hours";
}

/** The instant when the New York wall clock reads `minutes` past midnight on that New York date. */
function nyInstant(year: number, month: number, day: number, minutes: number): Date {
  // New York is UTC-5 (EST) or UTC-4 (EDT); pick the offset that reads back correctly.
  for (const offsetHours of [5, 4]) {
    const t = new Date(Date.UTC(year, month - 1, day, offsetHours, minutes));
    const p = nyParts(t);
    if (p.day === day && p.minutes === minutes) return t;
  }
  throw new Error("no matching New York instant");
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Seconds the regular session (Mon-Fri 09:30-16:00 New York, DST-aware) was
 * open between `from` and `to`. Returns 0 when `to` is not after `from`.
 * Stops counting once the total passes `stopAfterSeconds`.
 */
export function marketSecondsBetween(from: Date, to: Date, stopAfterSeconds = Infinity): number {
  if (to.getTime() <= from.getTime()) return 0;
  const start = nyParts(from);
  const end = nyParts(to);
  const endKey = end.year * 10000 + end.month * 100 + end.day;
  let total = 0;
  // Noon UTC is 07:00 or 08:00 in New York, so each probe lands on a distinct New York date.
  let probe = Date.UTC(start.year, start.month - 1, start.day, 12);
  for (let i = 0; i < 400; i++, probe += DAY_MS) {
    const p = nyParts(new Date(probe));
    if (p.year * 10000 + p.month * 100 + p.day > endKey) break;
    if (isWeekend(p.weekday)) continue;
    const open = nyInstant(p.year, p.month, p.day, OPEN_MIN).getTime();
    const close = nyInstant(p.year, p.month, p.day, CLOSE_MIN).getTime();
    const overlap = Math.min(close, to.getTime()) - Math.max(open, from.getTime());
    if (overlap > 0) total += overlap / 1000;
    if (total > stopAfterSeconds) return Math.round(total);
  }
  // Spans longer than 400 days stop early; the total is already far past any screen limit.
  return Math.round(total);
}

export interface FreshnessInput {
  /** The payload's `as_of`; undefined when there is no data. */
  asOf: string | undefined;
  now: Date;
  maxAgeSeconds: number;
  /** The payload's `market_status`, when the producer sent one. */
  marketStatus?: MarketStatus;
}

/**
 * Standing rule 5. STALE means a data problem: no data, an unreadable or
 * future time, or data older than the screen allows. Age is market-hours age:
 * only the seconds the regular session was open between `as_of` and `now`
 * count (by the clock, never the producer's word, so a dead producer still
 * goes stale). A closed market is reported separately.
 */
export function evaluateFreshness({ asOf, now, maxAgeSeconds, marketStatus }: FreshnessInput): Freshness {
  const reasons: StaleReason[] = [];
  let ageSeconds: number | null = null;

  if (asOf === undefined) {
    reasons.push({ kind: "no-data" });
  } else {
    const t = Date.parse(asOf);
    if (Number.isNaN(t)) {
      reasons.push({ kind: "bad-time" });
    } else {
      ageSeconds = Math.round((now.getTime() - t) / 1000);
      let marketAgeSeconds: number | null = null;
      try {
        marketAgeSeconds = marketSecondsBetween(new Date(t), now, maxAgeSeconds);
      } catch {
        // Times New York time-zone math can't place (before 1883) count as unreadable.
        reasons.push({ kind: "bad-time" });
      }
      if (marketAgeSeconds !== null && marketAgeSeconds > maxAgeSeconds) {
        reasons.push({ kind: "too-old", marketAgeSeconds, maxAgeSeconds });
      }
      if (-ageSeconds > CLOCK_SKEW_SECONDS) reasons.push({ kind: "future", aheadSeconds: -ageSeconds });
    }
  }

  const session = regularSessionStatus(now);
  const marketClosed: ClosedReason | null =
    session !== "open" ? session : marketStatus && marketStatus !== "open" ? marketStatus : null;

  return { stale: reasons.length > 0, reasons, ageSeconds, marketClosed };
}

export function formatDuration(seconds: number): string {
  const s = Math.abs(seconds);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 48) return rm ? `${h} h ${rm} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** One short line per reason, for the STALE banner. */
export function describeReason(r: StaleReason): string {
  switch (r.kind) {
    case "no-data":
      return "No data received yet";
    case "bad-time":
      return "Data time is unreadable";
    case "too-old":
      return `${formatDuration(r.marketAgeSeconds)} old in market hours (limit ${formatDuration(r.maxAgeSeconds)})`;
    case "future":
      return `Data time is ${formatDuration(r.aheadSeconds)} in the future`;
  }
}

/** Short detail for the market-closed notice. */
export function describeClosed(c: ClosedReason): string {
  const detail: Record<ClosedReason, string> = {
    weekend: "weekend",
    "outside-hours": "outside regular hours",
    "pre-market": "pre-market",
    "after-hours": "after hours",
    closed: "closed per producer",
    open: "open",
  };
  return detail[c];
}
