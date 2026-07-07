import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { fetchJson } from "../../core/http.ts";
import { facet } from "../../core/facet.ts";
import type { RawListing } from "../../core/types.ts";

// DAHLIA — SF Mayor's Office of Housing & Community Development affordable/BMR
// housing portal. Free, no auth, no anti-bot; it's a public gov API backed by
// Salesforce. These are income-capped lottery/waitlist units (mostly
// application-gated), so scope-limited for a market-rate hunt, but the
// authoritative affordable feed.
//
// Endpoints (verified live 2026-07):
//  • LIST:   GET /api/v1/listings.json[?type=rental|ownership]  → { listings: [...] }
//            Returns the COMPLETE current set in one shot (no pagination). `type`
//            is the ONLY server-side filter — rental(66) + ownership(62) = all(128).
//            Each row carries address/city, an imageURL, hasWaitlist, Status,
//            Lottery_Status, LastModifiedDate, and a `unitSummaries` breakdown
//            (general[] + reserved[]) with per-unit-type rent/sqft/occupancy.
//  • DETAIL: GET /api/v1/listings/{id}.json  → { listing: {...} }
//            Adds Neighborhood, Amenities, Year_Built, Pet/Smoking/Parking, etc.
//            Neighborhood is NOT in the list feed — only here. Opt-in (--enrich /
//            DAHLIA_ENRICH) since it costs one request per kept listing.
//
// The feed has NO lat/lon and NO per-unit bath count anywhere (list or detail),
// so those RawListing fields stay null. Beds are derived from unitType
// ("Studio"/"SRO" → 0, "N BR" → N).
const API_BASE = "https://housing.sfgov.org/api/v1";
const LISTING_TYPES = ["rental", "ownership", "all"] as const;
const ENRICH_CONCURRENCY = 4; // gentle on a free gov API

/** One unit-type row inside unitSummaries.general[] / .reserved[]. */
interface DahliaUnitSummary {
  unitType?: string | null;
  minMonthlyRent?: number | null;
  maxMonthlyRent?: number | null;
  minSquareFt?: number | null;
  maxSquareFt?: number | null;
  totalUnits?: number | null;
  availability?: number | null;
}
/** A row in the list feed (also the base of the detail record). */
interface DahliaListing {
  Id: string;
  Name?: string | null;
  Building_Name?: string | null;
  Building_Street_Address?: string | null;
  Building_City?: string | null;
  Building_State?: string | null;
  Building_Zip_Code?: string | null;
  Status?: string | null;
  Lottery_Status?: string | null;
  Listing_Type?: string | null;
  Tenure?: string | null;
  Program_Type?: string | null;
  Units_Available?: number | null;
  Application_Due_Date?: string | null;
  Lottery_Results_Date?: string | null;
  LastModifiedDate?: string | null;
  hasWaitlist?: boolean | null;
  imageURL?: string | null;
  RecordType?: { Name?: string | null } | null;
  unitSummaries?: {
    general?: DahliaUnitSummary[] | null;
    reserved?: DahliaUnitSummary[] | null;
  } | null;
}
interface DahliaListResponse {
  listings?: DahliaListing[] | null;
}
/** Extra fields only the per-listing detail endpoint returns. */
interface DahliaDetail extends DahliaListing {
  Neighborhood?: string | null;
  Amenities?: string | null;
  Year_Built?: number | null;
  Pet_Policy?: string | null;
  Smoking_Policy?: string | null;
  Parking_Information?: string | null;
  Deposit_Min?: number | null;
  Total_number_of_building_units?: number | null;
}
interface DahliaDetailResponse {
  listing?: DahliaDetail | null;
}

