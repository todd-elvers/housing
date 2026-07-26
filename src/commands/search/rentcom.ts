import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { httpFetch } from "../../core/http.ts";
import { facet } from "../../core/facet.ts";
import { neighborhoodAt } from "../../core/geo.ts";
import type { RawListing } from "../../core/types.ts";

// Rent.com (RentPath, Redfin-owned) — server-rendered Next.js. No API key and no
// HTML scraping needed: the ENTIRE search result set ships inside the page's
// `__NEXT_DATA__` script tag, so a plain GET with a browser UA yields structured
// JSON. Free, and the richest per-listing payload of any free source here.
//
// The one operational catch: AWS WAF Bot Control fronts the site and answers a
// crawl it dislikes with a JS challenge (see fetchPage). It is triggered by
// SUSTAINED volume, not by any single request — a full 4-property-type crawl of
// SF (~20 requests, ~525 listings) completes cleanly from a cold start, while
// running several of those back-to-back trips it. So this is a source to run on
// a schedule, not one to hammer; a challenged run degrades to partial results
// (or a clear error) rather than silently returning nothing.
//
// Verified against the live site (2026-07):
//  • Listings live at props.pageProps.pageData.location.listingSearch.listings —
//    fully hydrated rows, NOT just ids. Each carries per-floor-plan bed/bath/sqft/
//    price/availability, highlighted + unique amenities, photos, PM company,
//    deals, ratings and an `updatedAt` stamp.
//  • Pagination is a PATH segment (`/page-2`), 30 rows/page. Past the last real
//    page the server silently re-serves page 1, so we stop when the echoed
//    `pageNumber` doesn't match what we asked for (a plain length check would
//    loop forever re-ingesting page 1).
//  • Property type is also a path segment; there is no combined "all rentals"
//    page, so full coverage means crawling each type and deduping by id
//    (the houses page mixes in apartment filler, hence the cross-type dedup).
//  • Refinements (`/2-bedroom`, `/max-price-4000`, `/pet-friendly`, …) are path
//    segments too, but EXACTLY ONE composes — two segments 404. Price refinements
//    accept arbitrary integers (`max-price-4321`), not just round buckets.
//  • Rows come in two shapes discriminated by `__typename`: "Listing" (a managed
//    building or a single `lv` rental, with floorPlans/bedRange/priceRange) and
//    "Building" (an off-market/for-sale-adjacent card with only *Text fields and
//    no floor plans) — so beds/baths/sqft fall back to parsing "Studio–3 Beds".
//
// The detail page (opt-in --enrich, one request each) carries a much richer
// record than the search row: description, full amenity taxonomy, fees, pet
// policies with deposits, parking, walk/bike/transit scores, total unit count,
// schools, and per-unit unitId/deposit/availability inside each floor plan.
const BASE = "https://www.rent.com";
// Photo ids resolve to this CDN template; `resolvePhotos` (notification cards)
// picks the `photos` array up automatically because they're absolute URLs.
const PHOTO_CDN = "https://i.rent.com/t_3x2_fixed_webp_lg";
const PROPERTY_TYPES = ["apartments", "condos", "houses", "townhouses", "rooms-for-rent"] as const;
type PropertyType = (typeof PROPERTY_TYPES)[number];
// Rooms-for-rent is a share/roommate category, so it's available but off by default.
const DEFAULT_TYPES = "apartments,condos,houses,townhouses";
// A "Building" row carries no propertyType of its own, so it falls back to the
// category being crawled. rent.com's own labels aren't uniformly pluralised
// (APARTMENTS but CONDO/HOUSE), so match them here — otherwise one crawl emits
// both "condo" and "condos" and `find --source` filtering splits in two.
const TYPE_LABEL: Record<PropertyType, string> = {
  apartments: "apartments",
  condos: "condo",
  houses: "house",
  townhouses: "townhome",
  "rooms-for-rent": "room",
};
const PAGE_SIZE = 30; // server-fixed; not configurable via the URL
// Safety rail per property type — SF apartments is ~14 pages, so this is slack.
const MAX_PAGES_HARD = 40;
// CloudFront soft-throttles a sustained crawl (see fetchPage), so pace the pages.
const PAGE_PAUSE_MS = 1000;
// Throttle backoff: 2s, 4s, 8s, 16s. The block is intermittent and clears within
// seconds-to-minutes, so a handful of backed-off retries almost always recovers.
const THROTTLE_RETRIES = 4;
const THROTTLE_BASE_MS = 2000;
// Once this many pages have exhausted their backoff, the WAF challenge is on for
// this IP and further pages would just burn 30s each — stop and keep what we have.
const THROTTLE_GIVE_UP = 3;
// Detail pages are one request each, so keep the fan-out well under the crawl's
// and pace each worker — two workers at a 1s gap holds the run near ~2 req/s,
// which the edge tolerates where an unpaced fan-out gets soft-blocked.
const ENRICH_CONCURRENCY = 2;
const ENRICH_PAUSE_MS = 1000;
// Caps that keep a single `raw` JSON blob a sane size in the listings table.
const MAX_PHOTOS = 12;
const MAX_FLOOR_PLANS = 40;
const MAX_SCHOOLS = 8;
const MAX_RENT_ESTIMATES = 10;
const MAX_DESCRIPTION = 4000;

