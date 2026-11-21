# Data contract

Producers push one JSON document per source to `POST /ingest/<source>`. Each source has a JSON Schema (draft 2020-12) here, and the Worker validates every payload against it before storing it. The schemas in this folder are the only copy; the Worker imports them.

| Source | Schema | Producer | Secret (Worker secret name) | Screen |
|---|---|---|---|---|
| `trade-plans` | [trade-plans.schema.json](trade-plans.schema.json) | trading producer | `INGEST_SECRET_TRADING` | `/screen/trade-plans.png` |
| `market-summary` | [market-summary.schema.json](market-summary.schema.json) | AI summary agent | `INGEST_SECRET_SUMMARY` | `/screen/market-summary.png` |

## Rules every payload follows

- `schema_version` is `1`. A breaking change adds a new version.
- `as_of` is required: the time the data describes, in RFC 3339 with an offset (`2026-11-20T14:35:00-05:00`). Screens print it and show a stale banner when it is too old.
- `market_status` is optional. When a producer sends `closed`, `pre-market` or `after-hours`, the trade-plans screen shows its market-closed notice even during regular hours (for holidays and half days). It never makes data count as fresh: the stale check uses the clock only.
- Trade-plan prices must be ordered by side: long `stop < entry < target`, short `target < entry < stop`. The Worker checks this after the schema and answers `422` with the plan's path (`#/plans/2`).
- Limits are set to what fits on the screen: for example 80-character headlines, at most 4 indices with 6-character symbols, and changes between -99.99% and 99.99%. Longer lists (plans, points, watch symbols) are accepted and shown as `+ N more`.
- Unknown fields are rejected (`additionalProperties: false`), so typos fail loudly.
- Payloads carry display data only. Nothing in them triggers an action.

## Sending a payload

```sh
curl -X POST "$BASE_URL/ingest/trade-plans" \
  -H "Authorization: Bearer $INGEST_SECRET_TRADING" \
  -H "Content-Type: application/json" \
  --data @contract/examples/trade-plans.json
```

Responses: `204` stored, `400` not JSON, `401` missing or wrong secret, `404` unknown source, `413` body over 64 KB (counted while reading, with or without `Content-Length`), `415` not `application/json`, `422` fails the schema (the body lists the errors).

## Examples

[examples/](examples/) holds one made-up payload per source. Tests check that each example validates against its schema. All symbols, prices and text in them are invented.
