import tradePlansSchema from "../../contract/trade-plans.schema.json";
import marketSummarySchema from "../../contract/market-summary.schema.json";

/**
 * Kindle Basic 11th gen (KT5): 1072x1448 portrait at 300 ppi.
 * Change this one value if the device check finds a different size.
 */
export const SCREEN_SIZE = { width: 1072, height: 1448 } as const;

/** Largest ingest body the Worker accepts, in bytes. */
export const MAX_INGEST_BYTES = 64 * 1024;

/** Producer name -> the Worker secret that holds its ingest secret. */
export const PRODUCERS = {
  trading: "INGEST_SECRET_TRADING",
  summary: "INGEST_SECRET_SUMMARY",
} as const satisfies Record<string, keyof Env>;

export type ProducerName = keyof typeof PRODUCERS;

export interface SourceConfig {
  producer: ProducerName;
  schema: object;
}

/** Every source a producer may push. The schema lives in contract/. */
export const SOURCES = {
  "trade-plans": { producer: "trading", schema: tradePlansSchema },
  "market-summary": { producer: "summary", schema: marketSummarySchema },
} as const satisfies Record<string, SourceConfig>;

export type SourceName = keyof typeof SOURCES;

export interface ScreenConfig {
  source: SourceName;
  title: string;
  /**
   * Data older than this gets the stale banner. Set from how often the
   * producer pushes plus slack for one missed push.
   */
  maxAgeSeconds: number;
  /**
   * Show the quieter "market closed" notice. Off for screens that are read
   * while the market is closed by design, such as the pre-market summary.
   */
  marketNotice: boolean;
}

export const SCREENS = {
  // Ages are market-hours ages: only time the regular session is open counts.
  // Trading producer pushes every ~5-10 minutes during the session, so 20
  // market minutes allows for one or two missed pushes.
  "trade-plans": { source: "trade-plans", title: "Trade plans", maxAgeSeconds: 20 * 60, marketNotice: true },
  // Summary agent writes a pre-market summary before the open and an
  // end-of-day one after the close. A pre-market summary legitimately ages
  // through the whole 6.5 h session, so the limit is one session plus 30 min:
  // a summary goes stale 30 minutes into the second session after it.
  "market-summary": { source: "market-summary", title: "Market summary", maxAgeSeconds: 7 * 60 * 60, marketNotice: false },
} as const satisfies Record<string, ScreenConfig>;

export type ScreenName = keyof typeof SCREENS;

export function isSourceName(name: string): name is SourceName {
  return Object.hasOwn(SOURCES, name);
}

export function isScreenName(name: string): name is ScreenName {
  return Object.hasOwn(SCREENS, name);
}
