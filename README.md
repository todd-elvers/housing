# housing

Automated San Francisco rental hunt — ingest listings from many sources, diff for new/changed/removed, and surface them. Exposed as a discoverable CLI built for both engineers and LLM agents to drive. Work anchor: **539 Bryant St, San Francisco, CA 94107**.

> **Setting this up (human or LLM)?** Read **[SETUP.md](./SETUP.md)** — a step-by-step, runnable guide. TL;DR: install [`mise`](https://mise.jdx.dev), then `mise run bootstrap`, then `./housing --help`.

## Quick start

```sh
mise run bootstrap        # installs node + aube + python + uv (via mise), then all deps
./housing --help          # explore the command tree
./housing sources         # which rental sources are enabled
./housing ingest          # fetch all enabled sources, diff, notify
```

`./housing <args>` is a thin wrapper; `mise run housing -- <args>` is equivalent.

## The CLI is self-describing

Everything is discoverable — you never need to read the source to know what exists:

- **`./housing --help`** → top-level commands. **`./housing search --help`** → every source. **`./housing search rentcast --help`** → that command's args, examples, and required env. Recursive, at any depth.
- **`./housing introspect --json`** → the whole command tree as one machine-readable manifest: each tool's `summary` (what), `when` (when to use it), `kind` (query/mutation), args (+ JSON Schema), examples, and required env. This is the manifest an LLM reads to know what to call and when.
- **`--json`** on any command prints its result as JSON (stdout stays pure JSON; human logs go to the file).

## Commands

| Command | What |
|---|---|
| `housing ingest [--source a,b]` | Fetch enabled sources, diff against the DB, notify on new/changed/removed |
| `housing sources` | List sources and whether each is enabled (required env present) |
| `housing search <name>` | Run a single source and return its listings (`--json` for full output) |
| `housing introspect [--format json\|env-example\|agents]` | Machine-readable manifest; also regenerates `.env.example` / `AGENTS.md` |

Rental sources (under `housing search`):

- **Tier 1 (free/direct)** — `craigslist`, `redfin`, `dahlia`, `zumper`, `rentsfnow`, `rentcast`, `reddit`, `homeharvest`. Run by a plain `ingest`. Five need no config; the rest need a free key.
- **Tier 2 (paid/managed anti-bot)** — `zillow` (RapidAPI), `apartments` (Apify Apartments.com). These cost money per call, so a plain `ingest` **skips** them; run with `ingest --paid` or `ingest --source zillow`.

`housing sources` shows each source's tier + whether it's enabled.

## Adding a tool (the whole point)

Adding a search/tool is **write one file, drop it in `src/commands/`, done** — no central registry, no `switch`, no wiring. A file that default-exports `defineSource()` (a rental source) or `defineTool()` (any other verb) is automatically a registered, nested, help-documented, introspectable, env-validated command. Folders become command groups. Full recipe in [SETUP.md](./SETUP.md).

The integration test is self-maintaining too: `mise run test` discovers and exercises every command + **free** source the same way the CLI does, so a new tool is covered with no test changes (`HOUSING_TEST_LIVE=0` for offline/CI). It **never bills a paid API** — the tier-2 paid sources (`zillow`, `apartments`) live-fetch only under the deliberate `mise run test:paid`, so spending money is always an explicit act.

## Architecture

```
src/
  main.ts        entrypoint: load .env, build the command tree from src/commands/, run
  discover.ts    turns src/commands/** into the command tree (folders = groups, files = commands)
  tool.ts        defineTool()  — any command (env fail-fast → zod args → run → --json)
  source.ts      defineSource() — a rental source (also an ingestable adapter)
  args.ts        zod schema → CLI flags (help + parsing)
  catalog.ts     builds the introspect manifest from the live tree
  env/           .env loader (dotenv.ts) + per-command typed validation (spec.ts)
  core/          engine: db (SQLite diff), http, normalize, notify (Pushover), log
  commands/      >>> the only place you add files <<<
    ingest.ts sources.ts introspect.ts
    search/      one file per rental source
```

- **Engine:** TypeScript run via `tsx` (no build step), `node:sqlite` storage. Each run diffs sources → `new`/`changed`/`removed` events, notifies via Pushover if `PUSHOVER_TOKEN`/`PUSHOVER_USER` are set. ⚠️ Pushover is **unpolished** — with no criteria filtering yet it can be noisy on scheduled runs; needs refinement (see SETUP.md).
- **Discoverability:** [citty](https://github.com/unjs/citty) (recursive help) + [zod](https://zod.dev) v4 (one schema drives args, validation, help, and the `--json` manifest).
- **Env:** secrets load from a gitignored `.env`; each command declares the vars it needs and fails fast (which var + where to get it) before doing any work. Team secrets are committed **encrypted** as `.env.age` (age) and decrypted in memory at startup — never to disk (`mise run secrets:set -- KEY`; see [SETUP.md](./SETUP.md)).
- **Toolchain:** [`mise`](https://mise.jdx.dev) pins node/aube/python/uv (exact versions in `mise.lock`); [`aube`](https://github.com/jdx/aube) is the package manager, with a **7-day dependency cooldown** (`.npmrc` `minimumReleaseAge`) so freshly-published packages can't slip in.
- **Logs:** every run dual-writes to stdout and `./housing.log` (truncated each run, timestamped). `--verbose` for debug detail; the file always has full detail.

See [`data-ingress-catalog.md`](./data-ingress-catalog.md) for the research behind the sources (130 researched, 50 deep-verified) and the Tier 2/3 backlog.
