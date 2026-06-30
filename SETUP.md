# SETUP — housing ingest engine

This guide is written so an LLM agent (or a human) can stand the project up
deterministically. Run the steps in order; each lists its expected result.

The repo ingests San Francisco rental listings from the **Tier 1** data sources
in [`data-ingress-catalog.md`](./data-ingress-catalog.md), stores them in SQLite,
and emits `new` / `changed` / `removed` events on every run.

---

## 0. What you get

| Source | Adapter | Needs config? | Notes |
|---|---|---|---|
| Craigslist (`sapi` JSON) | `craigslist` | no | **Run from a residential IP** (home box). Datacenter IPs get 403. |
| Redfin (`/stingray` rentals) | `redfin` | no | Identity + address (price needs future detail-fetch enrichment). US IP. |
| DAHLIA (SF affordable/BMR) | `dahlia` | no | Income-capped lottery units. |
| Zumper (`/listables`) | `zumper` | no | Rich change fields (price/status/modified). |
| RentSFNow / Veritas | `rentsfnow` | no | Sitemap diff over ~4k units. |
| RentCast | `rentcast` | `RENTCAST_API_KEY` | The legal aggregator spine. |
| Reddit (housing subs) | `reddit` | `REDDIT_CLIENT_ID/SECRET` | NEW-lead intel, not structured listings. |
| HomeHarvest (Realtor.com) | `homeharvest` | `HOUSING_HOMEHARVEST=1` + `uv sync` | Python bridge. |

The five no-config sources work immediately after bootstrap. The rest unlock by
adding keys to `.env`.

---

## 1. Prerequisites — install `mise`

