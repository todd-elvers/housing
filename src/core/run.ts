import { Effect } from "effect";
import { Store } from "./db.ts";
import { notify } from "./notify.ts";
import { runVanNessWatch } from "./vanness-watch.ts";
import { enrichCommutes } from "./commute.ts";
import { apiLimitHint } from "./http.ts";
import { log } from "./log.ts";
import { isPaid, type SourceContract } from "../source.ts";
import type { SourceSyncSummary } from "./types.ts";

/**
 * Fetch each source, reconcile against the DB, and notify. Iterates the passed
 * list (from loadSources()); a disabled source is skipped, and one source's
 * failure never kills the batch. Orchestrated as an Effect pipeline; the store is
 * always closed via ensuring.
 */
export async function ingestSources(
  sources: SourceContract[],
  dbPath?: string,
  opts: { notify?: boolean } = {},
): Promise<SourceSyncSummary[]> {
  const resolvedDbPath = dbPath ?? process.env.HOUSING_DB ?? "data/housing.db";
  const store = await Store.create(resolvedDbPath);

  const enabled = sources.filter((source) => {
    const state = source.enabled();
    if (!state.ok) {
      log.info(`· ${source.name}: skipped (${state.reason})`);
      return false;
    }
    return true;
  });

  const program = Effect.gen(function* () {
    // Sequential (concurrency: 1) — polite to the upstream APIs, matching the
    // original loop. A source failure is captured as an error summary, not thrown.
    const summaries = yield* Effect.forEach(enabled, (source) => runSource(store, source), {
      concurrency: 1,
    });

    // Per-leg commute enrichment for any listing that still lacks one. No-ops
    // without TravelTime credentials + HOUSING_ANCHOR; a failure is non-fatal.
    //
    // The no-op MUST be loud. enrichCommutes returns `reason` instead of throwing
    // when its config is missing, and silently discarding that let a mis-configured
    // CI ingest run for days looking perfectly green while every new listing landed
    // with no travel times at all.
    yield* Effect.tryPromise(() => enrichCommutes(resolvedDbPath)).pipe(
      Effect.tap((res) =>
        Effect.sync(() => {
          if (res.reason) log.warn(`commute enrichment skipped: ${res.reason}`);
        }),
      ),
      Effect.catchAll((err) =>
        Effect.sync(() => log.error(`commute enrichment failed: ${(err as Error).message}`)),
      ),
    );

    // Tower watch: ping the phone if 100 Van Ness's 1BD/1BA floor-25+ inventory
    // changed since the last notified snapshot (state lives in watcher_state).
    // Non-fatal — a pushover outage must not fail the ingest.
    yield* Effect.tryPromise(() => runVanNessWatch(store)).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => log.error(`vanness watch failed: ${(err as Error).message}`)),
      ),
    );

    // Reconcile the Discord board unless suppressed (e.g. a source-only refresh
    // that shouldn't trigger a board drain). Per-source progress still logs above.
    if (opts.notify !== false) yield* Effect.promise(() => notify(summaries, store));
    return summaries;
  }).pipe(Effect.ensuring(Effect.sync(() => store.close())));

  return Effect.runPromise(program);
}

/** Fetch + reconcile one source into a summary; any failure becomes an error summary. */
function runSource(store: Store, source: SourceContract): Effect.Effect<SourceSyncSummary> {
  const started = Date.now();
  return Effect.tryPromise({
    try: async () => {
      log.info(`· ${source.name}: fetching…`);
      // Heartbeat so a slow source (e.g. apartments' multi-minute Apify scrape)
      // visibly stays alive instead of looking hung.
      const heartbeat = setInterval(() => {
        log.info(
          `  … ${source.name}: still fetching (${Math.round((Date.now() - started) / 1000)}s)`,
        );
      }, 30_000);
      heartbeat.unref?.();
      try {
        const listings = await source.fetch();
        const summary = await store.syncSource(source.name, listings, source.snapshotComplete);
        log.info(`✓ ${source.name}: ${listings.length} listings in ${Date.now() - started}ms`);
        return summary;
      } finally {
        clearInterval(heartbeat);
      }
    },
    catch: (err) => err as Error,
  }).pipe(
    Effect.catchAll((err) => {
      const message = err.message;
      // Surface an out-of-quota / bad-key failure loudly and actionably instead
      // of burying it as a generic "HTTP 429". 401/402 are unambiguously a bad
      // key / no credits (any source). 403/429 are ambiguous: for a keyed source
      // it's plan/quota; for a free scraper it's almost always an IP/rate block.
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 402) {
        log.warn(`⚠ ${source.name}: ${apiLimitHint(status)}`);
      } else if (status === 403 || status === 429) {
        log.warn(
          isPaid(source)
            ? `⚠ ${source.name}: ${apiLimitHint(status)}`
            : `⚠ ${source.name}: blocked (HTTP ${status}) — likely an IP/rate block`,
        );
      }
      log.error(`✗ ${source.name}: ${message}`);
      return Effect.succeed<SourceSyncSummary>({
        source: source.name,
        fetched: 0,
        seeded: 0,
        newCount: 0,
        changedCount: 0,
        removedCount: 0,
        events: [],
        error: message,
      });
    }),
  );
}
