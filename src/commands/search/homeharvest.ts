import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { facet } from "../../core/facet.ts";
import type { RawListing } from "../../core/types.ts";

// HomeHarvest (Realtor.com) has no usable JS path, so we shell out to a Python
// bridge via `uv run`. Disabled by default — set HOUSING_HOMEHARVEST=1 after
// `uv sync`. Here the "upstream API" IS the subprocess: we invoke the bridge,
// then parse the JSON array it prints on stdout.
//
// The bridge (scripts/homeharvest_fetch.py) emits exactly the keys in HhRow —
// LIVE-VERIFIED against realtor.com SF rentals (2026-07). Quirks baked in below:
//  • Only --location / --past-days / --listing-type are accepted upstream; price
//    and bed windows are therefore applied client-side (like rentcast's price).
//  • beds/baths/sqft are frequently null for building / price-RANGE listings —
//    that is the real data, not a parse bug. Roughly half of a fresh SF pull has
//    them; the rest are ranged multi-unit buildings with no single value.
//  • `price` is list_price, falling back to list_price_min for ranged listings
//    (so a "$1,995–$2,800" building surfaces at its entry price, 1995).
//  • `list_date` is a naive-UTC "YYYY-MM-DD HH:MM:SS" string (it matches the
//    tz-aware last_update_date), so we parse it as UTC, not local.
//  • `neighborhoods` and `status` are unhelpful here (null / constant FOR_RENT),
//    so RawListing.neighborhood stays null and changeTag keys off price + beds.
//
// Resolve paths from this module (not cwd) so `uv run` finds the project's
// pyproject.toml/.venv no matter where `housing` was launched from.
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const BRIDGE = fileURLToPath(new URL("../../../scripts/homeharvest_fetch.py", import.meta.url));

// scrape_property(listing_type=…) accepts these; default to rentals for this CLI.
const LISTING_TYPES = ["for_rent", "for_sale", "sold", "pending"] as const;

// One-shot: the bridge scrapes realtor.com (O(n) extra per-property requests), so
// give it room but never retry — re-running would re-hammer a free source.
const TIMEOUT_MS = 240_000;
const MAX_STDOUT = 64 * 1024 * 1024;

/** One row of the bridge's JSON stdout (the only keys it emits). */
interface HhRow {
  id?: string;
  url?: string;
  address?: string;
  city?: string;
  lat?: number | null;
  lon?: number | null;
  price?: number | null;
  beds?: number | null;
  baths?: number | null;
  sqft?: number | null;
  property_type?: string;
  list_date?: string;
}

/** Parse the bridge's naive "YYYY-MM-DD HH:MM:SS" list_date as UTC → epoch ms. */
function parseListDate(s?: string | null): number | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  // Already tz-qualified (Z or ±hh:mm) — parse as-is; else treat naive as UTC.
  const iso = /([zZ]|[+-]\d{2}:?\d{2})$/.test(t) ? t.replace(" ", "T") : `${t.replace(" ", "T")}Z`;
  return Date.parse(iso) || Date.parse(t) || null;
}

