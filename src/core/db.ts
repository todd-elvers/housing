import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { contentHash, normalizeAddress } from "./normalize.ts";
import type { ListingEvent, RawListing, SourceSyncSummary } from "./types.ts";

export class Store {
  private db: DatabaseSync;

  constructor(path = process.env.HOUSING_DB || "data/housing.db") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
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

      -- Small key/value store (e.g. the Discord backfill cutoff timestamp).
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    // Backfill later-added columns on DBs created before they existed.
    for (const col of [
      "commute_min INTEGER",
      "commute_route TEXT",
      "discord_message_id TEXT", // set once we've posted this listing's card
    ]) {
      try {
        this.db.exec(`ALTER TABLE listings ADD COLUMN ${col}`);
      } catch {
        /* already present */
      }
    }
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?")
      .run(key, value, value);
  }

  /** Record the Discord message we posted for a listing (for later edit/delist). */
  setDiscordMessage(id: string, messageId: string): void {
    this.db.prepare("UPDATE listings SET discord_message_id = ? WHERE id = ?").run(messageId, id);
  }

  /**
   * The next batch of listings to post: active, within the commute cap, not yet
   * posted, and first seen strictly after `cutoff` (so the pre-existing backlog is
   * never posted). Oldest-first and limited so a burst trickles out over runs.
   */
  pendingPosts(cutoff: number, maxCommuteMin: number, limit: number): ListingCard[] {
    return this.db
      .prepare(
        `SELECT id, source, url, title, address, neighborhood, lat, lon, price,
                beds, baths, sqft, property_type, commute_min, commute_route, raw,
                discord_message_id
           FROM listings
          WHERE status = 'active'
            AND discord_message_id IS NULL
            AND commute_min IS NOT NULL AND commute_min <= ?
            AND first_seen > ?
          ORDER BY first_seen ASC
          LIMIT ?`,
      )
      .all(maxCommuteMin, cutoff, limit) as unknown as ListingCard[];
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
              discord_message_id
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