interface Range {
  min?: number | null;
  max?: number | null;
}
interface Unit {
  unitId?: string | null;
  rent?: string | null;
  deposit?: string | null;
  dateAvailable?: string | null;
  isAvailable?: boolean | null;
  minSqft?: number | null;
  unitFloor?: string | null;
}
interface FloorPlan {
  id?: string | null;
  name?: string | null;
  bedCount?: number | null;
  bathCount?: number | null;
  halfBathCount?: number | null;
  sqFt?: number | null;
  sqFtRange?: Range | null;
  priceRange?: Range | null;
  priceTerm?: string | null;
  deposit?: number | null;
  availableCount?: number | null;
  availableDate?: string | null;
  availabilityStatusCode?: string | null;
  amenities?: string[] | null;
  units?: Unit[] | null;
}
interface PhotoRef {
  id?: string | null;
  caption?: string | null;
}
interface RentLocation {
  lat?: number | null;
  lng?: number | null;
  city?: string | null;
  state?: string | null;
  stateAbbr?: string | null;
  zip?: string | null;
}

/** A row in `listingSearch.listings` — `__typename` "Listing" or "Building". */
interface SearchRow {
  __typename?: string;
  id?: string;
  name?: string | null;
  address?: string | null;
  addressFull?: string | null;
  zipCode?: string | null;
  urlPathname?: string | null;
  location?: RentLocation | null;
  propertyType?: string | null;
  price?: number | null;
  priceRange?: Range | null;
  priceText?: string | null;
  bedRange?: Range | null;
  bedText?: string | null;
  bathText?: string | null;
  squareFeetText?: string | null;
  bedCountData?: { beds?: number | null; prices?: { low?: number | null } | null }[] | null;
  floorPlans?: FloorPlan[] | null;
  optimizedPhotos?: PhotoRef[] | null;
  photosWithAttribution?: { photos?: PhotoRef[] | null } | null;
  amenitiesHighlighted?: string[] | null;
  uniqueHighlights?: string[] | null;
  availabilityStatus?: string | null;
  unitsAvailableText?: string | null;
  updatedAt?: string | null;
  verified?: boolean | null;
  offMarket?: boolean | null;
  isUnpaid?: boolean | null;
  listingTier?: string | null;
  hasPriceDrops?: boolean | null;
  priceDrops?: { byFloorplanId?: unknown[] | null } | null;
  deals?: unknown[] | null;
  dealsText?: string | null;
  specialTerms?: string | null;
  leasingTerms?: unknown[] | null;
  incomeRestrictions?: unknown[] | null;
  propertyManagementCompany?: { id?: string | null; name?: string | null } | null;
  phoneDesktopText?: string | null;
  officeHours?: { day?: string | null; times?: unknown[] | null }[] | null;
  ratingPercent?: number | null;
  ratingCount?: number | null;
  pdpViews?: number | null;
  hasVideosOrTours?: boolean | null;
  videos?: unknown[] | null;
  hdTours?: unknown[] | null;
  website?: string | null;
  applicationUrl?: string | null;
  tplsource?: string | null;
  hoodIds?: number[] | null;
}

/** The detail-page record (`pageData.listing`) — a superset of SearchRow. */
interface DetailRow extends SearchRow {
  description?: string | null;
  totalUnits?: number | null;
  unitsAvailable?: number | null;
  squareFeetRange?: Range | null;
  providedPriceRange?: Range | null;
  photos?: PhotoRef[] | null;
  amenitiesWithSubcategories?:
    | { amenity?: string | null; subcategory?: string | null; category?: string | null }[]
    | null;
  amenitySearchFields?: string[] | null;
  propertyVibes?: { category?: string | null; context?: string | null }[] | null;
  petPolicies?: Record<string, unknown>[] | null;
  parking?: Record<string, unknown>[] | null;
  fees?: Record<string, unknown> | null;
  internetServices?: unknown[] | null;
  walkScore?: {
    walk?: { score?: number | null; description?: string | null } | null;
    bike?: { score?: number | null; description?: string | null } | null;
    transit?: { score?: number | null; description?: string | null } | null;
  } | null;
  schools?: Record<string, unknown>[] | null;
  redfinRentalEstimates?:
    | {
        addressInfo?: { unitNumber?: string | null } | null;
        beds?: number | null;
        baths?: number | null;
        sqft?: number | null;
        rentEstimate?: number | null;
      }[]
    | null;
  disclaimer?: string | null;
  /** Synthesised for `/building/…` pages: the unit listing ids nested under it. */
  buildingUnitIds?: string[] | null;
  unitName?: string | null;
}

