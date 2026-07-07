# SETUP — housing CLI

Step-by-step, runnable setup. Written so an LLM agent (or a human) can stand this
up and extend it deterministically. The CLI ingests San Francisco rental listings
from many sources, diffs for new/changed/removed, and notifies.

---

## 1. Prerequisites — install `mise`

All tool versions (node, aube, python, uv) are pinned in `mise.toml` and locked in
`mise.lock`. The only thing you install on the host is [mise](https://mise.jdx.dev):

```sh
brew install mise          # macOS
# or, any platform:
curl https://mise.run | sh
```

If tools don't appear on PATH, either activate mise (`eval "$(mise activate zsh)"`
in your shell rc) or prefix commands with `mise exec --`. `./housing` handles this
for you.

---

## 2. Bootstrap (one command)

```sh
mise run bootstrap
```

Runs, in order:
1. `mise install` — node 22, **aube** (the package manager), python 3.12, uv — at the exact versions in `mise.lock`.
2. `cp .env.example .env` (only if `.env` is absent).
3. `aube install` — JS deps (citty, zod, tsx, …). Only installs versions **≥ 7 days old** (`.npmrc` `minimumReleaseAge`) as a supply-chain cooldown.
4. `uv sync` — Python deps for the HomeHarvest bridge.

Sanity check:

```sh
./housing --help      # command tree
./housing sources     # 5 sources enabled, 3 need keys
```

---

## 3. Run

```sh
./housing ingest                      # fetch all enabled sources, diff, notify
./housing ingest --source craigslist  # just one (or --source a,b)
./housing search redfin --json        # run one source, print its listings as JSON
./housing sources                     # enabled/disabled + why
```

`./housing <args>` == `mise run housing -- <args>`. The DB lands at `data/housing.db`.
The first run per source **seeds** silently (no events); later runs report
new/changed/removed. Every run writes a timestamped `./housing.log` (truncated each
run); `--verbose` adds debug detail to stdout.

---

## 4. Discover what exists (for LLMs)

The CLI is self-describing — you never need to read source to know what's available:

```sh
./housing introspect --json           # the whole tool tree as one manifest
./housing introspect --json --path search   # scope to a subtree
./housing search rentcast --help      # a single command's args, examples, required env
```

`introspect --json` gives each tool's `summary` (what), `when` (when to use it),
`kind` (query/mutation), args (+ JSON Schema), examples, and required env — the
manifest an agent reads to pick the right tool. `AGENTS.md` is a human-readable
render of the same, regenerated with `./housing introspect --format agents`.

---

## 5. Enable the key-gated sources (optional)

