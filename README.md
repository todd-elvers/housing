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

The only GitHub secret is `AGE_KEY`. Everything else ships committed-but-encrypted in
`.env.age` ([age](https://age-encryption.org)) and is decrypted in memory at startup —
never written to disk, never printed to CI logs.
