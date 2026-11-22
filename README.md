# Kindle Dashboard

Turns a jailbroken Kindle into an e-ink dashboard. Producers in the cloud push data to a small backend, the backend draws each screen as a PNG, and the Kindle only downloads and shows images.

Status: backend and first two screens are deployed at `kindle.juansaldana.dev` behind Cloudflare Access. No producer pushes real data yet. The Kindle client is partly tested on a jailbroken Kindle (see `kindle/README.md`).

## How it fits together

```
Producers (cloud)                  Backend (Cloudflare Worker)                Kindle
─────────────────                  ───────────────────────────                ──────
trading data fetcher  ──POST──▶    /ingest/<source>   (secret per producer)
AI summary agent      ──POST──▶    stores latest data (KV), history (D1) later
dev board, weather …  ──POST──▶    renders each screen to a grayscale PNG
                                   /screen/<name>.png ◀──GET (Access token)── curl + eips -g
```

- **Backend:** a Cloudflare Worker. It owns the ingest API, storage, rendering, and the data contract producers follow.
- **Producers:** live with the data they report. Each one authenticates with its own secret and only pushes data.
- **Kindle client:** a shell script on the jailbroken Kindle that fetches a screen every few minutes, shows it with `eips -g`, and sleeps. It holds only a Cloudflare Access service token.

## Run it locally

Needs Node 22+ and npm. Everything below runs on your machine only; nothing touches a Cloudflare account.

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars   # local-only ingest secrets
npm test                         # Vitest inside the Workers runtime
npm run typecheck
npm run preview                  # writes screen PNGs to ../out/ (gitignored)
npm run dev                      # wrangler dev on http://localhost:8787
```

`npm run preview` starts `wrangler dev`, pushes the made-up payloads in `contract/examples/` through the real ingest route, and saves each screen three ways: `out/<screen>.png` (fresh data), `out/<screen>-stale.png` (data 8 days old, so the stale banner shows) and `out/<screen>-empty.png` (no data yet).

With `npm run dev` running, try the routes by hand:

```sh
curl -i -X POST http://localhost:8787/ingest/trade-plans \
  -H "Authorization: Bearer local-dev-trading-secret" \
  -H "Content-Type: application/json" \
  --data @../contract/examples/trade-plans.json          # 204