export default defineSource({
  name: "dahlia",
  summary:
    "SF DAHLIA affordable/BMR housing portal — the authoritative feed for income-capped lottery/waitlist rentals (address, per-unit-type rent/sqft, beds, availability; optional neighborhood/amenity enrichment).",
  when: "Use for SF affordable/below-market-rate units; mostly application-gated lottery/waitlist listings, so skip it for a market-rate hunt. Pass --enrich to add neighborhood/amenities (one request per listing).",
  snapshotComplete: true,
  // All optional: `ingest` runs with none set (env defaults drive the query);
  // an operator/LLM passes any combination to `search dahlia`.
  input: z.object({
    type: z
      .enum(LISTING_TYPES)
      .optional()
      .describe("Which portal feed to pull (rental|ownership|all)"),
    minPrice: z.coerce
      .number()
      .min(0)
      .optional()
      .describe("Client-side filter: drop listings whose cheapest unit rents below this"),
    maxPrice: z.coerce
      .number()
      .min(0)
      .optional()
      .describe("Client-side filter: drop listings whose cheapest unit rents above this"),
    minBeds: z.coerce
      .number()
      .min(0)
      .optional()
      .describe(
        "Client-side filter: require a unit with at least this many bedrooms (Studio/SRO = 0)",
      ),
    maxBeds: z.coerce
      .number()
      .min(0)
      .optional()
      .describe("Client-side filter: require a unit with at most this many bedrooms"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("Max listings to return (1-500)"),
    enrich: z
      .boolean()
      .optional()
      .describe("Fetch each listing's detail page for neighborhood/amenities (one request each)"),
  }),
  requires: {
    DAHLIA_TYPE: envSpec(
      z.enum(LISTING_TYPES).default("rental"),
      "Default portal feed for `ingest` (rental|ownership|all)",
      "",
    ),
    DAHLIA_LIMIT: envSpec(
      z.coerce.number().int().min(1).max(500).default(200),
      "Default max listings per run",
      "",
    ),
    DAHLIA_ENRICH: envSpec(
      z.stringbool().default(false),
      "Whether `ingest` fetches per-listing detail for neighborhood/amenities (true/false)",
      "",
    ),
  },
  async fetch(env, { input, log }): Promise<RawListing[]> {
    const type = input.type ?? env.DAHLIA_TYPE;
    const limit = input.limit ?? env.DAHLIA_LIMIT;
    const enrich = input.enrich ?? env.DAHLIA_ENRICH;

    const url =
      type === "all" ? `${API_BASE}/listings.json` : `${API_BASE}/listings.json?type=${type}`;
    const data = await fetchJson<DahliaListResponse>(url, { retries: 2, timeoutMs: 30_000 });
    const rows = data.listings ?? [];

    // Map → filter → dedup → cap. `type` is already applied server-side; the
    // price/beds filters are client-side (the API exposes no such params).
    const seen = new Set<string>();
    const out: RawListing[] = [];
    for (const row of rows) {
      if (!row?.Id || seen.has(row.Id)) continue;
      const listing = mapRow(row);
      if (!passesFilters(listing, input)) continue;
      seen.add(row.Id);
      out.push(listing);
      if (out.length >= limit) break;
    }

    if (enrich && out.length) {
      await enrichAll(out, log);
    }
    return out;
  },
});

/** "Studio"/"SRO" → 0, "1 BR"/"2 BR"/… → N, anything else → null. */
function bedsFromUnitType(t: string | null | undefined): number | null {
  if (!t) return null;
  const s = t.trim().toLowerCase();
  if (s === "studio" || s === "sro") return 0;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

const nums = (xs: (number | null | undefined)[]): number[] =>
  xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));

interface UnitAgg {
  minBeds: number | null;
  maxBeds: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  minSqft: number | null;
  maxSqft: number | null;
  unitTypes: string[];
}

/** Fold every general + reserved unit-type row into building-level ranges. */
function aggregateUnits(l: DahliaListing): UnitAgg {
  const units = [...(l.unitSummaries?.general ?? []), ...(l.unitSummaries?.reserved ?? [])].filter(
    (u): u is DahliaUnitSummary => !!u,
  );
  const beds = nums(units.map((u) => bedsFromUnitType(u.unitType)));
  const minRents = nums(units.map((u) => u.minMonthlyRent));
  const maxRents = nums(units.map((u) => u.maxMonthlyRent ?? u.minMonthlyRent));
  const minSqfts = nums(units.map((u) => u.minSquareFt));
  const maxSqfts = nums(units.map((u) => u.maxSquareFt ?? u.minSquareFt));
  const unitTypes = [...new Set(units.map((u) => u.unitType).filter((t): t is string => !!t))];
  return {
    minBeds: beds.length ? Math.min(...beds) : null,
    maxBeds: beds.length ? Math.max(...beds) : null,
    minPrice: minRents.length ? Math.min(...minRents) : null,
    maxPrice: maxRents.length ? Math.max(...maxRents) : null,
    minSqft: minSqfts.length ? Math.min(...minSqfts) : null,
    maxSqft: maxSqfts.length ? Math.max(...maxSqfts) : null,
    unitTypes,
  };
}

