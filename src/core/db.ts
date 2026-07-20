import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { contentHash, normalizeAddress } from "./normalize.ts";
import type { ListingEvent, RawListing, SourceSyncSummary } from "./types.ts";

// Source preference for choosing the ONE listing to post per unit — richer /
// photo-bearing sources first, bare aggregators (redfin, rentcast) last.
const SOURCE_RANK = [
  "zumper",
  "zillow",
  "homeharvest",
  "rentsfnow",
  "dahlia",
  "craigslist",
  "apartments",
  "redfin",
  "rentcast",
  "reddit",
] as const;
const RANK_CASE = `CASE p.source ${SOURCE_RANK.map((s, i) => `WHEN '${s}' THEN ${i + 1}`).join(" ")} ELSE 99 END`;

// Rank active, eligible (within-commute) listings within each unit (same
// address_norm — street + apartment; unaddressed rows are their own unit), best
// source first. Bound param: max commute minutes.
const RANKED_ELIGIBLE = `
  WITH ranked AS (
    SELECT p.*, ROW_NUMBER() OVER (
      PARTITION BY COALESCE(p.address_norm, p.id)
      ORDER BY ${RANK_CASE}, p.first_seen DESC, p.id
    ) AS rn
    FROM listings p
    WHERE p.status = 'active' AND p.commute_min IS NOT NULL AND p.commute_min <= ?
  )`;
// The best listing for each unit that isn't posted yet and whose unit has no card.
const BEST_UNPOSTED = `
   FROM ranked p
  WHERE p.rn = 1
    AND p.discord_message_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM listings q
       WHERE q.address_norm IS NOT NULL AND q.address_norm = p.address_norm
         AND q.discord_message_id IS NOT NULL
    )`;

export class Store {
  private db: DatabaseSync;

