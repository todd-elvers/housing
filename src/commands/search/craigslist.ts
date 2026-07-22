import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { fetchJson } from "../../core/http.ts";
import { facet } from "../../core/facet.ts";
import type { RawListing } from "../../core/types.ts";

// Craigslist SF Bay `sapi` (search API) — the JSON backend behind
// sfbay.craigslist.org/search/apa. Free, no key, but the endpoint 403s
// datacenter IPs (needs a residential IP). Be gentle: one retry, a single
// request per run — aggressive hammering gets the IP banned.
//
// Response shape (verified live 2026-07):
//   data.items[]                — compact POSITIONAL arrays, decoded via data.decode
//   data.categoryAbbr           — "apa" (the category segment of a detail-page URL)
//   data.totalResultCount       — total matches (endpoint returns ≤360 per request)
//   data.decode.minPostingId    — base for the per-item postingId delta (it[0])
//   data.decode.minPostedDate   — base epoch-SECONDS for the postedDate delta (it[1])
//   data.decode.locations[]     — [0, [type,"sfbay",subcode], …] — the 7 Bay subareas
//   data.decode.locationDescriptions[] — display place names (city- or hood-level)
//   data.decode.neighborhoods[] — fine-grained neighborhood names
//
// Each item array (indices 0-5 fixed, then tagged sub-arrays + the bare title):
//   [0] postingId delta   [1] postedDate delta (s)   [2] =1 (unused)
//   [3] price (−1 ⇒ no price)   [4] location string   [5] base36 post code
//   tagged: [6,slug]  [5,beds,sqft]  [10,"$price"]  [4,…imageTokens]  [13,hash]
// The location string has TWO shapes, both `~lat~lon`-suffixed:
//   "sub:desc:nbhd~lat~lon"  (fine — nbhd → neighborhoods, e.g. "bayview")
//   "sub:desc~lat~lon"       (coarse — desc → locationDescriptions, e.g. "San Jose")
// First field always indexes decode.locations (→ URL subarea); second always
// indexes locationDescriptions; the optional third indexes neighborhoods.
// Baths are NOT structured by Craigslist — parsed from the title.
const SAPI_BASE = "https://sapi.craigslist.org/web/v8/postings/search/full";
const HOST = "sfbay"; // SF Bay area site (areaId / batch cluster = 1)
const CLUSTER = 1;
// The endpoint returns up to 360 matches per request, and its batch "cursor" is
// broken (later pages just repeat the first). So to go past 360 we KEYSET-paginate
// by price: sort priceasc and walk `min_price` up to the last price seen, deduping
// by post id. Gentle + capped — craigslist bans hammering. Note the API's
// totalResultCount is inflated by reposts; the real returnable set is far smaller.
const MAX_LISTINGS = 360; // per-request page size
const MAX_TOTAL = 1500; // overall cap across paged requests
const MAX_PAGES = 8; // safety bound on requests per fetch
const PAGE_PACE_MS = 1200; // gap between paged requests

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Decode {
  minPostingId?: number;
  minPostedDate?: number;
  locations?: unknown[];
  locationDescriptions?: unknown[];
  neighborhoods?: unknown[];
}
interface SapiResponse {
  data?: {
    items?: unknown[][];
    categoryAbbr?: string;
    totalResultCount?: number;
    decode?: Decode;
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const truthy = (v: string): boolean => /^(1|true|yes|on)$/i.test(v.trim());
function setNum(p: URLSearchParams, key: string, v: number | undefined): void {
  if (typeof v === "number" && Number.isFinite(v)) p.set(key, String(v));
}

export default defineSource({
  name: "craigslist",
  summary:
    "Craigslist SF Bay apartments/housing (sapi JSON) — the highest-volume, lowest-latency NEW-listing feed; free, no key.",
  when: "Use for the freshest private-landlord/sublet listings across the Bay Area (up to 360 newest per run). Requires a residential IP (datacenter IPs are 403'd). Pass --minPrice/--maxBeds/--query/etc. for ad-hoc searches; add --no-postedToday to search the full backlog instead of just today.",
  snapshotComplete: false, // "posted today" feed by default — absence ≠ removed
  // All optional: `ingest` runs with none set (env config drives the standing
  // feed); an operator/LLM passes any combination to `search craigslist`.
  input: z.object({
    query: z.string().optional().describe('Keyword filter, e.g. "in-law" or "no fee"'),
    minPrice: z.coerce.number().int().min(0).optional().describe("Minimum monthly rent (USD)"),
    maxPrice: z.coerce.number().int().min(0).optional().describe("Maximum monthly rent (USD)"),
    minBeds: z.coerce
      .number()
      .int()
      .min(0)
      .max(12)
      .optional()
      .describe("Minimum bedrooms (0 = studio)"),
    maxBeds: z.coerce.number().int().min(0).max(12).optional().describe("Maximum bedrooms"),
    minBaths: z.coerce.number().int().min(0).max(12).optional().describe("Minimum bathrooms"),
    maxBaths: z.coerce.number().int().min(0).max(12).optional().describe("Maximum bathrooms"),
    minSqft: z.coerce.number().int().min(0).optional().describe("Minimum square feet"),
    maxSqft: z.coerce.number().int().min(0).optional().describe("Maximum square feet"),
    hasImage: z.coerce.boolean().optional().describe("Only listings that include photos"),
    postedToday: z.coerce
      .boolean()
      .optional()
      .describe(
        "Restrict to today's new posts (default on — the fresh feed; --no-postedToday for the backlog)",
      ),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_TOTAL)
      .optional()
      .describe(`Max listings to return across paged requests (1-${MAX_TOTAL})`),
  }),
  requires: {
    CRAIGSLIST_SEARCH_PATH: envSpec(
      z.string().default("apa"),
      "Craigslist search category (apa = apartments/housing for rent)",
      "",
    ),
    CRAIGSLIST_QUERY: envSpec(
      z.string().default(""),
      "Default keyword filter for the standing `ingest` feed (blank = none)",
      "",
    ),
    CRAIGSLIST_POSTED_TODAY: envSpec(
      z.string().default("1"),
      "Restrict the ingest feed to today's posts: 1/true = on (default), 0/false = full backlog",
      "",
    ),
    CRAIGSLIST_MAX_LISTINGS: envSpec(
      z.coerce.number().int().min(1).max(MAX_TOTAL).default(MAX_TOTAL),
      `Default max listings per ingest run (1-${MAX_TOTAL})`,
      "",
    ),
  },
  async fetch(env, { input, log }): Promise<RawListing[]> {
    const searchPath = env.CRAIGSLIST_SEARCH_PATH || "apa";
    const postedToday = input.postedToday ?? truthy(env.CRAIGSLIST_POSTED_TODAY);
    const query = input.query ?? (env.CRAIGSLIST_QUERY || undefined);
    const limit = Math.min(input.limit ?? env.CRAIGSLIST_MAX_LISTINGS, MAX_TOTAL);

    // Filter params, sorted price-ascending so we can keyset-paginate on min_price.
    const makeParams = (minPrice?: number): string => {
      const p = new URLSearchParams({ cc: "US", lang: "en", searchPath, sort: "priceasc" });
      p.set("batch", `${CLUSTER}-0-${MAX_LISTINGS}-1-0`);
      if (postedToday) p.set("postedToday", "1");
      if (query) p.set("query", query);
      setNum(p, "min_price", minPrice ?? input.minPrice);
      setNum(p, "max_price", input.maxPrice);
      setNum(p, "min_bedrooms", input.minBeds);
      setNum(p, "max_bedrooms", input.maxBeds);
      setNum(p, "min_bathrooms", input.minBaths);
      setNum(p, "max_bathrooms", input.maxBaths);
      setNum(p, "minSqft", input.minSqft);
      setNum(p, "maxSqft", input.maxSqft);
      if (input.hasImage) p.set("hasPic", "1");
      return p.toString();
    };

    const out: RawListing[] = [];
    const seen = new Set<string>();
    let cursor: number | undefined = input.minPrice; // price keyset cursor
    let total = 0;

    for (let page = 0; page < MAX_PAGES && out.length < limit; page++) {
      if (page > 0) await sleep(PAGE_PACE_MS); // gentle — craigslist bans hammering
      let body: SapiResponse;
      try {
        body = await fetchJson<SapiResponse>(`${SAPI_BASE}?${makeParams(cursor)}`, {
          headers: {
            referer: `https://${HOST}.craigslist.org/search/${searchPath}`,
            accept: "application/json",
          },
          retries: 1,
          timeoutMs: 20_000,
        });
      } catch (err) {
        if (out.length > 0) {
          log.info(`craigslist: page ${page + 1} failed (${String(err)}); returning ${out.length}`);
          break;
        }
        throw enrich(err); // first page failed — likely a 403 on a datacenter IP
      }

      const data = body.data;
      const items = Array.isArray(data?.items) ? data.items : [];
      const decode: Decode = data?.decode ?? {};
      const category = data?.categoryAbbr || searchPath;
      total = data?.totalResultCount ?? total;

      let maxPrice = cursor ?? 0;
      let added = 0;
      for (const it of items) {
        const listing = decodeItem(it, decode, category);
        if (!listing) continue;
        if (listing.price != null && listing.price > maxPrice) maxPrice = listing.price;
        if (seen.has(listing.sourceId)) continue;
        seen.add(listing.sourceId);
        out.push(listing);
        added++;
        if (out.length >= limit) break;
      }
      if (page > 0) log.info(`craigslist: page ${page + 1} +${added} (${out.length} so far)`);

      // A short page means we've exhausted what craigslist will return.
      if (items.length < MAX_LISTINGS || out.length >= limit) break;
      // Advance the price cursor; bump past a same-price cluster to avoid stalling.
      cursor = maxPrice > (cursor ?? -1) ? maxPrice : (cursor ?? 0) + 1;
    }

    if (typeof total === "number" && total > out.length) {
      log.info(
        `craigslist: ${out.length} unique (craigslist claims ${total}, inflated by reposts)`,
      );
    }
    return out;
  },
});

function decodeItem(it: unknown[], decode: Decode, category: string): RawListing | null {
  const minId = num(decode.minPostingId);
  const idDelta = num(it[0]);
  if (minId == null || idDelta == null) return null; // can't form a stable id — skip
  const pid = minId + idDelta;

  const minDate = num(decode.minPostedDate);
  const dateDelta = num(it[1]);
  const postedAt = minDate != null && dateDelta != null ? (minDate + dateDelta) * 1000 : null;

  const rawPrice = num(it[3]);
  const price = rawPrice != null && rawPrice >= 0 ? rawPrice : null; // −1 ⇒ no price

  // Location string: "sub:desc[:nbhd]~lat~lon". First field → subarea (URL path);
  // second → locationDescriptions (city-level); optional third → neighborhoods (fine).
  let lat: number | null = null;
  let lon: number | null = null;
  let subIdx: number | null = null;
  let descIdx: number | null = null;
  let nbIdx: number | null = null;
  const [idxPart, latStr, lonStr] = String(it[4] ?? "").split("~");
  if (idxPart) {
    const parts = idxPart.split(":").map(Number);
    if (Number.isFinite(parts[0])) subIdx = parts[0];
    if (Number.isFinite(parts[1])) descIdx = parts[1];
    if (parts.length >= 3 && Number.isFinite(parts[2])) nbIdx = parts[2];
    const latN = Number(latStr);
    const lonN = Number(lonStr);
    if (latStr && Number.isFinite(latN)) lat = latN;
    if (lonStr && Number.isFinite(lonN)) lon = lonN;
  }

  let slug = "";
  let title = "";
  let beds: number | null = null;
  let sqft: number | null = null;
  let imageUrls: string[] = [];
  for (let i = 6; i < it.length; i++) {
    const el = it[i];
    if (typeof el === "string") {
      title = el;
    } else if (Array.isArray(el)) {
      if (el[0] === 6) slug = String(el[1] ?? "");
      else if (el[0] === 5) {
        const b = num(el[1]);
        beds = b != null && b >= 0 ? b : null;
        const s = num(el[2]);
        sqft = s != null && s > 0 ? s : null;
      } else if (el[0] === 4) {
        // Image tokens "<sizePrefix>:<token>" → images.craigslist.org/<token>_600x450.jpg
        imageUrls = el
          .slice(1)
          .filter((t): t is string => typeof t === "string")
          .slice(0, 6)
          .map((t) => {
            const token = t.includes(":") ? t.slice(t.indexOf(":") + 1) : t;
            return `https://images.craigslist.org/${token}_600x450.jpg`;
          });
      }
    }
  }

  // Craigslist has no structured bath field, but titles usually encode it
  // ("3BR / 3BA", "2.5 bath"). Match the full fraction (not a single decimal digit,
  // which backtracks "1.25 ba" → 25) and cap implausible counts so address tokens
  // like "24 Bath St" don't become bath/bed counts.
  const bathMatch = title.match(/(\d+(?:\.\d+)?)\s*(?:ba\b|baths?\b)/i);
  let baths = bathMatch ? Number(bathMatch[1]) : null;
  if (baths != null && (baths <= 0 || baths > 10)) baths = null;
  if (beds == null) {
    const bedMatch = title.match(/(\d+(?:\.\d+)?)\s*(?:br\b|bd\b|beds?\b)/i);
    if (bedMatch) {
      const n = Number(bedMatch[1]);
      beds = n > 0 && n <= 12 ? n : null;
    }
  }

  const locations = Array.isArray(decode.locations) ? decode.locations : [];
  const loc = subIdx != null ? locations[subIdx] : undefined;
  const area = Array.isArray(loc) ? (str(loc[1]) ?? HOST) : HOST;
  const sub = Array.isArray(loc) ? str(loc[2]) : null;

  // Prefer the fine neighborhood; fall back to the city-level description.
  const nbTable = Array.isArray(decode.neighborhoods) ? decode.neighborhoods : [];
  const descTable = Array.isArray(decode.locationDescriptions) ? decode.locationDescriptions : [];
  const neighborhood =
    (nbIdx != null ? str(nbTable[nbIdx]) : null) ??
    (descIdx != null ? str(descTable[descIdx]) : null);

  const path = slug || "listing";
  const url = sub
    ? `https://${area}.craigslist.org/${sub}/${category}/d/${path}/${pid}.html`
    : `https://${area}.craigslist.org/${category}/d/${path}/${pid}.html`;

  const amenities = `${title} ${neighborhood ?? ""}`.trim().toLowerCase();
  return {
    sourceId: String(pid),
    url,
    title: title || null,
    address: null,
    city: null,
    neighborhood,
    lat,
    lon,
    price,
    beds,
    baths,
    sqft,
    propertyType: null,
    postedAt,
    // Fold the mutable fields so a real re-post edit flips "changed".
    changeTag: `${price ?? ""}|${beds ?? ""}|${baths ?? ""}|${sqft ?? ""}`,
    raw: {
      ...facet({
        minBeds: beds,
        maxBeds: beds,
        minBaths: baths,
        maxBaths: baths,
        minPrice: price,
        maxPrice: price,
        amenities,
      }),
      postId: String(pid),
      subarea: sub,
      neighborhood,
      imageUrls,
    },
  };
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));
function enrich(err: unknown): Error {
  const msg = errMsg(err);
  if (/\b403\b/.test(msg)) {
    return new Error(
      `craigslist: ${msg} — sapi 403s datacenter IPs; run from a residential IP/VPN`,
    );
  }
  return err instanceof Error ? err : new Error(msg);
}
