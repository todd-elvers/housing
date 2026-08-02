import { defineSource } from "../../source.ts";
import { facet } from "../../core/facet.ts";
import { fetchText } from "../../core/http.ts";
import type { RawListing } from "../../core/types.ts";

// 150 Van Ness (Emerald Fund) — the building's own floorplans page is a
// WordPress build (Jonah Digital "jd-fp" widget, RealPage-fed) that
// SERVER-RENDERS the complete availability dataset into an inline
// <script type="application/json" id="jd-fp-data-script-app"> blob: a `units`
// array with apartment number, exact rent range, sqft, beds/baths and
// available date. One GET, no auth, no JS, no bot wall (verified 2026-08-02).
// Its sister building 100 Van Ness uses SightMap instead (see sightmap.ts).
// The blob is the full current set, so snapshot-complete.
//
// Photos: the jd-fp unit data carries only an SVG floor-plan glyph (not a real
// photo, and canvas can't decode SVG for the Discord card anyway), so
// `raw.imageUrl` instead uses the page's own og:image — a real building photo
// — shared across every unit here. card.ts's resolvePhotos() picks it up.
const PAGE = "https://150vanness.com/floorplans/";

const BUILDING = {
  name: "150 Van Ness",
  address: "150 Van Ness Ave",
  neighborhood: "Civic Center / Van Ness corridor",
  lat: 37.7765,
  lon: -122.4198,
};

interface JdUnit {
  apartment_number: string;
  floorplan_title: string | null;
  bedrooms: string | number | null;
  bathrooms: string | number | null;
  square_feet: string | number | null;
  rent_min: string | number | null;
  rent_max: string | number | null;
  price_display: string | null;
  available_date: string | null; // unix epoch seconds, as a string
  available_display: string | null;
  permalink: string | null;
  specials?: unknown[];
}

const num = (v: string | number | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};

export default defineSource({
  name: "vanness150",
  summary:
    "150 Van Ness first-party availability — unit-level rent, sqft and available date parsed from the inline JSON its own floorplans page server-renders.",
  when: "Use for first-party 150 Van Ness availability; snapshot-complete (absence ⇒ delisted). No filters — the set is small.",
  snapshotComplete: true,
  async fetch(_env, { log }): Promise<RawListing[]> {
    const html = await fetchText(PAGE, { timeoutMs: 25_000, retries: 2 });
    const m = html.match(
      /<script type="application\/json" id="jd-fp-data-script-app">([\s\S]*?)<\/script>/,
    );
    if (!m) throw new Error("vanness150: jd-fp data blob not found in floorplans page");
    const units = (JSON.parse(m[1]) as { units?: JdUnit[] }).units ?? [];
    const imageUrl = html.match(/<meta property="og:image" content="([^"]+)"/)?.[1] ?? null;
    log.info(`vanness150: ${units.length} units`);

    return units.map((u): RawListing => {
      const rentMin = num(u.rent_min);
      const rentMax = num(u.rent_max);
      const beds = num(u.bedrooms);
      const baths = num(u.bathrooms);
      const unitNo = u.apartment_number;
      return {
        sourceId: unitNo,
        url: u.permalink ? new URL(u.permalink, PAGE).href : `${PAGE}#unit-${unitNo}`,
        title: [`${BUILDING.name} #${unitNo}`, u.floorplan_title].filter(Boolean).join(" · "),
        address: `${BUILDING.address} #${unitNo}`,
        city: "San Francisco",
        neighborhood: BUILDING.neighborhood,
        lat: BUILDING.lat,
        lon: BUILDING.lon,
        price: rentMin,
        beds,
        baths,
        sqft: num(u.square_feet),
        propertyType: "apartment",
        changeTag: `${rentMin ?? ""}|${rentMax ?? ""}|${u.available_date ?? ""}`,
        raw: {
          ...facet({
            buildingName: BUILDING.name,
            minBeds: beds,
            maxBeds: beds,
            minBaths: baths,
            maxBaths: baths,
            minPrice: rentMin,
            maxPrice: rentMax,
            amenities: [BUILDING.name, u.floorplan_title, u.available_display]
              .filter(Boolean)
              .join(" ")
              .toLowerCase(),
          }),
          unitNumber: unitNo,
          floorPlan: u.floorplan_title,
          rentMax,
          availableDisplay: u.available_display,
          availableEpoch: num(u.available_date),
          imageUrl,
        },
      };
    });
  },
});
