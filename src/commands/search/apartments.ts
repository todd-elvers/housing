import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { httpFetch, stripJsonGuard } from "../../core/http.ts";
import { facet } from "../../core/facet.ts";
import type { RawListing } from "../../core/types.ts";

// Apartments.com (CoStar) — the biggest UNIQUE SF multifamily inventory, behind
// Akamai+DataDome. Reached via the Apify actor `pro100chok/apartments-scraper-usage`
// (~$2/1k results). Tier 2 = paid, key-gated.
//
// The actor has THREE actions (verified against its live input schema):
//   • search  — crawl an apartments.com search URL, return a list of {listingId,url}
//               (NO building detail — just the URLs).
//   • details — scrape those listing URLs, return the RICH building record
//               (name, address, location, pricing.min/max, rentals[] units with
//               Beds/Baths/Rent, models[] floor plans, amenities, scores, …).
//   • emails  — contact extraction (not used here).
// So a useful run is TWO steps: search → collect URLs → details. (A prior version
// called only `search` and mapped fields that action never returns, yielding empty
// listings.) Beds/baths live in `rentals[]`, not `models[]`.
const ACTOR = "pro100chok~apartments-scraper-usage";
const RUN_SYNC = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;
const DEFAULT_SEARCH_URL = "https://www.apartments.com/apartments/san-francisco-ca/";

interface SearchItem {
  listingId?: string;
  url?: string;
}
interface DetailItem {
  listingId?: string;
  url?: string;
  name?: string;
  propertyType?: string;
  address?: {
    full?: string;
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
    neighborhood?: string;
  };
  location?: { latitude?: number; longitude?: number };
  pricing?: { min?: number; max?: number; currency?: string };
  rating?: { value?: number; count?: number };
  scores?: { walkScore?: number; transitScore?: number };
  rentals?: { Beds?: number; Baths?: number; Rent?: number; SqFt?: number }[];
  models?: {
    name?: string;
    rentMin?: number;
    rentMax?: number;
    sqftMin?: number;
    sqftMax?: number;
  }[];
  amenities?: Record<string, unknown>;
  description?: string;
  media?: { photoCount?: number };
}

const splitUrls = (s: string | undefined): string[] =>
  (s ?? "")
    .split(/[;\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);

export default defineSource({
  name: "apartments",
  summary:
    "Apartments.com (CoStar) via Apify — the biggest unique SF multifamily inventory (buildings, floor plans, per-unit beds/baths/rent, amenities, walk/transit scores).",
  when: "Use for broad multifamily coverage the free portals miss, or to deep-scrape specific buildings (--listingUrls). Paid (~$2/1k via Apify) and slow (managed anti-bot, two-step scrape).",
  snapshotComplete: false,
  tier: 2,
  input: z.object({
    url: z
      .string()
      .optional()
      .describe(`Apartments.com search URL to crawl (default: ${DEFAULT_SEARCH_URL})`),
    listingUrls: z
      .string()
      .optional()
      .describe(
        "Semicolon/space-separated apartments.com listing URLs to scrape directly (skips the search step)",
      ),
    maxItems: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Max buildings to scrape detail for"),
    maxPages: z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max search-result pages to crawl for listing URLs"),
    concurrency: z.coerce.number().int().min(1).max(50).optional().describe("Actor concurrency"),
  }),
  requires: {
    APIFY_TOKEN: envSpec(
      z.string().min(1),
      "Apify API token",
      "https://console.apify.com/account/integrations",
    ),
    APARTMENTS_SEARCH_URL: envSpec(
      z.string().default(DEFAULT_SEARCH_URL),
      "Default apartments.com search URL crawled by `ingest`",
      "",
    ),
    APARTMENTS_MAX_ITEMS: envSpec(
      z.coerce.number().int().min(1).max(1000).default(120),
      "Max buildings to scrape detail for per run",
      "",
    ),
    APARTMENTS_MAX_PAGES: envSpec(
      z.coerce.number().int().min(1).max(50).default(3),
      "Max search-result pages to crawl for listing URLs",
      "",
    ),
  },
  async fetch(env, { input, log }): Promise<RawListing[]> {
    const token = env.APIFY_TOKEN;
    const maxItems = input.maxItems ?? env.APARTMENTS_MAX_ITEMS;
    const maxPages = input.maxPages ?? env.APARTMENTS_MAX_PAGES;
    const concurrency = input.concurrency ?? 10;

    // Step 1: resolve the listing URLs — either given directly, or via a search crawl.
    let urls = splitUrls(input.listingUrls);
    if (urls.length === 0) {
      const searchUrl = input.url ?? env.APARTMENTS_SEARCH_URL;
      log.info(`apartments: Apify search (managed anti-bot — can take a few minutes)…`);
      // NB: the `search` action returns 0 results if maxItems is omitted — it must be sent.
      const found = await runActor<SearchItem>(token, {
        action: "search",
        startUrls: [{ url: searchUrl }],
        maxItems,
        maxPages,
        concurrency,
      });
      urls = found.map((f) => f.url).filter((u): u is string => Boolean(u));
      log.info(`apartments: search found ${urls.length} listing URLs`);
    }
    urls = [...new Set(urls)].slice(0, maxItems);
    if (urls.length === 0) return [];

    // Step 2: scrape the rich building detail for those URLs.
    log.info(`apartments: Apify detail scrape for ${urls.length} buildings (a few minutes)…`);
    const details = await runActor<DetailItem>(token, {
      action: "details",
      listingUrls: urls.map((url) => ({ url })),
      maxItems,
      concurrency,
    });
    log.info(`apartments: detailed ${details.length}/${urls.length} buildings`);
    const seen = new Set<string>();
    const out: RawListing[] = [];
    for (const it of details) {
      const listing = map(it);
      if (!listing || seen.has(listing.sourceId)) continue;
      seen.add(listing.sourceId);
      out.push(listing);
    }
    return out;
  },
});

/** POST an actor run synchronously and return its dataset items. Never retried (paid). */
async function runActor<T>(token: string, inputBody: Record<string, unknown>): Promise<T[]> {
  // Token goes in the Authorization header, NOT the URL (URLs land in logs/history).
  const res = await httpFetch(RUN_SYNC, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(inputBody),
    timeoutMs: 290_000, // run-sync can take minutes
    retries: 0, // never re-run a paid actor
  });
  if (!res.ok) throw new Error(`apify apartments (${inputBody.action}) → HTTP ${res.status}`);
  const items = JSON.parse(stripJsonGuard(await res.text())) as T[];
  return Array.isArray(items) ? items : [];
}

