import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { httpFetch, stripJsonGuard } from "../../core/http.ts";
import { facet } from "../../core/facet.ts";
import type { RawListing } from "../../core/types.ts";

// Zumper internal listables API (SF-HQ, light anti-bot: Fastly, no DataDome).
// Two steps: GET /bundle for a CSRF token + cookies, then POST /listables.
// Best change-detection field set of any portal: created_on / modified_on /
// listed_on / previous_price / listing_status.
//
// Verified against the live API (2026-07):
//  • The listables page is server-capped at ~100 rows regardless of the `limit`
//    we send, BUT the `offset` filter DOES page cleanly — offset+=returned walks
//    the full city set (a plain SF query yields ~465 unique buildings/units, not
//    the ~100 the old code assumed). We page until a short/empty page or the
//    caller's cap.
//  • `property_type` is a NUMERIC enum (0/1/2/4/13 in SF), not a string. The old
//    code shoved the integer into the string `propertyType` field. We map the
//    codes we've confirmed to labels and keep the raw code in `raw`.
//  • Each row is a building card (min/max beds/baths/price ranges) OR a single
//    unit; `price`/`beds`/`baths` take the row's min, ranges live in the facet.
const BASE = "https://www.zumper.com";
const REFERER = `${BASE}/apartments-for-rent/san-francisco-ca`;
// Server hard-caps a listables page near 100 rows; we advance `offset` by the
// actual returned count, so the exact value only bounds a single request.
const PAGE_SIZE = 100;
// Safety rail so a misbehaving/looping API can never spin forever.
const MAX_PAGES = 30;
// Be gentle on a free endpoint with light anti-bot: small pause between pages.
const PAGE_PAUSE_MS = 350;

// Confirmed SF property_type codes → human label. Unknown codes fall back to
// null (never the raw integer); the numeric code is preserved in `raw`.
const PROPERTY_TYPES: Record<number, string> = {
  0: "apartment",
  1: "condo",
  2: "apartment",
  4: "apartment",
  13: "house",
};

interface Listable {
  listing_id: number;
  group_id?: number;
  building_id?: number;
  pb_id?: number;
  pl_id?: number;
  url?: string;
  title?: string | null;
  building_name?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zipcode?: string | null;
  neighborhood_name?: string | null;
  lat?: number | null;
  lng?: number | null;
  min_price?: number | null;
  max_price?: number | null;
  base_min_price?: number | null;
  base_max_price?: number | null;
  previous_price?: number | null;
  min_bedrooms?: number | null;
  max_bedrooms?: number | null;
  min_bathrooms?: number | null;
  max_bathrooms?: number | null;
  property_type?: number | null;
  listing_type?: number | null;
  lease_type?: number | null;
  listing_status?: number | null;
  is_pad?: boolean;
  has_fees?: boolean;
  date_available?: string | null;
  listed_on?: number | null;
  created_on?: number | null;
  modified_on?: number | null;
  phone?: string | null;
  rating?: number | null;
  feed_name?: string | null;
  provider_url?: string | null;
  short_description?: string | null;
  image_ids?: unknown;
  amenities?: unknown;
  amenity_tags?: unknown;
  building_amenities?: unknown;
  building_amenity_tags?: unknown;
}

interface ListablesResponse {
  listables?: Listable[];
}

interface Session {
  csrf: string;
  cookie: string;
}

/** Flatten Zumper's various amenity + description fields into one lowercased blob. */
function amenityText(l: Listable): string {
  return [
    l.amenities,
    l.amenity_tags,
    l.building_amenities,
    l.building_amenity_tags,
    l.short_description,
  ]
    .map((x) => (x == null ? "" : typeof x === "string" ? x : JSON.stringify(x)))
    .join(" ")
    .toLowerCase();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Parse a comma-separated list of bedroom counts into a clamped int array (0-5). */
function parseBeds(s: string | undefined): number[] {
  if (!s) return [];
  return [
    ...new Set(
      s
        .split(",")
        .map((t) => Number(t.trim()))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 5),
    ),
  ];
}

