import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { readPngInfo } from "../src/png";
import { onceWithRetry } from "../src/render";
import { renderScreen } from "../src/screens";
import { bodyHeight, estimateLines } from "../src/screens/frame";
import { signed, summaryLayout, type MarketSummaryPayload } from "../src/screens/market-summary";
import {
  distanceLabel,
  planMetrics,
  plansThatFit,
  price,
  type TradePlan,
} from "../src/screens/trade-plans";
import { validatePayload } from "../src/validate";
import tradeMax from "./fixtures/trade-plans-max.json";
import summaryMax from "./fixtures/market-summary-max.json";
import { SUMMARY_SECRET, call, clearKv, ingest, tradeExamplePayload } from "./helpers";

// Weds 2026-11-18 10:05 ET: market open, both max fixtures are fresh.
const NOW = new Date("2026-11-18T15:05:00Z");
const summaryFixture = () => structuredClone(summaryMax) as MarketSummaryPayload;

describe("max-size payloads", () => {
  beforeEach(clearKv);

  it("both max fixtures are valid against the contract", () => {
    expect(validatePayload("trade-plans", tradeMax)).toEqual({ valid: true, errors: [] });
    expect(validatePayload("market-summary", summaryMax)).toEqual({ valid: true, errors: [] });
  });

  it("trade plans show what fits plus a '+ N more' line, with and without the banner", () => {
    expect(plansThatFit(50, false)).toBe(4);
    expect(plansThatFit(50, true)).toBe(3);
    expect(plansThatFit(4, false)).toBe(4);
    expect(plansThatFit(3, true)).toBe(3);
  });

  it("summary hides points that don't fit and keeps the footer", () => {
    for (const banner of [false, true]) {
      const layout = summaryLayout(summaryFixture(), banner);
      expect(layout.pointsShown).toBeGreaterThan(0);
      expect(layout.pointsHidden).toBeGreaterThan(0);
      expect(layout.pointsShown + layout.pointsHidden).toBe(8);
      expect(layout.watchShown.length).toBeGreaterThan(0);
      expect(layout.watchShown.length + layout.watchHidden).toBe(10);
    }
    expect(summaryLayout(summaryFixture(), true).pointsShown).toBeLessThanOrEqual(
      summaryLayout(summaryFixture(), false).pointsShown,
    );
  });

  it("the committed summary example shows every point", () => {
    const example = { ...summaryFixture(), headline: "Short", points: ["One.", "Two.", "Three.", "Four."] };
    expect(summaryLayout(example, false).pointsHidden).toBe(0);
  });

  it.each([
    ["trade-plans", tradeMax, undefined],
    ["market-summary", summaryMax, SUMMARY_SECRET],
  ] as const)("renders max-size %s as a 1072x1448 grayscale PNG", async (name, payload, secret) => {
    expect((await ingest(name, payload, { secret })).status).toBe(204);
    const r = await renderScreen(name, env, NOW);
    expect(r.freshness.stale).toBe(false);
    expect(readPngInfo(r.png)).toEqual({ width: 1072, height: 1448, bitDepth: 8, colorType: 0 });
  });

  it("body height leaves room for the banner", () => {
    expect(bodyHeight(false) - bodyHeight(true)).toBeGreaterThan(100);
  });
});

describe("estimateLines", () => {
  it("counts wrapped lines conservatively", () => {
    expect(estimateLines("short", 36, 940)).toBe(1);
    expect(estimateLines("word ".repeat(60).trim(), 36, 940)).toBeGreaterThanOrEqual(6);
  });
});

describe("prices and money fit their columns", () => {
  it("keeps two decimals below 100k and goes compact above", () => {
    expect(price(99999.99)).toBe("99999.99");
    expect(price(123456.78)).toBe("123.5K");
  });
});

