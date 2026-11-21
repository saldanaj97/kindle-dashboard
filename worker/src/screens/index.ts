import { SCREENS, type ScreenName } from "../config";
import { evaluateFreshness, type Freshness, type MarketStatus } from "../freshness";
import { renderPng, type Child } from "../render";
import { getLatest } from "../store";
import { frame } from "./frame";
import { marketSummaryBody, type MarketSummaryPayload } from "./market-summary";
import { tradePlansBody, type TradePlansPayload } from "./trade-plans";

interface Payloads {
  "trade-plans": TradePlansPayload;
  "market-summary": MarketSummaryPayload;
}

const BODIES: { [K in ScreenName]: (p: Payloads[K] | null, bannerShown: boolean) => Child } = {
  "trade-plans": tradePlansBody,
  "market-summary": marketSummaryBody,
};

export interface RenderedScreen {
  png: Uint8Array;
  asOf: string | undefined;
  freshness: Freshness;
}

export async function renderScreen(name: ScreenName, env: Env, now: Date): Promise<RenderedScreen> {
  const screen = SCREENS[name];
  const stored = await getLatest<Payloads[typeof name] & { as_of: string; market_status?: MarketStatus }>(
    env.DASHBOARD_KV,
    screen.source,
  );
  const payload = stored?.payload ?? null;
  const asOf = payload?.as_of;
  const freshness = evaluateFreshness({
    asOf,
    now,
    maxAgeSeconds: screen.maxAgeSeconds,
    marketStatus: payload?.market_status,
  });
  const body = (BODIES[name] as (p: unknown, bannerShown: boolean) => Child)(payload, freshness.stale);
  const png = await renderPng(frame({
      title: screen.title,
      asOf,
      freshness,
      now,
      timeZone: env.DISPLAY_TZ,
      marketNotice: screen.marketNotice,
      body,
    }));
  return { png, asOf, freshness };
}