All tool versions (node, pnpm, python, uv) are pinned in `mise.toml` and managed
by [mise](https://mise.jdx.dev). You only need `mise` itself on the host.

```sh
# macOS
brew install mise
# or, any platform
curl https://mise.run | sh
```

Verify:

```sh
mise --version        # expect 2025.x or newer
```

> If `mise` commands don't pick up the tools, ensure the shell is activated:
> add `eval "$(mise activate zsh)"` (or bash) to your shell rc, or prefix
> commands with `mise exec --`.

---

## 2. Bootstrap (one command)

From the repo root:

```sh
mise run bootstrap
```

This runs, in order:

1. `mise install` — downloads node 22, pnpm 10, python 3.12, uv.
2. `cp .env.example .env` (only if `.env` doesn't exist yet).
3. `pnpm install` — JS deps (tsx, typescript, oxlint).
4. `uv sync` — Python deps for the HomeHarvest bridge (pandas, homeharvest).

Expected tail: `uv sync` resolving packages with no error. Total ~1–3 min on a
cold cache.

Sanity check:

```sh
mise run sources
```

Expected: the 5 no-config adapters show `●` (enabled); `rentcast` / `reddit` /
`homeharvest` show `○` (disabled, awaiting config).

---

## 3. First run

```sh
mise run ingest
```

- The **first** run for each source **seeds** the DB (no events — avoids a flood).
- Every later run reports `new` / `changed` / `removed` and (if Pushover keys are
  set) sends a push.

Expected: `✓ craigslist: ~360 …`, `✓ redfin: ~500 …`, etc., then an `ingest
summary` block. A SQLite DB appears at `data/housing.db`.

Inspect it:

```sh
mise run db        # opens sqlite3 on data/housing.db
# e.g.
sqlite3 -box data/housing.db "SELECT source, count(*), count(price) FROM listings GROUP BY source;"
sqlite3 -box data/housing.db "SELECT source, type, detail, url FROM events ORDER BY id DESC LIMIT 20;"
```

Run a single source:

```sh
mise run ingest --source craigslist
mise run ingest --source redfin,zumper
```

---

## 4. Enable the key-gated sources (optional)

Edit `.env` (created by bootstrap). Each block below is independent.

### 4a. RentCast — the legal aggregator spine

1. Sign up at <https://app.rentcast.io> (self-serve, no business vetting).
2. Copy the API key from the dashboard.
3. In `.env`:
   ```
   RENTCAST_API_KEY=your_key_here
   RENTCAST_CITY=San Francisco
   ```
4. Verify: `mise run ingest --source rentcast` returns listings.

Cost: free tier = 50 req/mo (one paginated `ingest` = 1 request). Real daily
monitoring wants the **Foundation** plan (~$74/mo = 1,000 req). Use `daysOld`
deltas later to conserve quota.

### 4b. Reddit — housing-sub NEW leads

1. Go to <https://www.reddit.com/prefs/apps> → **create another app…** → type
   **script**. Redirect URI can be `http://localhost`.
2. Copy the client id (under the app name) and the secret.
3. In `.env`:
   ```
   REDDIT_CLIENT_ID=...
   REDDIT_CLIENT_SECRET=...
   REDDIT_USERNAME=your_reddit_username
   REDDIT_SUBS=sanfrancisco,bayarea,AskSF
   ```
4. Verify: `mise run ingest --source reddit`.

Notes: only `sanfrancisco`, `bayarea`, `AskSF` are confirmed to exist — verify any
others before adding. Posts are immutable (new-only feed). Honor Reddit's rate
limits (the adapter is well under them).

### 4c. HomeHarvest — Realtor.com (Python bridge)

Already installed by `uv sync` during bootstrap. Just enable it:

```
HOUSING_HOMEHARVEST=1
HOMEHARVEST_LOCATION=San Francisco, CA
HOMEHARVEST_PAST_DAYS=3
```

Verify: `mise run ingest --source homeharvest` (expect ~20–30 recent rentals).
If you hit intermittent `403`s, that's Realtor.com throttling — rerun later or
add a residential proxy (out of scope here).

---

## 5. Notifications (Pushover)

Every run prints a digest and records events in the `events` table. To get
pushed when listings change, set your [Pushover](https://pushover.net) keys in
`.env`:

```
PUSHOVER_TOKEN=your_app_api_token   # create at https://pushover.net/apps/build
PUSHOVER_USER=your_user_key         # from the Pushover dashboard
```

When both are set, any run that produces new/changed/removed listings sends a
push (title = the counts, body = the top listings with links, tap = open the
first one). Runs with no changes send nothing. Leave the keys unset and you just
get the stdout digest.

---

## 6. Scheduling

Cadence guidance from the catalog:

- **Craigslist**: every 2–5 min, **from a residential IP**, ≤3–5 concurrent.
- **Redfin / DAHLIA / RentSFNow / Zumper**: hourly–daily (trivial volume).
- **RentCast**: daily (mind the monthly quota).

The engine is one process; schedule `mise run ingest` (or per-source) however you
like.

**macOS (launchd / cron)** — simplest is cron:

```sh
crontab -e
# every 15 min, log to a file
*/15 * * * * cd /Users/telvers/Projects/housing && /opt/homebrew/bin/mise run ingest >> data/ingest.log 2>&1
```

**Synology (home box — the recommended host for Craigslist's residential IP):**
- DSM **Task Scheduler** → user-defined script → `cd /volume1/.../housing && mise run ingest`, OR
- Containerize and run under Container Manager on a schedule. (No Dockerfile yet —
  a future step; until then the host-cron / Task Scheduler path works.)

---

## 7. MCP servers (future Tier-2 scraping)

`.mcp.json` registers **Playwright** and **Fetch** MCP servers for scraping the
anti-bot portals (Zillow, Apartments.com) from within Claude Code. They are NOT
used by the headless ingest engine. When you open this repo in Claude Code,
approve the servers; `npx`/`uvx` fetch them on first use. See Tier 2 in the
catalog for when to reach for them.

---

## 8. Project layout

```
mise.toml            tool versions + tasks (bootstrap, ingest, sources, db, …)
package.json         JS deps + scripts (tsx runner)
pyproject.toml       Python deps (homeharvest) for the uv bridge
.env / .env.example  config + keys (gitignored)
src/
  cli.ts             entrypoint (ingest | sources)
  core/
    types.ts         RawListing / Adapter / event types
    env.ts           tiny .env loader (no dep)
    http.ts          fetch w/ UA, timeout, retry, JSON-guard strip
    normalize.ts     content hash + address normalization
    db.ts            node:sqlite store + new/changed/removed diff
    notify.ts        stdout digest + Pushover push (PUSHOVER_* env keys)
    run.ts           orchestrator
  adapters/
    index.ts         adapter registry
    craigslist.ts redfin.ts dahlia.ts zumper.ts rentsfnow.ts
    rentcast.ts reddit.ts homeharvest.ts
scripts/
  homeharvest_fetch.py   Realtor.com bridge (invoked via `uv run`)
data/                    SQLite DB lives here (gitignored)
```

---

## 9. Add a new source adapter

1. Create `src/adapters/<name>.ts` exporting an `Adapter`:
   ```ts
   export const mysource: Adapter = {
     name: "mysource",
     snapshotComplete: false,        // true ⇒ absence means "removed"
     enabled() { return { ok: true }; }, // gate on an env key if needed
     async fetch(): Promise<RawListing[]> { /* return canonical listings */ },
   };
   ```
2. Register it in `src/adapters/index.ts`.
3. `mise run typecheck && mise run ingest --source mysource`.

`snapshotComplete=true` only if a fetch returns the COMPLETE current set (so a
missing listing = removed). For "new today" feeds, keep it `false`.

---

## 10. Troubleshooting

- **Craigslist returns 0 / 403** → you're on a datacenter IP. Run from a
  residential connection (home box). This is expected and documented.
- **Redfin price is always null** → by design; this search variant omits price.
  Enrichment via the per-property `floorPlans` endpoint is a planned follow-up.
- **`node:sqlite` experimental warning** → silenced via `NODE_OPTIONS` in
  `mise.toml`. Needs node ≥ 22.5 (bootstrap pins 22).
- **`mise: command not found` inside a task** → run `mise install` first, or use
  `mise exec -- <cmd>`.
- **HomeHarvest empty / error** → ensure `uv sync` ran and `HOUSING_HOMEHARVEST=1`;
  transient `403`s are Realtor.com throttling.
