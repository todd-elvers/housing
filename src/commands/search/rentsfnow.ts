import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { fetchText } from "../../core/http.ts";
import { facet } from "../../core/facet.ts";
import type { RawListing } from "../../core/types.ts";

// RentSFNow / Veritas Investments — the largest single private SF/Oakland
// portfolio (with some LA/Marin inventory). The site is a WordPress build whose
// live availability search is served by the "WP Advanced Search" plugin over
// admin-ajax: POST action=wpas_ajax_load returns an HTML fragment of the
// CURRENTLY-AVAILABLE units, paginated 12/page, each card carrying the WP post
// id, url, neighborhood, address, beds/baths/rent, pet policy and a hero image.
// The page's Google-Maps `markers` array gives per-building lat/lon we join back
// by building name. This is the real product feed (real rents), so it supersedes
// the old property-sitemap crawl (complete but stale — many 2019 lastmods, no
// price). Absence from the available set ⇒ no longer listed, so snapshotComplete.
//
// Field-tested quirks that drive the design below:
//  • There is a JSON API (/wp-json/catalyst/v1/units) but it is auth-gated for
//    anonymous callers ("Invalid username"); the wpas_ajax_load HTML fragment is
//    the only anonymously-reachable feed, so we parse that.
//  • The `city` form param filters reliably server-side (and cuts pages fetched),
//    but combining server-side filters is buggy (e.g. bedrooms+city silently
//    drops the bedrooms filter) and NO price param works. So `city` is the only
//    server-side filter; every other filter (neighborhood, beds, baths, price) is
//    applied client-side on the parsed cards, which is exact regardless of the
//    backend's quirks. The default (unfiltered) query reliably returns the full
//    available set, which is what `ingest` needs.
const BASE = "https://www.rentsfnow.com";
const AJAX = `${BASE}/wp-admin/admin-ajax.php`;
const PAGE_DELAY_MS = 250; // be gentle on a free WordPress endpoint

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Decode the handful of HTML entities the fragment actually emits. */
function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&quot;/g, '"')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** Un-escape a double-quoted JS string literal body (markers array names). */
function unescapeJs(s: string): string {
  return s.replace(/\\(['"\\])/g, "$1");
}

/** Normalize a building/city name to a stable comparison key. */
const nameKey = (s: string) =>
  decodeEntities(s)
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** "San Francisco" | "san francisco" → "san-francisco" (WP taxonomy slug). */
const toSlug = (s: string) =>
  decodeEntities(s)
    .toLowerCase()
    .replace(/[‘’']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Split a delimited CLI string into trimmed, non-empty tokens. */
function splitList(s: string | undefined, sep: RegExp): string[] {
  if (!s) return [];
  return s
    .split(sep)
    .map((t) => t.trim())
    .filter(Boolean);
}

interface Card {
  postId: string;
  url: string;
  title: string | null;
  neighborhood: string | null;
  beds: number | null;
  baths: number | null;
  price: number | null;
  pets: string[];
  imageUrl: string | null;
}

/** Parse "Studio \\ 0 Bath \\ $1,095" / "2 Beds \\ 1.5 Baths \\ $4,095". */
function parseInfo(rawInfo: string): {
  beds: number | null;
  baths: number | null;
  price: number | null;
} {
  const s = decodeEntities(rawInfo);
  const bedM = s.match(/(\d+)\s*Bed/i);
  const beds = bedM ? Number(bedM[1]) : /studio/i.test(s) ? 0 : null;
  const bathM = s.match(/(\d+(?:\.\d+)?)\s*Bath/i);
  const baths = bathM ? Number(bathM[1]) : null;
  const priceM = s.match(/\$\s*([\d,]+)/);
  const price = priceM ? Number(priceM[1].replace(/,/g, "")) : null;
  return { beds, baths, price };
}

/** building name (lowercased key) → [lat, lon] from the map `markers` array. */
function parseMarkers(html: string): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const block = html.match(/markers\s*=\s*\[([\s\S]*?)\];/);
  if (!block) return out;
  const re = /\[\s*"((?:[^"\\]|\\.)*)"\s*,\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/g;
  for (let m = re.exec(block[1]); m; m = re.exec(block[1])) {
    const key = nameKey(unescapeJs(m[1]));
    if (!out.has(key)) out.set(key, [Number(m[2]), Number(m[3])]);
  }
  return out;
}

/** Extract every unit card from one wpas_ajax_load HTML fragment. */
function parseCards(html: string): Card[] {
  const cards: Card[] = [];
  const re = /searchListingContainer"\s+id="post-(\d+)">([\s\S]*?)<!-- \.grid-x -->/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const postId = m[1];
    const body = m[2];
    const href = body.match(/href="(\/[^"]*\/rental\/[^"]+)"/);
    if (!href) continue;
    const h3 = body.match(/<h3>([^<]*)<\/h3>/);
    const h2 = body.match(/<h2>([^<]*)<\/h2>/);
    const info = body.match(/apartment-info">([\s\S]*?)<\/p>/);
    const img = body.match(/background-image:\s*url\('([^']+)'\)/);
    const pets = [...body.matchAll(/<li class="([^"]+)"><\/li>/g)].map((f) => f[1]);
    const parsed = info ? parseInfo(info[1]) : { beds: null, baths: null, price: null };
    cards.push({
      postId,
      url: `${BASE}${href[1]}`,
      title: h2 ? decodeEntities(h2[1]).trim() : null,
      neighborhood: h3 ? decodeEntities(h3[1]).trim() : null,
      beds: parsed.beds,
      baths: parsed.baths,
      price: parsed.price,
      pets,
      imageUrl: img ? img[1] : null,
    });
  }
  return cards;
}

/** Total result pages from the fragment's hidden last_page input (defaults 1). */
function parseLastPage(html: string): number {
  const m = html.match(/id="last_page"[^>]*value="(\d+)"|value="(\d+)"[^>]*id="last_page"/);
  const n = m ? Number(m[1] ?? m[2]) : 1;
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

async function fetchPage(page: number, city: string): Promise<string> {
  const params = new URLSearchParams({
    action: "wpas_ajax_load",
    type: "search",
    page: String(page),
  });
  if (city) params.set("city", city);
  return fetchText(AJAX, {
    method: "POST",
    body: params.toString(),
    headers: {
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      referer: `${BASE}/apartments/`,
      accept: "text/html, */*; q=0.01",
    },
    timeoutMs: 20_000,
    retries: 2,
  });
}

export default defineSource({
  name: "rentsfnow",
  summary:
    "RentSFNow / Veritas live availability feed — the largest single private SF/Oakland portfolio's currently-listed units with real rent, beds/baths, neighborhood and lat/lon.",
  when: "Use for real available rentals (with prices) from a big private-landlord portfolio; snapshot-complete (absence ⇒ delisted). Filter with --city/--neighborhood/--min-max beds/baths/price.",
  snapshotComplete: true,
  // All optional. `ingest` runs with none set (env config drives the fetch); an
  // operator/LLM passes any combination to `search rentsfnow`. Only --city is
  // pushed to the upstream form (reliable + cuts pages); everything else filters
  // the parsed cards client-side (the backend's other filters are unreliable).
  input: z.object({
    city: z
      .string()
      .optional()
      .describe(
        'City to fetch, name or slug, e.g. "San Francisco" / "oakland". Empty = all cities.',
      ),
    neighborhood: z
      .string()
      .optional()
      .describe('Comma-separated neighborhoods, name or slug, e.g. "Nob Hill,tenderloin"'),
    minBeds: z.coerce.number().min(0).optional().describe("Minimum bedrooms (0 = studio)"),
    maxBeds: z.coerce.number().min(0).optional().describe("Maximum bedrooms"),
    minBaths: z.coerce.number().min(0).optional().describe("Minimum bathrooms"),
    maxBaths: z.coerce.number().min(0).optional().describe("Maximum bathrooms"),
    minPrice: z.coerce.number().int().min(0).optional().describe("Minimum monthly rent (USD)"),
    maxPrice: z.coerce.number().int().min(0).optional().describe("Maximum monthly rent (USD)"),
    maxPages: z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max search pages to fetch (12 units/page)"),
    limit: z.coerce.number().int().min(1).optional().describe("Max listings to return"),
  }),
  requires: {
    RENTSFNOW_CITY: envSpec(
      z.string().default(""),
      "Default city slug for `ingest` (empty = all cities in the portfolio)",
      "",
    ),
    RENTSFNOW_MAX_PAGES: envSpec(
      z.coerce.number().int().min(1).max(50).default(10),
      "Default page cap per run (12 units/page)",
      "",
    ),
  },
  async fetch(env, { input, log }): Promise<RawListing[]> {
    const city = (input.city ?? env.RENTSFNOW_CITY) ? toSlug(input.city ?? env.RENTSFNOW_CITY) : "";
    const maxPages = input.maxPages ?? env.RENTSFNOW_MAX_PAGES;

    // Page 1 tells us how many pages there are; then walk the rest sequentially.
    const markers = new Map<string, [number, number]>();
    const cards: Card[] = [];
    const seen = new Set<string>();

    const first = await fetchPage(1, city);
    const lastPage = parseLastPage(first);
    const collect = (html: string) => {
      for (const [k, v] of parseMarkers(html)) if (!markers.has(k)) markers.set(k, v);
      for (const c of parseCards(html)) {
        if (seen.has(c.postId)) continue;
        seen.add(c.postId);
        cards.push(c);
      }
    };
    collect(first);

    const pages = Math.min(lastPage, maxPages);
    for (let p = 2; p <= pages; p++) {
      await sleep(PAGE_DELAY_MS);
      collect(await fetchPage(p, city));
    }
    if (lastPage > maxPages) {
      log.info(
        `rentsfnow: ${lastPage} pages available, fetched ${pages} (raise RENTSFNOW_MAX_PAGES)`,
      );
    }

    // Client-side filters (exact, unlike the backend's).
    const hoodSlugs = new Set(splitList(input.neighborhood, /,/).map(toSlug));
    const inRange = (v: number | null, min?: number, max?: number) =>
      v == null ? min == null : (min == null || v >= min) && (max == null || v <= max);

    const out: RawListing[] = [];
    for (const c of cards) {
      if (hoodSlugs.size && !(c.neighborhood && hoodSlugs.has(toSlug(c.neighborhood)))) continue;
      if (!inRange(c.beds, input.minBeds, input.maxBeds)) continue;
      if (!inRange(c.baths, input.minBaths, input.maxBaths)) continue;
      if (!inRange(c.price, input.minPrice, input.maxPrice)) continue;

      const buildingName = c.title ? c.title.split("#")[0].trim() : null;
      const latlon = buildingName ? markers.get(nameKey(buildingName)) : undefined;
      const petText = c.pets
        .map((p) => (p === "dog" ? "dog friendly" : p === "cat" ? "cat friendly" : p))
        .join(" ");
      const furnished = c.url.includes("/furnished/");

      out.push({
        sourceId: c.postId, // stable WordPress post id
        url: c.url,
        title: c.title,
        address: c.title, // "580 O'Farrell #412" — street + unit
        city: city ? city.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()) : null,
        neighborhood: c.neighborhood,
        lat: latlon?.[0] ?? null,
        lon: latlon?.[1] ?? null,
        price: c.price,
        beds: c.beds,
        baths: c.baths,
        sqft: null, // not exposed on the search card
        propertyType: furnished ? "furnished apartment" : "apartment",
        changeTag: `${c.price ?? ""}|${c.beds ?? ""}|${c.baths ?? ""}`,
        raw: {
          ...facet({
            buildingName,
            minBeds: c.beds,
            maxBeds: c.beds,
            minBaths: c.baths,
            maxBaths: c.baths,
            minPrice: c.price,
            maxPrice: c.price,
            amenities: [petText, c.neighborhood ?? "", furnished ? "furnished" : ""]
              .filter(Boolean)
              .join(" ")
              .toLowerCase(),
          }),
          pets: c.pets,
          furnished,
          imageUrl: c.imageUrl,
        },
      });
      if (input.limit && out.length >= input.limit) break;
    }
    return out;
  },
});
