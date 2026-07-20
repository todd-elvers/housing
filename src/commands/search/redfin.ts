import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { fetchJson } from "../../core/http.ts";
import { facet } from "../../core/facet.ts";
import type { RawListing } from "../../core/types.ts";

// Redfin "Stingray" rentals search (unofficial web API, no auth, US-IP only).
// region_id 17151 = San Francisco (city), region_type 6. The endpoint prepends
// no anti-JSON guard on this path today, but fetchJson()/stripJsonGuard handle a
// `{}&&` / `)]}'` prefix if Redfin turns one on.
//
// CONTRARY TO THE OLD COMMENT IN THIS FILE, the search response DOES carry rent,
// beds, baths, and sqft inline — under `rentalExtension` (rentPriceRange /
// bedRange / bathRange / sqftRange, each {min,max}), plus propertyName,
// numAvailableUnits, status, description and lastUpdated. No per-property detail
// call is needed for those. Verified live against region 17151 (2026-07).
//
// Each `homes[]` entry is a *property* (a building for apartments); a building
// may span several units, so beds/baths/sqft/price are RANGES. We surface the
// low end as the headline scalar ("starting from") and record both ends in the
// queryable facet. `nearbyHomes[]` (outside the region) is intentionally ignored
// so a full snapshot stays region-scoped.
const PAGE = 350; // Redfin caps num_homes around here; asking for more still yields ≤350.
const HARD_CAP = 2000; // absolute safety ceiling on pages regardless of env/flags.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Best-effort label for Redfin's numeric homeData.propertyType (raw code kept in `raw`). */
const PROPERTY_TYPES: Record<number, string> = {
  1: "Single Family",
  2: "Condo",
  3: "Townhouse",
  4: "Multi-Family",
  5: "Apartment",
  6: "Other",
  7: "Manufactured",
  8: "Co-op",
  13: "Multi-Family",
};

