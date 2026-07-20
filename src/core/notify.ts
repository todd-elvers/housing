import type { ListingEvent, SourceSyncSummary } from "./types.ts";
import { log } from "./log.ts";
import { sendDigest } from "./discord.ts";

/**
 * Discord-first notifier. Always prints a digest to stdout; when a run produces
 * events AND DISCORD_WEBHOOK is set, posts a rich sectioned-embed digest to the
 * shared Discord channel (so all recipients see it — no per-person config). The
 * webhook URL is supplied by the user via env (.env / .env.age) — nothing hardcoded.
 */
export async function notify(summaries: SourceSyncSummary[]): Promise<void> {
  const events = summaries.flatMap((s) => s.events);
  const news = events.filter((e) => e.type === "new");
  const changed = events.filter((e) => e.type === "changed");
  const removed = events.filter((e) => e.type === "removed");

  printDigest(summaries, news, changed, removed);

  if (events.length === 0) return; // nothing changed → no push

  const webhook = process.env.DISCORD_WEBHOOK;
  if (!webhook) {
    log.print("· discord: set DISCORD_WEBHOOK to get notified (skipped)");
    return;
  }

  try {
    await sendDigest(webhook, events);
    log.print(`→ discord sent (${events.length} events)`);
  } catch (err) {
    log.error(`! discord failed: ${(err as Error).message}`);
  }
}

function printDigest(
  summaries: SourceSyncSummary[],
  news: ListingEvent[],
  changed: ListingEvent[],
  removed: ListingEvent[],
): void {
  log.print("\n──────── ingest summary ────────");
  for (const s of summaries) {
    const tag = s.error ? `ERROR ${s.error}` : s.seeded > 0 ? `seeded ${s.seeded}` : "";
    log.print(
      `  ${s.source.padEnd(12)} fetched ${String(s.fetched).padStart(4)}  ` +
        `new ${s.newCount}  changed ${s.changedCount}  removed ${s.removedCount}  ${tag}`,
    );
  }
  log.print(
    `  ─ total: ${news.length} new · ${changed.length} changed · ${removed.length} removed`,
  );

  const show = (label: string, evs: ListingEvent[]) => {
    if (!evs.length) return;
    log.print(`\n  ${label}:`);
    for (const e of evs.slice(0, 15)) {
      const title = (e.title ?? "(untitled)").slice(0, 64);
      log.print(`   • [${e.source}] ${title} — ${e.detail}\n     ${e.url}`);
    }
    if (evs.length > 15) log.print(`   … and ${evs.length - 15} more`);
  };
  show("NEW", news);
  show("CHANGED", changed);
  show("REMOVED", removed);
  log.print("");
}
