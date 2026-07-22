import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { fetchJson } from "../../core/http.ts";
import { facet } from "../../core/facet.ts";
import type { RawListing } from "../../core/types.ts";

// RentCast — the legal aggregator spine. Stable REST API with listedDate/status
// for clean diffs. Overlaps the portals and misses Craigslist-only/private
// landlords, so treat as a normalizing backbone rather than additive inventory.
//
// Endpoint: GET https://api.rentcast.io/v1/listings/rental/long-term
//   Auth:   X-Api-Key: <RENTCAST_API_KEY>
//   Query:  city, state, status, propertyType, bedrooms, bathrooms, daysOld,
//           limit (<=500), offset.  Returns a BARE JSON ARRAY of listing objects.
//
// Live-verified quirks (SF, 2026-07):
//  • Response is a top-level ARRAY, not a {listings:[…]} envelope.
//  • `bedrooms` / `bathrooms` are EXACT-match filters (bedrooms=2 ⇒ only 2-beds),
//    not minimums — so we surface them as exact --beds/--baths.
//  • `limit` is capped server-side at 500 (asking for 600 returns 500), and SF
//    has ~560 active rentals, so a single request silently truncates. We paginate
//    with `offset` up to RENTCAST_LIMIT (each 500 rows = one billed request).
//  • There is NO price filter on this endpoint (min/maxPrice params are ignored,
//    prices came back unfiltered) — so --minPrice/--maxPrice are applied locally.
//  • An unmatched query (e.g. bogus state) returns an empty array with HTTP 200.

const BASE = "https://api.rentcast.io/v1/listings/rental/long-term";
const PAGE_SIZE = 500; // RentCast hard-caps `limit` at 500 per request.
const MAX_PAGES = 20; // safety valve so a moving result set can't loop forever.

/** One rental listing object from the RentCast long-term rentals endpoint. */
interface RcListing {
  id: string;
  formattedAddress?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  county?: string;
  latitude?: number;
  longitude?: number;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  lotSize?: number;
  yearBuilt?: number;
  status?: string;
  price?: number;
  listingType?: string;
  listedDate?: string;
  removedDate?: string | null;
  createdDate?: string;
  lastSeenDate?: string;
  daysOnMarket?: number;
  history?: Record<string, unknown>;
  // Occasionally present per RentCast docs (agent/office/MLS-sourced rows); absent
  // in the SF sample. Kept optional and only used defensively.
  mlsName?: string;
  mlsNumber?: string;
}

const parseDate = (s?: string | null): number | null => (s ? Date.parse(s) || null : null);

export default defineSource({
  name: "rentcast",
  summary:
    "RentCast REST aggregator — a normalized snapshot with listedDate/status for clean diffs, over the long-term rentals endpoint with exact beds/baths, propertyType, and recency filters.",
  when: "Opt-in only (metered API + it mostly duplicates units we already have from photo-bearing sources, and has no photos itself). Run via `ingest --paid` or `ingest --source rentcast`. Each 500 listings costs one RentCast request.",
  // Tier 2 = metered/paid, gated out of a plain `ingest`. RentCast's free tier is
  // just 50 requests/month, and it's a photoless aggregator that near-always loses
  // the per-unit dedup — so it's not worth spending a call on by default.
  tier: 2,
  snapshotComplete: false,
  // All optional: `ingest` runs with none set (env config drives the query); an
  // operator/LLM passes any combination to `search rentcast` for ad-hoc lookups.
  input: z.object({
    city: z.string().optional().describe('City to query, e.g. "San Francisco"'),
    state: z.string().optional().describe("Two-letter state code, e.g. CA"),
    status: z.enum(["Active", "Inactive"]).optional().describe("Listing status (default Active)"),
    propertyType: z
      .string()
      .optional()
      .describe('Exact property type, e.g. "Apartment", "Condo", "Single Family", "Townhouse"'),
    beds: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("EXACT bedroom count (RentCast filters exactly, not as a minimum)"),
    baths: z.coerce
      .number()
      .min(0)
      .optional()
      .describe("EXACT bathroom count (exact match, not a minimum)"),
    daysOld: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Only listings first seen within the last N days"),
    minPrice: z.coerce
      .number()
      .min(0)
      .optional()
      .describe("Min monthly rent (applied locally; API has no price filter)"),
    maxPrice: z.coerce
      .number()
      .min(0)
      .optional()
      .describe("Max monthly rent (applied locally; API has no price filter)"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PAGE_SIZE * MAX_PAGES)
      .optional()
      .describe(`Max listings to fetch across pages (each ${PAGE_SIZE} = one API request)`),
  }),
  requires: {
    RENTCAST_API_KEY: envSpec(
      z.string().min(1),
      "RentCast API key (sent as X-Api-Key)",
      "https://app.rentcast.io",
    ),
    RENTCAST_CITY: envSpec(z.string().default("San Francisco"), "City to query", ""),
    RENTCAST_STATE: envSpec(z.string().default("CA"), "Two-letter state code to query", ""),
    RENTCAST_STATUS: envSpec(
      z.enum(["Active", "Inactive"]).default("Active"),
      "Listing status to query (Active | Inactive)",
      "",
    ),
    RENTCAST_LIMIT: envSpec(
      z.coerce
        .number()
        .int()
        .min(1)
        .max(PAGE_SIZE * MAX_PAGES)
        .default(500),
      `Max listings to fetch across pages (each ${PAGE_SIZE} = one API request)`,
      "",
    ),
  },
  async fetch(env, { input, log }): Promise<RawListing[]> {
    const headers = { "X-Api-Key": env.RENTCAST_API_KEY, accept: "application/json" };

    // Upstream filters: input overrides env; unset optional filters are omitted.
    const params = new URLSearchParams({
      city: input.city ?? env.RENTCAST_CITY,
      state: input.state ?? env.RENTCAST_STATE,
      status: input.status ?? env.RENTCAST_STATUS,
    });
    if (input.propertyType) params.set("propertyType", input.propertyType);
    if (input.beds !== undefined) params.set("bedrooms", String(input.beds));
    if (input.baths !== undefined) params.set("bathrooms", String(input.baths));
    if (input.daysOld !== undefined) params.set("daysOld", String(input.daysOld));

    const cap = input.limit ?? env.RENTCAST_LIMIT;

    // Paginate with offset until we hit the cap, run dry, or trip the page guard.
    // Dedup by stable id across pages (the result set can shift between requests).
    const byId = new Map<string, RcListing>();
    for (
      let page = 0, offset = 0;
      page < MAX_PAGES && byId.size < cap;
      page++, offset += PAGE_SIZE
    ) {
      const want = Math.min(PAGE_SIZE, cap - byId.size);
      params.set("limit", String(want));
      params.set("offset", String(offset));
      const data = await fetchJson<RcListing[] | { listings?: RcListing[] }>(
        `${BASE}?${params.toString()}`,
        { headers, retries: 2, timeoutMs: 20_000 },
      );
      const arr = Array.isArray(data) ? data : (data.listings ?? []);
      if (arr.length === 0) break;
      for (const l of arr) if (l?.id) byId.set(l.id, l);
      if (arr.length < want) break; // last page: server returned fewer than asked.
    }

    // Client-side price window (RentCast has no price param on this endpoint).
    const { minPrice, maxPrice } = input;
    const listings: RawListing[] = [];
    for (const l of byId.values()) {
      if (minPrice !== undefined && (l.price == null || l.price < minPrice)) continue;
      if (maxPrice !== undefined && (l.price == null || l.price > maxPrice)) continue;
      listings.push(toListing(l));
    }
    log.info(`rentcast: ${byId.size} fetched, ${listings.length} after price filter`);
    return listings;
  },
});

