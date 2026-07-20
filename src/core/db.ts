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
    `);
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
      "SELECT content_hash, price, status FROM listings WHERE id = ?",
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
        raw=@raw, last_seen=@last_seen
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
        const existing = getStmt.get(id) as
          | { content_hash: string; price: number | null; status: string }
          | undefined;

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
              : priceChange(existing.price, l.price);
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

  close(): void {
    this.db.close();
  }
}

function priceLabel(p?: number | null): string {
  return p ? `$${p.toLocaleString()}/mo` : "price n/a";
}

function priceChange(oldP: number | null, newP?: number | null): string {
  if (oldP && newP && oldP !== newP) {
    const arrow = newP < oldP ? "↓" : "↑";
    return `price ${arrow} $${oldP.toLocaleString()} → $${newP.toLocaleString()}`;
  }
  return "updated";
}
