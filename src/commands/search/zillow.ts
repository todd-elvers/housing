import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { fetchJson } from "../../core/http.ts";
import { facet } from "../../core/facet.ts";
import type { RawListing } from "../../core/types.ts";

// Zillow — the dominant SF portal, otherwise behind PerimeterX/HUMAN. Reached via
// the RapidAPI "zillow-property-data1" API: an ASYNC bulk scraper/enricher that
// takes five input modes (free-text search, zipcodes, zpids, addresses, listing/
// search URLs), scrapes the matching Zillow detail pages behind residential
// proxies, and returns a rich per-property record (price, beds/baths, rent +
// sale zestimates, price/tax history, schools, images, description, …).
//
// Flow: POST /v1/properties returns a job_id instantly; poll GET /v1/results/{id}
// every few seconds until status is "complete"/"failed". Tier 2 = paid, key-gated.
//
// Field-tested quirks baked into the defaults below:
//  • `type` is only reliably honored for URL scrapes — broad search/zipcode
//    discovery returns mostly FOR_SALE inventory regardless of type. We still
//    send it (it's the API's documented filter) and record home_status per row.
//  • Rental *search-page* URLs (zillow.com/.../rentals/) are frequently
//    PerimeterX-blocked; zpid / address / listing-URL lookups are reliable.
const HOST = "zillow-property-data1.p.rapidapi.com";
const POLL_INTERVAL_MS = 4_000;
const POLL_TIMEOUT_MS = 180_000; // scrapes run behind proxies; large jobs take a while

const LISTING_TYPES = ["all", "sale", "fsbo", "rent", "sold"] as const;

/** One property record inside a completed job's `results[]`. */
interface ZProperty {
  zpid?: number;
  url?: string;
  street_address?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  latitude?: number;
  longitude?: number;
  price?: number | null;
  last_sold_price?: number | null;
  currency?: string;
  zestimate?: number | null;
  rent_zestimate?: number | null;
  tax_assessed_value?: number | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  living_area?: number | null;
  lot_size?: number | null;
  year_built?: number | null;
  property_type?: string | null;
  home_status?: string | null;
  hoa_fee?: number | null;
  days_on_zillow?: number | null;
  description?: string | null;
  interior_features?: string[];
  exterior_features?: string[];
  image_urls?: string[];
}
interface ZResult {
  url?: string;
  success?: boolean;
  zpid?: number;
  blocked?: boolean;
  error?: string;
  property?: ZProperty | null;
}
interface ZJob {
  job_id?: string;
  status?: "processing" | "complete" | "failed";
  results?: ZResult[];
  errors?: { error?: string }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Split a delimited CLI string into trimmed, non-empty tokens. */
function splitList(s: string | undefined, sep: RegExp): string[] {
  if (!s) return [];
  return s
    .split(sep)
    .map((t) => t.trim())
    .filter(Boolean);
}
const toInts = (s: string | undefined): number[] =>
  splitList(s, /,/).map(Number).filter(Number.isFinite);

export default defineSource({
  name: "zillow",
  summary:
    "Zillow property data via the RapidAPI zillow-property-data1 async API — rich per-property detail (price, beds/baths, rent + sale zestimates, price/tax history, images) by search, zipcode, zpid, address, or URL.",
  when: "Use for the deepest Zillow per-property data or to look up specific homes (--zpids/--addresses/--urls). Paid (RapidAPI). Broad search/zipcode discovery skews FOR_SALE; pass a rentals search URL or type=rent for rentals.",
  snapshotComplete: false,
  tier: 2,
  // All optional: `ingest` runs with none set (env config drives the query);
  // an operator/LLM passes any combination to `search zillow` for ad-hoc lookups.
  input: z.object({
    search: z
      .string()
      .optional()
      .describe('Free-text location/query, e.g. "San Francisco, CA" or "Miami Beach FL"'),
    zipcodes: z.string().optional().describe("Comma-separated US ZIP codes, e.g. 94107,94103"),
    zpids: z
      .string()
      .optional()
      .describe("Comma-separated Zillow property IDs, e.g. 20794780,15149398"),
    addresses: z
      .string()
      .optional()
      .describe(
        'Semicolon-separated street addresses (they contain commas), e.g. "123 Main St, City, ST 12345; 456 Oak Ave, …"',
      ),
    urls: z
      .string()
      .optional()
      .describe("Semicolon/space-separated Zillow listing (_zpid) or search-page URLs"),
    type: z
      .enum(LISTING_TYPES)
      .optional()
      .describe("Listing type filter (most reliable on URL scrapes)"),
    maxItems: z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional()
      .describe("Max properties to return (1-1000)"),
  }),
  requires: {
    RAPIDAPI_KEY: envSpec(
      z.string().min(1),
      "RapidAPI key (X-RapidAPI-Key), subscribed to zillow-property-data1",
      "https://rapidapi.com/search/zillow-property-data1",
    ),
    ZILLOW_SEARCH: envSpec(
      z.string().default("San Francisco, CA"),
      "Default free-text search used by `ingest` (when no --search/--zpids/etc. given)",
      "",
    ),
    ZILLOW_TYPE: envSpec(
      z.enum(LISTING_TYPES).default("rent"),
      "Default listing type filter for `ingest` (all|sale|fsbo|rent|sold)",
      "",
    ),
    ZILLOW_MAX_ITEMS: envSpec(
      z.coerce.number().int().min(1).max(1000).default(200),
      "Default max properties per run",
      "",
    ),
  },
  async fetch(env, { input, log }): Promise<RawListing[]> {
    const headers = {
      "X-RapidAPI-Key": env.RAPIDAPI_KEY,
      "X-RapidAPI-Host": HOST,
      "content-type": "application/json",
    };

    // Assemble the request body from whichever input modes were supplied. If the
    // caller gave none (the `ingest` path), fall back to the env default search.
    const zipcodes = toInts(input.zipcodes);
    const zpids = toInts(input.zpids);
    const addresses = splitList(input.addresses, /;/);
    const urls = splitList(input.urls, /[;\s]+/);
    const body: Record<string, unknown> = {
      type: input.type ?? env.ZILLOW_TYPE,
      max_items: input.maxItems ?? env.ZILLOW_MAX_ITEMS,
    };
    if (input.search) body.search = input.search;
    if (zipcodes.length) body.zipcodes = zipcodes;
    if (zpids.length) body.zpids = zpids;
    if (addresses.length) body.addresses = addresses;
    if (urls.length) body.urls = urls;
    const hasQuery = Boolean(
      input.search || zipcodes.length || zpids.length || addresses.length || urls.length,
    );
    if (!hasQuery) body.search = env.ZILLOW_SEARCH;

    const results = await submitAndPoll(body, headers, log);
    const out: RawListing[] = [];
    const seen = new Set<string>();
    for (const r of results) {
      const listing = map(r);
      if (!listing || seen.has(listing.sourceId)) continue;
      seen.add(listing.sourceId);
      out.push(listing);
    }
    return out;
  },
});

/** POST the async job, then poll results until complete/failed or timeout. */
async function submitAndPoll(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  log: { info(m: string): void },
): Promise<ZResult[]> {
  // Never retry the POST — re-submitting bills a second paid job.
  const submit = await fetchJson<ZJob>(`https://${HOST}/v1/properties`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    retries: 0,
    timeoutMs: 30_000,
  });
  if (submit.status === "complete") return submit.results ?? [];
  const jobId = submit.job_id;
  if (!jobId) throw new Error(`zillow: no job_id returned (status=${submit.status ?? "?"})`);

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    // Polling a job is an idempotent read (not a re-scrape) — safe to retry.
    const job = await fetchJson<ZJob>(`https://${HOST}/v1/results/${jobId}`, {
      headers,
      retries: 2,
      timeoutMs: 30_000,
    });
    if (job.status === "complete") {
      const errs = (job.errors ?? []).map((e) => e.error).filter(Boolean);
      if (!job.results?.length && errs.length) {
        throw new Error(`zillow: job returned no properties — ${errs.join("; ")}`);
      }
      return job.results ?? [];
    }
    if (job.status === "failed") {
      const errs = (job.errors ?? []).map((e) => e.error).filter(Boolean);
      throw new Error(`zillow: job failed — ${errs.join("; ") || "unknown error"}`);
    }
    log.info(`zillow: job ${jobId} still processing…`);
  }
  throw new Error(`zillow: job ${jobId} did not complete within ${POLL_TIMEOUT_MS / 1000}s`);
}

