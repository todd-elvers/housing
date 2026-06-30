import { fetchJson } from "../core/http.ts";
import type { Adapter, RawListing } from "../core/types.ts";

// RentCast — the legal aggregator spine. Stable REST API with first-class
// listedDate / lastSeenDate / removedDate, ideal for diffing. Needs a key
// (free 50 req/mo; Foundation $74/mo = 1000). Overlaps the portals and misses
// Craigslist-only/private landlords, so treat as a normalizing backbone.
interface RcListing {
  id: string;
  formattedAddress?: string;
  addressLine1?: string;
  city?: string;
  state?: string;
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

export const rentcast: Adapter = {
  name: "rentcast",
  snapshotComplete: false,
  enabled() {
    return process.env.RENTCAST_API_KEY
      ? { ok: true }
      : { ok: false, reason: "set RENTCAST_API_KEY (app.rentcast.io)" };
  },
  async fetch(): Promise<RawListing[]> {
    const key = process.env.RENTCAST_API_KEY!;
    const city = process.env.RENTCAST_CITY || "San Francisco";
    const url =
      `https://api.rentcast.io/v1/listings/rental/long-term` +
      `?city=${encodeURIComponent(city)}&state=CA&status=Active&limit=500`;
    const data = await fetchJson<RcListing[] | { listings?: RcListing[] }>(url, {
      headers: { "X-Api-Key": key, accept: "application/json" },
    });
    const arr = Array.isArray(data) ? data : (data.listings ?? []);
    return arr.map(map);
  },
};

function map(l: RcListing): RawListing {
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
}
