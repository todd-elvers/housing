import type { Store } from "./db.ts";
import { pushoverConfigured, sendPushover } from "./pushover.ts";
import { log } from "./log.ts";

// Personal watch: ping Todd's phone whenever 100 Van Ness's 1BD/1BA inventory
// on floor 25+ changes. Runs as a post-sync step of every ingest, reading the
// just-reconciled listings table rather than the raw scrape, so it works no
// matter which process ran the sightmap source (CI, laptop, by hand).
//
// Memory between runs is a snapshot of the matching units persisted in
// watcher_state (same DB the listings live in — CI runners are stateless).
// The snapshot only advances after a pushover is accepted, so a failed send is
// retried on the next run instead of dropping the update. The very first run
// seeds the snapshot silently — the watch reports *changes*, not standing
// inventory.
//
// If the sightmap source failed this run its rows are untouched (runSource
// captures the error before syncSource), so the diff is naturally a no-op —
// a scrape outage can't masquerade as "everything delisted".

const STATE_KEY = "vanness100:1bd1ba-floor25plus";
const PAGE_URL = "https://100vanness.com/floorplans/";
const MIN_FLOOR = 25;

interface WatchedUnit {
  floor: number;
  price: number | null;
  availableOn: string | null;
  specials: string | null;
}
type Snapshot = Record<string, WatchedUnit>; // keyed by unit number

interface ListingRow {
  source_id: string;
  price: number | null;
  beds: number | null;
  baths: number | null;
  raw: string | null;
}

/** "Floor 26" → 26; falls back to the unit number's leading digits (2614 → 26). */
function floorOf(floorLabel: string | null, unitNo: string): number | null {
  const fromLabel = floorLabel?.match(/(\d+)/)?.[1];
  if (fromLabel) return Number(fromLabel);
  const fromUnit = unitNo.match(/^(\d+)\d{2}$/)?.[1];
  return fromUnit ? Number(fromUnit) : null;
}

const money = (n: number | null): string => (n == null ? "$?" : `$${n.toLocaleString("en-US")}`);

function describe(unitNo: string, prev: WatchedUnit, cur: WatchedUnit): string | null {
  const deltas: string[] = [];
  if (cur.price !== prev.price) deltas.push(`${money(prev.price)} → ${money(cur.price)}`);
  if (cur.availableOn !== prev.availableOn)
    deltas.push(`avail ${prev.availableOn ?? "?"} → ${cur.availableOn ?? "?"}`);
  if ((cur.specials ?? "") !== (prev.specials ?? ""))
    deltas.push(cur.specials ? `special: ${cur.specials}` : "special ended");
  return deltas.length ? `~ #${unitNo} (fl ${cur.floor}): ${deltas.join(", ")}` : null;
}

export async function runVanNessWatch(store: Store): Promise<void> {
  if (!pushoverConfigured()) {
    // Loud no-op, same doctrine as commute enrichment: a silently skipped watch
    // looks identical to "no updates" forever.
    log.warn("vanness watch skipped: PUSHOVER_TOKEN / PUSHOVER_USER not set");
    return;
  }

  const rows = await store.activeListings("sightmap", "100vanness:");
  const current: Snapshot = {};
  for (const r of rows as ListingRow[]) {
    if (r.beds !== 1 || r.baths !== 1) continue;
    let raw: {
      unitNumber?: string;
      floor?: string | null;
      availableOn?: string | null;
      specials?: string | null;
    } = {};
    try {
      raw = r.raw ? JSON.parse(r.raw) : {};
    } catch {
      /* tolerate malformed raw — floor falls back to the unit number */
    }
    const unitNo = raw.unitNumber ?? r.source_id.split(":")[1] ?? r.source_id;
    const floor = floorOf(raw.floor ?? null, unitNo);
    if (floor == null || floor < MIN_FLOOR) continue;
    current[unitNo] = {
      floor,
      price: r.price,
      availableOn: raw.availableOn ?? null,
      specials: raw.specials ?? null,
    };
  }

  const prevJson = await store.getWatcherState(STATE_KEY);
  if (prevJson == null) {
    await store.setWatcherState(STATE_KEY, JSON.stringify(current));
    log.info(
      `vanness watch: seeded baseline (${Object.keys(current).length} matching units) — future changes will ping`,
    );
    return;
  }
  const prev: Snapshot = JSON.parse(prevJson);

  const lines: string[] = [];
  for (const [unitNo, cur] of Object.entries(current).sort()) {
    const was = prev[unitNo];
    if (!was) {
      lines.push(
        `+ #${unitNo} (fl ${cur.floor}): ${money(cur.price)}` +
          (cur.availableOn ? `, avail ${cur.availableOn}` : "") +
          (cur.specials ? ` — ${cur.specials}` : ""),
      );
    } else {
      const change = describe(unitNo, was, cur);
      if (change) lines.push(change);
    }
  }
  for (const [unitNo, was] of Object.entries(prev).sort()) {
    if (!current[unitNo])
      lines.push(`- #${unitNo} (fl ${was.floor}) delisted (was ${money(was.price)})`);
  }

  if (!lines.length) return; // no changes → no noise

  await sendPushover({
    title: "100 Van Ness · 1BD 25F+",
    message: lines.join("\n"),
    url: PAGE_URL,
    urlTitle: "Floor plans",
  });
  // Only after the send is accepted — a failure above leaves the old snapshot
  // in place so the same diff fires again next run.
  await store.setWatcherState(STATE_KEY, JSON.stringify(current));
  log.info(`vanness watch: pinged phone (${lines.length} change${lines.length === 1 ? "" : "s"})`);
}
