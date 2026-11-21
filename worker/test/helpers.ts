import { exports } from "cloudflare:workers";
import tradeExample from "../../contract/examples/trade-plans.json";
import summaryExample from "../../contract/examples/market-summary.json";

export const TRADING_SECRET = "test-trading-secret";
export const SUMMARY_SECRET = "test-summary-secret";

export const tradeExamplePayload = () => structuredClone(tradeExample) as Record<string, unknown>;
export const summaryExamplePayload = () => structuredClone(summaryExample) as Record<string, unknown>;

export function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(new Request(`https://dashboard.test${path}`, init));
}

export function ingest(
  source: string,
  body: unknown,
  opts: { secret?: string | null; auth?: string; contentType?: string | null; method?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  else if (opts.secret !== null) headers.authorization = `Bearer ${opts.secret ?? TRADING_SECRET}`;
  const method = opts.method ?? "POST";
  return call(`/ingest/${source}`, {
    method,
    headers,
    body: method === "GET" || method === "HEAD" ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** Storage is isolated per test file, not per test, so tests clear KV themselves. */
export async function clearKv(): Promise<void> {
  const { env } = await import("cloudflare:workers");
  const { keys } = await env.DASHBOARD_KV.list();
  await Promise.all(keys.map((k) => env.DASHBOARD_KV.delete(k.name)));
}
