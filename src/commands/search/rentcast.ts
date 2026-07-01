import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { fetchJson } from "../../core/http.ts";
import type { RawListing } from "../../core/types.ts";

// RentCast — the legal aggregator spine. Stable REST API with listedDate/status
// for clean diffs. Overlaps the portals and misses Craigslist-only/private
// landlords, so treat as a normalizing backbone rather than additive inventory.
interface RcListing {
  id: string;
  formattedAddress?: string;
  addressLine1?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  price?: number;
  status?: string;
  listedDate?: string;
}

export default defineSource({
  name: "rentcast",
  summary:
    "RentCast REST aggregator — the legal Tier-1 backbone with listedDate/status for clean diffs.",
  when: "Use for a normalized cross-source rental snapshot of SF; misses Craigslist-only / private-landlord units.",
  snapshotComplete: false,
  requires: {
    RENTCAST_API_KEY: envSpec(
      z.string().min(1),
      "RentCast API key (sent as X-Api-Key)",
      "https://app.rentcast.io",
    ),
    RENTCAST_CITY: envSpec(z.string().default("San Francisco"), "City to query", ""),
  },
  async fetch(env): Promise<RawListing[]> {
    const url =
      `https://api.rentcast.io/v1/listings/rental/long-term` +
      `?city=${encodeURIComponent(env.RENTCAST_CITY)}&state=CA&status=Active&limit=500`;
    const data = await fetchJson<RcListing[] | { listings?: RcListing[] }>(url, {
      headers: { "X-Api-Key": env.RENTCAST_API_KEY, accept: "application/json" },
    });
    const arr = Array.isArray(data) ? data : (data.listings ?? []);
    return arr.map((l): RawListing => {
      const addr = l.formattedAddress || l.addressLine1 || "";
      return {
        sourceId: l.id,
        url: addr
          ? `https://www.google.com/search?q=${encodeURIComponent(addr + " for rent")}`
          : "https://www.rentcast.io/",
        title: addr || null,
        address: addr || null,
        city: l.city ?? null,
        lat: l.latitude ?? null,
        lon: l.longitude ?? null,
        price: l.price ?? null,
        beds: l.bedrooms ?? null,
        baths: l.bathrooms ?? null,
        sqft: l.squareFootage ?? null,
        propertyType: l.propertyType ?? null,
        postedAt: l.listedDate ? Date.parse(l.listedDate) || null : null,
        changeTag: `${l.price ?? ""}|${l.status ?? ""}|${l.listedDate ?? ""}`,
      };
    });
  },
});
