import type { ListingEvent, SourceSyncSummary } from "./types.ts";
import { httpFetch } from "./http.ts";

/**
 * Notification is intentionally generic. Every run's events are already recorded
 * in the `events` table; this just surfaces a summary:
 *   1. always prints a digest to stdout,
 *   2. if HOUSING_WEBHOOK_URL is set, POSTs the structured digest as JSON.
 * Wire any private/personal delivery (push, email, …) off the webhook or the DB.
 */
export async function notify(summaries: SourceSyncSummary[]): Promise<void> {
  const events = summaries.flatMap((s) => s.events);
  const news = events.filter((e) => e.type === "new");
  const changed = events.filter((e) => e.type === "changed");
  const removed = events.filter((e) => e.type === "removed");

  printDigest(summaries, news, changed, removed);

  const webhook = process.env.HOUSING_WEBHOOK_URL;
  if (webhook && events.length > 0) {
    try {
      await httpFetch(webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          summary: { new: news.length, changed: changed.length, removed: removed.length },
          counts: summaries.map((s) => ({
            source: s.source,
            fetched: s.fetched,
            new: s.newCount,
            changed: s.changedCount,
            removed: s.removedCount,
            seeded: s.seeded,
            error: s.error,
          })),
          events,
        }),
        retries: 1,
      });
      console.log(`\n→ webhook notified (${events.length} events)`);
    } catch (err) {
      console.error(`\n! webhook POST failed: ${(err as Error).message}`);
    }
  }
}

function printDigest(
  summaries: SourceSyncSummary[],
  news: ListingEvent[],
  changed: ListingEvent[],
  removed: ListingEvent[],
): void {
  console.log("\n──────── ingest summary ────────");
  for (const s of summaries) {
    const tag = s.error ? `ERROR ${s.error}` : s.seeded > 0 ? `seeded ${s.seeded}` : "";
    console.log(
      `  ${s.source.padEnd(12)} fetched ${String(s.fetched).padStart(4)}  ` +
        `new ${s.newCount}  changed ${s.changedCount}  removed ${s.removedCount}  ${tag}`,
    );
  }
  console.log(
    `  ─ total: ${news.length} new · ${changed.length} changed · ${removed.length} removed`,
  );

  const show = (label: string, evs: ListingEvent[]) => {
    if (!evs.length) return;
    console.log(`\n  ${label}:`);
    for (const e of evs.slice(0, 15)) {
      const title = (e.title ?? "(untitled)").slice(0, 64);
      console.log(`   • [${e.source}] ${title} — ${e.detail}\n     ${e.url}`);
    }
    if (evs.length > 15) console.log(`   … and ${evs.length - 15} more`);
  };
  show("NEW", news);
  show("CHANGED", changed);
  show("REMOVED", removed);
  console.log("");
}