/** GET /bundle for a CSRF token + the Set-Cookie session the POST must echo back. */
async function openSession(): Promise<Session> {
  const res = await httpFetch(`${BASE}/api/t/1/bundle`, {
    headers: { referer: REFERER, accept: "application/json" },
  });
  if (!res.ok) throw new Error(`zumper: bundle → HTTP ${res.status}`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const bundle = JSON.parse(stripJsonGuard(await res.text())) as { csrf?: string };
  if (!bundle.csrf) throw new Error("zumper: bundle returned no csrf token (blocked?)");
  return { csrf: bundle.csrf, cookie };
}

export default defineSource({
  name: "zumper",
  summary:
    "Zumper internal listables API — the richest change-detection field set (created/modified/listed_on, previous_price, listing_status), paged over the full city set.",
  when: "Use for precise diff tracking of SF portal listings; pages the whole city (not just the first ~100). Not guaranteed exhaustive, so don't infer removal.",
  // Even paged, the listables view can miss units and honors filters, so a fetch
  // is not a guaranteed-complete snapshot — absence must not imply removal.
  snapshotComplete: false,
  // All optional: `ingest` runs with none set (env drives the query); an
  // operator/LLM can pass any subset to `search zumper` for ad-hoc lookups.
  input: z.object({
    city: z
      .string()
      .optional()
      .describe(
        'Zumper city slug, e.g. "san-francisco-ca" or "oakland-ca" (overrides ZUMPER_CITY)',
      ),
    minPrice: z.coerce.number().int().min(0).optional().describe("Minimum monthly rent (USD)"),
    maxPrice: z.coerce.number().int().min(0).optional().describe("Maximum monthly rent (USD)"),
    beds: z
      .string()
      .optional()
      .describe("Comma-separated bedroom counts to include, 0-5 (0 = studio), e.g. 1,2"),
    minBaths: z.coerce.number().min(0).optional().describe("Minimum bathrooms"),
    maxItems: z.coerce
      .number()
      .int()
      .min(1)
      .max(3000)
      .optional()
      .describe("Max listings to return across all pages (1-3000)"),
  }),
  requires: {
    ZUMPER_CITY: envSpec(z.string().default("san-francisco-ca"), "Default Zumper city slug", ""),
    ZUMPER_MAX_ITEMS: envSpec(
      z.coerce.number().int().min(1).max(3000).default(500),
      "Default max listings per run (paged, ~100/page)",
      "",
    ),
  },
  async fetch(env, { input, log }): Promise<RawListing[]> {
    const city = input.city?.trim() || env.ZUMPER_CITY;
    const maxItems = input.maxItems ?? env.ZUMPER_MAX_ITEMS;
    const beds = parseBeds(input.beds);

    // Base filters applied to every page; offset is the only thing that changes.
    const filters: Record<string, unknown> = { external: true, longTerm: true, url: city };
    if (input.minPrice != null) filters.min_price = input.minPrice;
    if (input.maxPrice != null) filters.max_price = input.maxPrice;
    if (beds.length) filters.bedrooms = beds;
    if (input.minBaths != null) filters.min_bathrooms = input.minBaths;

    const session = await openSession();
    const out: RawListing[] = [];
    const seen = new Set<string>();

    for (let page = 0, offset = 0; page < MAX_PAGES; page++) {
      const res = await httpFetch(`${BASE}/api/t/1/pages/listables`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-csrftoken": session.csrf,
          cookie: session.cookie,
          referer: REFERER,
          accept: "application/json",
        },
        body: JSON.stringify({ ...filters, limit: PAGE_SIZE, offset }),
      });
      if (!res.ok) {
        // Fail hard on the first page (nothing to salvage); on a deeper page,
        // return what we already have rather than sink the whole ingest.
        if (page === 0) throw new Error(`zumper: listables → HTTP ${res.status}`);
        log.info(`zumper: page ${page} → HTTP ${res.status}, stopping with ${out.length} listings`);
        break;
      }
      const data = JSON.parse(stripJsonGuard(await res.text())) as ListablesResponse;
      const rows = data.listables ?? [];
      if (rows.length === 0) break;

      let fresh = 0;
      for (const row of rows) {
        const listing = map(row, city);
        if (!listing || seen.has(listing.sourceId)) continue;
        seen.add(listing.sourceId);
        out.push(listing);
        fresh++;
        if (out.length >= maxItems) break;
      }

      // Stop on the caller's cap, a short (final) page, or a page that added
      // nothing new (guards against an API that ignores offset).
      if (out.length >= maxItems || rows.length < PAGE_SIZE || fresh === 0) break;
      offset += rows.length;
      await sleep(PAGE_PAUSE_MS);
    }

    log.info(`zumper: ${out.length} listings for "${city}"`);
    return out;
  },
});