function map(r: ZResult): RawListing | null {
  const p = r.property;
  if (!p) return null;
  const detail = p.url ?? r.url ?? "";
  const url = detail.startsWith("http") ? detail : `https://www.zillow.com/`;
  const sourceId = String(p.zpid ?? r.zpid ?? detail ?? p.street_address ?? "");
  if (!sourceId) return null;
  const fullAddress =
    [p.street_address, p.city, p.state && p.zipcode ? `${p.state} ${p.zipcode}` : p.state]
      .filter(Boolean)
      .join(", ") || null;
  // Pre-flatten searchable text (features + description + status) for `find`'s LIKE match.
  const amenities = [
    ...(p.interior_features ?? []),
    ...(p.exterior_features ?? []),
    p.property_type ?? "",
    p.home_status ?? "",
    p.description ?? "",
  ]
    .join(" ")
    .toLowerCase();
  return {
    sourceId,
    url,
    title: p.street_address ?? fullAddress,
    address: fullAddress,
    city: p.city ?? null,
    lat: p.latitude ?? null,
    lon: p.longitude ?? null,
    // The listed price: monthly rent for FOR_RENT rows, sale price otherwise
    // (home_status, recorded below, disambiguates).
    price: typeof p.price === "number" ? p.price : null,
    beds: p.bedrooms ?? null,
    baths: p.bathrooms ?? null,
    sqft: p.living_area ?? null,
    propertyType: p.property_type ?? null,
    changeTag: `${p.price ?? ""}|${p.home_status ?? ""}|${p.rent_zestimate ?? ""}`,
    raw: {
      ...facet({
        minBeds: p.bedrooms ?? null,
        maxBeds: p.bedrooms ?? null,
        minBaths: p.bathrooms ?? null,
        maxBaths: p.bathrooms ?? null,
        minPrice: p.price ?? null,
        maxPrice: p.price ?? null,
        amenities,
      }),
      // Extra Zillow richness preserved for later enrichment / debugging.
      zpid: p.zpid ?? null,
      homeStatus: p.home_status ?? null,
      rentZestimate: p.rent_zestimate ?? null,
      zestimate: p.zestimate ?? null,
      hoaFee: p.hoa_fee ?? null,
      yearBuilt: p.year_built ?? null,
      daysOnZillow: p.days_on_zillow ?? null,
      imageUrl: p.image_urls?.[0] ?? null,
    },
  };
}