Edit `.env` (created by bootstrap; it's gitignored). Each block is independent;
`./housing sources` tells you exactly which var is missing and where to get it.

Tier-1 (free):
- **rentcast** — `RENTCAST_API_KEY` from <https://app.rentcast.io> (free tier 50 req/mo).
- **reddit** — `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET` from a "script" app at <https://www.reddit.com/prefs/apps>.
- **homeharvest** — set `HOUSING_HOMEHARVEST=1` (Python bridge; `uv sync` ran during bootstrap).

Tier-2 (paid/managed anti-bot — **these cost money per call**, so a plain `ingest` skips them; run `ingest --paid` or `ingest --source <name>`):
- **zillow** — `RAPIDAPI_KEY` subscribed to the [zillow-property-data1](https://rapidapi.com/search/zillow-property-data1) RapidAPI API (async bulk scraper: `POST /v1/properties` → poll `/v1/results/{job_id}`). Deep per-property Zillow data (price, beds/baths, rent + sale zestimates, price/tax history, images) by `--search`/`--zipcodes`/`--zpids`/`--addresses`/`--urls`.
- **apartments** — `APIFY_TOKEN` from <https://console.apify.com/account/integrations> (~$2/1k results). Apartments.com multifamily via the `pro100chok/apartments-scraper-usage` actor.

`.env.example` lists every variable with a description and where to obtain it. It's
generated — regenerate after adding a tool with `./housing introspect --format env-example > .env.example`.

### Notifications (Pushover)

Set `PUSHOVER_TOKEN` (app token from <https://pushover.net/apps/build>) and
`PUSHOVER_USER`. When both are set, any `ingest` that produces changes sends a push.
Unset → stdout digest + `housing.log` only.

> ⚠️ **Unpolished — expect noise.** There's no criteria filtering yet, so every
> genuinely-new listing counts as an event. A scheduled `ingest` (especially
> Craigslist's whole-Bay-Area feed) will push often, with large counts. This needs
> refinement — add price/beds/location filtering so only listings you care about
> trigger a push — before relying on it for real alerts.

### Sharing secrets with the team (age-encrypted)

Secrets are committed **encrypted** as `.env.age` and decrypted **in memory at
startup** — the plaintext never touches disk. Anyone whose age public key is in
`.age.public-keys` can clone the repo and run it immediately; no manual `.env` setup.

**Personal vs shared.** `.env.age` is the *shared* team baseline. For a secret you
DON'T want to share (your own `PUSHOVER_TOKEN`, a machine-specific override), put it
in **`.env.local`** — a gitignored plaintext file that overrides `.env.age`. Load
precedence, highest first: **shell env → `.env.local` → `.env` → `.env.age`**. So
`echo 'PUSHOVER_TOKEN=...' >> .env.local` keeps your token local and never committed.

**First time on a machine** — generate your key and get added as a recipient:

```sh
mise run secrets:keygen        # writes ~/.age/key.txt, prints your age1... public key
# send that public key to a maintainer; they add it to .age.public-keys and re-encrypt
```

**Add or change a secret** (in memory — no plaintext on disk; preferred):

```sh
mise run secrets:set -- RENTCAST_API_KEY     # prompts for the value, then stores it in .env.age
mise run secrets:unset -- RENTCAST_API_KEY   # deletes that secret from .env.age
git add .env.age && git commit               # commit .env.age so teammates get the secret on pull
```

Other tasks: `mise run secrets:decrypt` prints the secrets to stdout (pipe it — never
writes a file); `mise run secrets:encrypt` bulk-encrypts an existing plaintext `.env`
(then `rm .env`). `~/.age/key.txt` is your private key — **never commit it**; only the
encrypted `.env.age` and the public `.age.public-keys` are committed (`.env` is gitignored).

Requires the `age` CLI, which mise installs (`mise install`).

---

## 6. Add a tool (the whole point)

**Adding a tool = write one file, drop it in `src/commands/`, done.** No central
registry, no `switch`, no task, no `.env.example` edit. If you're editing a shared
file to make a command appear, you're doing it wrong — the file drop IS the
registration. Folders under `src/commands/` become command groups (arbitrary depth).

1. **Which primitive?** Does it FETCH rental listings for the diff/notify engine?
   - **Yes** → `defineSource` in `src/commands/search/<name>.ts` (`<name>` == filename).
   - **No** (a query/report/utility) → `defineTool` in `src/commands/<group>/<name>.ts`.

2. **Copy the nearest sibling** as a template: `src/commands/search/rentcast.ts` (has
   required env) or `src/commands/search/craigslist.ts` (no env); for a non-source
   verb, `src/commands/introspect.ts`.

3. **Fill it in:**
   - `summary` (one line: WHAT) and `when` (one line: WHEN an agent should pick it — this drives correct tool selection).
   - Sources: `snapshotComplete` (true if a full fetch is the complete set, so absence ⇒ removed). Verbs: `kind: "query" | "mutation"`.
   - **Secrets inline** — the only place a secret is registered:
     ```ts
     requires: { API_KEY: envSpec(z.string().min(1), "what it is", "https://where-to-get-it") }
     ```
     This one line gives you: fail-fast validation before any work, the ingest
     enable/skip gate, the `--help` "Required env" line, the `introspect` entry, and
     the `.env.example` row. Never read `process.env` directly; never hand-write an enable check.
   - **Args are a flat zod object** (`input`): add a field → get a `--flag`, validation,
     coercion, a help line, and an introspect entry. Use `.describe()` for help,
     `z.coerce.number()` / `z.enum([...])` for typed/choice args, `.optional()` /
     `.default()` for optionality. Keep inputs flat (scalars/enums/string arrays); for
     structured input, take a JSON string arg and `z.parse()` it.
   - **Body:** `fetch(env)` returning `RawListing[]` (source) or `run({ input, env, log })`
     returning any value (verb — auto-serialized under `--json`; `throw` for errors).

4. **Verify:**
   ```sh
   mise run typecheck
   ./housing search <name> --help        # generated help
   ./housing introspect --json           # appears in the manifest (also resolves every command = smoke test)
   ./housing sources                     # a source shows up + enabled/skip
   ./housing introspect --format env-example > .env.example   # if you added env
   ./housing introspect --format agents  > AGENTS.md
   ```

Worked example (a real source): [`src/commands/search/rentcast.ts`](./src/commands/search/rentcast.ts).

---

## 7. Testing

```sh
mise run test                     # FREE sources only — never bills a paid API
HOUSING_TEST_LIVE=0 mise run test # skip network (contract + wiring only; ~1s, CI-safe)
mise run test:paid                # DELIBERATE: live-fetch the tier-2 PAID sources (spends money)
```

Spending money is a **deliberate act**, so the two suites are split:

- **`mise run test`** (`test/tools.test.ts`) is **structurally incapable** of billing a
  paid API — tier-2 sources are unconditionally skipped, and there is *no* env flag to
  opt them in from this suite. It only verifies their wiring (contract + enabled/disabled).
- **`mise run test:paid`** (`test/paid.test.ts`) is the only path that live-fetches the
  paid sources (RapidAPI Zillow, Apify Apartments). It self-gates behind `HOUSING_TEST_PAID=1`
  (set for you by the mise task), so an accidental `tsx --test` over `test/` can't spend a cent.
  It keeps each call small (a few items, one page) and asserts real enriched data comes back.

`test/tools.test.ts` is **self-maintaining** — it discovers commands + sources the
same way the CLI does (`loadCommands` / `loadSources` / `introspect`), so a new tool
is picked up and exercised with **no test changes**. It checks, generically:
every tool is well-formed (summary/when/kind, valid args + env) and in the manifest;
`--help`, `introspect --json`, and `sources` run; a disabled source fails fast with a
structured `env_missing` error; a full `ingest` runs against a throwaway DB; and each
enabled **free** source actually fetches and returns valid listings (`sourceId` + http `url`).
Live fetches are on by default (real proof); `HOUSING_TEST_LIVE=0` runs only the
offline tiers.

---

## 8. Scheduling

The engine is one process; schedule `./housing ingest` however you like. Cadence
(see `data-ingress-catalog.md`): Craigslist every 2–5 min **from a residential IP**
(datacenter IPs are 403'd — run it on a home box); Redfin/DAHLIA/RentSFNow/Zumper
hourly–daily; RentCast daily (mind the monthly quota).

```sh
crontab -e
*/15 * * * * cd /path/to/housing && ./housing ingest >> /dev/null 2>&1   # housing.log has the detail
```

---

## 9. Project layout

```
mise.toml / mise.lock   pinned tool versions (node/aube/python/uv) + tasks
.npmrc                  aube 7-day dependency cooldown (minimumReleaseAge)
package.json            JS deps (citty, zod) + dev deps
pyproject.toml          Python deps (homeharvest) for the uv bridge
.env / .env.example     config + keys (.env gitignored; .env.example generated)
AGENTS.md               generated agent-facing tool catalog
housing                 ./housing shim → mise exec -- aube exec tsx src/main.ts
housing.log             latest run's log (gitignored, truncated per run)
src/
  main.ts               entrypoint: load .env → build tree from src/commands/ → run
  discover.ts           src/commands/** → command tree (folders = groups, files = commands)
  tool.ts / source.ts   defineTool() / defineSource() authoring primitives
  args.ts catalog.ts    zod → CLI flags; live tree → introspect manifest
  env/dotenv.ts spec.ts .env loader; per-command typed env validation
  core/                 engine: db, http, normalize, notify, log, run, types
  commands/             >>> add files here <<<  ingest.ts sources.ts introspect.ts + search/*.ts
test/tools.test.ts      self-discovering integration test (FREE sources; never bills a paid API)
test/paid.test.ts       deliberate PAID-API suite (`mise run test:paid`; live Zillow + Apartments)
scripts/homeharvest_fetch.py   Python bridge (uv)
```

---

## 10. Troubleshooting

- **Craigslist returns 0 / 403** → you're on a datacenter IP; run from a residential connection.
- **A source says "disabled — set X"** → add `X` to `.env` (`.env.example` says where to get it).
- **`aube: command not found`** → run `mise install` first, or use `./housing` / `mise exec -- aube …`.
- **`node:sqlite` experimental warning** → silenced via `NODE_OPTIONS` in `mise.toml` (needs node ≥ 22.5, pinned).
- **A new command doesn't appear** → it must `default export` a `defineTool`/`defineSource` and not start with `_`; run `mise run typecheck` (lazy imports surface file errors only when that command runs, so typecheck the whole graph).
- **Read the last run in detail** → `./housing.log` (full detail always, even when stdout was quiet or `--json`).