export default defineSource({
  name: "homeharvest",
  summary:
    "Realtor.com rentals via the HomeHarvest Python scraper, shelled out through a `uv run` bridge. Location/recency/listing-type map upstream; price + bed windows filter locally.",
  when: "Use for Realtor.com/MLS inventory not covered by the JS sources; requires local `uv sync` and HOUSING_HOMEHARVEST=1. Scrapes a free source, so keep the window small (past-days) to stay gentle.",
  snapshotComplete: false,
  // All optional: `ingest` runs with none set (env config drives the query); an
  // operator/LLM passes any combination to `search homeharvest` for ad-hoc pulls.
  input: z.object({
    location: z
      .string()
      .optional()
      .describe('Location to scrape, e.g. "San Francisco, CA" or a ZIP like "94102"'),
    pastDays: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Only listings from the last N days (smaller = gentler on the scraper)"),
    listingType: z
      .enum(LISTING_TYPES)
      .optional()
      .describe("Realtor.com listing type (default for_rent)"),
    minBeds: z.coerce.number().min(0).optional().describe("Min bedrooms (applied locally)"),
    maxBeds: z.coerce.number().min(0).optional().describe("Max bedrooms (applied locally)"),
    minPrice: z.coerce.number().min(0).optional().describe("Min monthly rent (applied locally)"),
    maxPrice: z.coerce.number().min(0).optional().describe("Max monthly rent (applied locally)"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Cap the number of listings returned (after local filtering)"),
  }),
  requires: {
    HOUSING_HOMEHARVEST: envSpec(
      z.literal("1"),
      "Set to 1 to enable (needs `uv sync` first)",
      "run: uv sync",
    ),
    HOMEHARVEST_LOCATION: envSpec(
      z.string().default("San Francisco, CA"),
      "Location to scrape",
      "",
    ),
    HOMEHARVEST_PAST_DAYS: envSpec(
      z.coerce.number().int().min(1).default(3),
      "Only listings from the last N days",
      "",
    ),
    HOMEHARVEST_LISTING_TYPE: envSpec(
      z.enum(LISTING_TYPES).default("for_rent"),
      "Realtor.com listing type (for_rent | for_sale | sold | pending)",
      "",
    ),
  },
  async fetch(env, { input, log }): Promise<RawListing[]> {
    // Upstream request params (only these three reach the bridge). Input overrides
    // env; unset falls back to the env default.
    const location = input.location ?? env.HOMEHARVEST_LOCATION;
    const pastDays = input.pastDays ?? env.HOMEHARVEST_PAST_DAYS;
    const listingType = input.listingType ?? env.HOMEHARVEST_LISTING_TYPE;

    const res = spawnSync(
      "uv",
      [
        "run",
        "python",
        BRIDGE,
        "--location",
        location,
        "--past-days",
        String(pastDays),
        "--listing-type",
        listingType,
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        maxBuffer: MAX_STDOUT,
        timeout: TIMEOUT_MS,
        killSignal: "SIGTERM",
      },
    );

    // Spawn-level failure (uv missing, timeout, buffer overflow) — surface clearly.
    if (res.error) {
      const e = res.error as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new Error("homeharvest: `uv` not found on PATH — install uv, then run `uv sync`.");
      }
      if (e.code === "ETIMEDOUT") {
        throw new Error(
          `homeharvest: bridge timed out after ${TIMEOUT_MS / 1000}s (realtor.com slow/blocked, or the past-days window is too large).`,
        );
      }
      if (e.code === "ENOBUFS") {
        throw new Error(
          "homeharvest: bridge output exceeded the buffer — narrow the past-days window.",
        );
      }
      throw new Error(`homeharvest: could not run uv bridge — ${e.message}`);
    }
    if (res.signal) {
      throw new Error(
        `homeharvest: bridge killed by ${res.signal} (likely the ${TIMEOUT_MS / 1000}s timeout).`,
      );
    }
    if (res.status !== 0) {
      const stderr = (res.stderr || "").trim();
      const hint = res.status === 2 ? " — run `uv sync` to install HomeHarvest" : "";
      throw new Error(
        `homeharvest: bridge exited ${res.status}${hint}: ${stderr.slice(-400) || "no stderr"}`,
      );
    }

    const stdout = (res.stdout || "").trim();
    if (!stdout) return []; // empty scrape (e.g. blocked / no recent listings) → graceful empty
    let rows: HhRow[];
    try {
      rows = JSON.parse(stdout) as HhRow[];
    } catch {
      throw new Error(
        `homeharvest: bridge stdout was not valid JSON — starts: ${stdout.slice(0, 200)}`,
      );
    }
    if (!Array.isArray(rows)) throw new Error("homeharvest: bridge returned non-array JSON");

    // Map, dedup by stable id, apply the client-side windows, then cap.
    const { minBeds, maxBeds, minPrice, maxPrice, limit } = input;
    const seen = new Set<string>();
    const out: RawListing[] = [];
    let dropped = 0;
    for (const r of rows) {
      const listing = map(r);
      if (!listing) {
        dropped++;
        continue;
      }
      if (seen.has(listing.sourceId)) continue;
      const beds = listing.beds;
      const price = listing.price;
      if (minBeds !== undefined && (beds == null || beds < minBeds)) continue;
      if (maxBeds !== undefined && (beds == null || beds > maxBeds)) continue;
      if (minPrice !== undefined && (price == null || price < minPrice)) continue;
      if (maxPrice !== undefined && (price == null || price > maxPrice)) continue;
      seen.add(listing.sourceId);
      out.push(listing);
      if (limit !== undefined && out.length >= limit) break;
    }
    log.info(
      `homeharvest: ${rows.length} rows, ${out.length} listings after filter${dropped ? ` (${dropped} unmappable)` : ""}`,
    );
    return out;
  },
});

function map(r: HhRow): RawListing | null {
  const street = r.address?.trim() || null;
  const sourceId = String(r.id ?? r.url ?? street ?? "").trim();
  if (!sourceId) return null; // no stable id/url/address → cannot diff, skip
  const url = r.url && /^https?:\/\//.test(r.url) ? r.url : "https://www.realtor.com/";
  const fullAddress = [street, r.city].filter(Boolean).join(", ") || null;
  const price = typeof r.price === "number" ? r.price : null;
  const beds = typeof r.beds === "number" ? r.beds : null;
  const baths = typeof r.baths === "number" ? r.baths : null;
  const sqft = typeof r.sqft === "number" ? r.sqft : null;
  // Searchable blob for `find`'s LIKE match — realtor's amenity text isn't emitted
  // by the bridge, so fold in the categorical bits people actually search by.
  const amenities = [r.property_type, r.city].filter(Boolean).join(" ").toLowerCase();
  return {
    sourceId,
    url,
    title: street ?? fullAddress,
    address: fullAddress,
    city: r.city ?? null,
    // Realtor.com's neighborhoods field is null for SF rentals — leave it null.
    neighborhood: null,
    lat: typeof r.lat === "number" ? r.lat : null,
    lon: typeof r.lon === "number" ? r.lon : null,
    price,
    beds,
    baths,
    sqft,
    propertyType: r.property_type ?? null,
    postedAt: parseListDate(r.list_date),
    // Mutation signal: a re-price or a corrected bed/bath count flips "changed";
    // status is a constant FOR_RENT here, so it's deliberately excluded.
    changeTag: `${price ?? ""}|${beds ?? ""}|${baths ?? ""}`,
    raw: {
      ...facet({
        minBeds: beds,
        maxBeds: beds,
        minBaths: baths,
        maxBaths: baths,
        minPrice: price,
        maxPrice: price,
        amenities,
        buildingName: null,
      }),
      // Extras kept for debugging / later enrichment.
      street,
      listDate: r.list_date ?? null,
    },
  };
}
