<!--
SF Rental Data Ingress Catalog
Generated 2026-06-29 via multi-agent workflow (7 discovery sweeps -> adversarial verification -> synthesis).
130 raw sources discovered -> 130 unique -> 50 deep-verified (49 confirmed usable).
Scope: data ingress routes only (how to AUTOMATE collection); criteria/price filtering deliberately deferred.
Work address anchor: 539 Bryant St, San Francisco, CA 94107.
-->

# SF Rental Data Ingress Catalog — Scheduling-Ready Map (work address 539 Bryant St, 94107)

## 1. Executive Summary — the realistic landscape

The good news: there is a **solid free/cheap automatable spine** for SF rentals that needs no anti-bot fight. Five sources are essentially "GET a URL on a cron and diff the JSON," all confirmed live in testing:

- **Craigslist** (`sapi.craigslist.org` JSON) — highest-volume, lowest-latency NEW signal in SF, but **must run from a residential IP** (your home Synology is the right host). A purpose-built CLI (`craigslist-pp-cli`) already emits `[NEW]`/`[PRICE-DROP]` events.
- **Redfin** (`/stingray/api/v1/search/rentals`) — clean JSON, no auth, light WAF, US IP only. SF = 2 requests/poll.
- **RentCast** (official REST API) — the only legal, stable, key-authed aggregator with first-class `listedDate`/`lastSeenDate`/`removedDate` for diffing. ~$74/mo for real monitoring.
- **DAHLIA** (`housing.sfgov.org/api/v1`) — authoritative SF affordable/BMR lottery feed, free, zero anti-bot (income-capped lottery units, so scope-limited for a tech salary).
- **Zumper** (`/api/t/1/pages/listables`) and **RentSFNow/Veritas** (sitemap diff) — both free, light/no anti-bot, SF-dense.

The walled-off reality: **the single dominant SF rental portal, Zillow, is the hardest to scrape** (Imperva + PerimeterX/HUMAN press-and-hold, robots-disallowed). Its only *official* pull API (Bridge) is enterprise/MLS-gated and thin on rentals — a dead end for a renter. The realistic Zillow path is a **managed Apify actor** (`maxcopell/zillow-scraper`) or a paid unblocker (Bright Data). Same story for **Apartments.com** (CoStar; Akamai+DataDome) which holds the biggest *unique* SF multifamily inventory — only reachable via managed actors. **HotPads/Trulia are Zillow-Group-owned and serve the same inventory**, so scraping them is largely redundant.

The aggregators (RentCast, HelloData, Datafiniti, Mashvisor) all **normalize the same public/syndicated sources** — they overlap the portals and **systematically miss Craigslist-only and private-landlord SF units**. Use one as a legal spine, not as additive inventory.

Net strategy: **stand up the free direct-JSON sources + RentCast + the Craigslist CLI first** (covers most of the market with near-zero anti-bot cost), then **bolt on Apify-managed Zillow + Apartments.com** for the portal inventory those miss, then **changedetection.io on the Synology** as the schedule/diff/notify backbone for the long-tail PM sites.

A note on legality: most internal-endpoint and scraping routes violate the target's ToS. For a single personal renter at low volume the practical risk is low, but don't redistribute or run at scale.

---

## 2. Tiered Catalog of Ingress Routes

Legend — **Verdict**: ✅ recommend / 🟡 conditional / ⛔ avoid. **Confidence** is the verifier's confidence the route works as described.

### TIER 1 — Wire up first (clean, automatable now; free or cheap; no/light anti-bot)

These are the v1 backbone. All confirmed live except where noted.

---

**Craigslist sapi JSON API — SF Bay** · `internal-json-endpoint` · ✅ high
- **Access:** `GET https://sapi.craigslist.org/web/v8/postings/search/full?batch=1-0-360-1-0&cc=US&lang=en&searchPath=apa&sort=date&postedToday=1` — add `&area=1&subarea=sfc` for SF-city, or `&lat=37.7825&lon=-122.3947&search_distance=2&postal=94107` for a radius around 539 Bryant. Detail body via `rapi.craigslist.org/web/v8/postings/{UUID}?lang=en` (per-item UUID, not numeric id). `items[]` are **compact positional arrays** decoded against inline `data.decode` tables — budget a small parser.
- **Auth:** none. **Cost:** free. **Rate limits:** per-IP; poll a given search every 2–5 min, ≤3–5 concurrent.
- **Anti-bot:** IP reputation only — no JS/CAPTCHA on the JSON. **Datacenter IPs get instant 403; MUST run from a residential IP (home Synology).**
- **Freshness:** real-time (`postedToday=1`, `sort=date`). **NEW/CHANGED:** stable posting id/UUID → diff per poll; best CL NEW signal. **Effort:** medium (parser + residential egress).
- **SF:** full Bay; `searchPath` codes `apa`/`roo`/`sub`/`hhh`.

**craigslist-pp-cli (mvanhorn/printing-press-library)** · `cli` (also MCP) · ✅ high
- **Access:** `npx -y @mvanhorn/printing-press-library install craigslist` or `go install .../craigslist-pp-cli@latest`. Workflow: `watch save apartments --sites sfbay --category apa --max-price 2500` → cron `watch run apartments --json` (or `watch tail --interval 5m --json`). Emits typed `[NEW]`/`[PRICE-DROP]`/`SEED` JSON; local SQLite snapshot history distinguishes new vs edit vs repost.
- **Auth:** none. **Cost:** free OSS. **Anti-bot:** same residential-IP requirement; ships explicit 403-cooldown guidance (≥5m, ≤3–5 watches). **Freshness:** real-time. **Effort:** low.
- **Caveat:** v0.1.18, repo ~3mo old, binary not runtime-tested by verifier — pin a version + smoke-test before trusting unattended. **This is the best ready-made CL wrapper; use it instead of hand-rolling the sapi parser.**