interface NextData {
  props?: {
    pageProps?: {
      pageData?: {
        pageNumber?: number;
        /** `/apartment/…` and `/r/…` detail pages. */
        listing?: DetailRow | null;
        /** `/building/…` detail pages — the real units are nested inside. */
        building?: {
          listings?: (SearchRow & { unitName?: string | null })[] | null;
          schools?: Record<string, unknown>[] | null;
          photosWithAttribution?: { photos?: PhotoRef[] | null } | null;
        } | null;
        location?: {
          listingSearch?: {
            total?: number | null;
            currentFutureAvailUnitTotal?: number | null;
            listings?: SearchRow[] | null;
          } | null;
        } | null;
      } | null;
    } | null;
  } | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nums = (xs: (number | null | undefined)[]): number[] =>
  xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x));
const min = (xs: number[]): number | null => (xs.length ? Math.min(...xs) : null);
const max = (xs: number[]): number | null => (xs.length ? Math.max(...xs) : null);

/**
 * Pull + parse the `__NEXT_DATA__` payload out of a server-rendered page.
 * Next.js escapes any nested `</script>`, so the non-greedy match is safe.
 */
function extractNextData(html: string): NextData | null {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(m[1]) as NextData;
  } catch {
    return null;
  }
}

/** Distinguishes "we were throttled" from "this page genuinely doesn't exist". */
type PageResult =
  | { kind: "ok"; data: NextData }
  | { kind: "missing" } // 404 / real HTTP error — walked off the end of the results
  | { kind: "throttled" }; // soft-blocked even after backing off

/**
 * GET a rent.com page and return its parsed `__NEXT_DATA__`.
 *
 * Rent.com sits behind AWS WAF Bot Control, which answers a crawl it dislikes
 * with `HTTP 202` + `x-amzn-waf-action: challenge` and either an empty body or a
 * JS proof-of-work page. That's a 2xx, so it sails straight past any status
 * check and would otherwise look like "the page shape changed".
 *
 * The challenge is volume-triggered and probabilistic — individual requests
 * still get through while it's active — so an unsolved page is retried with
 * exponential backoff. We can't solve it (it needs a real JS engine), so once
 * the retries are spent the caller decides whether to keep going.
 */
async function fetchPage(url: string, retries = THROTTLE_RETRIES): Promise<PageResult> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await httpFetch(url, {
        headers: { accept: "text/html,application/xhtml+xml", referer: BASE },
        timeoutMs: 30_000,
        retries: 1,
      });
    } catch {
      return { kind: "missing" };
    }
    if (res.status >= 400) return { kind: "missing" };

    const challenged = res.headers.get("x-amzn-waf-action") !== null;
    const data = challenged ? null : extractNextData(await res.text());
    if (data) return { kind: "ok", data };
    if (attempt >= retries) return { kind: "throttled" };
    await sleep(THROTTLE_BASE_MS * 2 ** attempt);
  }
}

/** Numbers in a range label ("Studio–3 Beds", "418–1429 Sqft"); "studio" ⇒ 0. */
function parseRangeText(text: string | null | undefined): number[] {
  if (!text) return [];
  const found = [...text.matchAll(/(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1]));
  if (/studio/i.test(text)) found.unshift(0);
  return found.filter((n) => Number.isFinite(n));
}

/** Rent.com writes rents as "$4,601"; pull the number back out. */
function parseMoney(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Monthly-rent sanity window — keeps fees/deposits out of the price fields. */
const isRent = (n: number): boolean => n >= 300 && n <= 60_000;

/** `urlPathname` is sometimes absolute-ish ("/r/…") and sometimes not ("building/…"). */
function absoluteUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (path.startsWith("http")) return path;
  return `${BASE}/${path.replace(/^\/+/, "")}`;
}

function photoUrls(row: SearchRow & { photos?: PhotoRef[] | null }): string[] {
  const refs = [
    ...(row.photos ?? []),
    ...(row.optimizedPhotos ?? []),
    ...(row.photosWithAttribution?.photos ?? []),
  ];
  const out: string[] = [];
  for (const p of refs) {
    if (!p?.id) continue;
    const url = `${PHOTO_CDN}/${p.id}`;
    if (!out.includes(url)) out.push(url);
    if (out.length >= MAX_PHOTOS) break;
  }
  return out;
}

/** Build one crawl path: /{state}/{city}-{type}[/{refinement}][/page-N]. */
function searchPath(
  state: string,
  city: string,
  type: PropertyType,
  refinement: string | null,
  page: number,
): string {
  const parts = [`${BASE}/${state}/${city}-${type}`];
  if (refinement) parts.push(refinement);
  if (page > 1) parts.push(`page-${page}`);
  return parts.join("/");
}

/**
 * Turn the convenience flags into rent.com's single refinement segment.
 * Only ONE composes into a URL (two segments 404), so more than one is a
 * hard error rather than a silently-dropped filter.
 */
