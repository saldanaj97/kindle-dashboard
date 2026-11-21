import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { readPngInfo } from "../src/png";
import { renderScreen } from "../src/screens";
import { planMetrics, type TradePlan } from "../src/screens/trade-plans";
import { SUMMARY_SECRET, clearKv, call, ingest, summaryExamplePayload, tradeExamplePayload } from "./helpers";

const SCREENS = [
  { name: "trade-plans", payload: tradeExamplePayload, secret: undefined },
  { name: "market-summary", payload: summaryExamplePayload, secret: SUMMARY_SECRET },
] as const;

async function expectPng(res: Response) {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("image/png");
  expect(res.headers.get("cache-control")).toBe("no-store");
  const info = readPngInfo(new Uint8Array(await res.arrayBuffer()));
  expect(info).toEqual({ width: 1072, height: 1448, bitDepth: 8, colorType: 0 });
}

describe.each(SCREENS)("GET /screen/$name.png", ({ name, payload, secret }) => {
  beforeEach(clearKv);

  it("renders a stale placeholder with no data", async () => {
    const res = await call(`/screen/${name}.png`);
    await expectPng(res);
    expect(res.headers.get("x-data-stale")).toBe("1");
    expect(res.headers.get("x-data-as-of")).toBeNull();
  });

  it("renders after ingest, reporting as_of and staleness for old data", async () => {
    // Weeks old, so stale on any day of the week.
    const body = { ...payload(), as_of: "2026-10-01T10:00:00-04:00" };
    expect((await ingest(name, body, { secret })).status).toBe(204);
    const res = await call(`/screen/${name}.png`);
    await expectPng(res);
    expect(res.headers.get("x-data-as-of")).toBe(body.as_of);
    expect(res.headers.get("x-data-stale")).toBe("1");
  });
});

describe("renderScreen with an injected clock", () => {
  beforeEach(clearKv);

  it.each(SCREENS)("$name shows no banner for fresh data during regular hours", async ({ name, payload, secret }) => {
    // Fri 2026-11-20 10:00 ET, inside the regular session.
    const body = { ...payload(), as_of: "2026-11-20T10:00:00-05:00", market_status: "open" };
    expect((await ingest(name, body, { secret })).status).toBe(204);
    const fresh = await renderScreen(name, env, new Date("2026-11-20T15:05:00Z"));
    expect(fresh.asOf).toBe(body.as_of);
    expect(fresh.freshness).toEqual({ stale: false, reasons: [], ageSeconds: 300, marketClosed: null });
    expect(readPngInfo(fresh.png)).toEqual({ width: 1072, height: 1448, bitDepth: 8, colorType: 0 });
  });
});

describe("market-closed notice", () => {
  beforeEach(clearKv);

  it("keeps Friday-close trade plans fresh on Saturday and reports the market closed", async () => {
    const body = { ...tradeExamplePayload(), as_of: "2026-11-20T15:58:00-05:00", market_status: "closed" };
    expect((await ingest("trade-plans", body)).status).toBe(204);
    const r = await renderScreen("trade-plans", env, new Date("2026-11-21T15:00:00Z"));
    expect(r.freshness.stale).toBe(false);
    expect(r.freshness.marketClosed).toBe("weekend");
  });
});

describe("screen routing", () => {
  it("returns 404 for an unknown screen", async () => {
    expect((await call("/screen/nope.png")).status).toBe(404);
  });

  it("returns 405 for POST", async () => {
    const res = await call("/screen/trade-plans.png", { method: "POST" });
    expect(res.status).toBe(405);
  });

  it("returns 404 for unrelated paths", async () => {
    expect((await call("/")).status).toBe(404);
  });
});

describe("planMetrics", () => {
  const base: TradePlan = { symbol: "ACME", side: "long", status: "open", entry: 100, stop: 95, target: 110, last: 102, quantity: 10 };

  it("measures a long's distance to stop from last", () => {
    const m = planMetrics(base);
    expect(m.reference).toBe(102);
    expect(m.referenceLabel).toBe("last");
    expect(m.distanceToStop).toBe(7);
    expect(m.distanceToStopPct).toBeCloseTo((7 / 102) * 100);
  });

  it("measures a short's distance to stop from last", () => {
    const m = planMetrics({ ...base, side: "short", entry: 100, stop: 105, target: 90, last: 98 });
    expect(m.distanceToStop).toBe(7);
  });

  it("falls back to entry when last is missing", () => {
    const { last: _last, ...noLast } = base;
    const m = planMetrics(noLast);
    expect(m.reference).toBe(100);
    expect(m.referenceLabel).toBe("entry");
    expect(m.distanceToStop).toBe(5);
  });

  it("gives distance <= 0 when the stop is hit or crossed", () => {
    expect(planMetrics({ ...base, last: 95 }).distanceToStop).toBe(0);
    expect(planMetrics({ ...base, last: 94 }).distanceToStop).toBeLessThan(0);
    expect(planMetrics({ ...base, side: "short", stop: 105, target: 90, last: 106 }).distanceToStop).toBeLessThan(0);
  });

  it("computes max loss as |entry - stop| x quantity for both sides", () => {
    expect(planMetrics(base).maxLoss).toBe(50);
    expect(planMetrics({ ...base, side: "short", stop: 105, target: 90 }).maxLoss).toBe(50);
  });

  it("computes reward:risk and tolerates zero risk", () => {
    expect(planMetrics(base).rewardRisk).toBe(2);
    expect(planMetrics({ ...base, stop: 100 }).rewardRisk).toBe(0);
  });
});
