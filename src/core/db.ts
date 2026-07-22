import type { Client, InStatement } from "@libsql/client";
import { openDb, rowsToObjects, chunkArray } from "./client.ts";
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
const sourceRankCase = (col: string): string =>
  `CASE ${col} ${SOURCE_RANK.map((s, i) => `WHEN '${s}' THEN ${i + 1}`).join(" ")} ELSE 99 END`;
const RANK_CASE = sourceRankCase("p.source");

// Rank active, eligible (within-commute) listings within each unit (same
// address_norm — street + apartment; unaddressed rows are their own unit), best
// source first. Bound param: max commute minutes.
// Budget ceiling by size — a listing priced above what's worth seeing for its
// bedroom count is dropped from the board (studio ≤ $5k, 1br ≤ $6k, 2br ≤ $8k,
// 3br+ ≤ $12k). Rows with an unknown price or bed count are kept (can't judge).
const PRICE_CAP = `CASE
      WHEN p.beds IS NULL THEN 1e9
      WHEN p.beds < 1 THEN 5000
      WHEN p.beds < 2 THEN 6000
      WHEN p.beds < 3 THEN 8000
      ELSE 12000
    END`;
const RANKED_ELIGIBLE = `
  WITH ranked AS (
    SELECT p.*, ROW_NUMBER() OVER (
      PARTITION BY COALESCE(p.address_norm, p.id)
      ORDER BY ${RANK_CASE}, p.first_seen DESC, p.id
    ) AS rn
    FROM listings p
    WHERE p.status = 'active' AND p.commute_min IS NOT NULL AND p.commute_min <= ?
      AND (p.price IS NULL OR p.price <= ${PRICE_CAP})
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

// How long a listing may go unseen (across its source's runs) before it's swept
// as "no longer available". Snapshot-complete sources ignore this (absence in a
// single run already means gone); partial/feed sources wait this out so a listing
// that merely aged out of a "recent" feed isn't yanked prematurely. Tunable so a
// noisier feed can be given more grace.
const DEFAULT_STALE_DAYS = 2;
function staleMs(): number {
  const d = Number(process.env.HOUSING_STALE_DAYS);
  return (Number.isFinite(d) && d > 0 ? d : DEFAULT_STALE_DAYS) * 86_400_000;
}

// Statements per batch() call. Each batch is one implicit transaction; a
// listing's event INSERT is always kept in the same chunk as its upsert so a
// mid-sync failure can't record an event without its row (re-runs are idempotent
// either way — an unchanged content_hash produces no second event).
const BATCH_CHUNK = 200;

export class Store {
  private constructor(private db: Client) {}

  /**
   * Open the DB (local file path or remote libsql:// URL — see client.ts) and
   * run migrations. All I/O is async now, so construction goes through here.
   */
  static async create(path = process.env.HOUSING_DB || "data/housing.db"): Promise<Store> {
    const { client, isRemote } = openDb(path);
    const store = new Store(client);
    // WAL only applies to a local file; PRAGMAs are unreliable over remote sqld.
    if (!isRemote) await client.execute("PRAGMA journal_mode = WAL");
    await store.migrate();
    return store;
  }

  private async migrate(): Promise<void> {
    // discord_threads was briefly keyed by `neighborhood`; it's a disposable cache,
    // so if the old shape exists, drop it and let the CREATE below rebuild it keyed
    // by the (neighborhood + bed-count) group. (sqlite_master instead of PRAGMA
    // table_info — PRAGMAs don't travel over remote connections.)
    const legacy = await this.db.execute(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'discord_threads'",
    );
    const legacySql = legacy.rows[0]?.["sql"];
    if (typeof legacySql === "string" && legacySql.includes("neighborhood")) {
      await this.db.execute("DROP TABLE discord_threads");
    }
    await this.db.executeMultiple(`
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
        await this.db.execute(`ALTER TABLE listings ADD COLUMN ${col}`);
      } catch {
        /* already present */
      }
    }
    // Keep the dedup key in sync with the current normalizeAddress logic. Computed
    // in JS (libSQL has no custom SQL functions); only rewrites rows whose key
    // actually changed, so it's a no-op after the first run.
    const rs = await this.db.execute(
      "SELECT id, address, address_norm FROM listings WHERE address IS NOT NULL",
    );
    const fixes: InStatement[] = [];
    for (const row of rowsToObjects<{ id: string; address: string; address_norm: string | null }>(
      rs,
    )) {
      const want = normalizeAddress(row.address);
      if (want !== row.address_norm) {
        fixes.push({
          sql: "UPDATE listings SET address_norm = ? WHERE id = ?",
          args: [want, row.id],
        });
      }
    }
    for (const chunk of chunkArray(fixes, BATCH_CHUNK)) await this.db.batch(chunk, "write");
  }

  /**
   * Other active listings for the same unit (same address_norm) as `id` — the
   * cross-source duplicates we deduped away — so the card can link to them.
   */
  async unitSiblings(id: string): Promise<{ source: string; url: string }[]> {
    const rs = await this.db.execute({
      sql: `SELECT o.source, o.url
           FROM listings p
           JOIN listings o ON o.address_norm = p.address_norm AND o.id <> p.id
          WHERE p.id = ? AND p.address_norm IS NOT NULL AND o.status = 'active'
          ORDER BY ${sourceRankCase("o.source")}, o.id`,
      args: [id],
    });
    return rowsToObjects(rs);
  }

  /**
   * Fill fields the winning listing lacks (sqft, beds, baths, property_type) from
   * the best-ranked sibling in the same unit that does have them — "most-populated
   * data for the address". Returns the row unchanged if nothing to borrow.
   */
  async enrichUnit(row: ListingCard): Promise<ListingCard> {
    if (row.sqft != null && row.beds != null && row.baths != null && row.property_type != null) {
      return row;
    }
    const best = (field: string) =>
      `(SELECT o.${field} FROM listings o
         WHERE o.address_norm = p.address_norm AND o.id <> p.id
           AND o.status = 'active' AND o.${field} IS NOT NULL
         ORDER BY ${sourceRankCase("o.source")} LIMIT 1)`;
    const rs = await this.db.execute({
      sql: `SELECT ${best("sqft")} AS sqft, ${best("beds")} AS beds,
                ${best("baths")} AS baths, ${best("property_type")} AS property_type
           FROM listings p WHERE p.id = ? AND p.address_norm IS NOT NULL`,
      args: [row.id],
    });
    const r = rowsToObjects<{
      sqft: number | null;
      beds: number | null;
      baths: number | null;
      property_type: string | null;
    }>(rs)[0];
    if (!r) return row;
    return {
      ...row,
      sqft: row.sqft ?? r.sqft,
      beds: row.beds ?? r.beds,
      baths: row.baths ?? r.baths,
      property_type: row.property_type ?? r.property_type,
    };
  }

  /** Record the Discord message (and its thread) we posted for a listing. */
  async setDiscordMessage(id: string, messageId: string, threadId: string | null): Promise<void> {
    await this.db.execute({
      sql: "UPDATE listings SET discord_message_id = ?, discord_thread_id = ? WHERE id = ?",
      args: [messageId, threadId, id],
    });
  }

  /** Forget the Discord message for one listing (after its card is deleted). */
  async clearDiscordMessage(id: string): Promise<void> {
    await this.db.execute({
      sql: "UPDATE listings SET discord_message_id = NULL, discord_thread_id = NULL WHERE id = ?",
      args: [id],
    });
  }

  /** The Discord thread id for a group, or null if none has been created yet. */
  async getThread(groupKey: string): Promise<string | null> {
    const rs = await this.db.execute({
      sql: "SELECT thread_id FROM discord_threads WHERE group_key = ?",
      args: [groupKey],
    });
    const v = rs.rows[0]?.["thread_id"];
    return typeof v === "string" ? v : null;
  }

  /** Remember the thread we created for a group. */
  async setThread(groupKey: string, threadId: string): Promise<void> {
    await this.db.execute({
      sql: "INSERT INTO discord_threads (group_key, thread_id) VALUES (?,?) ON CONFLICT(group_key) DO UPDATE SET thread_id=?",
      args: [groupKey, threadId, threadId],
    });
  }

  /**
   * Forget all Discord posting state — message ids, per-listing thread ids, and
   * the neighborhood→thread map — so the next sync re-posts the board from
   * scratch. Leaves listings + commute data untouched.
   */
  async clearDiscordState(): Promise<number> {
    const rs = await this.db.execute(
      "UPDATE listings SET discord_message_id = NULL, discord_thread_id = NULL WHERE discord_message_id IS NOT NULL",
    );
    await this.db.execute("DELETE FROM discord_threads");
    return rs.rowsAffected;
  }

  /**
   * The next batch of listings to post: active, within the commute cap, and not
   * yet posted. Newest-first (so fresh listings surface promptly) and limited so
   * the whole eligible set — backlog included — trickles out across runs.
   */
  async pendingPosts(maxCommuteMin: number, limit: number): Promise<ListingCard[]> {
    const rs = await this.db.execute({
      sql: `${RANKED_ELIGIBLE}
         SELECT p.id, p.source, p.url, p.title, p.address, p.neighborhood, p.lat, p.lon,
                p.price, p.beds, p.baths, p.sqft, p.property_type, p.posted_at, p.commute_min,
                p.commute_route, p.raw, p.discord_message_id, p.discord_thread_id
           ${BEST_UNPOSTED}
          ORDER BY p.first_seen DESC
          LIMIT ?`,
      args: [maxCommuteMin, limit],
    });
    return rowsToObjects<ListingCard>(rs);
  }

  /** Count of units still awaiting their (best-source) card, within the commute cap. */
  async countPendingPosts(maxCommuteMin: number): Promise<number> {
    const rs = await this.db.execute({
      sql: `${RANKED_ELIGIBLE} SELECT COUNT(*) AS n ${BEST_UNPOSTED}`,
      args: [maxCommuteMin],
    });
    return Number(rs.rows[0]?.["n"] ?? 0);
  }

  /**
   * Reconcile a fresh fetch for one source against stored state.
   * Returns counts + the new/changed/removed events. On a source's first-ever
   * run everything is "seeded" silently (no events) to avoid a notification flood.
   *
   * Network-friendly shape: ONE read of the source's stored rows, the whole diff
   * in JS, then chunked transactional batch() writes — instead of a per-listing
   * read/write round trip inside a long-held transaction.
   */
  async syncSource(
    source: string,
    listings: RawListing[],
    snapshotComplete: boolean,
  ): Promise<SourceSyncSummary> {
    const runTs = Date.now();
    const existingRs = await this.db.execute({
      sql: `SELECT id, content_hash, price, beds, baths, sqft, property_type, title, status,
                   last_seen, url, neighborhood
              FROM listings WHERE source = ?`,
      args: [source],
    });
    const existing = new Map<string, StoredRow>();
    for (const row of rowsToObjects<StoredRow>(existingRs)) existing.set(row.id, row);
    const seedMode = existing.size === 0;

    const events: ListingEvent[] = [];
    const stmts: InStatement[] = [];
    const seen = new Set<string>();
    let newCount = 0;
    let changedCount = 0;
    let seeded = 0;

    const insertEvent = (listingId: string, type: string, detail: string): InStatement => ({
      sql: "INSERT INTO events (listing_id, source, type, detail, created_at) VALUES (?,?,?,?,?)",
      args: [listingId, source, type, detail, runTs],
    });

    for (const l of listings) {
      const id = `${source}:${l.sourceId}`;
      if (seen.has(id)) continue; // duplicate within one fetch — first occurrence wins
      seen.add(id);
      const hash = contentHash(l);
      const old = existing.get(id);

      if (!old) {
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
          stmts.push(insertEvent(id, "new", ev.detail));
        } else {
          seeded++;
        }
      } else if (old.content_hash !== hash || old.status === "removed") {
        changedCount++;
        const detail =
          old.status === "removed" ? `relisted ${priceLabel(l.price)}` : describeChanges(old, l);
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
        stmts.push(insertEvent(id, "changed", detail));
      }

      stmts.push({
        sql: `
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
    `,
        args: {
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
        },
      });
    }

    // Removal sweep: an active listing not seen recently enough is "gone". A
    // complete-snapshot source removes anything it didn't return THIS run
    // (absence ⇒ delisted). A partial/feed source instead waits until a listing
    // hasn't shown up for HOUSING_STALE_DAYS — absence only means gone once it's
    // been missing across several runs. Skipped while seeding (no baseline yet).
    // Computed from the pre-run snapshot: rows fetched this run are excluded via
    // `seen`, so the stale check matches the old post-upsert semantics.
    let removedCount = 0;
    if (!seedMode) {
      const cutoff = snapshotComplete ? runTs : runTs - staleMs();
      for (const s of existing.values()) {
        if (s.status !== "active" || s.last_seen >= cutoff || seen.has(s.id)) continue;
        stmts.push({ sql: "UPDATE listings SET status = 'removed' WHERE id = ?", args: [s.id] });
        stmts.push(insertEvent(s.id, "removed", "no longer listed"));
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

    for (const chunk of chunkArray(stmts, BATCH_CHUNK)) await this.db.batch(chunk, "write");
    return {
      source,
      fetched: listings.length,
      seeded,
      newCount,
      changedCount,
      removedCount,
      events,
    };
  }

  /**
   * Read post-enrichment card data for a set of listing ids — called at notify
   * time, after commute enrichment has written commute_min/commute_route. Returns
   * rows keyed by id (missing ids are simply absent).
   */
  async getCards(ids: string[]): Promise<Map<string, ListingCard>> {
    const out = new Map<string, ListingCard>();
    for (const group of chunkArray(ids, 400)) {
      const rs = await this.db.execute({
        sql: `SELECT id, source, url, title, address, neighborhood, lat, lon, price,
              beds, baths, sqft, property_type, posted_at, commute_min, commute_route, raw,
              discord_message_id, discord_thread_id
         FROM listings WHERE id IN (${group.map(() => "?").join(",")})`,
        args: group,
      });
      for (const row of rowsToObjects<ListingCard>(rs)) out.set(row.id, row);
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
  /** When the listing was posted at the source (epoch ms), or null. */
  posted_at: number | null;
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

/** The stored columns read back to diff an incoming listing against (plus the
 *  fields the removal sweep needs to build its event without a second read). */
interface StoredRow {
  id: string;
  content_hash: string;
  price: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  property_type: string | null;
  title: string | null;
  status: string;
  last_seen: number;
  url: string;
  neighborhood: string | null;
}

/**
 * Human-readable summary of what actually changed between the stored listing and
 * the fresh fetch — e.g. "price ↓ $3,500 → $3,200 · 2Bd → 1Bd". Falls back to
 * "updated" when the hash flipped on a field we don't surface (e.g. a source's
 * changeTag/lastmod).
 */
function describeChanges(old: StoredRow, l: RawListing): string {
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