function resolveRefinement(input: {
  minPrice?: number;
  maxPrice?: number;
  beds?: string;
  refine?: string;
}): string | null {
  const segments: string[] = [];
  if (input.minPrice != null) segments.push(`min-price-${Math.round(input.minPrice)}`);
  if (input.maxPrice != null) segments.push(`max-price-${Math.round(input.maxPrice)}`);
  if (input.beds) {
    const b = input.beds.trim().toLowerCase();
    segments.push(b === "studio" || b === "0" ? "studio" : `${parseInt(b, 10)}-bedroom`);
  }
  if (input.refine) segments.push(input.refine.trim().replace(/^\/+|\/+$/g, ""));
  if (segments.length > 1) {
    throw new Error(
      `rentcom: rent.com accepts only ONE refinement per URL — got ${segments.length} (${segments.join(", ")}). ` +
        `Pass a single one of --minPrice / --maxPrice / --beds / --refine.`,
    );
  }
  return segments[0] ?? null;
}

export default defineSource({
  name: "rentcom",
  summary:
    "Rent.com (RentPath/Redfin) server-rendered search — free, keyless, and unusually rich: per-floor-plan beds/baths/sqft/rent, availability, amenities, photos, PM company, deals and ratings, with an opt-in detail pass for description, fees, pet policies, parking and walk/transit scores.",
  when: "Use for broad SF multifamily + single-unit coverage without paying for Apartments.com — it crawls every property type and pages the full city set. Add --enrich for the deep per-property record (one extra request per listing).",
  // We cap pages/items and the result set folds in cross-type filler, so a fetch
  // is not a guaranteed-complete set — absence must never imply removal.
  snapshotComplete: false,
  input: z.object({
    state: z
      .string()
      .optional()
      .describe('State slug, e.g. "california" (overrides RENTCOM_STATE)'),
    city: z
      .string()
      .optional()
      .describe('City slug, e.g. "san-francisco" or "oakland" (overrides RENTCOM_CITY)'),
    propertyTypes: z
      .string()
      .optional()
      .describe(
        `Comma-separated property types to crawl (${PROPERTY_TYPES.join("|")}); default ${DEFAULT_TYPES}`,
      ),
    minPrice: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Server-side min rent refinement (mutually exclusive with the other refinements)"),
    maxPrice: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Server-side max rent refinement (mutually exclusive with the other refinements)"),
    beds: z
      .string()
      .optional()
      .describe(
        'Server-side bedroom refinement: "studio" or 1-4 (mutually exclusive with the other refinements)',
      ),
    refine: z
      .string()
      .optional()
      .describe(
        'Any other single rent.com refinement segment, e.g. "pet-friendly", "furnished", "luxury", "garage", "income-restricted", "noe-valley-neighborhood"',
      ),
    maxPages: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_PAGES_HARD)
      .optional()
      .describe(`Max pages per property type (30 listings/page, hard cap ${MAX_PAGES_HARD})`),
    maxItems: z.coerce
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe("Max listings to return across all property types"),
    enrich: z
      .boolean()
      .optional()
      .describe(
        "Fetch each listing's detail page for description, fees, pet policies, parking, walk/transit scores and per-unit data (one request each)",
      ),
    enrichMax: z.coerce
      .number()
      .int()
      .min(1)
      .max(5000)
      .optional()
      .describe("Cap on how many listings --enrich fetches detail for (the rest keep base fields)"),
  }),
  requires: {
    RENTCOM_STATE: envSpec(z.string().default("california"), "Default rent.com state slug", ""),
    RENTCOM_CITY: envSpec(z.string().default("san-francisco"), "Default rent.com city slug", ""),
    RENTCOM_PROPERTY_TYPES: envSpec(
      z.string().default(DEFAULT_TYPES),
      `Comma-separated property types \`ingest\` crawls (${PROPERTY_TYPES.join("|")})`,
      "",
    ),
    RENTCOM_MAX_PAGES: envSpec(
      z.coerce.number().int().min(1).max(MAX_PAGES_HARD).default(MAX_PAGES_HARD),
      "Max pages per property type per run (30 listings/page)",
      "",
    ),
    RENTCOM_MAX_ITEMS: envSpec(
      z.coerce.number().int().min(1).max(5000).default(1200),
      "Max listings per run across all property types",
      "",
    ),
    RENTCOM_ENRICH: envSpec(
      z.stringbool().default(false),
      "Whether `ingest` fetches each listing's detail page for the deep record (true/false)",
      "",
    ),
    RENTCOM_ENRICH_MAX: envSpec(
      z.coerce.number().int().min(1).max(5000).default(200),
      "Cap on how many listings an enriched run fetches detail pages for",
      "",
    ),
  },
  async fetch(env, { input, log }): Promise<RawListing[]> {
    const state = input.state?.trim() || env.RENTCOM_STATE;
    const city = input.city?.trim() || env.RENTCOM_CITY;
    const maxPages = input.maxPages ?? env.RENTCOM_MAX_PAGES;
    const maxItems = input.maxItems ?? env.RENTCOM_MAX_ITEMS;
    const enrich = input.enrich ?? env.RENTCOM_ENRICH;
    const enrichMax = input.enrichMax ?? env.RENTCOM_ENRICH_MAX;
    const refinement = resolveRefinement(input);

    const requested = (input.propertyTypes ?? env.RENTCOM_PROPERTY_TYPES)
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    const bad = requested.filter((t) => !PROPERTY_TYPES.includes(t as PropertyType));
    if (bad.length) {
      throw new Error(
        `rentcom: unknown property type(s) ${bad.join(", ")} — valid: ${PROPERTY_TYPES.join(", ")}`,
      );
    }
    const types = [...new Set(requested)] as PropertyType[];

    // One id set across every property type: the houses/condos pages fold in
    // apartment filler, so cross-type dedup is what keeps the count honest.
    const seen = new Set<string>();
    const out: RawListing[] = [];

    let blocked = 0;
    for (const type of types) {
      if (out.length >= maxItems || blocked >= THROTTLE_GIVE_UP) break;
      let typeCount = 0;
      for (let page = 1; page <= maxPages; page++) {
        const url = searchPath(state, city, type, refinement, page);
        const res = await fetchPage(url);
        if (res.kind === "missing") {
          // Page 1 missing ⇒ this type/refinement combination doesn't exist;
          // deeper ⇒ we simply walked off the end. Neither should sink the run.
          if (page === 1) log.info(`rentcom: ${type} page 1 not found, skipping this type`);
          break;
        }
        if (res.kind === "throttled") {
          blocked++;
          log.info(
            `rentcom: ${type} page ${page} still WAF-challenged after ${THROTTLE_RETRIES} backoffs`,
          );
          break;
        }

        const pageData = res.data.props?.pageProps?.pageData;
        if (!pageData) {
          log.info(`rentcom: ${type} page ${page} had no pageData, stopping this type`);
          break;
        }

        // Past the last real page the server re-serves page 1. Trusting row
        // count alone would re-ingest page 1 forever, so trust the echo instead.
        if (page > 1 && pageData.pageNumber !== page) break;

        const search = pageData.location?.listingSearch;
        const rows = search?.listings ?? [];
        if (rows.length === 0) break;

        let fresh = 0;
        for (const row of rows) {
          const listing = map(row, type);
          if (!listing || seen.has(listing.sourceId)) continue;
          seen.add(listing.sourceId);
          out.push(listing);
          fresh++;
          typeCount++;
          if (out.length >= maxItems) break;
        }

        if (page === 1) {
          log.info(
            `rentcom: ${type} — ${search?.total ?? "?"} properties / ${search?.currentFutureAvailUnitTotal ?? "?"} available units advertised`,
          );
        }
        // Stop on the caller's cap, a short (final) page, or a page that added
        // nothing new (belt-and-braces against an unexpected server-side reset).
        if (out.length >= maxItems || rows.length < PAGE_SIZE || fresh === 0) break;
        await sleep(PAGE_PAUSE_MS);
      }
      log.info(`rentcom: ${type} → ${typeCount} new listings (${out.length} total)`);
    }

    // Nothing at all + a challenge ⇒ report it, so a run that silently fetched
    // zero listings can't be mistaken for "rent.com has no SF rentals today".
    // (`ingest` records this as a per-source error and carries on with the rest.)
    if (out.length === 0 && blocked) {
      throw new Error(
        "rentcom: AWS WAF served its JS bot challenge (HTTP 202 + x-amzn-waf-action) on every request — this IP is rate-limited. It clears on its own; run less often, or lower RENTCOM_MAX_PAGES / RENTCOM_PROPERTY_TYPES to make each run smaller.",
      );
    }
    if (blocked) {
      log.info(
        `rentcom: partial crawl — ${blocked} page(s) stayed WAF-challenged and were skipped`,
      );
    }

    if (enrich && out.length) await enrichAll(out.slice(0, enrichMax), log);

    log.info(`rentcom: ${out.length} listings for ${city}, ${state}${enrich ? " (enriched)" : ""}`);
    return out;
  },
});