  constructor(path = process.env.HOUSING_DB || "data/housing.db") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    // Expose the JS address normalizer to SQL so the dedup key is one source of
    // truth and can self-heal the stored column (below).
    this.db.function("norm_addr", { deterministic: true }, (a) =>
      normalizeAddress(a as string | null),
    );
    this.migrate();
  }

  private migrate(): void {
    // discord_threads was briefly keyed by `neighborhood`; it's a disposable cache,
    // so if the old shape exists, drop it and let the CREATE below rebuild it keyed
    // by the (neighborhood + bed-count) group.
    try {
      const cols = this.db.prepare("PRAGMA table_info(discord_threads)").all() as {
        name: string;
      }[];
      if (cols.some((c) => c.name === "neighborhood")) this.db.exec("DROP TABLE discord_threads");
    } catch {
      /* table absent on a fresh DB */
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS listings (
        id            TEXT PRIMARY KEY,      -- "<source>:<sourceId>"
        source        TEXT NOT NULL,
        source_id     TEXT NOT NULL,
        url           TEXT NOT NULL,
        title         TEXT,
        address       TEXT,
        address_norm  TEXT,
        city          TEXT,
        neighborhood  TEXT,
        lat           REAL,
        lon           REAL,
        price         INTEGER,
        beds          REAL,
        baths         REAL,
        sqft          INTEGER,
        property_type TEXT,
        status        TEXT NOT NULL DEFAULT 'active',  -- active | removed
        posted_at     INTEGER,
        content_hash  TEXT NOT NULL,
        raw           TEXT,
        commute_min   INTEGER,
        commute_route TEXT,
        first_seen    INTEGER NOT NULL,
        last_seen     INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_listings_source ON listings(source);
      CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(source, status);
      CREATE INDEX IF NOT EXISTS idx_listings_addr ON listings(address_norm);

      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        listing_id TEXT NOT NULL,
        source     TEXT NOT NULL,
        type       TEXT NOT NULL,            -- new | changed | removed
        detail     TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

      -- One Discord forum thread per group ("<neighborhood> · <beds>"); cards post here.
      CREATE TABLE IF NOT EXISTS discord_threads (
        group_key TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL
      );
    `);
    // Backfill later-added columns on DBs created before they existed.
    for (const col of [
      "commute_min INTEGER",
      "commute_route TEXT",
      "discord_message_id TEXT", // set once we've posted this listing's card
      "discord_thread_id TEXT", // the neighborhood thread the card lives in
    ]) {
      try {
        this.db.exec(`ALTER TABLE listings ADD COLUMN ${col}`);
      } catch {
        /* already present */
      }
    }
    // Keep the dedup key in sync with the current normalizeAddress logic (only
    // rewrites rows whose key actually changed, so it's a no-op after the first run).
    this.db.exec(
      "UPDATE listings SET address_norm = norm_addr(address) WHERE address IS NOT NULL AND address_norm IS NOT norm_addr(address)",
    );
  }

  /** Record the Discord message (and its thread) we posted for a listing. */
  setDiscordMessage(id: string, messageId: string, threadId: string | null): void {
    this.db
      .prepare("UPDATE listings SET discord_message_id = ?, discord_thread_id = ? WHERE id = ?")
      .run(messageId, threadId, id);
  }

  /** The Discord thread id for a group, or null if none has been created yet. */
  getThread(groupKey: string): string | null {
    const row = this.db
      .prepare("SELECT thread_id FROM discord_threads WHERE group_key = ?")
      .get(groupKey) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
  }

  /** Remember the thread we created for a group. */
  setThread(groupKey: string, threadId: string): void {
    this.db
      .prepare(
        "INSERT INTO discord_threads (group_key, thread_id) VALUES (?,?) ON CONFLICT(group_key) DO UPDATE SET thread_id=?",
      )
      .run(groupKey, threadId, threadId);
  }

  /**
   * Forget all Discord posting state — message ids, per-listing thread ids, and
   * the neighborhood→thread map — so the next sync re-posts the board from
   * scratch. Leaves listings + commute data untouched.
   */
  clearDiscordState(): number {
    const info = this.db
      .prepare(
        "UPDATE listings SET discord_message_id = NULL, discord_thread_id = NULL WHERE discord_message_id IS NOT NULL",
      )
      .run();
    this.db.prepare("DELETE FROM discord_threads").run();
    return Number(info.changes ?? 0);
  }

  /**
   * The next batch of listings to post: active, within the commute cap, and not
   * yet posted. Newest-first (so fresh listings surface promptly) and limited so
   * the whole eligible set — backlog included — trickles out across runs.
   */
  pendingPosts(maxCommuteMin: number, limit: number): ListingCard[] {
    return this.db
      .prepare(
        `${RANKED_ELIGIBLE}
         SELECT p.id, p.source, p.url, p.title, p.address, p.neighborhood, p.lat, p.lon,
                p.price, p.beds, p.baths, p.sqft, p.property_type, p.commute_min,
                p.commute_route, p.raw, p.discord_message_id, p.discord_thread_id
           ${BEST_UNPOSTED}
          ORDER BY p.first_seen DESC
          LIMIT ?`,
      )
      .all(maxCommuteMin, limit) as unknown as ListingCard[];
  }

  /** Count of units still awaiting their (best-source) card, within the commute cap. */
  countPendingPosts(maxCommuteMin: number): number {
    const row = this.db
      .prepare(`${RANKED_ELIGIBLE} SELECT COUNT(*) AS n ${BEST_UNPOSTED}`)
      .get(maxCommuteMin) as { n: number };
    return row.n;
  }

  private countForSource(source: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM listings WHERE source = ?")
      .get(source) as { n: number };
    return row.n;
  }

  /**
   * Reconcile a fresh fetch for one source against stored state.
   * Returns counts + the new/changed/removed events. On a source's first-ever
   * run everything is "seeded" silently (no events) to avoid a notification flood.
   */
  syncSource(source: string, listings: RawListing[], snapshotComplete: boolean): SourceSyncSummary {
    const runTs = Date.now();
    const seedMode = this.countForSource(source) === 0;
    const events: ListingEvent[] = [];
    let newCount = 0;
    let changedCount = 0;
    let seeded = 0;

    const getStmt = this.db.prepare(
      "SELECT content_hash, price, beds, baths, sqft, property_type, title, status FROM listings WHERE id = ?",
    );
    const upsert = this.db.prepare(`
      INSERT INTO listings (id, source, source_id, url, title, address, address_norm,
        city, neighborhood, lat, lon, price, beds, baths, sqft, property_type,
        status, posted_at, content_hash, raw, first_seen, last_seen)
      VALUES (@id,@source,@source_id,@url,@title,@address,@address_norm,@city,
        @neighborhood,@lat,@lon,@price,@beds,@baths,@sqft,@property_type,'active',
        @posted_at,@content_hash,@raw,@first_seen,@last_seen)
      ON CONFLICT(id) DO UPDATE SET
        url=@url, title=@title, address=@address, address_norm=@address_norm,
        city=@city, neighborhood=@neighborhood, lat=@lat, lon=@lon, price=@price,
        beds=@beds, baths=@baths, sqft=@sqft, property_type=@property_type,
        status='active', posted_at=@posted_at, content_hash=@content_hash,
        raw=@raw, last_seen=@last_seen,
        -- drop cached commute data when the coordinates move so it's recomputed
        commute_min=CASE WHEN lat IS NOT @lat OR lon IS NOT @lon THEN NULL ELSE commute_min END,
        commute_route=CASE WHEN lat IS NOT @lat OR lon IS NOT @lon THEN NULL ELSE commute_route END
    `);
    upsert.setAllowBareNamedParameters(true);
    const insertEvent = this.db.prepare(
      "INSERT INTO events (listing_id, source, type, detail, created_at) VALUES (?,?,?,?,?)",
    );

    const tx = this.db.prepare("BEGIN");
    tx.run();
    try {
      for (const l of listings) {
        const id = `${source}:${l.sourceId}`;
        const hash = contentHash(l);
        const existing = getStmt.get(id) as StoredForDiff | undefined;

        if (!existing) {
          if (!seedMode) {
            newCount++;
            const ev: ListingEvent = {
              listingId: id,
              source,
              type: "new",
              detail: priceLabel(l.price),
              url: l.url,
              title: l.title ?? null,
              price: l.price ?? null,
              beds: l.beds ?? null,
              baths: l.baths ?? null,
              neighborhood: l.neighborhood ?? null,
            };
            events.push(ev);
            insertEvent.run(id, source, "new", ev.detail, runTs);
          } else {
            seeded++;
          }
        } else if (existing.content_hash !== hash || existing.status === "removed") {
          changedCount++;
          const detail =
            existing.status === "removed"
              ? `relisted ${priceLabel(l.price)}`
              : describeChanges(existing, l);
          const ev: ListingEvent = {
            listingId: id,
            source,
            type: "changed",
            detail,
            url: l.url,
            title: l.title ?? null,
            price: l.price ?? null,
            beds: l.beds ?? null,
            baths: l.baths ?? null,
            neighborhood: l.neighborhood ?? null,
          };
          events.push(ev);
          insertEvent.run(id, source, "changed", detail, runTs);
        }

        upsert.run({
          id,
          source,
          source_id: l.sourceId,
          url: l.url,
          title: l.title ?? null,
          address: l.address ?? null,
          address_norm: normalizeAddress(l.address),
          city: l.city ?? null,
          neighborhood: l.neighborhood ?? null,
          lat: l.lat ?? null,
          lon: l.lon ?? null,
          price: l.price ?? null,
          beds: l.beds ?? null,
          baths: l.baths ?? null,
          sqft: l.sqft ?? null,
          property_type: l.propertyType ?? null,
          posted_at: l.postedAt ?? null,
          content_hash: hash,
          raw: l.raw === undefined ? null : JSON.stringify(l.raw),
          first_seen: runTs,
          last_seen: runTs,
        });
      }

      // Removal sweep: only when the fetch is a complete snapshot.
      let removedCount = 0;
      if (snapshotComplete && !seedMode) {
        const stale = this.db
          .prepare(
            "SELECT id, url, title, price, beds, baths, neighborhood FROM listings WHERE source = ? AND status = 'active' AND last_seen < ?",
          )
          .all(source, runTs) as {
          id: string;
          url: string;
          title: string | null;
          price: number | null;
          beds: number | null;
          baths: number | null;
          neighborhood: string | null;
        }[];
        const markRemoved = this.db.prepare("UPDATE listings SET status = 'removed' WHERE id = ?");
        for (const s of stale) {
          markRemoved.run(s.id);
          insertEvent.run(s.id, source, "removed", "no longer listed", runTs);
          events.push({
            listingId: s.id,
            source,
            type: "removed",
            detail: "no longer listed",
            url: s.url,
            title: s.title,
            price: s.price,
            beds: s.beds,
            baths: s.baths,
            neighborhood: s.neighborhood,
          });
          removedCount++;
        }
      }

      this.db.prepare("COMMIT").run();
      return {
        source,
        fetched: listings.length,
        seeded,
        newCount,
        changedCount,
        removedCount,
        events,
      };
    } catch (err) {
      this.db.prepare("ROLLBACK").run();
      throw err;
    }
  }

  /**
   * Read post-enrichment card data for a set of listing ids — called at notify
   * time, after commute enrichment has written commute_min/commute_route. Returns
   * rows keyed by id (missing ids are simply absent).
   */
  getCards(ids: string[]): Map<string, ListingCard> {
    const out = new Map<string, ListingCard>();
    if (ids.length === 0) return out;
    const stmt = this.db.prepare(
      `SELECT id, source, url, title, address, neighborhood, lat, lon, price,
              beds, baths, sqft, property_type, commute_min, commute_route, raw,
              discord_message_id, discord_thread_id
         FROM listings WHERE id = ?`,
    );
    for (const id of ids) {
      const row = stmt.get(id) as ListingCard | undefined;
      if (row) out.set(id, row);
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}

/** A listing row shaped for building a notification card. */
export interface ListingCard {
  id: string;
  source: string;
  url: string;
  title: string | null;
  address: string | null;
  neighborhood: string | null;
  lat: number | null;
  lon: number | null;
  price: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  property_type: string | null;
  commute_min: number | null;
  /** JSON-encoded CommuteRoute ({mins, legs, geometry?}) or null. */
  commute_route: string | null;
  /** JSON-encoded source payload; may hold a photo URL under a per-source key. */
  raw: string | null;
  /** Discord message id once this listing's card has been posted, else null. */
  discord_message_id: string | null;
  /** The neighborhood thread the card was posted into, else null. */
  discord_thread_id: string | null;
}

function priceLabel(p?: number | null): string {
  return p ? `$${p.toLocaleString()}/mo` : "price n/a";
}

/** The stored columns we read back to diff an incoming listing against. */
interface StoredForDiff {
  content_hash: string;
  price: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  property_type: string | null;
  title: string | null;
  status: string;
}

/**
 * Human-readable summary of what actually changed between the stored listing and
 * the fresh fetch — e.g. "price ↓ $3,500 → $3,200 · 2Bd → 1Bd". Falls back to
 * "updated" when the hash flipped on a field we don't surface (e.g. a source's
 * changeTag/lastmod).
 */
function describeChanges(old: StoredForDiff, l: RawListing): string {
  const parts: string[] = [];
  if (old.price != null && l.price != null && old.price !== l.price) {
    const arrow = l.price < old.price ? "↓" : "↑";
    parts.push(`price ${arrow} $${old.price.toLocaleString()} → $${l.price.toLocaleString()}`);
  }
  if (numChanged(old.beds, l.beds)) parts.push(`beds ${bedLabel(old.beds)} → ${bedLabel(l.beds)}`);
  if (numChanged(old.baths, l.baths))
    parts.push(`baths ${numLabel(old.baths)} → ${numLabel(l.baths)}`);
  if (numChanged(old.sqft, l.sqft)) parts.push(`sqft ${numLabel(old.sqft)} → ${numLabel(l.sqft)}`);
  if (strChanged(old.property_type, l.propertyType))
    parts.push(`type ${old.property_type ?? "n/a"} → ${l.propertyType ?? "n/a"}`);
  if (strChanged(old.title, l.title)) parts.push("title updated");
  return parts.length ? parts.join(" · ") : "updated";
}

/** True when both sides are known and differ. Absent-on-one-side isn't a change. */
function numChanged(a: number | null, b?: number | null): boolean {
  return a != null && b != null && a !== b;
}
function strChanged(a: string | null, b?: string | null): boolean {
  const x = (a ?? "").trim();
  const y = (b ?? "").trim();
  return x !== "" && y !== "" && x !== y;
}
const numLabel = (n: number | null | undefined): string =>
  n == null ? "n/a" : Number.isInteger(n) ? String(n) : n.toFixed(1);
const bedLabel = (n: number | null | undefined): string => (n === 0 ? "Studio" : numLabel(n));
