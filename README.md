# housing

Automating the San Francisco rental hunt — monitoring for new/changed listings and surfacing matches proactively. Renting, not buying. Work anchor: **539 Bryant St, San Francisco, CA 94107**.

## Status

Phase 1 (data ingress mapping) complete. Implementation not yet started.

## Contents

- [`data-ingress-catalog.md`](./data-ingress-catalog.md) — ranked catalog of every automatable data ingress route (MCP / CLI / API / internal-JSON / scrape / RSS) for SF rentals, with concrete access paths, auth, cost, anti-bot notes, freshness, and an architecture sketch for the monitoring loop. 130 sources researched, 50 deep-verified.

## v1 monitor spine (next up)

Free/low-anti-bot backbone to stand up first, on the home Synology:

1. **Craigslist** — `craigslist-pp-cli` (residential IP required)
2. **Redfin** — `/stingray/api/v1/search/rentals`
3. **RentCast** — official API (legal, diffable backbone)
4. **DAHLIA** — SF affordable/BMR feed
5. **Zumper** — `/api/t/1/pages/listables`
6. **RentSFNow / Veritas** — sitemap diff
7. **Zillow** — Apify `maxcopell/zillow-scraper`
8. **changedetection.io** — schedule + diff + notify backbone → pushover

See the catalog for the full tiered list and gaps to test live.
