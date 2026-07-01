import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { httpFetch, stripJsonGuard } from "../../core/http.ts";
import type { RawListing } from "../../core/types.ts";

// Zumper internal listables API (SF-HQ, light anti-bot: Fastly, no DataDome).
// Two steps: GET /bundle for a CSRF token + cookies, then POST /listables.
// Best change-detection field set of any portal: created_on / modified_on /
// listed_on / previous_price / listing_status.
const BASE = "https://www.zumper.com";
const REFERER = `${BASE}/apartments-for-rent/san-francisco-ca`;

interface Listable {
  listing_id: number;
  url?: string;
  title?: string;
  building_name?: string;
  address?: string;
  city?: string;
  state?: string;
  zipcode?: string;
  neighborhood_name?: string;
  lat?: number;
  lng?: number;
  min_price?: number;
  max_price?: number;
  min_bedrooms?: number;
  max_bedrooms?: number;
  min_bathrooms?: number;
  property_type?: string;
  listing_status?: number;
  listed_on?: number;
  created_on?: number;
  modified_on?: number;
}

export default defineSource({
  name: "zumper",
  summary: "Zumper internal listables API — the richest change-detection field set (created/modified/listed_on, previous_price, listing_status).",
  when: "Use for precise diff tracking of SF portal listings; a single listables call may not return every unit, so don't infer removal.",
  // A single listables call may not return every SF unit, so don't infer removal.
  snapshotComplete: false,
  requires: {
    ZUMPER_CITY: envSpec(z.string().default("san-francisco-ca"), "Zumper city slug", ""),
  },
  async fetch(env): Promise<RawListing[]> {
    const CITY = env.ZUMPER_CITY;
    const bundleRes = await httpFetch(`${BASE}/api/t/1/bundle`, {
      headers: { referer: REFERER, accept: "application/json" },
    });
    const cookies = (bundleRes.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .join("; ");
    const bundle = JSON.parse(stripJsonGuard(await bundleRes.text())) as { csrf: string };

    const res = await httpFetch(`${BASE}/api/t/1/pages/listables`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrftoken": bundle.csrf,
        cookie: cookies,
        referer: REFERER,
        accept: "application/json",
      },
      body: JSON.stringify({ external: true, longTerm: true, url: CITY, limit: 500 }),
    });
    if (!res.ok) throw new Error(`listables → HTTP ${res.status}`);
    const data = JSON.parse(stripJsonGuard(await res.text())) as { listables?: Listable[] };
    return (data.listables ?? []).map(map);
  },
});

function map(l: Listable): RawListing {
  return {
    sourceId: String(l.listing_id),
    url: l.url ? (l.url.startsWith("http") ? l.url : `${BASE}${l.url}`) : BASE,
    title: l.title || l.building_name || l.address || null,
    address: l.address ?? null,
    city: l.city ?? null,
    neighborhood: l.neighborhood_name ?? null,
    lat: l.lat ?? null,
    lon: l.lng ?? null,
    price: l.min_price ?? null,
    beds: l.min_bedrooms ?? null,
    baths: l.min_bathrooms ?? null,
    propertyType: l.property_type ?? null,
    postedAt: l.listed_on ? l.listed_on * 1000 : null,
    changeTag: `${l.min_price ?? ""}|${l.listing_status ?? ""}|${l.modified_on ?? ""}`,
    raw: { group: l.building_name, status: l.listing_status, maxPrice: l.max_price },
  };
}
