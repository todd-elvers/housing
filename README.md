# housing

Automated San Francisco apartment hunt. Every 10 minutes, CI scrapes ~10 free rental
sources (Zumper, Redfin, Craigslist, building sightmaps, …), diffs them into a shared
[Turso](https://turso.tech) DB, and computes transit/walk/drive times to a configurable
anchor. A live map at **[housing.toddelvers.com](https://housing.toddelvers.com)** reads
that DB.

```
Cloudflare cron ──dispatch──▶ GitHub Actions: ingest free sources ──┐
laptop loop: craigslist (403s datacenter IPs) ──────────────────────┤
                                                                    ▼
                                                            Turso (libSQL) DB
                                                                    ▼
                                                     map webapp · this CLI · LLM agents
```

## Try it

```sh
mise run bootstrap        # installs the pinned toolchain + deps
./housing --help          # explore the command tree
./housing sources         # which sources are enabled
./housing ingest          # fetch free sources, diff, done
```

Full setup (env, secrets, Turso vs local SQLite): **[SETUP.md](./SETUP.md)**.

## The CLI explains itself

- `--help` recurses: `./housing search rentcast --help` shows that source's args, examples, and required env.
- `./housing introspect --json` emits the whole tree as a machine-readable manifest — what LLM agents read to drive it ([AGENTS.md](./AGENTS.md)).
- `--json` on any command prints pure-JSON results.

## Sources & money

Plain `ingest` runs only **tier-1 (free)** sources. **Tier-2** sources (`zillow`,
`apartments`, `rentcast`) hit metered APIs, so they never run unless you explicitly say
so (`ingest --paid`) — spending money is always a deliberate act. Source research lives
in [data-ingress-catalog.md](./data-ingress-catalog.md).

Adding a source = dropping one `defineSource()` file into `src/commands/search/`.
No registry, no wiring; help, introspection, ingest, and tests pick it up automatically.

## Secrets, since this repo is public

Secrets are managed with [age](https://age-encryption.org) keys: everything ships
committed-but-encrypted in `.env.age`, decrypted in memory at startup by whoever holds a
matching private key — never written to disk, never printed to CI logs. (The only actual
GitHub secret is `AGE_KEY`, CI's copy of such a key.)

**Not us? It still works.** You can't decrypt our `.env.age`, but you don't need to:
`HOUSING_DB` defaults to a local SQLite file and several sources need no config at all,
so clone → `mise run bootstrap` → `./housing ingest` just works. To go further, bring
your own keys: `mise run secrets:keygen` mints your age identity, then
`mise run secrets:set -- KEY` builds your own `.env.age` (or skip age entirely and use a
plain gitignored `.env`). Per-source requirements: `./housing sources` — anything
missing fails fast and tells you which var to set and where to get it.