function nums(xs: (number | undefined)[]): number[] {
  return xs.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
}

function map(it: DetailItem): RawListing | null {
  const url = it.url;
  const sourceId = it.listingId || url || it.name || "";
  if (!sourceId) return null;

  // Beds/baths live per-unit in rentals[]; sqft in models[] (or rentals[].SqFt).
  const rentals = Array.isArray(it.rentals) ? it.rentals : [];
  const models = Array.isArray(it.models) ? it.models : [];
  const beds = nums(rentals.map((r) => r.Beds));
  const baths = nums(rentals.map((r) => r.Baths));
  const sqfts = nums([...models.map((m) => m.sqftMin), ...rentals.map((r) => r.SqFt)]).filter(
    (n) => n >= 100 && n <= 20000,
  );
  const minBeds = beds.length ? Math.min(...beds) : null;
  const maxBeds = beds.length ? Math.max(...beds) : null;
  const minBaths = baths.length ? Math.min(...baths) : null;
  const maxBaths = baths.length ? Math.max(...baths) : null;
  // Monthly-rent sanity window: the feed mixes junk into rent fields (0/unavailable,
  // fees like $25, annualized or deposit figures like $300k) that would otherwise blow
  // out the range. Prefer the building's advertised pricing.min/max; fall back to sane
  // per-unit rents from rentals[]/models[].
  const isRent = (n: number) => n >= 300 && n <= 60000;
  const unitRents = nums([
    ...rentals.map((r) => r.Rent),
    ...models.map((m) => m.rentMin),
    ...models.map((m) => m.rentMax),
  ]).filter(isRent);
  const pMin =
    typeof it.pricing?.min === "number" && isRent(it.pricing.min)
      ? it.pricing.min
      : unitRents.length
        ? Math.min(...unitRents)
        : null;
  const pMax =
    typeof it.pricing?.max === "number" && isRent(it.pricing.max)
      ? it.pricing.max
      : unitRents.length
        ? Math.max(...unitRents)
        : null;
  const minPrice = pMin;
  const maxPrice = pMax ?? pMin;

  // Shape-robust amenity text (categories→list or name→bool) + description, for LIKE matching.
  const amenities = JSON.stringify({
    a: it.amenities ?? {},
    d: it.description ?? "",
  }).toLowerCase();

  return {
    sourceId,
    url: url || DEFAULT_SEARCH_URL,
    title: it.name || it.address?.full || null,
    address: it.address?.full || it.address?.street || null,
    city: it.address?.city ?? "San Francisco",
    neighborhood: it.address?.neighborhood ?? null,
    lat: it.location?.latitude ?? null,
    lon: it.location?.longitude ?? null,
    price: minPrice,
    beds: minBeds,
    baths: minBaths,
    sqft: sqfts.length ? Math.min(...sqfts) : null,
    propertyType: it.propertyType ?? "apartments-com",
    changeTag: `${minPrice ?? ""}|${maxPrice ?? ""}|${rentals.length}`,
    raw: {
      ...facet({
        buildingName: it.name ?? null,
        minBeds,
        maxBeds,
        minBaths,
        maxBaths,
        minPrice,
        maxPrice,
        amenities,
      }),
      unitsAvailable: rentals.length,
      floorPlans: models.length,
      rating: it.rating?.value ?? null,
      walkScore: it.scores?.walkScore ?? null,
      transitScore: it.scores?.transitScore ?? null,
      photoCount: it.media?.photoCount ?? null,
    },
  };
}
