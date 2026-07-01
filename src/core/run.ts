import { Store } from "./db.ts";
import { notify } from "./notify.ts";
import { log } from "./log.ts";
import type { SourceContract } from "../source.ts";
import type { SourceSyncSummary } from "./types.ts";

/**
 * Fetch each source, reconcile against the DB, and notify. Iterates the passed
 * list (from loadSources()); a disabled source is skipped, and one source's
 * failure never kills the batch.
 */
export async function ingestSources(
  sources: SourceContract[],
  dbPath?: string,
): Promise<SourceSyncSummary[]> {
  const store = new Store(dbPath);
  const summaries: SourceSyncSummary[] = [];
  try {
    for (const source of sources) {
      const state = source.enabled();
      if (!state.ok) {
        log.info(`· ${source.name}: skipped (${state.reason})`);
        continue;
      }
      const started = Date.now();
      try {
        const listings = await source.fetch();
        const summary = store.syncSource(source.name, listings, source.snapshotComplete);
        summaries.push(summary);
        log.info(`✓ ${source.name}: ${listings.length} listings in ${Date.now() - started}ms`);
      } catch (err) {
        const message = (err as Error).message;
        log.error(`✗ ${source.name}: ${message}`);
        summaries.push({
          source: source.name,
          fetched: 0,
          seeded: 0,
          newCount: 0,
          changedCount: 0,
          removedCount: 0,
          events: [],
          error: message,
        });
      }
    }
    await notify(summaries);
    return summaries;
  } finally {
    store.close();
  }
}
