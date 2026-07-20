import { Duration, Effect, RateLimiter } from "effect";
import type { ListingEvent, SourceSyncSummary } from "./types.ts";
import { log } from "./log.ts";
import { editCard, markDelisted, postCard, type RenderedCard } from "./discord.ts";
// card.ts pulls in the native canvas binary; import it lazily (only when we
// actually render cards) so a plain ingest without a webhook never loads it.
import type { Anchor, CardInput, TileCache } from "./card.ts";
import { formatLegs, type CommuteRoute } from "./commute.ts";
import { neighborhoodAt } from "./geo.ts";
import type { ListingCard, Store } from "./db.ts";

// Only listings within this commute (minutes to HOUSING_ANCHOR) are eligible for a
// Discord card. Override via HOUSING_NOTIFY_MAX_MIN.
const DEFAULT_NOTIFY_MAX_MIN = 30;
// Trickle controls: at most this many NEW cards post per run (leftovers roll to the
// next run), each write spaced this many ms apart to respect Discord's per-webhook
// rate limit (~30/min). Both overridable via env.
const DEFAULT_MAX_NEW_PER_RUN = 25;
const DEFAULT_PACE_MS = 2000;
const RENDER_CONCURRENCY = 3;

/**
 * Discord notifier. Prints a digest to stdout, then (when DISCORD_WEBHOOK is set)
 * keeps a live per-listing board in the channel: every eligible listing gets its
 * own message, posted on a trickle; a listing that changes has its card edited in
 * place; a listing that's delisted has its message rewritten to a greyed state.
 */
export async function notify(summaries: SourceSyncSummary[], store: Store): Promise<void> {
  const events = summaries.flatMap((s) => s.events);
  const news = events.filter((e) => e.type === "new");
  const changed = events.filter((e) => e.type === "changed");
  const removed = events.filter((e) => e.type === "removed");

  printDigest(summaries, news, changed, removed);

  const webhook = process.env.DISCORD_WEBHOOK;
  if (!webhook) {
    if (news.length + changed.length > 0) {
      log.print("· discord: set DISCORD_WEBHOOK to get notified (skipped)");
    }
    return;
  }
  if (!commuteConfigured()) {
    log.print("· discord: commute not configured (HOUSING_ANCHOR + TravelTime) — nothing posted");
    return;
  }

  try {
    await Effect.runPromise(reconcileDiscord(webhook, store, changed, removed));
  } catch (err) {
    log.error(`! discord failed: ${(err as Error).message}`);
  }
}

/**
 * Post eligible listings not yet on the board (trickled through a RateLimiter),
 * edit ones that changed, and mark delisted ones — all as individual,
 * in-place-editable messages. A failed write is logged and skipped, never
 * aborting the batch.
 */
function reconcileDiscord(
  webhook: string,
  store: Store,
  changed: ListingEvent[],
  removed: ListingEvent[],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const maxMin = intEnv("HOUSING_NOTIFY_MAX_MIN", DEFAULT_NOTIFY_MAX_MIN);
    const perRun = intEnv("HOUSING_NOTIFY_MAX_PER_RUN", DEFAULT_MAX_NEW_PER_RUN);
    const paceMs = intEnv("HOUSING_NOTIFY_PACE_MS", DEFAULT_PACE_MS);

    // Edits + delists only apply to listings we've already posted (have a message id).
    const trackedRows = store.getCards([...changed, ...removed].map((e) => e.listingId));
    const edits = changed
      .map((e) => ({ row: trackedRows.get(e.listingId), detail: e.detail }))
      .filter((x): x is { row: ListingCard; detail: string } => !!x.row?.discord_message_id);
    const delists = removed
      .map((e) => trackedRows.get(e.listingId))
      .filter((row): row is ListingCard => !!row?.discord_message_id);
    // New posts come from the DB queue (not events): the whole eligible set,
    // newest-first, capped so it trickles out over many runs.
    const posts = store.pendingPosts(maxMin, perRun);

    if (edits.length + delists.length + posts.length === 0) return;

    const anchor = parseAnchor(process.env.HOUSING_ANCHOR);
    const tileCache: TileCache = new Map();
    const { renderCard, resolvePhotoUrl } = yield* Effect.promise(() => import("./card.ts"));
    const render = (row: ListingCard, kind: "new" | "changed", detail: string | null) =>
      Effect.promise(() =>
        toCard(row, kind, detail, anchor, tileCache, renderCard, resolvePhotoUrl),
      );

    // Pre-render card images with bounded concurrency.
    const editCards = yield* Effect.forEach(edits, (e) => render(e.row, "changed", e.detail), {
      concurrency: RENDER_CONCURRENCY,
    });
    const postCards = yield* Effect.forEach(posts, (row) => render(row, "new", null), {
      concurrency: RENDER_CONCURRENCY,
    });

    let posted = 0;
    let edited = 0;
    let delisted = 0;
    const writes: Effect.Effect<void>[] = [
      ...edits.map((e, i) =>
        editCard(webhook, e.row.discord_message_id!, editCards[i]).pipe(
          Effect.tap(() => Effect.sync(() => void edited++)),
        ),
      ),
      ...delists.map((row) =>
        markDelisted(webhook, row.discord_message_id!, {
          title: cardTitle(row),
          url: row.url,
          source: row.source,
        }).pipe(Effect.tap(() => Effect.sync(() => void delisted++))),
      ),
      ...posts.map((row, i) =>
        postCard(webhook, postCards[i]).pipe(
          Effect.tap((id) =>
            Effect.sync(() => {
              if (id) {
                store.setDiscordMessage(row.id, id);
                posted++;
              }
            }),
          ),
          Effect.asVoid,
        ),
      ),
    ].map((w) =>
      w.pipe(
        Effect.catchAll((err) =>
          Effect.sync(() => log.error(`! discord write failed: ${err.status} ${err.detail}`)),
        ),
      ),
    );

    // Trickle: at most one write per paceMs, honoring Discord's per-webhook limit.
    const limiter = yield* RateLimiter.make({ limit: 1, interval: Duration.millis(paceMs) });
    yield* Effect.forEach(writes, (w) => limiter(w), { concurrency: 1 });

    const remaining = store.countPendingPosts(maxMin);
    log.print(
      `→ discord: ${posted} posted, ${edited} edited, ${delisted} delisted` +
        (remaining > 0 ? ` (${remaining} still queued, trickling)` : ""),
    );
  }).pipe(Effect.scoped);
}

