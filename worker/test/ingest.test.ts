import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { SUMMARY_SECRET, clearKv, TRADING_SECRET, call, ingest, summaryExamplePayload, tradeExamplePayload } from "./helpers";

async function stored(source: string) {
  return env.DASHBOARD_KV.get<{ received_at: string; payload: unknown }>(`latest:${source}`, "json");
}

describe("POST /ingest auth and storage", () => {
  beforeEach(clearKv);

  it("accepts the trading secret for trade-plans and stores the payload", async () => {
    const payload = tradeExamplePayload();
    const res = await ingest("trade-plans", payload);
    expect(res.status).toBe(204);
    const row = await stored("trade-plans");
    expect(row?.payload).toEqual(payload);
    expect(Number.isNaN(Date.parse(row!.received_at))).toBe(false);
  });

  it("accepts the summary secret for market-summary and stores the payload", async () => {
    const payload = summaryExamplePayload();
    const res = await ingest("market-summary", payload, { secret: SUMMARY_SECRET });
    expect(res.status).toBe(204);
    expect((await stored("market-summary"))?.payload).toEqual(payload);
  });

  it("accepts a content-type with a charset parameter", async () => {
    const res = await ingest("trade-plans", tradeExamplePayload(), { contentType: "application/json; charset=utf-8" });
    expect(res.status).toBe(204);
  });

  it("rejects a missing Authorization header with 401", async () => {
    const res = await ingest("trade-plans", tradeExamplePayload(), { secret: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects a wrong secret with 401", async () => {
    const res = await ingest("trade-plans", tradeExamplePayload(), { secret: "nope" });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed Authorization header with 401", async () => {
    const res = await ingest("trade-plans", tradeExamplePayload(), { auth: `Basic ${btoa("a:b")}` });
    expect(res.status).toBe(401);
  });

  it("does not let the trading secret write market-summary", async () => {
    const res = await ingest("market-summary", summaryExamplePayload(), { secret: TRADING_SECRET });
    expect(res.status).toBe(401);
    expect(await stored("market-summary")).toBeNull();
  });

  it("does not let the summary secret write trade-plans", async () => {
    const res = await ingest("trade-plans", tradeExamplePayload(), { secret: SUMMARY_SECRET });
    expect(res.status).toBe(401);
    expect(await stored("trade-plans")).toBeNull();
  });

  it("answers 401 before looking at a bad body or content type", async () => {
    const res = await ingest("trade-plans", "{not json", { secret: "nope", contentType: "text/plain" });
    expect(res.status).toBe(401);
  });

  it("returns 404 for an unknown source", async () => {
    const res = await ingest("nope", {});
    expect(res.status).toBe(404);
  });

  it("returns 405 for GET on ingest", async () => {
    const res = await ingest("trade-plans", "", { method: "GET" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("returns 415 for a non-JSON content type", async () => {
    const res = await ingest("trade-plans", tradeExamplePayload(), { contentType: "text/plain" });
    expect(res.status).toBe(415);
  });

  it("returns 415 when content-type is missing", async () => {
    const res = await call("/ingest/trade-plans", {
      method: "POST",
      headers: { authorization: `Bearer ${TRADING_SECRET}` },
      body: new Uint8Array([123, 125]),
    });
    expect(res.status).toBe(415);
  });

  it("returns 400 for invalid JSON", async () => {
    const res = await ingest("trade-plans", "{not json");
    expect(res.status).toBe(400);
  });

  it("returns 413 for a body over 64 KB", async () => {
    const big = JSON.stringify({ filler: "x".repeat(64 * 1024 + 1) });
    const res = await ingest("trade-plans", big);
    expect(res.status).toBe(413);
    expect(await stored("trade-plans")).toBeNull();
  });

  it("returns 422 with error paths for a payload that breaks the contract", async () => {
    const payload = tradeExamplePayload();
    delete payload.as_of;
    const res = await ingest("trade-plans", payload);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details: { path: string; message: string }[] };
    expect(body.details.length).toBeGreaterThan(0);
    for (const d of body.details) {
      expect(typeof d.path).toBe("string");
      expect(typeof d.message).toBe("string");
    }
    expect(await stored("trade-plans")).toBeNull();
  });

  it("points 422 details at the offending field", async () => {
    const payload = tradeExamplePayload();
    (payload.plans as { side: string }[])[0]!.side = "sideways";
    const res = await ingest("trade-plans", payload);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { details: { path: string }[] };
    expect(body.details.some((d) => d.path.includes("/plans/0"))).toBe(true);
  });

  it("overwrites the previous payload with the latest one", async () => {
    const first = tradeExamplePayload();
    const second = { ...tradeExamplePayload(), as_of: "2026-11-20T15:00:00-05:00" };
    await ingest("trade-plans", first);
    await ingest("trade-plans", second);
    expect((await stored("trade-plans"))?.payload).toEqual(second);
  });
});
