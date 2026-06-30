# housing

Automating the San Francisco rental hunt — monitoring for new/changed listings and surfacing matches proactively. Renting, not buying. Work anchor: **539 Bryant St, San Francisco, CA 94107**.

> **Setting this up?** Read **[SETUP.md](./SETUP.md)** — a step-by-step, LLM-runnable guide. TL;DR: install [`mise`](https://mise.jdx.dev), then `mise run bootstrap && mise run ingest`.

## Status

- **Phase 1 — data ingress mapping:** done. See [`data-ingress-catalog.md`](./data-ingress-catalog.md) (130 sources researched, 50 deep-verified).
- **Phase 2 — Tier 1 ingest engine:** built. Pulls 8 sources → SQLite → `new`/`changed`/`removed` events. Five sources need no config; three unlock with keys.

## Quick start

```sh
mise run bootstrap     # install tools (node/pnpm/python/uv) + deps
mise run sources       # list adapters + which are enabled
mise run ingest        # fetch all enabled sources, diff, notify
```

The five no-config sources (Craigslist, Redfin, DAHLIA, Zumper, RentSFNow) work
immediately. Add API keys in `.env` to enable RentCast, Reddit, and HomeHarvest —
see [SETUP.md](./SETUP.md).

## How it works

```
adapters (per source) → normalize → SQLite store → diff (new/changed/removed) → digest + Pushover push
```

- **Tool/version management:** [`mise`](https://mise.jdx.dev) — one `mise run bootstrap` from a clean clone.
- **Engine:** TypeScript (run via `tsx`), `node:sqlite` storage, Pushover notifier (set `PUSHOVER_TOKEN`/`PUSHOVER_USER` in `.env`); events also persist in the `events` table.
- **Storage:** `data/housing.db` (gitignored). First run per source seeds silently; later runs emit events.

## Tier 1 sources (built)

| Source | Adapter | Config | Removal-aware |
|---|---|---|---|
| Craigslist `sapi` JSON | `craigslist` | none (residential IP) | no (new-today feed) |
| Redfin `/stingray` rentals | `redfin` | none (US IP) | yes |
| DAHLIA (SF affordable/BMR) | `dahlia` | none | yes |
| Zumper `/listables` | `zumper` | none | no |
| RentSFNow / Veritas sitemap | `rentsfnow` | none | yes |
| RentCast API | `rentcast` | `RENTCAST_API_KEY` | no |
| Reddit housing subs | `reddit` | `REDDIT_CLIENT_ID/SECRET` | no |
| HomeHarvest (Realtor.com) | `homeharvest` | `HOUSING_HOMEHARVEST=1` | no |

## Next up

Tier-2 anti-bot portals (Zillow via Apify, Apartments.com), per-listing price
enrichment for Redfin/RentSFNow, cross-source dedup, and a deploy target on the
home box. See the catalog's Tier 2/3 and "gaps" sections, and the `.mcp.json`
Playwright/Fetch servers for in-editor scraping.