function map(l: Listable, city: string): RawListing | null {
  if (l.listing_id == null) return null;
  const path = l.url ?? "";
  const url = path ? (path.startsWith("http") ? path : `${BASE}${path}`) : REFERER;
  const price = l.min_price ?? l.base_min_price ?? null;
  const propertyType = l.property_type != null ? (PROPERTY_TYPES[l.property_type] ?? null) : null;
  return {
    sourceId: String(l.listing_id),
    url,
    title: l.title || l.building_name || l.address || l.neighborhood_name || null,
    address: l.address ?? null,
    city: l.city ?? null,
    neighborhood: l.neighborhood_name ?? null,
    lat: l.lat ?? null,
    lon: l.lng ?? null,
    price,
    beds: l.min_bedrooms ?? null,
    baths: l.min_bathrooms ?? null,
    // No per-listing square footage in the listables payload.
    sqft: null,
    propertyType,
    postedAt: l.listed_on ? l.listed_on * 1000 : l.created_on ? l.created_on * 1000 : null,
    // modified_on flips on any server-side mutation; price fields + status make
    // the reason human-legible in the folded hash.
    changeTag: `${price ?? ""}|${l.previous_price ?? ""}|${l.listing_status ?? ""}|${l.modified_on ?? ""}`,
    raw: {
      ...facet({
        buildingName: l.building_name ?? null,
        minBeds: l.min_bedrooms ?? null,
        maxBeds: l.max_bedrooms ?? null,
        minBaths: l.min_bathrooms ?? null,
        maxBaths: l.max_bathrooms ?? null,
        minPrice: l.min_price ?? l.base_min_price ?? null,
        maxPrice: l.max_price ?? l.base_max_price ?? null,
        amenities: amenityText(l),
      }),
      // Extra Zumper richness preserved for debugging / later enrichment.
      citySlug: city,
      state: l.state ?? null,
      zipcode: l.zipcode ?? null,
      propertyTypeCode: l.property_type ?? null,
      listingType: l.listing_type ?? null,
      leaseType: l.lease_type ?? null,
      listingStatus: l.listing_status ?? null,
      isPad: l.is_pad ?? null,
      hasFees: l.has_fees ?? null,
      previousPrice: l.previous_price ?? null,
      dateAvailable: l.date_available ?? null,
      createdOn: l.created_on ? l.created_on * 1000 : null,
      modifiedOn: l.modified_on ? l.modified_on * 1000 : null,
      phone: l.phone ?? null,
      rating: l.rating ?? null,
      feedName: l.feed_name ?? null,
      providerUrl: l.provider_url ?? null,
      buildingId: l.building_id ?? null,
      groupId: l.group_id ?? null,
      imageIds: Array.isArray(l.image_ids) ? l.image_ids : null,
    },
  };
}
