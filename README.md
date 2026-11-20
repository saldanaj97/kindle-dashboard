# Kindle Dashboard

Turns a jailbroken Kindle into an e-ink dashboard. Producers in the cloud push data to a small backend, the backend draws each screen as a PNG, and the Kindle only downloads and shows images.

Status: design phase. No code yet.

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

## Planned screens

| Screen | Source |
|---|---|
| Open trade plans: entry, stop, target, distance to stop, max loss | Trading producer |
| Pre-market and end-of-day summary | Trading producer + AI summary |
| Watchlist with quote times and a stale banner | Trading producer |
| Pending trade approvals reminder | Trading producer |
| Strategy scoreboard | Backtest results |

Later: dev status board, weather and calendar, focus timer.

## Device

Tested target: Kindle 11th generation (2022, KT5). Jailbreak guides: [kindlemodding.org](https://kindlemodding.org/).

## License

[MIT](LICENSE)
