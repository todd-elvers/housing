import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { httpFetch, stripJsonGuard } from "../../core/http.ts";
import type { RawListing } from "../../core/types.ts";

// Apartments.com (CoStar) — the biggest UNIQUE SF multifamily inventory, behind
// Akamai+DataDome. Reached via the Apify actor `pro100chok/apartments-scraper-usage`
// (~$2/1k results, no residential proxy needed). Tier 2 = paid, key-gated.
const ACTOR = "pro100chok~apartments-scraper-usage";
const SEARCH_URL = "https://www.apartments.com/apartments/san-francisco-ca/";

interface ApItem {
  name?: string;
  url?: string;
  address?: { street?: string; city?: string; full?: string; neighborhood?: string };
  location?: { latitude?: number; longitude?: number };
  pricing?: { min?: number; max?: number };
  models?: { beds?: number; baths?: number; sqftMin?: number }[];
  amenities?: Record<string, unknown>;
}

export default defineSource({
  name: "apartments",
  summary:
    "Apartments.com (CoStar) via Apify — the biggest unique SF multifamily inventory (buildings + floor plans).",
  when: "Use for broad multifamily coverage the free portals miss. Paid (~$2/1k via Apify) and slow (managed anti-bot).",
  snapshotComplete: false,
  tier: 2,
  requires: {
    APIFY_TOKEN: envSpec(
      z.string().min(1),
      "Apify API token",
      "https://console.apify.com/account/integrations",
    ),
    APARTMENTS_MAX_ITEMS: envSpec(
      z.coerce.number().default(150),
      "Max listings to pull per run",
      "",
    ),
  },
  async fetch(env): Promise<RawListing[]> {
    const url = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(env.APIFY_TOKEN)}`;
    const res = await httpFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        action: "search",
        startUrls: [{ url: SEARCH_URL }],
        maxItems: env.APARTMENTS_MAX_ITEMS,
        maxPages: 5,
        concurrency: 10,
      }),
      timeoutMs: 290_000, // run-sync can take minutes
      retries: 0, // never re-run a paid actor
    });
    if (!res.ok)
      throw new Error(`apify apartments → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const items = JSON.parse(stripJsonGuard(await res.text())) as ApItem[];
    return (Array.isArray(items) ? items : []).map(map);
  },
});

function map(it: ApItem): RawListing {
  const models = Array.isArray(it.models) ? it.models : [];
  const beds = models.map((m) => m.beds).filter((n): n is number => typeof n === "number");
  const baths = models.map((m) => m.baths).filter((n): n is number => typeof n === "number");
  const sqfts = models.map((m) => m.sqftMin).filter((n): n is number => typeof n === "number");
  const minBeds = beds.length ? Math.min(...beds) : null;
  const maxBeds = beds.length ? Math.max(...beds) : null;
  const minBaths = baths.length ? Math.min(...baths) : null;
  const maxBaths = baths.length ? Math.max(...baths) : null;
  const amenities = Object.values(it.amenities ?? {})
    .flat()
    .filter((x) => typeof x === "string")
    .join(" ")
    .toLowerCase();
  return {
    sourceId: it.url || it.address?.full || (it.name ?? "unknown"),
    url: it.url || SEARCH_URL,
    title: it.name || it.address?.full || null,
    address: it.address?.full || it.address?.street || null,
    city: it.address?.city ?? "San Francisco",
    neighborhood: it.address?.neighborhood ?? null,
    lat: it.location?.latitude ?? null,
    lon: it.location?.longitude ?? null,
    price: it.pricing?.min ?? null,
    beds: minBeds,
    baths: minBaths,
    sqft: sqfts.length ? Math.min(...sqfts) : null,
    propertyType: "apartments-com",
    changeTag: `${it.pricing?.min ?? ""}|${it.pricing?.max ?? ""}`,
    // Same raw shape as zumper so `find`'s range/amenity queries work uniformly.
    raw: {
      buildingName: it.name ?? null,
      minBeds,
      maxBeds,
      minBaths,
      maxBaths,
      minPrice: it.pricing?.min ?? null,
      maxPrice: it.pricing?.max ?? null,
      amenities,
    },
  };
}
