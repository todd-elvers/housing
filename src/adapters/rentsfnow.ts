import { httpFetch } from "../core/http.ts";
import type { Adapter, RawListing } from "../core/types.ts";

// RentSFNow / Veritas Investments — the largest single private SF/Oakland
// portfolio. No API, but the property sitemaps expose every unit URL + lastmod.
// A new <loc> = new unit; a changed <lastmod> = relist/delist. Cheap and
// complete, so absence ⇒ removed. (Per-unit price/availability needs a JSON-LD
// page fetch — future enrichment; this tracks the unit set + changes.)
const SITEMAPS = (n: number) =>
  n === 1
    ? "https://www.rentsfnow.com/property-sitemap.xml"
    : `https://www.rentsfnow.com/property-sitemap${n}.xml`;

export const rentsfnow: Adapter = {
  name: "rentsfnow",
  snapshotComplete: true,
  enabled() {
    return { ok: true };
  },
  async fetch(): Promise<RawListing[]> {
    const out: RawListing[] = [];
    const seen = new Set<string>();
    for (let n = 1; n <= 6; n++) {
      let xml: string;
      try {
        const res = await httpFetch(SITEMAPS(n));
        if (!res.ok) break;
        xml = await res.text();
      } catch {
        break;
      }
      const entries = [
        ...xml.matchAll(
          /<url>\s*<loc>([^<]+)<\/loc>\s*(?:<lastmod>([^<]+)<\/lastmod>)?/g,
        ),
      ];
      if (entries.length === 0) break;
      for (const m of entries) {
        const loc = m[1].trim();
        if (seen.has(loc)) continue;
        seen.add(loc);
        const lastmod = m[2]?.trim() ?? null;
        const slug = loc.replace(/\/$/, "").split("/").pop() || loc;
        out.push({
          sourceId: loc,
          url: loc,
          title: slug.replace(/-/g, " "),
          propertyType: "veritas-unit",
          changeTag: lastmod ?? "",
          raw: { lastmod },
        });
      }
    }
    return out;
  },
};