interface Range {
  min?: number | null;
  max?: number | null;
}
interface RedfinResponse {
  homes?: { homeData?: RedfinHome; rentalExtension?: RentalExtension }[];
  numMatchedHomes?: number;
  numMatchedUnits?: number;
}
interface RedfinHome {
  propertyId?: string;
  url?: string;
  propertyType?: number;
  addressInfo?: {
    formattedStreetLine?: string;
    city?: string;
    state?: string;
    zip?: string;
    centroid?: { centroid?: { latitude?: number; longitude?: number } };
  };
  sashes?: { sashTypeName?: string; timeOnRedfin?: string }[];
  photosInfo?: { photoRanges?: { startPos?: number; endPos?: number }[] };
}
interface RentalExtension {
  rentalId?: string;
  propertyName?: string;
  bedRange?: Range;
  bathRange?: Range;
  sqftRange?: Range;
  rentPriceRange?: Range;
  numAvailableUnits?: number;
  status?: number;
  lastUpdated?: string;
  dateAvailable?: string;
  freshnessTimestamp?: string;
  description?: string;
  feedSource?: string;
  feedOriginalSource?: string;
  mlsName?: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export default defineSource({
  name: "redfin",
  summary:
    "Redfin Stingray rentals search for SF — a full paginated snapshot of listed buildings/units with inline rent, beds/baths, sqft and status badges.",
  when: "Use for a complete NEW/REMOVED/price snapshot of Redfin-listed SF rentals. Filterable by price/beds/baths/type; multi-unit buildings report ranges (low end is the headline).",
  snapshotComplete: true, // a full region search ⇒ absence implies delisted
  // All optional: `ingest` runs with none set (env config drives the query); an
  // operator/LLM passes any subset to `search redfin` for an ad-hoc filtered pull.
  input: z.object({
    region: z.string().optional().describe("Redfin region_id override (SF city = 17151)"),
    regionType: z.coerce
      .number()
      .int()
      .optional()
      .describe("Redfin region_type override (6 = city; default 6)"),
    minPrice: z.coerce.number().int().min(0).optional().describe("Minimum monthly rent (USD)"),
    maxPrice: z.coerce.number().int().min(0).optional().describe("Maximum monthly rent (USD)"),
    minBeds: z.coerce.number().int().min(0).optional().describe("Minimum bedrooms (0 = studio)"),
    maxBeds: z.coerce.number().int().min(0).optional().describe("Maximum bedrooms"),
    minBaths: z.coerce.number().int().min(0).optional().describe("Minimum bathrooms"),
    propertyTypes: z
      .string()
      .optional()
      .describe(
        "Redfin uipt type filter, comma-separated (1=House,2=Condo,3=Townhouse,4=Multi-family)",
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(HARD_CAP)
      .optional()
      .describe(`Max listings to return (1-${HARD_CAP})`),
  }),
  requires: {
    REDFIN_REGION_ID: envSpec(
      z.string().default("17151"),
      "Redfin region id (SF city = 17151)",
      "",
    ),
    REDFIN_REGION_TYPE: envSpec(
      z.coerce.number().int().default(6),
      "Redfin region_type (6 = city)",
      "",
    ),
    REDFIN_MAX_LISTINGS: envSpec(
      z.coerce.number().int().min(1).max(HARD_CAP).default(500),
      "Default max listings per run (ingest)",
      "",
    ),
  },
  async fetch(env, { input, log }): Promise<RawListing[]> {
    const regionId = input.region ?? env.REDFIN_REGION_ID;
    const regionType = input.regionType ?? env.REDFIN_REGION_TYPE;
    const maxListings = input.limit ?? env.REDFIN_MAX_LISTINGS;

    // Filter params confirmed live: num_beds/num_baths are MINIMUMS, max_num_beds
    // is the upper bound, min_price/max_price bound rent, uipt is the type filter.
    const filters = new URLSearchParams();
    if (input.minPrice != null) filters.set("min_price", String(input.minPrice));
    if (input.maxPrice != null) filters.set("max_price", String(input.maxPrice));
    if (input.minBeds != null) filters.set("num_beds", String(input.minBeds));
    if (input.maxBeds != null) filters.set("max_num_beds", String(input.maxBeds));
    if (input.minBaths != null) filters.set("num_baths", String(input.minBaths));
    if (input.propertyTypes) {
      const uipt = input.propertyTypes
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .join(",");
      if (uipt) filters.set("uipt", uipt);
    }
    const filterStr = filters.toString();

    const out: RawListing[] = [];
    const seen = new Set<string>();
    let total = Infinity; // learned from numMatchedHomes after the first page

    for (let start = 0; start < HARD_CAP && out.length < maxListings; start += PAGE) {
      const params = new URLSearchParams({
        al: "1",
        region_id: String(regionId),
        region_type: String(regionType),
        num_homes: String(PAGE),
        start: String(start),
      });
      const url =
        `https://www.redfin.com/stingray/api/v1/search/rentals?${params}` +
        (filterStr ? `&${filterStr}` : "");

      let data: RedfinResponse;
      try {
        data = await fetchJson<RedfinResponse>(url, {
          headers: { referer: "https://www.redfin.com/", accept: "application/json" },
          timeoutMs: 30_000,
          retries: 2,
        });
      } catch (err) {
        // Be gentle: if we already have a partial snapshot, keep it rather than
        // failing the whole run; only surface the error when we have nothing.
        if (out.length > 0) {
          log.info(`redfin: page start=${start} failed (${String(err)}); returning partial`);
          break;
        }
        throw err;
      }

      if (start === 0 && typeof data.numMatchedHomes === "number") {
        total = data.numMatchedHomes;
        log.info(
          `redfin: ${total} matched homes (${data.numMatchedUnits ?? "?"} units) in region ${regionId}`,
        );
      }

      const homes = data.homes ?? [];
      if (homes.length === 0) break;
      for (const h of homes) {
        const hd = h.homeData;
        if (!hd?.propertyId || seen.has(hd.propertyId)) continue;
        seen.add(hd.propertyId);
        out.push(map(hd, h.rentalExtension));
        if (out.length >= maxListings) break;
      }
      if (homes.length < PAGE || start + PAGE >= total) break;
      await sleep(400); // polite pause between pages on a free endpoint
    }
    return out;
  },
});

/** Age-on-Redfin (ms) from a status sash → approximate posting epoch. */
function postedFromSashes(sashes: RedfinHome["sashes"]): number | null {
  let maxAge = 0;
  for (const s of sashes ?? []) {
    const age = Number(s.timeOnRedfin);
    if (Number.isFinite(age) && age > maxAge) maxAge = age;
  }
  return maxAge > 0 ? Date.now() - maxAge : null;
}

function map(hd: RedfinHome, re: RentalExtension | undefined): RawListing {
  const sashes = (hd.sashes ?? [])
    .map((s) => s.sashTypeName)
    .filter(Boolean)
    .join(",");
  const c = hd.addressInfo?.centroid?.centroid;
  const price = re?.rentPriceRange ?? {};
  const beds = re?.bedRange ?? {};
  const baths = re?.bathRange ?? {};
  const sqft = re?.sqftRange ?? {};
  const priceMin = num(price.min);
  const priceMax = num(price.max);
  const bedMin = num(beds.min);
  const bedMax = num(beds.max);
  const bathMin = num(baths.min);
  const bathMax = num(baths.max);
  const sqftMin = num(sqft.min);
  const propertyType =
    hd.propertyType != null ? (PROPERTY_TYPES[hd.propertyType] ?? `type-${hd.propertyType}`) : null;

  // Pre-flatten searchable text (building name + description + feed) for `find`'s LIKE match.
  const amenities = [re?.propertyName ?? "", re?.description ?? "", re?.feedSource ?? ""]
    .join(" ")
    .toLowerCase()
    .trim();

  // Rental photos live on the CDN keyed by the rentalId GUID. The search feed gives
  // no URLs, but the pattern is stable and version "1" (the original upload) is
  // reliably present; build a few and let the card drop any that 404.
  const rentalId = re?.rentalId ?? null;
  const photoCount =
    hd.photosInfo?.photoRanges?.reduce((m, r) => Math.max(m, (r.endPos ?? -1) + 1), 0) ?? 0;
  const imageUrls =
    rentalId && photoCount > 0
      ? Array.from(
          { length: Math.min(photoCount, 4) },
          (_, i) => `https://ssl.cdn-redfin.com/photo/rent/${rentalId}/bigphoto/${i}_1.jpg`,
        )
      : [];

  return {
    sourceId: hd.propertyId!,
    url: hd.url ? `https://www.redfin.com${hd.url}` : "https://www.redfin.com/",
    title: hd.addressInfo?.formattedStreetLine ?? re?.propertyName ?? null,
    address: hd.addressInfo?.formattedStreetLine ?? null,
    city: hd.addressInfo?.city ?? null,
    neighborhood: null, // not provided by this endpoint
    lat: c?.latitude ?? null,
    lon: c?.longitude ?? null,
    price: priceMin, // headline = starting rent; full range lives in the facet
    beds: bedMin,
    baths: bathMin,
    sqft: sqftMin,
    propertyType,
    postedAt: postedFromSashes(hd.sashes),
    // Fold the mutable, meaningful signals into the change hash (lastUpdated is a
    // feed-refresh timestamp that churns without a real change, so it's excluded).
    changeTag: `${priceMin ?? ""}-${priceMax ?? ""}|b${bedMin ?? ""}-${bedMax ?? ""}|u${re?.numAvailableUnits ?? ""}|s${re?.status ?? ""}|${sashes}`,
    raw: {
      ...facet({
        buildingName: re?.propertyName ?? null,
        minBeds: bedMin,
        maxBeds: bedMax,
        minBaths: bathMin,
        maxBaths: bathMax,
        minPrice: priceMin,
        maxPrice: priceMax,
        amenities,
      }),
      imageUrls,
      // Extra Redfin richness preserved for later enrichment / debugging.
      rentalId: re?.rentalId ?? null,
      rawPropertyType: hd.propertyType ?? null,
      zip: hd.addressInfo?.zip ?? null,
      state: hd.addressInfo?.state ?? null,
      numAvailableUnits: re?.numAvailableUnits ?? null,
      status: re?.status ?? null,
      sashes,
      sqftMax: num(sqft.max),
      dateAvailable: re?.dateAvailable ?? null,
      lastUpdated: re?.lastUpdated ?? null,
      freshnessTimestamp: re?.freshnessTimestamp ?? null,
      feedSource: re?.feedSource ?? null,
      feedOriginalSource: re?.feedOriginalSource ?? null,
      mlsName: re?.mlsName ?? null,
      description: re?.description ?? null,
    },
  };
}