curl -o /tmp/trade-plans.png http://localhost:8787/screen/trade-plans.png
```

A missing or wrong secret gets `401`. The data contract and every response code are in [contract/README.md](contract/README.md).

## Screens

| Screen | Route | Source | Stale after (market hours) |
|---|---|---|---|
| Open trade plans: entry, stop, target, distance to stop, max loss | `/screen/trade-plans.png` | `trade-plans` | 20 min |
| Pre-market and end-of-day summary | `/screen/market-summary.png` | `market-summary` | pre-market 7 h, end-of-day 30 min |

Every screen prints its data time and the render time. A black **STALE** banner means a data problem and lists each reason: no data yet, an unreadable or future data time, or data older than the screen allows. Age is market-hours age: only the time the regular session (Mon to Fri, 09:30 to 16:00 New York, daylight saving aware) was open between the data time and now counts. Trade-plan data from Friday 15:55 is fresh all weekend and goes stale at 09:46 on Monday. A summary's limit depends on its `session`: a pre-market summary gets one full session plus 30 minutes, so it stays fresh through its own session; an end-of-day summary gets 30 minutes, so it stays fresh overnight and shows STALE at 10:00 New York time if no pre-market summary has replaced it. Because market-hours age stops while the market is closed, a missing summary cannot be flagged before the open or in the evening. The banner shows the market-hours age next to the limit; the wall-clock age is on the data line.

A closed market is not a data problem. Trade plans show a separate outlined **MARKET CLOSED** notice beside the title. The summary screen leaves it out, because its pre-market or end-of-day label already says so. "Closed" uses the New York clock (Mon to Fri, 09:30 to 16:00) plus the producer's `market_status`. The age check uses the clock only, so a producer that stops pushing still goes stale. There is no holiday calendar: on a holiday or after a half-day close, the clock treats the market as open, so trade plans show STALE once their data passes the limit.

Screens never clip silently. Each body has a fixed height; trade plans show as many plans as fit (4, or 3 under the STALE banner) and the summary shows the points that fit, each followed by a `+ N more not shown` line. The summary's watch and plan-count footer always stays on screen. `npm run preview` also writes `-max` and `-max-stale` variants from the largest payloads the contract allows (`worker/test/fixtures/`).

Rendering: [Satori](https://github.com/vercel/satori) (through `@cf-wasm/satori`, which loads its WebAssembly the way Workers require) lays out the screen and emits SVG, [resvg](https://github.com/thx/resvg-js) rasterises it, and the Worker converts the pixels to an 8-bit grayscale PNG at 1072 x 1448. The screen size is one value, `SCREEN_SIZE` in `worker/src/config.ts`. The font is Atkinson Hyperlegible (SIL OFL), chosen for legibility at a distance.

## Deploying (owner)

Done once on 2026-11-22; kept here for rebuilding or rotating. These steps change the Cloudflare account, so the owner runs them.

The Worker needs the **Workers Paid plan** (the owner has it). Each screen render is CPU-bound layout and rasterising: measured locally under `wrangler dev` at about 200 ms per trade-plans render and 330 ms per summary render with the largest payloads (about 100 ms with the examples). That is far over the Free plan's 10 ms CPU limit and well inside the Paid plan's default 30 s. `npx wrangler deploy --dry-run` (local build, no account change) measures the bundle at 3,362 KiB, 1,186 KiB gzipped, inside the Paid plan's 10 MB limit. At a 10-minute refresh that is about 4,300 renders a month.

1. **Access first.** In Zero Trust, create a service token for the Kindle, then a self-hosted Access application for `kindle.juansaldana.dev` with path `screen/*` and one policy: action **Service Auth**, include that service token. Leave `/ingest` outside the application; the producer secrets protect it. Then put your team domain (`https://<team>.cloudflareaccess.com`) and the application's **Application Audience (AUD) Tag** in `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `worker/wrangler.jsonc`. The Worker verifies Access's signed JWT on every `/screen/*` request and answers 403 when these are empty or the JWT is missing or invalid, so a misconfigured Access application blocks the screens instead of exposing them.
2. **Secrets in 1Password.** Keep the service token (`CF_CLIENT_ID`, `CF_CLIENT_SECRET`) and one random ingest secret per producer (`INGEST_SECRET_TRADING`, `INGEST_SECRET_SUMMARY`) in the project's 1Password Environment. Agents read it through `op-sa` with a read-only service account.
3. **KV namespace:** `cd worker && npx wrangler kv namespace create DASHBOARD_KV`, then put the printed `"id"` in the `kv_namespaces` entry in `worker/wrangler.jsonc`.
4. **First deploy.** Wrangler will not deploy a new Worker whose `secrets.required` are unset, and `wrangler secret put` needs the Worker to exist, so the first deploy passes the secrets in a temporary file that is deleted afterwards:
   ```sh
   cd worker && op-sa run --environment <environment-id> -- sh -c 'f=$(mktemp) && trap "rm -f \"$f\"" EXIT && printf "INGEST_SECRET_TRADING=%s\nINGEST_SECRET_SUMMARY=%s\n" "$INGEST_SECRET_TRADING" "$INGEST_SECRET_SUMMARY" > "$f" && npx wrangler deploy --secrets-file "$f"'
   ```
   Later deploys are plain `npx wrangler deploy`; the secrets stay on the Worker. `workers_dev` and `preview_urls` stay `false`, so the screens have no URL that skips Access.
5. **Check Access before any producer pushes real data:** `curl -i https://kindle.juansaldana.dev/screen/trade-plans.png` without the token must return a redirect or 403, not a PNG. With the two `CF-Access-Client-*` headers it must return the PNG.
6. Put the service token's Client ID and Secret in `kindle/dashboard.conf` on the device (see [kindle/README.md](kindle/README.md)).

## Planned screens

| Screen | Source |
|---|---|
| Watchlist with quote times and a stale banner | Trading producer |
| Pending trade approvals reminder | Trading producer |
| Strategy scoreboard | Backtest results |

Later: dev status board, weather and calendar, focus timer.

## Repository layout

```
worker/     Cloudflare Worker: ingest API, KV storage, rendering, screen routes, tests
contract/   JSON Schema per source, plus made-up example payloads
kindle/     Shell script for the Kindle (fetch, display, sleep); parts tested on the device
```

## Device

Tested target: Kindle 11th generation (2022, KT5). Jailbreak guides: [kindlemodding.org](https://kindlemodding.org/).

## License

[MIT](LICENSE)
