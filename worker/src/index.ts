import { MAX_INGEST_BYTES, PRODUCERS, SOURCES, isScreenName, isSourceName } from "./config";
import { bearerToken, secretMatches } from "./auth";
import { readBodyLimited } from "./body";
import { putLatest } from "./store";
import { validatePayload } from "./validate";
import { renderScreen } from "./screens";

// Routes:
//   POST /ingest/<source>      producers push data; per-producer secret
//   GET  /screen/<name>.png    the Kindle fetches screens; behind Cloudflare Access
// Nothing the Kindle can reach triggers an action (standing rule 2).

const json = (status: number, body: unknown, headers: HeadersInit = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

async function handleIngest(request: Request, env: Env, source: string): Promise<Response> {
  if (request.method !== "POST") return json(405, { error: "method not allowed" }, { allow: "POST" });
  if (!isSourceName(source)) return json(404, { error: "unknown source" });

  // Authenticate before reading the body.
  const secretName = PRODUCERS[SOURCES[source].producer];
  if (!(await secretMatches(bearerToken(request), env[secretName]))) {
    return json(401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) return json(415, { error: "content-type must be application/json" });

  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_INGEST_BYTES) return json(413, { error: "payload too large" });
  // Content-Length can be absent (chunked) or wrong, so count while reading.
  const bytes = await readBodyLimited(request, MAX_INGEST_BYTES);
  if (!bytes) return json(413, { error: "payload too large" });

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json(400, { error: "body is not valid JSON" });
  }

  const result = validatePayload(source, payload);
  if (!result.valid) return json(422, { error: "payload does not match the contract", details: result.errors });

  await putLatest(env.DASHBOARD_KV, source, payload, new Date());
  return new Response(null, { status: 204 });
}

async function handleScreen(request: Request, env: Env, name: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return json(405, { error: "method not allowed" }, { allow: "GET, HEAD" });
  }
  if (!isScreenName(name)) return json(404, { error: "unknown screen" });
  const { png, asOf, freshness } = await renderScreen(name, env, new Date());
  const headers: Record<string, string> = {
    "content-type": "image/png",
    "cache-control": "no-store",
    "x-data-stale": freshness.stale ? "1" : "0",
    "x-market-open": freshness.marketClosed ? "0" : "1",
  };
  if (asOf) headers["x-data-as-of"] = asOf;
  return new Response(request.method === "HEAD" ? null : png, { headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const ingest = pathname.match(/^\/ingest\/([a-z0-9-]+)$/);
    if (ingest) return handleIngest(request, env, ingest[1]!);
    const screen = pathname.match(/^\/screen\/([a-z0-9-]+)\.png$/);
    if (screen) return handleScreen(request, env, screen[1]!);
    return json(404, { error: "not found" });
  },
} satisfies ExportedHandler<Env>;
