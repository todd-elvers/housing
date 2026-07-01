import type { ListingEvent, SourceSyncSummary } from "./types.ts";
import { log } from "./log.ts";

const PUSHOVER_API = "https://api.pushover.net/1/messages.json";
const MAX_MESSAGE = 1024; // Pushover message hard limit

/**
 * Pushover-first notifier. Always prints a digest to stdout; when a run produces
 * events AND PUSHOVER_TOKEN + PUSHOVER_USER are set, sends a Pushover push.
 * Keys are supplied by the user via env (.env) — nothing is hardcoded here.
 */
export async function notify(summaries: SourceSyncSummary[]): Promise<void> {
  const events = summaries.flatMap((s) => s.events);
  const news = events.filter((e) => e.type === "new");
  const changed = events.filter((e) => e.type === "changed");
  const removed = events.filter((e) => e.type === "removed");

  printDigest(summaries, news, changed, removed);

  if (events.length === 0) return; // nothing changed → no push

  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  if (!token || !user) {
    log.print("· pushover: set PUSHOVER_TOKEN + PUSHOVER_USER to get pushed (skipped)");
    return;
  }

  const form = new URLSearchParams({
    token,
    user,
    title: `SF rentals: ${news.length} new · ${changed.length} changed · ${removed.length} removed`,
    message: buildMessage(news, changed, removed),
    html: "1",
  });
  const lead = news[0] ?? changed[0] ?? removed[0];
  if (lead) {
    form.set("url", lead.url);
    form.set("url_title", "Open listing");
  }

  try {
    const res = await fetch(PUSHOVER_API, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (res.ok) {
      log.print(`→ pushover sent (${events.length} events)`);
    } else {
      log.error(`! pushover HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    log.error(`! pushover failed: ${(err as Error).message}`);
  }
}

function buildMessage(
  news: ListingEvent[],
  changed: ListingEvent[],
  removed: ListingEvent[],
): string {
  const lines: string[] = [];
  const add = (label: string, evs: ListingEvent[]) => {
    for (const e of evs.slice(0, 6)) {
      const title = esc((e.title ?? "(untitled)").slice(0, 60));
      lines.push(`<b>${label}</b> ${title} — ${esc(e.detail)}\n<a href="${escAttr(e.url)}">link</a>`);
    }
  };
  add("NEW", news);
  add("CHG", changed);
  add("RM", removed);
  const total = news.length + changed.length + removed.length;
  let msg = lines.slice(0, 10).join("\n\n");
  if (total > 10) msg += `\n\n…and ${total - 10} more`;
  return msg.slice(0, MAX_MESSAGE);
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
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
