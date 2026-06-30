import { Store } from "./db.ts";
import { notify } from "./notify.ts";
import { getAdapters } from "../adapters/index.ts";
import type { SourceSyncSummary } from "./types.ts";

export interface RunOpts {
  sources?: string[];
}

export async function runIngest(opts: RunOpts = {}): Promise<SourceSyncSummary[]> {
  const adapters = getAdapters(opts.sources);
  const store = new Store();
  const summaries: SourceSyncSummary[] = [];

  try {
    for (const adapter of adapters) {
      const state = adapter.enabled();
      if (!state.ok) {
        console.log(`· ${adapter.name}: skipped (${state.reason ?? "disabled"})`);
        continue;
      }
      const started = Date.now();
      try {
        const listings = await adapter.fetch();
        const summary = store.syncSource(adapter.name, listings, adapter.snapshotComplete);
        summaries.push(summary);
        console.log(
          `✓ ${adapter.name}: ${listings.length} listings in ${Date.now() - started}ms`,
        );
      } catch (err) {
        const message = (err as Error).message;
        console.error(`✗ ${adapter.name}: ${message}`);
        summaries.push({
          source: adapter.name,
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