async function toCard(
  row: ListingCard,
  kind: "new" | "changed",
  changeDetail: string | null,
  anchor: Anchor | null,
  tileCache: TileCache,
  renderCard: typeof import("./card.ts").renderCard,
  resolvePhotoUrl: typeof import("./card.ts").resolvePhotoUrl,
): Promise<RenderedCard> {
  const route = parseRoute(row.commute_route);
  const neighborhood = row.neighborhood ?? neighborhoodAt(row.lat, row.lon);
  const input: CardInput = {
    kind,
    source: row.source,
    url: row.url,
    title: row.title,
    address: row.address,
    neighborhood,
    lat: row.lat,
    lon: row.lon,
    price: row.price,
    beds: row.beds,
    baths: row.baths,
    sqft: row.sqft,
    photoUrl: resolvePhotoUrl(row.raw),
    commuteMin: row.commute_min,
    route,
    changeDetail: kind === "changed" ? changeDetail : null,
  };
  const png = await renderCard(input, anchor, tileCache);
  return {
    kind,
    url: row.url,
    title: cardTitle(row),
    description: describe(row, kind, changeDetail, route),
    png,
  };
}

/** "$3,200/mo · 2Bd/1Ba · Mission" for the embed title. */
function cardTitle(row: ListingCard): string {
  const neighborhood = row.neighborhood ?? neighborhoodAt(row.lat, row.lon);
  return (
    [money(row.price), bedsBaths(row.beds, row.baths) || null, neighborhood]
      .filter(Boolean)
      .join(" · ") ||
    row.title ||
    "listing"
  );
}

/** Embed description: change note (if any) + commute summary + source. */
function describe(
  row: ListingCard,
  kind: "new" | "changed",
  changeDetail: string | null,
  route: CommuteRoute | null,
): string {
  const lines: string[] = [];
  if (kind === "changed" && changeDetail) lines.push(`🔔 ${changeDetail}`);
  const mins = route?.mins ?? row.commute_min ?? null;
  if (mins != null) {
    const legs = route?.legs?.length ? ` · ${formatLegs(route.legs)}` : "";
    lines.push(`🚆 ${mins} min to work${legs}`);
  }
  lines.push(`via ${row.source}`);
  return lines.join("\n");
}

// --- helpers ---

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function parseRoute(json: string | null | undefined): CommuteRoute | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as CommuteRoute;
  } catch {
    return null;
  }
}

/** True when commute enrichment can run — i.e. commute times are meaningful. */
function commuteConfigured(): boolean {
  return !!(
    process.env.HOUSING_ANCHOR &&
    process.env.TRAVELTIME_API_KEY &&
    process.env.TRAVELTIME_APPLICATION_ID
  );
}

function parseAnchor(str: string | undefined): Anchor | null {
  if (!str) return null;
  const [lat, lon] = str.split(",").map(Number);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function money(p: number | null | undefined): string {
  return typeof p === "number" ? `$${p.toLocaleString()}/mo` : "price n/a";
}
function bedsBaths(beds: number | null, baths: number | null): string {
  const b = beds == null ? null : beds === 0 ? "Studio" : `${num(beds)}Bd`;
  const ba = baths == null ? null : `${num(baths)}Ba`;
  return [b, ba].filter(Boolean).join("/");
}
const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

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
