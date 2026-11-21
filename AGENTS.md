# Kindle Dashboard

E-ink dashboard for a jailbroken Kindle. Cloud producers push data to a Cloudflare Worker backend, the Worker renders screens as PNGs, and the Kindle only fetches and displays them. See [README.md](README.md) for the architecture.

This file is the single source of instructions for every agent. `CLAUDE.md` imports it.

## Standing rules

1. **This repo is public.** Never commit secrets, tokens, account numbers, positions, P&L, or other personal data. Local secrets go in `.dev.vars` or `.env` (both gitignored); deployed secrets go in Worker secrets. Sample data in tests and fixtures must be made up.
2. **The Kindle is a display, nothing more.** No endpoint the Kindle can reach may trigger an action: no orders, no writes to outside services, no changes to producer state.
3. **The backend never holds trading credentials.** Producers fetch their own data and push it here. A producer that needs a broker or account token keeps that token in its own repo and runtime.
4. **Every request is authenticated.** Producers send a per-producer ingest secret. Screens sit behind Cloudflare Access and the Kindle uses a service token.
5. **Every screen shows when its data is from.** Print the data timestamp, and show a stale banner when the data is older than the screen's refresh interval allows or when the market is closed.
6. **Track work in GitHub Issues, not Linear.** This project files no Linear issues. Issues are public like the repo, so anything private goes in the owner's Notion, with only a link in the issue.

## Cloudflare

- The backend will have a Wrangler config, so use `wrangler` in this repo rather than `cf`.
- Account-level setup (Access applications, service tokens, custom domains, plan changes) is done by the owner. When work reaches one of those steps, stop and give an exact checklist.

## Layout (planned)

```
worker/     Cloudflare Worker: ingest API, storage, rendering, screen routes
kindle/     Scripts installed on the Kindle (fetch, display, sleep)
contract/   Data contract producers follow (JSON schema per source)
```

Create a folder when its first code lands.

## Open decisions

- Where the trading data fetcher runs: a scheduled Worker acting as an MCP client, or a small VPS. Depends on whether Robinhood's MCP sign-in accepts a non-Claude client.
- Whether storing trading data (positions, P&L) in Cloudflare is acceptable. The owner decides; record it in the trading project's decision log.
- KV only, or KV plus D1 for history.