describe("stop labels", () => {
  const plan = (over: Partial<TradePlan>): TradePlan => ({
    symbol: "ACME",
    side: "long",
    status: "open",
    entry: 10,
    stop: 9,
    target: 12,
    quantity: 1,
    ...over,
  });
  const label = (p: TradePlan) => distanceLabel(p, planMetrics(p));

  it("shows STOP HIT only for an open position through its stop", () => {
    expect(label(plan({ last: 8.5 }))).toEqual({ text: "STOP HIT", alarm: true });
  });
  it("shows a neutral note for a watching long below its stop", () => {
    expect(label(plan({ status: "watching", last: 8.5 }))).toEqual({ text: "last is below the stop", alarm: false });
  });
  it("shows a neutral note for a watching short above its stop", () => {
    const p = plan({ side: "short", status: "watching", entry: 10, stop: 11, target: 8, last: 11.5 });
    expect(label(p)).toEqual({ text: "last is above the stop", alarm: false });
  });
  it("shows the distance otherwise", () => {
    expect(label(plan({ last: 10 })).alarm).toBe(false);
    expect(label(plan({ last: 10 })).text).toBe("1.00 (10.0%) from last");
  });
});

describe("price ordering at ingest", () => {
  beforeEach(clearKv);

  const withPlan = (plan: Record<string, unknown>) => {
    const body = tradeExamplePayload();
    body.plans = [plan];
    return body;
  };

  it.each([
    [{ side: "long", entry: 10, stop: 11, target: 12 }, "long plan needs stop < entry < target"],
    [{ side: "long", entry: 10, stop: 9, target: 9.5 }, "long plan needs stop < entry < target"],
    [{ side: "short", entry: 10, stop: 9, target: 8 }, "short plan needs target < entry < stop"],
    [{ side: "short", entry: 10, stop: 11, target: 10.5 }, "short plan needs target < entry < stop"],
  ])("rejects misordered prices %j with a 422 and a path", async (prices, message) => {
    const res = await ingest("trade-plans", withPlan({ symbol: "ACME", status: "watching", quantity: 1, ...prices }));
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details: { path: string; message: string }[] };
    expect(body.details).toEqual([{ path: "#/plans/0", message }]);
  });

  it("accepts correctly ordered long and short plans", async () => {
    const res = await ingest(
      "trade-plans",
      withPlan({ symbol: "ACME", side: "short", status: "open", entry: 10, stop: 11, target: 8, quantity: 1 }),
    );
    expect(res.status).toBe(204);
  });
});

describe("signed percent", () => {
  it.each([
    [0.12, "+0.12%"],
    [-0.08, "-0.08%"],
    [0, "0.00%"],
    [-0.001, "0.00%"],
    [0.004, "0.00%"],
    [-0.005, "-0.01%"],
  ])("formats %d as %s", (pct, text) => expect(signed(pct)).toBe(text));
});

describe("streaming body cap", () => {
  beforeEach(clearKv);

  const chunked = (chunks: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });

  it("returns 413 for a chunked body over 64 KB with no Content-Length", async () => {
    const chunk = new Uint8Array(16 * 1024).fill(0x20);
    const req = new Request("https://dashboard.test/ingest/trade-plans", {
      method: "POST",
      headers: { authorization: "Bearer test-trading-secret", "content-type": "application/json" },
      body: chunked([chunk, chunk, chunk, chunk, chunk]),
    });
    expect(req.headers.get("content-length")).toBeNull();
    const { exports } = await import("cloudflare:workers");
    const res = await exports.default.fetch(req);
    expect(res.status).toBe(413);
  });

  it("accepts a small chunked body with no Content-Length", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(tradeExamplePayload()));
    const req = new Request("https://dashboard.test/ingest/trade-plans", {
      method: "POST",
      headers: { authorization: "Bearer test-trading-secret", "content-type": "application/json" },
      body: chunked([bytes.slice(0, 100), bytes.slice(100)]),
    });
    const { exports } = await import("cloudflare:workers");
    expect((await exports.default.fetch(req)).status).toBe(204);
    expect((await call("/screen/trade-plans.png")).status).toBe(200);
  });
});

describe("onceWithRetry", () => {
  it("retries after a failed init and caches a successful one", async () => {
    let calls = 0;
    const ensure = onceWithRetry(async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    });
    await expect(ensure()).rejects.toThrow("boom");
    await expect(ensure()).resolves.toBeUndefined();
    await expect(ensure()).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});