/** Compact a floor plan down to the fields worth storing per listing. */
function compactFloorPlan(fp: FloorPlan) {
  const units = (fp.units ?? []).map((u) => ({
    unitId: u.unitId ?? null,
    rent: parseMoney(u.rent),
    deposit: parseMoney(u.deposit),
    sqft: u.minSqft ?? null,
    floor: u.unitFloor ?? null,
    availableDate: u.dateAvailable ?? null,
    isAvailable: u.isAvailable ?? null,
  }));
  return {
    id: fp.id ?? null,
    name: fp.name ?? null,
    beds: fp.bedCount ?? null,
    baths: fp.bathCount ?? null,
    halfBaths: fp.halfBathCount ?? null,
    sqftMin: fp.sqFtRange?.min ?? fp.sqFt ?? null,
    sqftMax: fp.sqFtRange?.max ?? fp.sqFt ?? null,
    priceMin: fp.priceRange?.min ?? null,
    priceMax: fp.priceRange?.max ?? null,
    priceTerm: fp.priceTerm ?? null,
    deposit: fp.deposit ?? null,
    availableCount: fp.availableCount ?? null,
    availableDate: fp.availableDate ?? null,
    availability: fp.availabilityStatusCode ?? null,
    units,
  };
}

function map(row: SearchRow, crawledType: PropertyType): RawListing | null {
  if (!row?.id) return null;
  const url = absoluteUrl(row.urlPathname);
  if (!url) return null;

  const plans = (row.floorPlans ?? []).filter(Boolean);
  // Structured floor-plan data when present; otherwise fall back to the display
  // strings, which is all a "Building" row ever carries.
  const planBeds = nums(plans.map((p) => p.bedCount));
  const planBaths = nums(plans.map((p) => p.bathCount));
  const planSqfts = nums(plans.flatMap((p) => [p.sqFtRange?.min, p.sqFtRange?.max, p.sqFt])).filter(
    (n) => n >= 100 && n <= 20_000,
  );
  const textBeds = parseRangeText(row.bedText);
  const textBaths = parseRangeText(row.bathText);
  const textSqfts = parseRangeText(row.squareFeetText);

  const minBeds = row.bedRange?.min ?? min(planBeds) ?? min(textBeds);
  const maxBeds = row.bedRange?.max ?? max(planBeds) ?? max(textBeds);
  const minBaths = min(planBaths) ?? min(textBaths);
  const maxBaths = max(planBaths) ?? max(textBaths);
  const sqftMin = min(planSqfts) ?? min(textSqfts);
  const sqftMax = max(planSqfts) ?? max(textSqfts);

  // Prices: prefer the row's own headline/range, then per-unit and per-plan rents.
  const unitRents = nums(plans.flatMap((p) => (p.units ?? []).map((u) => parseMoney(u.rent))));
  const planRents = nums(plans.flatMap((p) => [p.priceRange?.min, p.priceRange?.max]));
  const bedLows = nums((row.bedCountData ?? []).map((b) => b?.prices?.low));
  const allRents = [...unitRents, ...planRents, ...bedLows].filter(isRent);
  const headline = nums([row.price, row.priceRange?.min]).filter(isRent);
  const minPrice = min(headline) ?? min(allRents);
  const maxPrice =
    nums([row.priceRange?.max]).filter(isRent)[0] ?? max(allRents) ?? minPrice ?? null;

  const lat = row.location?.lat ?? null;
  const lon = row.location?.lng ?? null;
  const address = row.addressFull || row.address || null;

  // Everything text-ish that a `find --match` should be able to hit.
  const amenities = [
    ...(row.amenitiesHighlighted ?? []),
    ...(row.uniqueHighlights ?? []),
    ...plans.flatMap((p) => p.amenities ?? []),
    row.dealsText,
    row.specialTerms,
    row.propertyManagementCompany?.name,
    row.availabilityStatus,
    row.unitsAvailableText,
    (row.incomeRestrictions ?? []).length ? "income restricted" : "",
    crawledType.replace(/-/g, " "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const availableUnits = nums(plans.map((p) => p.availableCount)).reduce((a, b) => a + b, 0);

  return {
    sourceId: row.id,
    url,
    title: row.name || address,
    address,
    city: row.location?.city ?? null,
    // hoodIds are opaque numeric ids with no name mapping in the payload, so the
    // committed SF neighborhood polygons do the labelling.
    neighborhood: neighborhoodAt(lat, lon),
    lat,
    lon,
    price: minPrice,
    beds: minBeds,
    baths: minBaths,
    sqft: sqftMin,
    // "Building" rows carry no propertyType; fall back to the category we were
    // crawling rather than the GraphQL __typename (which is kept in raw.rowType).
    propertyType: (row.propertyType ?? TYPE_LABEL[crawledType]).toLowerCase(),
    // `updatedAt` is a last-modified stamp, not a first-posted date, so it drives
    // change detection (below) rather than masquerading as postedAt.
    postedAt: null,
    changeTag: [
      minPrice ?? "",
      maxPrice ?? "",
      availableUnits,
      row.availabilityStatus ?? "",
      row.unitsAvailableText ?? "",
      row.hasPriceDrops ? "drop" : "",
      row.updatedAt ?? "",
    ].join("|"),
    raw: {
      ...facet({
        buildingName: row.name ?? null,
        minBeds,
        maxBeds,
        minBaths,
        maxBaths,
        minPrice,
        maxPrice,
        amenities,
      }),
      // Absolute URLs so the Discord card collage picks them up as-is.
      photos: photoUrls(row),
      sqftMin,
      sqftMax,
      priceText: row.priceText ?? null,
      bedText: row.bedText ?? null,
      bathText: row.bathText ?? null,
      squareFeetText: row.squareFeetText ?? null,
      floorPlans: plans.slice(0, MAX_FLOOR_PLANS).map(compactFloorPlan),
      floorPlanCount: plans.length,
      unitsAvailable: availableUnits || null,
      unitsAvailableText: row.unitsAvailableText ?? null,
      availabilityStatus: row.availabilityStatus ?? null,
      amenitiesHighlighted: row.amenitiesHighlighted ?? null,
      uniqueHighlights: row.uniqueHighlights ?? null,
      propertyManager: row.propertyManagementCompany?.name ?? null,
      phone: row.phoneDesktopText ?? null,
      website: row.website ?? null,
      applicationUrl: row.applicationUrl ?? null,
      officeHours: row.officeHours ?? null,
      deals: row.deals?.length ? row.deals : null,
      dealsText: row.dealsText ?? null,
      specialTerms: row.specialTerms ?? null,
      leasingTerms: row.leasingTerms?.length ? row.leasingTerms : null,
      incomeRestrictions: row.incomeRestrictions?.length ? row.incomeRestrictions : null,
      hasPriceDrops: row.hasPriceDrops ?? null,
      priceDrops: row.priceDrops?.byFloorplanId?.length ? row.priceDrops.byFloorplanId : null,
      ratingPercent: row.ratingPercent ?? null,
      ratingCount: row.ratingCount ?? null,
      pdpViews: row.pdpViews ?? null,
      hasVideosOrTours: row.hasVideosOrTours ?? null,
      videoCount: (row.videos ?? []).length || null,
      hdTourCount: (row.hdTours ?? []).length || null,
      verified: row.verified ?? null,
      offMarket: row.offMarket ?? null,
      isUnpaid: row.isUnpaid ?? null,
      listingTier: row.listingTier ?? null,
      // "ZILLOW", "MITS", … — which upstream feed supplied the row.
      feedSource: row.tplsource ?? null,
      rowType: row.__typename ?? null,
      crawledType,
      state: row.location?.stateAbbr ?? null,
      zip: row.zipCode ?? row.location?.zip ?? null,
      hoodIds: row.hoodIds ?? null,
      updatedAt: row.updatedAt ?? null,
    },
  };
}

// ── detail-page enrichment (opt-in) ──────────────────────────────────────────

/** Fetch every listing's PDP concurrently and fold the deep record in. Best-effort. */
async function enrichAll(listings: RawListing[], log: { info(m: string): void }): Promise<void> {
  let i = 0;
  let failures = 0;
  let enriched = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = i++;
      if (idx >= listings.length) return;
      const l = listings[idx];
      if (idx >= ENRICH_CONCURRENCY) await sleep(ENRICH_PAUSE_MS);
      // Fewer backoffs than the crawl: a detail page is a bonus, not the payload,
      // so a throttled one is dropped rather than waited out.
      const res = await fetchPage(l.url, 2);
      if (res.kind !== "ok") {
        failures++; // keep the base row — enrichment never fails the fetch
        continue;
      }
      mergeDetail(l, resolveDetail(res.data.props?.pageProps?.pageData));
      enriched++;
    }
  };
  log.info(`rentcom: enriching ${listings.length} listings from their detail pages…`);
  await Promise.all(Array.from({ length: Math.min(ENRICH_CONCURRENCY, listings.length) }, worker));
  log.info(
    `rentcom: enriched ${enriched}/${listings.length} listings` +
      (failures ? ` (${failures} unavailable/rate-limited — kept base rows)` : ""),
  );
}