**Redfin Stingray rentals JSON** · `internal-json-endpoint` · ✅ high
- **Access:** `GET https://www.redfin.com/stingray/api/v1/search/rentals?al=1&region_id=17151&region_type=6&num_homes=350&start=0` (SF city `region_id=17151`). Paginate with `&start=350` (350 hard cap; SF = 543 rentals = **2 requests/poll**). Send browser UA + Referer. Per-property detail: `/stingray/api/v1/rentals/{rentalId}/floorPlans`.
- **Auth:** none. **Cost:** free. **Rate limits:** per-IP, aggressive at scale, irrelevant at 2 req/poll. **Anti-bot:** light CloudFront/WAF; **US-IP only** (`location-autocomplete` is 403-blocked — hardcode SF region_ids, don't look them up). **Freshness:** `freshnessTimestamp`/`lastUpdated` stamped to the minute. **NEW/CHANGED:** diff on `homeData.propertyId` + `rentPriceRange`/`numAvailableUnits`/`status`. **Effort:** low.
- **SF:** strong but **thinner than Zillow/Apartments** (RentPath/Zillow-syndicated feed). Correction to common belief: `gis-csv` is **for-sale only** — use `/api/v1/search/rentals` for rentals.

**RentCast official API** · `official-api` · ✅ high — **the legal spine**
- **Access:** `GET https://api.rentcast.io/v1/listings/rental/long-term?city=San Francisco&state=CA&status=Active&limit=500&offset=0` (also `zipCode=94107`, or `latitude=37.7749&longitude=-122.4194&radius=8`). Header `X-Api-Key`. Use `daysOld=1` for cheap delta sweeps.
- **Auth:** API key, self-serve at app.rentcast.io (no business vetting). **Cost:** free 50 req/mo (too small); realistic **Foundation $74/mo = 1,000 req** (a paginated call = 1 request regardless of result count). **Rate limits:** 20 req/s/key; binding limit is monthly quota.
- **Anti-bot:** none. **Freshness:** 500k+ updates/day, no caching. **NEW/CHANGED/REMOVED:** stable `id` + `listedDate`/`lastSeenDate`/`removedDate`/`status` — best-in-class for diffing. **Effort:** low.
- **Caveat:** it **aggregates the same public/syndicated sources** as the portals — overlaps them, misses Craigslist-only/private SF landlords. Treat as normalizing backbone, not additive inventory. (Do **not** build on legacy Realty Mole — permanently shut down 2025-03-01.) The `robcerda/rentcast-mcp-server` MCP is misdescribed (its `get_property_listings` hits `/properties`, not the rental endpoint, with no status filter) — **call the REST endpoint directly** or fork the MCP.

**DAHLIA SF Affordable Housing API** · `official-api` · ✅ high — crown jewel for BMR
- **Access:** `GET https://housing.sfgov.org/api/v1/listings.json?type=rental` (66 live rentals). Detail `/listings/{id}.json`; units `/listings/{id}/units.json` (rent/availability/AMI); lottery `/listings/{id}/lottery_buckets.json`.
- **Auth:** none. **Cost:** free. **Anti-bot:** none (Heroku, no robots Disallow). **Freshness:** per-listing `LastModifiedDate` current to today. **NEW/CHANGED:** diff `Id` set + `LastModifiedDate`/`Status`/`Units_Available`/`Lottery_Status`/`Application_Due_Date`. **Effort:** low.
- **Scope caveat:** income-capped **lottery** units (e.g. `maxQualifyingAMI` 80%) requiring applications — a high-income hire likely won't qualify for most. High value for completeness/tracking the affordable channel, not a primary path. No MCP exists — call REST directly.

**Zumper internal listables JSON** · `internal-json-endpoint` · ✅ high
- **Access:** 2-step, no login: (1) `GET https://www.zumper.com/api/t/1/bundle` → `{csrf}`; (2) `POST https://www.zumper.com/api/t/1/pages/listables` with header `x-csrftoken:<csrf>` + body `{"external":true,"longTerm":true,"url":"san-francisco-ca","limit":100,...}`. Page via `excludeGroupIds`. (The 2023 `x-zumper-xz-token` requirement is gone.)
- **Auth:** none (per-session CSRF + cookies). **Cost:** free. **Anti-bot:** **lighter than reputed** — Fastly/Varnish, no Cloudflare/DataDome/CAPTCHA; residential proxies NOT needed at low volume. `robots.txt` Disallows `/api` (ToS gray area). **Freshness:** `modified_on` current. **NEW/CHANGED/DELISTED:** stable `listing_id`/`group_id`/`building_id` + `created_on`/`listed_on`/`modified_on` + `previous_price` + `listing_status` → best change-detection field set of any portal here. **Effort:** low.
- **SF:** strong (Zumper is SF-HQ). Note: page-1 skews to corporate multifamily (Yardi/Essex/AvalonBay/Blueground) — the "unique private-landlord inventory" claim is unproven on the default view.

**RentSFNow / Veritas Investments — sitemap diff + JSON-LD scrape** · `sitemap`+`html-scrape` · ✅ high
- **Access:** diff `https://www.rentsfnow.com/property-sitemap.xml` … `property-sitemap5.xml` (~4,061 unit URLs, `<loc>`+`<lastmod>`). On change, GET the unit page (e.g. `/apartments/rental/1651-market-503/`), parse JSON-LD `datePublished`/`dateModified` + EPL `property_price_global_from/to` + the literal "Apartment No Longer Available" banner.
- **Auth:** none. **Cost:** free. **Anti-bot:** none on GETs (permissive robots). **Freshness:** sitemap regenerates to-the-minute. **NEW/CHANGED:** new `<loc>` = new unit; changed `<lastmod>` = relist/delist — fetch page to disambiguate available vs rented. **Effort:** low.
- **SF:** Veritas = **largest single SF/Oakland private portfolio** (~2,100+ SF units). Skip the `catalyst/v1` JSON API — it needs server credentials a renter can't get (not a frontend nonce).

**AppFolio per-PM tenant sites** · `html-scrape` · ✅ high — long-tail landlords
- **Access:** `https://{sub}.appfolio.com/listings` (canonical `/listings/listings`, robots-permitted). Verified SF subs: `apg`, `amsires`, `progressivesf`, `amore`. Each card has a stable UUID (`data-listing-id`, `/listings/detail/{uuid}`). Discover subs via Google `site:appfolio.com San Francisco`. Build + maintain a registry.
- **Auth:** none (JSON variant is 401-gated → parse HTML). **Cost:** free. **Anti-bot:** none; `Crawl-delay: 10`. **Freshness:** real-time per PM. **NEW/CHANGED:** UUID set diff + inline price/availability. **Effort:** medium (registry maintenance; per-sub inventory is single-digit, so breadth matters).

**SpareRoom (US) SEO scrape** · `html-scrape` · ✅ high — rooms/roommates
- **Access:** `https://www.spareroom.com/rooms-for-rent/san_francisco_bay_area` + `/page2…`. Extract `listing-id="NNN"` / trailing path id. **Do NOT use `/flatshare/search.pl`** (UK structure, returns 0 US results, robots-disallowed).
- **Auth:** none for browsing. **Cost:** free (Apify `memo23/spareroom-scraper` ~$0.95/1k as managed fallback, US-capable). **Anti-bot:** light (Cloudflare present, no challenge on browse pages; throttle, browser UA, residential IP). **Freshness:** high churn; poll first 1–3 pages every 15–60 min. **NEW:** stable integer ids; **CHANGED:** refetch detail page. **Effort:** low. **SF:** #1 dedicated room/share channel (722 rooms observed).

**HomeHarvest (Realtor.com OSS lib)** · `library` · ✅ high
- **Access:** `pip install -U homeharvest` → `scrape_property(location="San Francisco, CA", listing_type="for_rent", past_days=2, return_type="raw")` (also ZIP/radius). Self-mints a Realtor.com mobile token; POSTs internal GraphQL — no browser anti-bot. **No CLI exists** (despite README) — Python API only.
- **Auth:** none. **Cost:** free MIT (proxy only if you hit 403s). **Anti-bot:** light-but-recurring (documented 403 waves; budget a residential proxy on a long cron). **Freshness:** continuous; `list_date`/`last_status_change_date` for diffing. **NEW/CHANGED:** dedup on `property_id`. **Effort:** low. **SF:** genuine but Realtor.com rentals are thinner than Zillow/Apartments — pair for breadth. (Zillow/Redfin modules in the repo don't exist; Realtor.com only.)

**Reddit OAuth Data API** · `official-api` · 🟡 high — NEW-lead intel, not structured listings
- **Access:** register a "script" app at reddit.com/prefs/apps → `POST https://www.reddit.com/api/v1/access_token` (Basic auth, `grant_type=client_credentials`) → `GET https://oauth.reddit.com/r/{sub}/new?limit=100&before={last_fullname}` and `/search?q=apartment OR rent&restrict_sr=1&sort=new`.
- **Auth:** free account + app (client_id/secret). **Cost:** free non-commercial. **Rate limits:** 100 QPM/client_id (honor `X-Ratelimit-*`). **Anti-bot:** none on the authed path (unauth `.json` is datacenter-403'd — use OAuth, descriptive UA). **Freshness:** real-time `/new`. **NEW:** strong (before/after fullnames); **CHANGED:** weak (posts immutable). **Effort:** low-medium.
- **Caveats:** Reddit's Nov-2025 "Responsible Builder Policy" says approval is required before any Data API access — self-serve registration still works in practice but carries policy risk. **Verify housing subs exist before wiring** (r/sanfrancisco/r/bayarea/r/AskSF confirmed; r/bayareahousing/r/sanfranciscohousing/r/bayhousing/r/SFList unverified). Free-text posts → needs LLM extraction downstream.

**PadSplit `__NEXT_DATA__` SSR** · `internal-json-endpoint` · 🟡 high mechanics / low SF value
- **Access:** `GET https://www.padsplit.com/rooms-for-rent/san-francisco-ca` → parse `<script id="__NEXT_DATA__">` → `props.pageProps.dehydratedState.queries[0].state.data.results[]` (id, status, `statusUpdatedAt`, `initialActivationDate`, price, lat/lng). (`/_next/data/<buildId>` route returns HTML fallback — don't use.)
- **Auth:** none. **Cost:** free. **Anti-bot:** none. **NEW/CHANGED:** best-in-class fields (`statusUpdatedAt`). **Effort:** low.
- **Reality:** SF-city `roomsForRentCount=0`; whole MSA returned ~6–8 East-Bay/Peninsula budget shared rooms. Cheap to bolt on as a catch-all, **do not weight it**.

**Microsoft Playwright MCP** · `scraping-infra` (MCP) · ✅ high — local browser workhorse
- **Access:** `npx @playwright/mcp@latest` (use the **scoped** package — `playwright-mcp` is an impostor) or Docker `mcr.microsoft.com/playwright/mcp` (port 8931). Accessibility-tree snapshots; `--proxy-server` for one static proxy.
- **Auth:** none, free, Apache-2.0. **Anti-bot:** weak OOTB (no rotation/CAPTCHA) — fine for Craigslist/small portals; pair with Bright Data/Apify residential proxy (or the `apify/actor-playwright-mcp` mirror) for hard targets. **Effort:** medium. **Use for** lightly-protected long-tail PM sites that lack an API.

**Fetch MCP (official reference)** · `mcp` · 🟡 high — open-feed glue only
- **Access:** `uvx mcp-server-fetch`; single `fetch` tool (URL→markdown, `--user-agent`, `--proxy-url`). **Auth:** none, free. **Anti-bot:** none — plain HTTP, **403'd by Craigslist/Cloudflare/Akamai** (verifier confirmed CL RSS 403). **Use only for genuinely open RSS/JSON/sitemaps**, not anti-bot targets. Pipeline plumbing, not a source.

---

### TIER 2 — Promising but more effort (paid APIs, Apify actors, scraping infra, change-detection)

The portal inventory the Tier-1 free sources miss lives here, behind managed anti-bot or paid keys.

| Source | Type / Path | Auth · Cost | Freshness · NEW/CHANGED | Anti-bot · SF | Effort · Verdict · Conf |
|---|---|---|---|---|---|
| **Zillow via Apify `maxcopell/zillow-scraper`** | apify · `POST api.apify.com/v2/acts/maxcopell~zillow-scraper/run-sync-get-dataset-items?token=` with SF for-rent `searchQueryState` URL, `extractionMethod=PAGINATION_WITH_ZOOM_IN` | Apify token · **$2/1k results** (+$5/mo free credit); detail actor $3/1k | continuous; diff `zpid`+price+status; `daysOnZillow` | offloaded (PerimeterX/HUMAN); 96% run success · full SF | med · ✅ high · **best Zillow path** |
| **Zillow internal `/async-create-search-page-state`** | internal-json · `PUT` with `searchQueryState{mapBounds,filterState.isForRent}`, `wants{cat1:[listResults,mapResults]}`; 500/query cap → tile SF bbox; `mapResults` = cheap pins | none (cookies help) · proxy/unblocker **$50–500/mo** | near-real-time; `daysOnZillow=0/1` NEW, `priceChange` CHANGED | **severe** — robots-disallowed, Imperva+PerimeterX · full SF | high · ✅ high (DIY) / med (managed) |
| **Apify MCP Server (official)** | mcp · `https://mcp.apify.com` Bearer token, `?tools=<owner>/<actor>`; or REST `run-sync-get-dataset-items` | Apify token · per-actor pay-per-result; $5/mo free | live per run; you diff snapshots | actor-managed proxies · per-actor SF | low · ✅ high — one credential unlocks every rental actor; prefer raw REST for cron |
| **Apify Real-Estate Aggregator `tri_angle/real-estate-aggregator`** | apify · one run → Zillow+Realtor+Zumper+Apartments.com (exclude UK Rightmove), dedup'd | Apify token · $0.003 start + $0.002/listing + $0.05 dedup (~$0.85/run, ~$26/mo daily) | live; diff across runs (no cross-run delta) | offloaded · ZIP 94107 | low · 🟡 high — best breadth/call; raise `maxResultsPerProvider`, low-adoption author (add per-provider health check) |
| **Apify Apartments.com actors** (`haketa/apartments-com-scraper`, `pro100chok/apartments-scraper-usage`, `parseforge`) | apify · `location:"san-francisco-ca"` or SF search URL | Apify token · $2–3.50/1k + residential proxy | daily-ish; diff property+address+floorplan | **Akamai+DataDome**, offloaded · **biggest UNIQUE SF multifamily** | med · ✅ high — keep a 2nd actor as hot spare (selector churn) |
| **Apify Zumper/HotPads actors** (`scrapemind/zumpercom-scraper` $25/mo, `benthepythondev/hotpads-rental-scraper` $10/1k) | apify · city slug/URL | Apify token · varies (higher than $1/1k for some) | live; diff listing URL+price | actor-managed · SF dense | med · 🟡 high — HotPads is **redundant with Zillow** (Zillow Rental Network); Zumper has light direct path (Tier 1) |
| **Bright Data MCP (official)** | mcp · `npx @brightdata/mcp`, `scrape_as_markdown` (free) / `web_data_zillow_properties_listing` (PRO/paid) | API_TOKEN · **5,000 req/mo free** Rapid mode; structured Zillow = paid; PAYG ~$1.50/1k | live; diff yourself; **scheduled Zillow dataset** option | **strongest** — residential + CAPTCHA + unblock · any URL | med · ✅ high — the anti-bot heavy-lifter for Zillow/Realtor |
| **HasData MCP / REST (Zillow+Redfin+Airbnb)** | mcp/rest · `GET api.hasdata.com/scrape/zillow/listing?keyword=San Francisco, CA&type=forRent` | x-api-key, no CC · **free 1,000 req/mo**; Startup $49/mo | live ~2s; diff on `zpid` | managed (absorbs PerimeterX) · SF=Zillow's | low · ✅ high — one key, 3 portals; prefer REST over MCP for cron |
| **Firecrawl MCP** | mcp · `npx -y firecrawl-mcp`, `firecrawl_extract` (schema'd) on rental URLs | FIRECRAWL_API_KEY · free 1,000 credits/mo; Hobby $16 | live; DIY diff; `firecrawl_monitor_*` | moderate (Stealth 5cr/page); heavy DataDome still blocks · any URL | med · ✅ high — extract removes parser-writing for soft sources |
| **Oxylabs MCP** | mcp · `uvx oxylabs-mcp`, `universal_scraper`/`ai_scraper` + geo=US | acct · free 2,000 results; Micro $49/mo | live; DIY diff | strong (195+ countries) · any URL | med · 🟡 high — Bright Data alternative/fallback |
| **Browserbase / Stagehand MCP** | mcp · `https://mcp.browserbase.com/mcp` Bearer; `act/extract/observe` | API key · free tier too small; Dev $20/mo | live; LLM-extract drift → normalize before diff | strong (Advanced Stealth = Scale-only) · any URL | med · 🟡 high — reserve for **login-walled/heavy-JS broker portals** only |
| **changedetection.io (self-host)** | scraping-infra · Docker on Synology + sockpuppetbrowser sidecar; add SF search/JSON URLs as "watches", Apprise→pushover | none/self-host · **free** | recheck down to minutes; diff+notify is the product | not a bypass — soft targets only (pin selectors / watch JSON to avoid ad-row noise) · any URL | med · ✅ high — **the schedule+diff+notify backbone** |
| **RapidAPI `zillow-property-data1`** ✅ *implemented (`zillow` source)* | data-api · **async** `POST zillow-property-data1.p.rapidapi.com/v1/properties` (search / zipcodes / zpids / addresses / urls) → poll `GET /v1/results/{job_id}` | X-RapidAPI-Key · paid per result | live; diff `zpid`+price+`home_status` | residential-proxy scrape (per-item PerimeterX blocks auto-retried) · full SF | low · ✅ high — rich per-property data (price, beds/baths, rent+sale zestimates, price/tax history, images). NB: `type=rent` is unreliable for broad search/zip discovery (skews FOR_SALE); rental search-page URLs get blocked — prefer zpid/address/URL lookups. *(Legacy `zillow-com1/propertyExtendedSearch` was the prior path.)* |
| **RapidAPI Realtor wrappers** (`apidojo realty-in-us` `/properties/v2/list-for-rent`, `ntd119/realtor-search`, `realtor16`) | data-api · `city=San Francisco&state_code=CA&sort=newest` | X-RapidAPI-Key · freemium → ~$10–50/mo | mirrors Realtor.com; diff `property_id`+`last_update` | provider-handled (Kasada) · SF thinner | low · 🟡 high — **secondary/dedup**; RapidAPI in post-Nokia flux, keep swappable |
| **Realtor.com internal `/api/v1/hulk`** | internal-json · `POST .../api/v1/hulk?client_id=rdc-x&schema=vesta` (GraphQL, for-rent query undocumented) or parse `/apartments/San-Francisco_CA/` `__NEXT_DATA__` | none · proxy spend | frequent; `list_date`/`last_update_date` | **Kasada/Cloudflare** (not Akamai) · SF secondary | med · 🟡 high — prefer the RapidAPI wrapper over raw |
| **Apartments.com internal HTML + JSON-LD `@graph`** | html-scrape · merge cards + `ld+json` CollectionPage; via managed actor in practice | none · residential proxy (DIY blocked first hit) | ~daily; first-seen diff (no daysOnMarket) | **Akamai+DataDome**, datacenter-403 · biggest unique SF multifamily | high DIY / med managed · 🟡 high |
| **HelloData.ai API** | official-api · free `/property/search` (IDs) → paid `/property/{id}` ($0.50/rec) + activation-gated `/market/market-search` | x-api-key, **B2B sales-gated** · paid plans custom | 24h refresh; per-property history diff | none on API · **multifamily communities only** | med · 🟡 high — sales-gated + multifamily-only; supplement, not primary |
| **Datafiniti Property API** | official-api · `POST api.datafiniti.co/v4/properties/search` Lucene query `city:"San Francisco" AND mostRecentStatus:Rental AND dateUpdated:[since TO *]` | token · trial 1k/2wk; $119–3,999/mo (record quota) | 24h on-market / weekly off; `dateAdded`/`dateSeen` diff | none on API · 122M+ records | med · 🟡 high — laggy aggregator; cross-source dedup layer |
| **Mashvisor API** | official-api · `GET api.mashvisor.com/v1.1/client/city/listings` + `/long-term-rental-comps`, x-api-key | trial 30 credits; ~$129/mo | daily; weak for "rentable now" | none · SF covered but investment-first | med · 🟡 high — **comps/rent-estimate enrichment**, not a listing feed |
| **Airbnb monthly (pyairbnb / Apify `tri_angle/airbnb-scraper`)** | internal-json/apify · `pip install pyairbnb` (auto-fetches key+hash) or actor `locationQueries=["San Francisco"]`, monthly filters | none/Apify token · free DIY+proxy, or ~$1.25/1k | very high churn; diff listing-id sets (240-cap → tile by bbox/price) | high (Bot Manager) · largest SF furnished/monthly | med · 🟡 high — **furnished mid-term, not lease**; ToS risk |
| **Furnished Finder (Apify `adventurous_nut/...` $1/1k, `rigelbytes/furnishedfinder`)** | apify · seed SF search URL; Apify webhook on new items | Apify token · ~$1–4/1k + plan | good for furnished; diff property-id + availability | **Cloudflare-403** even on sitemap, offloaded · solid SF | med · 🟡 high — **midterm/travel-nurse** angle; partner "API" is supply-side only |
| **Reddit `.rss` with private token** | rss · `r/{sub}/new/.rss?limit=100&user=<hash>&feed=<hash>` (token from reddit.com/prefs) | free account+token · free | near-real-time NEW; dedup on `<id>` t3_ | IP-throttled (1/60s unauth now); token bypasses · same SF subs | low · 🟡 high — token required from cloud; CHANGED weak |
| **nexgendata Real-Estate MCP (Apify)** | apify · `mcp.apify.com/?tools=nexgendata/real-estate-mcp-server`, `search_properties` | Apify token · $0.01/item | live; for-sale-oriented | offloaded · ZIP | med · 🟡 high — **rental support unverified** (no rental param, all examples for-sale); smoke-test before reliance |
| **Reddit unauth `.json`** | internal-json · `r/{sub}/new.json?limit=100` | none · free | real-time NEW | **datacenter-403'd** — residential IP only · SF subs | med · 🟡 high — home-NAS fallback to OAuth |

### TIER 3 — Marginal / blocked / high-maintenance / dead

| Source | Why it's here · Verdict |
|---|---|
| **Zillow Bridge / Bridge Data Output API** (`api.bridgedataoutput.com`) | The only *official* Zillow pull-API, but **enterprise/MLS-gated** (~$500+/mo, weeks-months approval, needs brokerage relationship), and **SF rentals are mostly off-MLS** so coverage is thin. ⛔ avoid for rentals. |
| **Trulia internal GraphQL / `__NEXT_DATA__`** | Real but **Zillow-Group-owned = identical inventory to Zillow** at the same Akamai cost. Zero net-new. Parse `/for_rent/San_Francisco,CA/` `__NEXT_DATA__` (not robots-disallowed `/graphql`). 🟡→avoid; redundancy only. |
| **HotPads internal `hotpads-api`** | Real but **same Zillow Rental Network inventory**, **DataDome+Akamai+reCAPTCHA** (hardest tier), sitemap is category-index not listing URLs. Via `benthepythondev/hotpads-rental-scraper` only, after Zillow is covered, for scattered private-landlord pins. 🟡 deprioritize. |
| **Zillow deprecated public API (ZWSID)** | Shut down ~2021. ⛔ dead — listed so it isn't chased. |
| **Zillow Rentals Feed Connect / Lead API** | Feed-**IN** (property managers push listings), wrong direction. Confirms Zillow/Trulia/HotPads share one backend → don't scrape all three. ⛔ N/A. |
| **CoStar siblings** (ApartmentFinder, ForRent, ApartmentHomeLiving, WestsideRentals, After55) | Same CoStar backend + Akamai/DataDome as Apartments.com → duplicate data. Scrape Apartments.com only. ⛔ redundant. |
| **Apartments.com Customer API** (`api.apartments.com/v1`) | B2B manage-your-own-ads (OAuth2 password grant, five-figure contracts), not market-read. ⛔ wrong direction. |
| **Rent.com / ApartmentGuide (RentPath)** | No self-serve API; scrape overlaps Apartments.com/Zillow. 🟡 low marginal value. |
| **Apartment List** | Internal JSON exists but undocumented + quiz-gated + CDN-protected; no named actor. 🟡 reverse-engineer if needed. |
| **PadMapper (Zumper-owned)** | Cloudflare client-challenge; inventory ≈ Zumper. Scrape Zumper directly. 🟡 redundant. |
| **RentHop** | Sitemap-crawlable, but NYC-centric/agent-skewed, thin SF. 🟡 low priority. |
| **RentCafe APIv2 (Yardi)** | Partner-gated (2+ yrs, 3 Voyager clients) = closed to renters. But many SF buildings run RentCafe — hit a known building's own availability endpoint for freshest unit data. 🟡 per-building only. |
| **MLS/RESO stack** — CoreLogic Trestle (~$12k/yr), Bridge, RESO Web API/ListHub, Spark | All **membership/broker-gated AND thin on SF rentals** (off-MLS). ⛔ dead end for an individual renter. |
| **ATTOM / Estated** | Public-record + AVM, **not active listings**. Enrichment only. 🟡 enrichment. |
| **Dwellsy IQ API** | Rent **comps/analytics** (PMS-sourced), not a NEW-listing firehose. 🟡 pricing layer. |
| **Mashvisor/Rabbu/AirDNA** | STR/investment analytics, wrong vertical for long-term lease. ⛔ (Mashvisor kept in Tier 2 as comps). |
| **Rentberry / Roomster / Roomi / RoomieMatch / Diggz / Kopa** | No usable API; Roomster (FTC fake-listings settlement) and Roomi (semi-abandoned) are low signal. 🟡→⛔. |
| **Symbi / Sonder** | **Defunct** (Symbi folded into Roomi 2018; Sonder bankrupt 2025-11). ⛔ dead. |
| **Realty Mole API** | **Permanently shut down 2025-03-01** → use RentCast. ⛔ dead. |
| **MCP servers: `sap156/zillow-mcp-server`** (Bridge-gated, ToS forbids local storage), **`agentic-ops/real-estate-mcp`** (static fake Riverside data), **`andrewlwn77/rapidapi-mcp`** (API discovery, not listings), **`zytelabs/zyte-mcp`** (unconfirmed) | All confirmed off-target or gated. ⛔ flagged to prevent wasted effort. |
| **Craigslist native RSS (`?format=rss`)** | **Removed by Craigslist** — 403/gone since the 2023 JS redesign. Use the sapi JSON API instead. ⛔ dead. |
| **pycraigslist / python-craigslist / craigsfeed / ecnepsnai** | Stale HTML scrapers (obsolete selectors) — silently return nothing. ⛔ code reference only; use sapi/`craigslist-pp-cli`. |
| **Facebook Marketplace + housing Groups** | Public Marketplace rentals are a **major SF channel** but heavy anti-bot (login modal, datacenter-block); private Groups need a logged-in session (ToS/ban risk). Only via paid Apify actors or manual. 🟡 see "not deep-verified" below. |
| **Nextdoor / OfferUp** | Nextdoor API partner-gated (no individual access); OfferUp heavily defended + thin rental yield. ⛔/🟡 low ROI. |

---

### Not-deep-verified sources (include, marked "not deep-verified")

These appeared in research but weren't independently exercised by the verifier — vet before wiring.

- **Facebook Marketplace — Property Rentals (SF)** *(not deep-verified)* — 2nd-highest-value channel after Craigslist for private landlords/sublets; no read API. Via Apify (`apify/facebook-marketplace-scraper`, `crowdpull/...` no-login, `raidr-api/...` real-time-notify) or Bright Data; or local **`BoPeng/ai-marketplace-monitor`** (uses your FB session, AI-filters, notifies — account-ban caveat). Heavy anti-bot; budget managed scraping.
- **Listings Project** *(not deep-verified)* — weekly-curated, often off-market SF rentals/sublets. Likely **email-only** (no confirmed RSS) — subscribe and parse the weekly email. High signal, low volume.
- **Apify Craigslist actors** (`automation-lab/craigslist-scraper`, `nexgendata/...`, `dash_authority/craigslist-scraper` MCP) *(not deep-verified)* — managed CL-from-cloud fallback (~$1.50–3/1k) if you'd rather not run residential. Use only if the free sapi/CLI path proves insufficient.
- **Midterm/furnished aggregators** *(not deep-verified)*: **Anyplace** (`/_next/data/<buildId>` JSON, light anti-bot, aggregates Blueground/Sentral/Landing — best single US-furnished scrape), **Blueground** (internal XHR — needs DevTools capture; aggregates partner network), **Kasa** (`window.__NUXT__` state), **Sublet.com** (legacy server-rendered HTML, trivially scrapeable), **Vrbo** (official **Expedia Rapid API** partner-gated, or Apify `makework36/vrbo-scraper`). **June Homes / Landing / Bungalow / Flatio** = weak/no SF inventory — deprioritize.
- **Big SF PM portals** *(not deep-verified)*: **Greystar** (`__NEXT_DATA__` + Sitecore search XHR), **AvalonBay** (`/affordable-housing/community-list/` is a clean scrapeable BMR add; unit availability via internal API/headless), **Essex** (429-walled — headless+proxy), **Equity Residential** (403/Akamai — headless), **Parkmerced** (`/api/embed?pid=` widget feed, ~3,200 units, no anti-bot — high single-site value). Most need a one-time DevTools capture of the availability XHR before scheduling.
- **Yardi RentCafe scrapers** *(not deep-verified)*: Apify `shahidirfan/rentcafe-scraper`, `azzouzana/rentcafe-search-pages-scraper` ($1/1k); WordPress **Rent Fetch** (`BrindleDigital/rentfetch`) natively syncs RentCafe/RealPage/Entrata/AppFolio feeds — backs many SF buildings.
- **RentPress/Rent Fetch discovery technique** *(not deep-verified)* — for any SF PM on WordPress, probe `/wp-json/wp/v2/types` for `rentpress_property`/`*_floorplan` CPTs, then read `/wp-json/wp/v2/{cpt}` + `{cpt}-sitemap.xml`. Confirmed on **Mosser Living** (77 buildings / 481 floorplans) — but Mosser's REST `modified` timestamps are **frozen 18mo–4yr** and `acf` is empty (no rent/availability), so treat RentPress sites as a **building/floorplan directory for seeding a watchlist**, then attach a RentCafe/Yardi availability monitor per building. Highest-leverage reusable "which platform does PM X use?" probe.
- **Redfin `gis-csv`** *(not deep-verified for rentals)* — for-sale bulk CSV; rentals use the Tier-1 `/api/v1/search/rentals` instead.
- **No-code change-monitors** *(not deep-verified)*: **Browse.ai** (list-aware NEW/MODIFIED/DELETED tagging, $49/mo — strongest turnkey "new SF listings → webhook"), **Octoparse** (real-estate templates, cloud schedule paywalled $69/mo), **Distill.io/Visualping** (page-diff, lighter than changedetection.io).
- **Anti-bot proxy/unblocker APIs** *(not deep-verified, vendor benchmarks vary)*: Scrapfly (~99% on Zillow), Scrape.do (~89%), ZenRows, ScrapingBee, Zyte, ScraperAPI/Scrapingdog (weaker ~56–69%) — drop-in front-ends for a DIY Zillow/Apartments scraper if you skip Apify/Bright Data.
- **OSS engines** *(not deep-verified)*: **Crawl4AI** (`unclecode/crawl4ai`, ~50k★, async Playwright, free) and **Scrapy + scrapy-zyte-api** for custom spiders against the documented internal endpoints (Redfin gis-csv, Realtor hulk) — highest control, highest maintenance.
- **Reddit MCP servers** *(not deep-verified)*: `Hawstein/mcp-server-reddit`, `eliasbiondo/reddit-mcp-server` (keyless → datacenter-403 risk), `jordanburke/...`/`adhikasp/mcp-reddit` (OAuth). For a cron diff, the raw OAuth API is simpler.
- **DataSF Socrata (SODA) open data** *(not deep-verified)* — Affordable Housing Pipeline `7dpd-r63z`, Dev Pipeline `6jgi-cpb4`, Rent Board Inventory `gdc7-dmcn`. Context on *where* new BMR supply is coming, **not live availability**. Verify current dataset IDs.
- **Places4Students (UCSF id 38, Stanford id 108)** *(not deep-verified)* — off-campus boards behind institutional SSO; rooms/sublets not on big portals.

---

## 3. Wire These Up First (v1 monitor — 5–8 highest-leverage routes)

Stand these up in order; together they cover most of the SF market with near-zero anti-bot cost, plus the dominant portal via a managed actor.

1. **Craigslist → `craigslist-pp-cli`** on the **home Synology** (residential IP). `watch save` an `sfbay`/`apa` search, cron `watch run --json`, pipe `[NEW]`/`[PRICE-DROP]` into the store. *Highest-volume, lowest-latency NEW signal; free.*
2. **Redfin** → `GET https://www.redfin.com/stingray/api/v1/search/rentals?region_id=17151&region_type=6&num_homes=350` (+`&start=350`). 2 requests/poll, US IP, free. Diff on `propertyId`.
3. **RentCast** → `GET https://api.rentcast.io/v1/listings/rental/long-term?city=San Francisco&state=CA&status=Active&limit=500` with `X-Api-Key`; daily, plus `daysOld=1` deltas. *Legal, stable, diffable spine.* Budget $74/mo.
4. **DAHLIA** → `GET https://housing.sfgov.org/api/v1/listings.json?type=rental`, daily diff on `Id`+`LastModifiedDate`. Free, zero anti-bot, authoritative BMR.
5. **Zumper** → `bundle` (csrf) then `POST /api/t/1/pages/listables` body `{"url":"san-francisco-ca","limit":100}`; diff `listing_id`+`modified_on`+`min_price`+`listing_status`. Free, light anti-bot.
6. **RentSFNow/Veritas** → diff `property-sitemap[1-5].xml`, fetch changed slugs, parse JSON-LD + "No Longer Available" banner. Free. Largest single private SF portfolio.
7. **Zillow** → Apify `maxcopell/zillow-scraper` via `run-sync-get-dataset-items` with an SF for-rent `searchQueryState` URL, daily; diff `zpid`+price+status. ~$2/1k (free $5/mo credit covers a few searches). *The one portal worth paying for.*
8. **changedetection.io** on the Synology as the **schedule + diff + notify** layer (Apprise → pushover) for AppFolio subdomains, SpareRoom, and long-tail PM pages — pin selectors / watch JSON to avoid ad-row noise.

Exact handles to start from:
- `npx -y @mvanhorn/printing-press-library install craigslist`
- `https://www.redfin.com/stingray/api/v1/search/rentals?al=1&region_id=17151&region_type=6&num_homes=350&start=0`
- `https://api.rentcast.io/v1/listings/rental/long-term` (header `X-Api-Key`)
- `https://housing.sfgov.org/api/v1/listings.json?type=rental`
- `POST https://www.zumper.com/api/t/1/pages/listables` (after `GET /api/t/1/bundle`)
- `https://www.rentsfnow.com/property-sitemap.xml` … `property-sitemap5.xml`
- `POST https://api.apify.com/v2/acts/maxcopell~zillow-scraper/run-sync-get-dataset-items?token=`
- `docker run dgtlmoon/changedetection.io` + `dgtlmoon/sockpuppetbrowser`

---

## 4. Architecture Sketch — the monitoring loop

```
                 ┌──────────────── INGEST (per-source adapters) ───────────────┐
 home Synology   │ residential-IP cron:                                        │
 (residential    │   • Craigslist sapi / craigslist-pp-cli   (2–5 min)         │
  egress)        │   • Reddit OAuth/.json  • SpareRoom  • AppFolio subs        │
                 │ direct HTTP cron (any IP, US):                              │
                 │   • Redfin /search/rentals  • RentCast API  • DAHLIA        │
                 │   • Zumper listables  • RentSFNow sitemap+JSON-LD           │
                 │   • HomeHarvest (Realtor)                                   │
                 │ managed / paid (anti-bot offloaded):                        │
                 │   • Apify maxcopell/zillow-scraper  • Apify Apartments.com  │
                 │   • Bright Data MCP (Zillow/Realtor fallback)  • HasData    │
                 │ change-monitor: changedetection.io → Apprise (long-tail PM) │
                 └───────────────────────────┬────────────────────────────────┘
                                             ▼
        NORMALIZE → canonical listing record:
          {source, source_id (zpid/postid/propertyId/listing_id/rentalId),
           address_norm, lat, lng, price, beds, baths, sqft, url,
           first_seen, last_seen, status, raw_blob}
                                             ▼
        DEDUP across overlapping sources (key = normalized address + beds + price band):
          • Zillow ≡ Trulia ≡ HotPads (one Zillow Rental Network) → collapse
          • RentCast / Realtor-RapidAPI / Datafiniti aggregate the same syndicated feed
          • Apify aggregator already dedups within-run; reconcile cross-source here
                                             ▼
        DETECT NEW / CHANGED / REMOVED (snapshot diff per source_id):
          NEW     = unseen source_id (or daysOnZillow=0/1, listedDate=today, postedToday)
          CHANGED = price / status / availability delta (priceChange, modified_on,
                    rentPriceRange, lastSeenDate, dateModified)
          REMOVED = source_id gone / status→Inactive / removedDate / "No Longer Available"
                                             ▼
        STORE: SQLite (or JSON) on the Synology — listings table + per-source snapshot history
                                             ▼
        ENRICH + SCORE:
          • feed address → existing sf-commute-map (ground-zeroed on 539 Bryant) for
            transit travel-time scoring
          • optional rent-comp sanity check via RentCast AVM / Mashvisor
                                             ▼
        NOTIFY: pushover CLI  →  "NEW 1BR $3.2k · 12 min to 539 Bryant · <url>"
```

**Cadence & rate-limit notes:**
- Craigslist: 2–5 min per saved search, ≤3–5 concurrent, **residential IP only** (datacenter = 403). The Synology home box satisfies this.
- Redfin / DAHLIA / RentSFNow / Zumper / AppFolio: **daily–hourly direct GETs**, polite pacing — trivial volume (Redfin SF = 2 req; DAHLIA = 1 req).
- RentCast: daily full sweep + `daysOld=1` deltas to stay inside the $74/mo (1,000 req) Foundation quota; 20 req/s ceiling is moot.
- Reddit: ≤100 QPM/client_id (authed), honor `X-Ratelimit-*`; unauth `.json`/`.rss` only from the residential box or with the private feed token.
- Apify actors: daily; one `searchQueryState` SF tile per run (Zillow 500-cap → tile bbox if you need full enumeration); add a **per-provider/empty-result health check** (silent breakage signal).

**Anti-bot / proxy needs by lane:**
- **No proxy:** Redfin (US IP), RentCast, DAHLIA, Zumper, RentSFNow, AppFolio, SpareRoom, HomeHarvest, PadSplit.
- **Residential egress (home NAS or residential proxy):** Craigslist, Reddit unauth.
- **Managed anti-bot (pay):** Zillow, Apartments.com, HotPads, Furnished Finder, Airbnb — via Apify actors or Bright Data MCP. Keep Bright Data's 5,000-free-req/mo for the hardest Zillow/Realtor fallbacks and conserve it by routing soft sources direct.

---

## 5. Gaps & Open Questions (test live before relying)

- **Reddit housing subreddits:** r/sanfrancisco / r/bayarea / r/AskSF confirmed; **r/bayareahousing, r/sanfranciscohousing, r/bayhousing, r/SFList, r/sfhousing unconfirmed** — verify each via an authenticated `GET /r/{sub}/about` before wiring, and confirm Reddit's Nov-2025 approval policy doesn't block your self-serve app.
- **Craigslist pagination:** `search/batch` needs the `cacheId` from the first `/full` call — exact `batch=` syntax not reproduced; the 360-item `/full` page is enough for a `postedToday` diff, so this is non-blocking.
- **Internal availability XHRs to capture via Chrome DevTools** (one-time, then schedule): Blueground search API host/path + SF slug; Apartment List; Greystar Sitecore search controller; AvalonBay/Essex/Equity unit-availability endpoints (Essex 429, Equity 403 — need headless + realistic fingerprint); Kopa; Parkmerced `/api/embed?pid=` resolution.
- **Listings Project:** confirm whether any RSS/location-filtered URL exists, or whether it's email-only (default assumption: parse the weekly email).
- **RapidAPI free-tier quotas** (zillow-property-data1, realtor16, realtor-search, realty-in-us): pricing pages are JS-rendered/uncrawlable — check live in the playground before committing a polling cadence; expect paid tiers for daily SF sweeps.
- **HelloData.ai:** whether an individual (vs B2B) can actually obtain ongoing API access beyond the 7-day trial; the bulk Market/Shape Search must be account-activated.
- **Vrbo Expedia Rapid API:** partner-approval friction for a personal hunt — may not be grantable; Apify actor is the practical fallback.
- **Trinity Properties** (~1,900 SoMa units) and **Prado Group:** corporate WordPress sites expose no listing CPT — locate the actual leasing surface (likely RentCafe/AppFolio) before scheduling.
- **RentPress family freshness:** Mosser's REST `modified` is frozen and `acf` empty — confirm whether *other* SF RentPress installs carry live ACF data, or whether the whole family is directory-only (attach a per-building RentCafe/Yardi availability monitor regardless).
- **nexgendata Real-Estate MCP:** spend a few cents to confirm a `for_rent` SF query returns rentals (not just for-sale) before any reliance — likely drop in favor of `tri_angle` or direct endpoints.
- **changedetection.io on Synology Container Manager:** sockpuppetbrowser needs `SYS_ADMIN` cap + ~2g shm — validate the container starts under your existing Container Manager (custom `db` logging driver) config.
- **Dedup heuristic** across Zillow/Trulia/HotPads and the aggregators needs a real address-normalization test on live SF data (unit suffixes, "St" vs "Street", building-vs-unit) — the cross-source merge is where false NEW/REMOVED events will originate.
