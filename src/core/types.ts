/** A listing as produced by an adapter, before it is stored/normalized. */
export interface RawListing {
  /** Stable id within the source (postingId, propertyId, listing_id, sitemap URL, …). */
  sourceId: string;
  url: string;
  title?: string | null;
  address?: string | null;
  city?: string | null;
  neighborhood?: string | null;
  lat?: number | null;
  lon?: number | null;
  /** Monthly rent in USD, when known. */
  price?: number | null;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  propertyType?: string | null;
  /** When the listing was posted, epoch ms. */
  postedAt?: number | null;
  /**
   * Optional extra string folded into the change hash so source-specific
   * mutations (a sitemap lastmod, a `modified_on`, a badge set) flip "changed".
   */
  changeTag?: string | null;
  /** Anything worth keeping for debugging / later enrichment. Stored as JSON. */
  raw?: unknown;
}

export interface EnabledState {
  ok: boolean;
  /** Why it's disabled, shown by `sources`. */
  reason?: string;
}

export interface Adapter {
  name: string;
  /**
   * True when a fetch returns the COMPLETE current set for the source, so a
   * listing's absence implies it was removed. False for "new today" style feeds
   * (e.g. craigslist postedToday) where absence means nothing.
   */
  snapshotComplete: boolean;
  enabled(): EnabledState;
  fetch(): Promise<RawListing[]>;
}

export type EventType = "new" | "changed" | "removed";

export interface ListingEvent {
  listingId: string;
  source: string;
  type: EventType;
  /** Human-readable one-liner, e.g. "price 3200 → 2950". */
  detail: string;
  url: string;
  title: string | null;
  price: number | null;
}

export interface SourceSyncSummary {
  source: string;
  fetched: number;
  seeded: number;
  newCount: number;
  changedCount: number;
  removedCount: number;
  events: ListingEvent[];
  error?: string;
}