function mapRow(l: DahliaListing): RawListing {
  const agg = aggregateUnits(l);
  const address = l.Building_Street_Address ?? null;
  const amenities = [
    l.Building_Name,
    l.Tenure,
    l.Listing_Type,
    l.Program_Type,
    "affordable bmr below-market-rate lottery",
    ...agg.unitTypes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return {
    sourceId: l.Id,
    url: `https://housing.sfgov.org/listing/${encodeURIComponent(l.Id)}`,
    title: l.Name ?? l.Building_Name ?? address,
    address,
    city: l.Building_City ?? "San Francisco",
    // No lat/lon anywhere in the DAHLIA feed; neighborhood only via --enrich.
    lat: null,
    lon: null,
    // Cheapest available unit rent (monthly USD). Full range is in raw facet.
    price: agg.minPrice,
    beds: agg.minBeds,
    baths: null, // not provided by the API
    sqft: agg.minSqft,
    propertyType: "affordable",
    postedAt: null, // the API exposes no created/publish date, only LastModifiedDate
    changeTag: [
      l.Status,
      l.Lottery_Status,
      l.Units_Available,
      l.Application_Due_Date,
      l.LastModifiedDate,
      agg.minPrice,
    ]
      .map((v) => v ?? "")
      .join("|"),
    raw: {
      ...facet({
        buildingName: l.Building_Name ?? null,
        minBeds: agg.minBeds,
        maxBeds: agg.maxBeds,
        minBaths: null,
        maxBaths: null,
        minPrice: agg.minPrice,
        maxPrice: agg.maxPrice,
        amenities,
      }),
      status: l.Status ?? null,
      lotteryStatus: l.Lottery_Status ?? null,
      listingType: l.Listing_Type ?? null,
      tenure: l.Tenure ?? null,
      programType: l.Program_Type ?? null,
      recordType: l.RecordType?.Name ?? null,
      unitsAvailable: l.Units_Available ?? null,
      hasWaitlist: l.hasWaitlist ?? null,
      unitTypes: agg.unitTypes,
      minSqft: agg.minSqft,
      maxSqft: agg.maxSqft,
      zip: l.Building_Zip_Code ?? null,
      applicationDue: l.Application_Due_Date ?? null,
      lotteryResultsDate: l.Lottery_Results_Date ?? null,
      lastModified: l.LastModifiedDate ?? null,
      imageUrl: l.imageURL ?? null,
      // populated by --enrich:
      neighborhood: null as string | null,
      yearBuilt: null as number | null,
      petPolicy: null as string | null,
      parking: null as string | null,
      depositMin: null as number | null,
      buildingUnits: null as number | null,
    },
  };
}

function passesFilters(
  l: RawListing,
  f: { minPrice?: number; maxPrice?: number; minBeds?: number; maxBeds?: number },
): boolean {
  const raw = l.raw as { minBeds?: number | null; maxBeds?: number | null };
  if (f.minPrice != null && (l.price == null || l.price < f.minPrice)) return false;
  if (f.maxPrice != null && (l.price == null || l.price > f.maxPrice)) return false;
  // A listing passes a bed filter if ANY of its unit types satisfies it.
  if (f.minBeds != null && (raw.maxBeds == null || raw.maxBeds < f.minBeds)) return false;
  if (f.maxBeds != null && (raw.minBeds == null || raw.minBeds > f.maxBeds)) return false;
  return true;
}

/** Fetch each kept listing's detail page and merge neighborhood/amenity fields in place. */
async function enrichAll(listings: RawListing[], log: { info(m: string): void }): Promise<void> {
  let i = 0;
  let failures = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = i++;
      if (idx >= listings.length) return;
      const l = listings[idx];
      try {
        const res = await fetchJson<DahliaDetailResponse>(
          `${API_BASE}/listings/${encodeURIComponent(l.sourceId)}.json`,
          { retries: 1, timeoutMs: 20_000 },
        );
        mergeDetail(l, res.listing);
      } catch {
        failures++; // keep the base listing; enrichment is best-effort
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, listings.length) }, worker));
  if (failures)
    log.info(`dahlia: ${failures}/${listings.length} detail enrichments failed (kept base rows)`);
}

function mergeDetail(l: RawListing, d: DahliaDetail | null | undefined): void {
  if (!d) return;
  const raw = l.raw as Record<string, unknown>;
  if (d.Neighborhood) {
    l.neighborhood = d.Neighborhood;
    raw.neighborhood = d.Neighborhood;
  }
  raw.yearBuilt = d.Year_Built ?? raw.yearBuilt ?? null;
  raw.petPolicy = d.Pet_Policy ?? raw.petPolicy ?? null;
  raw.parking = d.Parking_Information ?? raw.parking ?? null;
  raw.depositMin = d.Deposit_Min ?? raw.depositMin ?? null;
  raw.buildingUnits = d.Total_number_of_building_units ?? raw.buildingUnits ?? null;
  // Fold the real amenity/neighborhood/policy text into the searchable facet.
  const extra = [d.Neighborhood, d.Amenities, d.Parking_Information, d.Pet_Policy, d.Smoking_Policy]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (extra) raw.amenities = `${raw.amenities ?? ""} ${extra}`.trim();
}