function toListing(l: RcListing): RawListing {
  const addr = l.formattedAddress || l.addressLine1 || "";
  // Amenity blob for `find`'s LIKE match — RentCast has no amenity text, so fold
  // in the categorical bits people actually search by (type, zip, county).
  const amenities = [l.propertyType, l.listingType, l.zipCode, l.county]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return {
    sourceId: l.id,
    // RentCast exposes no listing URL; a Zillow rentals address search is the best
    // bet at reaching the actual unit (Zillow indexes most US rentals).
    url: addr
      ? `https://www.zillow.com/homes/for_rent/${addr.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "")}_rb/`
      : "https://www.rentcast.io/",
    title: addr || null,
    address: addr || null,
    city: l.city ?? null,
    // RentCast exposes no neighborhood; county isn't one, so leave it null.
    neighborhood: null,
    lat: l.latitude ?? null,
    lon: l.longitude ?? null,
    price: l.price ?? null,
    beds: l.bedrooms ?? null,
    baths: l.bathrooms ?? null,
    sqft: l.squareFootage ?? null,
    propertyType: l.propertyType ?? null,
    postedAt: parseDate(l.listedDate) ?? parseDate(l.createdDate),
    // Mutation signal: real changes (re-price, off-market, relist) flip this;
    // per-crawl churn (lastSeenDate, daysOnMarket) is deliberately excluded.
    changeTag: `${l.price ?? ""}|${l.status ?? ""}|${l.listedDate ?? ""}|${l.removedDate ?? ""}`,
    raw: {
      ...facet({
        minBeds: l.bedrooms ?? null,
        maxBeds: l.bedrooms ?? null,
        minBaths: l.bathrooms ?? null,
        maxBaths: l.bathrooms ?? null,
        minPrice: l.price ?? null,
        maxPrice: l.price ?? null,
        amenities,
        buildingName: null,
      }),
      // Extra RentCast fields kept for debugging / later enrichment.
      addressLine2: l.addressLine2 ?? null,
      state: l.state ?? null,
      zipCode: l.zipCode ?? null,
      county: l.county ?? null,
      status: l.status ?? null,
      listingType: l.listingType ?? null,
      lotSize: l.lotSize ?? null,
      yearBuilt: l.yearBuilt ?? null,
      daysOnMarket: l.daysOnMarket ?? null,
      createdDate: l.createdDate ?? null,
      lastSeenDate: l.lastSeenDate ?? null,
      removedDate: l.removedDate ?? null,
      priceHistory: l.history ? Object.keys(l.history).length : 0,
    },
  };
}
