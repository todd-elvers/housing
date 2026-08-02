import { defineSource } from "../../source.ts";
import { facet } from "../../core/facet.ts";
import { fetchText } from "../../core/http.ts";
import type { RawListing } from "../../core/types.ts";

// The Oak (55 Oak St, "The Oak SF, LLC") — a 109-unit two-tower building with
// no leasing platform at all: its Squarespace site hand-maintains plan-level
// cards ("A2 · 1 BEDROOM, 1 BATHROOM · 767-788 SQ. FT. · STARTING AT $3950 /
// MONTH") across four static residences pages. Its SightMap embed exists but
// the unit feed is empty (covered by sightmap.ts should it ever turn on), so
// these plan-level starting prices are the only first-party signal. We emit one
// listing per floor plan — floorplan-granularity like several aggregators, not
// unit-level. Prices are hand-edited marketing copy: expect occasional
// staleness. The four pages are the complete plan set ⇒ snapshot-complete.
//
// Parsing (validated against live HTML 2026-08-02): spec blocks and plan
// labels are separate Squarespace text blocks whose DOM order flips between
// cards, so each spec block is paired with the NEAREST label by byte offset —
// verified to pair all 16 plans correctly (a plan with no current spec block,
// e.g. B4, is simply skipped).
//
// Photos: no per-plan photo exists on these pages, and the residences pages
// carry no og:image either — only the homepage does. `raw.imageUrl` is that
// homepage building photo, shared across every plan. card.ts's
// resolvePhotos() picks it up automatically.
const BASE = "https://www.theoaksf.com";
const PAGES = [
  "/studio-residences",
  "/residences-1-bedroom",
  "/residences-2-bedroom",
  "/residences-3-bedroom",
];

const BUILDING = {
  name: "The Oak",
  address: "55 Oak St",
  neighborhood: "Hub / Hayes Valley",
  lat: 37.7752,
  lon: -122.4213,
};

const SPEC_RE =
  />((?:STUDIO|[\dA-Z+ ]*BEDROOM[^<]*?)), ?([\d.]+) BATHROOMS?<br>([\d,]+)(?:\s*-\s*([\d,]+))? ?SQ\.? ?FT\.?<br>STARTING AT \$([\d,]+)/g;
const LABEL_RE = />([ABCS]\d+)</g;

const money = (s: string): number => Number(s.replace(/,/g, ""));

function parsePage(html: string, pagePath: string, imageUrl: string | null): RawListing[] {
  const labels = [...html.matchAll(LABEL_RE)].map((m) => ({ off: m.index, label: m[1] }));
  const out: RawListing[] = [];
  for (const m of html.matchAll(SPEC_RE)) {
    const [, bedsLabel, bathsStr, sqftMinStr, sqftMaxStr, priceStr] = m;
    const nearest = labels.length
      ? labels.reduce((a, b) => (Math.abs(b.off - m.index) < Math.abs(a.off - m.index) ? b : a))
      : null;
    if (!nearest) continue;
    const beds = /STUDIO/i.test(bedsLabel) ? 0 : Number(bedsLabel.match(/\d+/)?.[0] ?? NaN);
    if (!Number.isFinite(beds)) continue;
    const hasDen = /DEN/i.test(bedsLabel);
    const price = money(priceStr);
    const sqftMin = money(sqftMinStr);
    const sqftMax = sqftMaxStr ? money(sqftMaxStr) : sqftMin;
    const url = `${BASE}${pagePath}#${nearest.label}`;
    out.push({
      sourceId: `plan-${nearest.label}`,
      url,
      title: `${BUILDING.name} · Plan ${nearest.label} (${bedsLabel.toLowerCase()}, from $${priceStr})`,
      address: BUILDING.address,
      city: "San Francisco",
      neighborhood: BUILDING.neighborhood,
      lat: BUILDING.lat,
      lon: BUILDING.lon,
      price,
      beds,
      baths: Number(bathsStr),
      sqft: sqftMin,
      propertyType: "apartment",
      changeTag: `${price}|${sqftMin}-${sqftMax}`,
      raw: {
        ...facet({
          buildingName: BUILDING.name,
          minBeds: beds,
          maxBeds: beds,
          minBaths: Number(bathsStr),
          maxBaths: Number(bathsStr),
          minPrice: price,
          maxPrice: price,
          amenities: [BUILDING.name, `plan ${nearest.label}`, hasDen ? "den" : "", "starting at"]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
        }),
        plan: nearest.label,
        den: hasDen,
        sqftMin,
        sqftMax,
        startingAt: true,
        imageUrl,
      },
    });
  }
  return out;
}

export default defineSource({
  name: "theoak",
  summary:
    "The Oak (55 Oak St) first-party plan-level pricing — 'starting at' rent, sqft range and beds/baths per floor plan scraped from its static Squarespace residences pages.",
  when: "Use for The Oak's first-party floor-plan pricing (plan-level 'starting at', not unit-level); snapshot-complete across its four residences pages.",
  snapshotComplete: true,
  async fetch(_env, { log }): Promise<RawListing[]> {
    const homeHtml = await fetchText(BASE, { timeoutMs: 25_000, retries: 2 }).catch(() => "");
    const imageUrl = homeHtml.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null;

    const out: RawListing[] = [];
    const seen = new Set<string>();
    for (const p of PAGES) {
      const html = await fetchText(`${BASE}${p}`, { timeoutMs: 25_000, retries: 2 });
      for (const l of parsePage(html, p, imageUrl)) {
        if (seen.has(l.sourceId)) continue; // a plan card repeated across pages
        seen.add(l.sourceId);
        out.push(l);
      }
    }
    if (!out.length) throw new Error("theoak: parsed 0 plans — page structure changed?");
    log.info(`theoak: ${out.length} floor plans`);
    return out;
  },
});