/**
 * Resolve a detail page's payload to one enrichable record.
 *
 * `/apartment/…` and `/r/…` pages expose `pageData.listing` directly. A
 * `/building/…` page (what a "Building" search row links to) instead nests the
 * REAL unit rows under `pageData.building.listings[]` — each a full listing with
 * floor plans, amenities, PM company and phone that the thin building card lacks.
 * Folding the first of those in (plus the building's own schools/photos) is what
 * turns a Building stub into a proper record.
 */
function resolveDetail(
  pageData: NonNullable<NonNullable<NextData["props"]>["pageProps"]>["pageData"],
): DetailRow | null {
  if (pageData?.listing) return pageData.listing;
  const b = pageData?.building;
  if (!b) return null;
  const units = (b.listings ?? []).filter(Boolean);
  return {
    ...units[0],
    schools: b.schools ?? null,
    photos: b.photosWithAttribution?.photos ?? units[0]?.optimizedPhotos ?? null,
    buildingUnitIds: units.map((u) => u.id).filter((id): id is string => Boolean(id)),
    unitName: units[0]?.unitName ?? null,
  };
}

/** Fold the PDP's extra fields into an already-mapped listing, in place. */
function mergeDetail(l: RawListing, d: DetailRow | null | undefined): void {
  if (!d) return;
  const raw = l.raw as Record<string, unknown>;

  // Floor plans on the PDP carry unit numbers, deposits and per-unit availability
  // the search row omits, so they replace (not merge with) the shallow version.
  const plans = (d.floorPlans ?? []).filter(Boolean);
  if (plans.length) {
    raw.floorPlans = plans.slice(0, MAX_FLOOR_PLANS).map(compactFloorPlan);
    raw.floorPlanCount = plans.length;
    const planSqfts = nums(plans.flatMap((p) => [p.sqFtRange?.min, p.sqFtRange?.max, p.sqFt]));
    if (planSqfts.length && l.sqft == null) l.sqft = Math.min(...planSqfts);
    const planBaths = nums(plans.map((p) => p.bathCount));
    if (planBaths.length && l.baths == null) l.baths = Math.min(...planBaths);
  }

  // Backfill anything the search row couldn't supply. This is mostly a no-op for
  // an already-rich `/apartment/` row, and it's the whole point for a Building
  // stub, whose card carried nothing but display strings.
  const detailRents = nums([
    d.price,
    d.priceRange?.min,
    ...(d.bedCountData ?? []).map((b) => b?.prices?.low),
  ]).filter(isRent);
  if (l.price == null && detailRents.length) l.price = Math.min(...detailRents);
  if (l.beds == null) l.beds = d.bedRange?.min ?? null;
  if (!l.title && d.name) l.title = d.name;
  if (d.propertyType && (raw.rowType === "Building" || !l.propertyType)) {
    l.propertyType = d.propertyType.toLowerCase();
  }
  for (const [key, value] of Object.entries({
    amenitiesHighlighted: d.amenitiesHighlighted?.length ? d.amenitiesHighlighted : null,
    uniqueHighlights: d.uniqueHighlights?.length ? d.uniqueHighlights : null,
    propertyManager: d.propertyManagementCompany?.name ?? null,
    phone: d.phoneDesktopText ?? null,
    unitsAvailableText: d.unitsAvailableText ?? null,
    availabilityStatus: d.availabilityStatus ?? null,
    officeHours: d.officeHours?.length ? d.officeHours : null,
    dealsText: d.dealsText ?? null,
    specialTerms: d.specialTerms ?? null,
    verified: d.verified ?? null,
    feedSource: d.tplsource ?? null,
    updatedAt: d.updatedAt ?? null,
    unitName: d.unitName ?? null,
    buildingUnitIds: d.buildingUnitIds?.length ? d.buildingUnitIds : null,
  })) {
    if (value != null && raw[key] == null) raw[key] = value;
  }

  const photos = photoUrls(d);
  if (photos.length) raw.photos = photos;

  const description = d.description?.slice(0, MAX_DESCRIPTION) ?? null;
  if (description) raw.description = description;
  raw.totalUnits = d.totalUnits ?? raw.totalUnits ?? null;
  if (typeof d.unitsAvailable === "number") raw.unitsAvailable = d.unitsAvailable;
  raw.sqftMin = d.squareFeetRange?.min ?? raw.sqftMin ?? null;
  raw.sqftMax = d.squareFeetRange?.max ?? raw.sqftMax ?? null;

  raw.amenitiesDetailed = d.amenitiesWithSubcategories?.length
    ? d.amenitiesWithSubcategories
    : null;
  raw.amenityCodes = d.amenitySearchFields?.length ? d.amenitySearchFields : null;
  raw.propertyVibes = d.propertyVibes?.length ? d.propertyVibes : null;
  raw.petPolicies = d.petPolicies?.length ? d.petPolicies : null;
  raw.parking = d.parking?.length ? d.parking : null;
  raw.fees = d.fees ?? null;
  raw.internetServices = d.internetServices?.length ? d.internetServices : null;
  raw.walkScore = d.walkScore?.walk?.score ?? null;
  raw.bikeScore = d.walkScore?.bike?.score ?? null;
  raw.transitScore = d.walkScore?.transit?.score ?? null;
  raw.schools = d.schools?.length ? d.schools.slice(0, MAX_SCHOOLS) : null;
  raw.rentEstimates = d.redfinRentalEstimates?.length
    ? d.redfinRentalEstimates.slice(0, MAX_RENT_ESTIMATES).map((e) => ({
        unit: e.addressInfo?.unitNumber ?? null,
        beds: e.beds ?? null,
        baths: e.baths ?? null,
        sqft: e.sqft ?? null,
        rentEstimate: e.rentEstimate ?? null,
      }))
    : null;
  raw.disclaimer = d.disclaimer ?? null;
  if (d.website && !raw.website) raw.website = d.website;
  if (d.applicationUrl && !raw.applicationUrl) raw.applicationUrl = d.applicationUrl;
  raw.enriched = true;

  // Fold the deep text into the searchable amenity facet so `find --match` sees it.
  const extra = [
    description,
    ...(d.amenitiesWithSubcategories ?? []).map((a) => a?.amenity),
    ...(d.amenitySearchFields ?? []),
    ...(d.propertyVibes ?? []).map((v) => [v?.category, v?.context].filter(Boolean).join(" ")),
    ...(d.petPolicies ?? []).map((p) => String(p?.label ?? "")),
    ...(d.parking ?? []).map((p) => String(p?.label ?? p?.type ?? "")),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (extra) raw.amenities = `${String(raw.amenities ?? "")} ${extra}`.trim();
}
