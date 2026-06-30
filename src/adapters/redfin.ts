import { fetchJson } from "../core/http.ts";
import type { Adapter, RawListing } from "../core/types.ts";

// Redfin Stingray rentals search. region_id 17151 = San Francisco (city),
// region_type 6. No auth; US IP only. NOTE: this search variant returns
// identity + address + url + badges but NOT inline price/beds — those need the
// per-property `/rentals/{id}/floorPlans` detail call (see catalog; future
// enrichment). Plenty for NEW/REMOVED detection today.
const REGION_ID = process.env.REDFIN_REGION_ID || "17151";
const PAGE = 350;

interface RedfinResponse {
  homes?: { homeData?: RedfinHome }[];
}
interface RedfinHome {
  propertyId?: string;
  url?: string;
  propertyType?: number;
  addressInfo?: {
    formattedStreetLine?: string;
    city?: string;
    centroid?: { centroid?: { latitude?: number; longitude?: number } };
  };
  sashes?: { name?: string }[];
}

export const redfin: Adapter = {
  name: "redfin",
  snapshotComplete: true, // full SF search ⇒ absence means delisted
  enabled() {
    return { ok: true };
  },
  async fetch(): Promise<RawListing[]> {
    const out: RawListing[] = [];
    const seen = new Set<string>();
    for (let start = 0; start < 2000; start += PAGE) {
      const url =
        `https://www.redfin.com/stingray/api/v1/search/rentals` +
        `?al=1&region_id=${REGION_ID}&region_type=6&num_homes=${PAGE}&start=${start}`;
      const data = await fetchJson<RedfinResponse>(url, {
        headers: { referer: "https://www.redfin.com/" },
      });
      const homes = data.homes ?? [];
      if (homes.length === 0) break;
      for (const h of homes) {
        const hd = h.homeData;
        if (!hd?.propertyId || seen.has(hd.propertyId)) continue;
        seen.add(hd.propertyId);
        out.push(map(hd));
      }
      if (homes.length < PAGE) break;
    }
    return out;
  },
};

function map(hd: RedfinHome): RawListing {
  const sashes = (hd.sashes ?? []).map((s) => s.name).filter(Boolean).join(",");
  const c = hd.addressInfo?.centroid?.centroid;
  return {
    sourceId: hd.propertyId!,
    url: hd.url ? `https://www.redfin.com${hd.url}` : `https://www.redfin.com/`,
    title: hd.addressInfo?.formattedStreetLine ?? null,
    address: hd.addressInfo?.formattedStreetLine ?? null,
    city: hd.addressInfo?.city ?? null,
    lat: c?.latitude ?? null,
    lon: c?.longitude ?? null,
    price: null, // not in this endpoint variant
    propertyType: hd.propertyType != null ? `type-${hd.propertyType}` : null,
    changeTag: sashes, // badges flip on status changes ("New", "Price Drop")
    raw: { sashes },
  };
}
