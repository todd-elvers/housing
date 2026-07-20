import { Effect } from "effect";
import { Store } from "./db.ts";
import { notify } from "./notify.ts";
import { enrichCommutes } from "./commute.ts";
import { log } from "./log.ts";
import type { SourceContract } from "../source.ts";
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
  const store = new Store(resolvedDbPath);

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
    yield* Effect.tryPromise(() => enrichCommutes(resolvedDbPath)).pipe(
      Effect.catchAll((err) =>
        Effect.sync(() => log.error(`commute enrichment failed: ${(err as Error).message}`)),
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
      const listings = await source.fetch();
      const summary = store.syncSource(source.name, listings, source.snapshotComplete);
      log.info(`✓ ${source.name}: ${listings.length} listings in ${Date.now() - started}ms`);
      return summary;
    },
    catch: (err) => err as Error,
  }).pipe(
    Effect.catchAll((err) => {
      const message = err.message;
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
