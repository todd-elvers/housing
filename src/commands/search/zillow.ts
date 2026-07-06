import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { fetchJson } from "../../core/http.ts";
import type { RawListing } from "../../core/types.ts";

// Zillow — the dominant SF rental portal, otherwise behind PerimeterX/HUMAN.
// Reached via the RapidAPI "zillow-com1" wrapper (unit-level beds/baths/price).
// Tier 2 = paid, key-gated (RapidAPI freemium).
const HOST = "zillow-com1.p.rapidapi.com";

interface ZProp {
  zpid?: number | string;
  address?: string;
  price?: number;
  bedrooms?: number;
  bathrooms?: number;
  livingArea?: number;
  latitude?: number;
  longitude?: number;
  propertyType?: string;
  listingStatus?: string;
  detailUrl?: string;
}
interface ZResponse {
  props?: ZProp[];
  totalPages?: number;
}

export default defineSource({
  name: "zillow",
  summary:
    "Zillow for-rent via the RapidAPI zillow-com1 wrapper — unit-level beds/baths/price for the dominant SF portal.",
  when: "Use for the broadest SF rental coverage with real per-unit beds/baths. Paid (RapidAPI) — the one portal worth paying to reach.",
  snapshotComplete: false,
  tier: 2,
  requires: {
    RAPIDAPI_KEY: envSpec(
      z.string().min(1),
      "RapidAPI key (X-RapidAPI-Key)",
      "https://rapidapi.com/apimaker/api/zillow-com1",
    ),
    ZILLOW_LOCATION: envSpec(z.string().default("San Francisco, CA"), "Search location", ""),
    ZILLOW_MAX_PAGES: envSpec(
      z.coerce.number().default(3),
      "Max result pages to pull (~41/page)",
      "",
    ),
  },
  async fetch(env): Promise<RawListing[]> {
    const headers = { "X-RapidAPI-Key": env.RAPIDAPI_KEY, "X-RapidAPI-Host": HOST };
    const out: RawListing[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= env.ZILLOW_MAX_PAGES; page++) {
      const url =
        `https://${HOST}/propertyExtendedSearch` +
        `?location=${encodeURIComponent(env.ZILLOW_LOCATION)}&status_type=ForRent&page=${page}`;
      const data = await fetchJson<ZResponse>(url, { headers });
      const props = data.props ?? [];
      if (props.length === 0) break;
      for (const p of props) {
        const id = String(p.zpid ?? p.detailUrl ?? p.address ?? "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(map(p));
      }
      if (data.totalPages && page >= data.totalPages) break;
    }
    return out;
  },
});

function map(p: ZProp): RawListing {
  const detail = p.detailUrl ?? "";
  const url = detail.startsWith("http")
    ? detail
    : detail
      ? `https://www.zillow.com${detail}`
      : "https://www.zillow.com/";
  return {
    sourceId: String(p.zpid ?? detail ?? p.address ?? "unknown"),
    url,
    title: p.address ?? null,
    address: p.address ?? null,
    city: "San Francisco",
    lat: p.latitude ?? null,
    lon: p.longitude ?? null,
    price: typeof p.price === "number" ? p.price : null,
    beds: p.bedrooms ?? null,
    baths: p.bathrooms ?? null,
    sqft: p.livingArea ?? null,
    propertyType: p.propertyType ?? null,
    changeTag: `${p.price ?? ""}|${p.listingStatus ?? ""}`,
    // Mirror zumper's raw shape so `find`'s range/amenity queries work uniformly.
    raw: {
      minBeds: p.bedrooms ?? null,
      maxBeds: p.bedrooms ?? null,
      minBaths: p.bathrooms ?? null,
      maxBaths: p.bathrooms ?? null,
      minPrice: p.price ?? null,
      maxPrice: p.price ?? null,
      amenities: "",
    },
  };
}
