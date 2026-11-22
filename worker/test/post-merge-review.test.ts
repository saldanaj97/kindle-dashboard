import { beforeEach, describe, expect, it } from "vitest";
import { evaluateFreshness } from "../src/freshness";
import { SUMMARY_SECRET, call, clearKv, ingest, summaryExamplePayload, tradeExamplePayload } from "./helpers";

// Regression tests for the review of the merged backend (issue #1).

describe("ingest rejects payloads that would break a screen", () => {
  beforeEach(clearKv);

  it("rejects a number that JSON.parse turns into Infinity", async () => {
    const raw = JSON.stringify(tradeExamplePayload()).replace(/"target":\s*[0-9.]+/, '"target":1e999');
    expect(raw).toContain("1e999");
    const res = await ingest("trade-plans", raw);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details: { path: string; message: string }[] };
    expect(body.details).toContainEqual({ path: "#/plans/0/target", message: "number must be finite" });

    // Nothing was stored, so the screen still renders.
    expect((await call("/screen/trade-plans.png")).status).toBe(200);
  });

  it.each(["1800-01-01T00:00:00Z", "1883-01-01T00:00:00Z", "1999-12-31T23:59:59Z"])(
    "rejects as_of %s, before 2000",
    async (asOf) => {
      const res = await ingest("market-summary", { ...summaryExamplePayload(), as_of: asOf }, { secret: SUMMARY_SECRET });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { details: { path: string }[] };
      expect(body.details.map((d) => d.path)).toContain("#/as_of");
    },
  );

  it("accepts as_of on 2000-01-01", async () => {
    const res = await ingest(
      "market-summary",
      { ...summaryExamplePayload(), as_of: "2000-01-01T00:00:00Z" },
      { secret: SUMMARY_SECRET },
    );
    expect(res.status).toBe(204);
  });

  it.each(["application/json-patch", "application/jsonx"])("rejects content-type %s", async (contentType) => {
    expect((await ingest("trade-plans", tradeExamplePayload(), { contentType })).status).toBe(415);
  });

  it("accepts application/json with a charset", async () => {
    const res = await ingest("trade-plans", tradeExamplePayload(), { contentType: "application/json; charset=utf-8" });
    expect(res.status).toBe(204);
  });
});

describe("freshness never throws on an old time", () => {
  it("reports bad-time instead of throwing for a pre-1883 as_of", () => {
    const result = evaluateFreshness({
      asOf: "1800-01-01T00:00:00Z",
      now: new Date("2026-11-18T15:05:00Z"),
      maxAgeSeconds: 20 * 60,
    });
    expect(result.stale).toBe(true);
    expect(result.reasons.map((r) => r.kind)).toContain("bad-time");
  });
});
