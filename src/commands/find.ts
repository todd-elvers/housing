import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { defineTool } from "../tool.ts";
import { envSpec } from "../env/spec.ts";
import { log } from "../core/log.ts";
import { facetPath } from "../core/facet.ts";
import { formatLegs, type CommuteRoute } from "../core/commute.ts";
import { neighborhoodAt, pointInPolygon } from "../core/geo.ts";

// Query the ingested DB. Bed/bath filters match EITHER a per-unit listing
// (craigslist) OR a building whose range covers the target (zumper's
// minBeds..maxBeds in raw JSON), so "3 beds" finds both a 3BR unit and a
// building that offers 3BR units. Amenity/keyword matching is best-effort over
// title + address + the raw amenity blob.
interface Row {
  source: string;
  title: string | null;
  address: string | null;
  neighborhood: string | null;
  price: number | null;
  beds: number | null;
  baths: number | null;
  lat: number | null;
  lon: number | null;
  url: string;
  raw: string | null;
  commute_min: number | null;
  commute_route: string | null;
}

export default defineTool({
  summary:
    "Search the ingested rental DB by beds/baths/price/keyword, rank by distance, and label by commute zone.",
  when: "Use after `ingest` to find matching listings near a location — e.g. a 3BR/3BA near work, ideally with a gym.",
  kind: "query",
  input: z.object({
    beds: z.coerce
      .number()
      .optional()
      .describe("Bedrooms the listing must offer (per-unit or within a building's range)"),
    baths: z.coerce.number().optional().describe("Bathrooms the listing must offer"),
    near: z
      .string()
      .optional()
      .describe("Anchor 'lat,lon' to filter + rank by distance (e.g. 37.7726,-122.4189)"),
    radius: z.coerce.number().default(3).describe("Max km from --near"),
    minCommute: z.coerce
      .number()
      .optional()
      .describe("Min commute minutes from HOUSING_ANCHOR (excludes listings closer than this)"),
    maxCommute: z.coerce
      .number()
      .optional()
      .describe(
        "Max commute minutes from HOUSING_ANCHOR (uses data/commute-zones.geojson; excludes listings with no coordinates or outside all zones)",
      ),
    minPrice: z.coerce.number().optional().describe("Minimum monthly rent"),
    maxPrice: z.coerce.number().optional().describe("Maximum monthly rent"),
    match: z
      .string()
      .optional()
      .describe("Keyword required in title/address/amenities (e.g. gym, tower, luxury)"),
    neighborhood: z
      .string()
      .optional()
      .describe("Filter to a specific SF neighborhood (partial match, e.g. 'mission', 'soma')"),
    source: z.string().optional().describe("Limit to one source"),
    limit: z.coerce.number().default(25).describe("Max results"),
  }),
  requires: {
    HOUSING_DB: envSpec(z.string().default("data/housing.db"), "SQLite database path", ""),
    HOUSING_ANCHOR: envSpec(
      z.string().optional(),
      "Default 'lat,lon' anchor for --near (e.g. office location)",
      "",
    ),
  },
  async run({ input, env }) {
    if (!existsSync(env.HOUSING_DB)) {
      throw new Error(`no database at ${env.HOUSING_DB} — run \`housing ingest\` first`);
    }
    const where = ["status = 'active'"];
    const params: (string | number)[] = [];
    if (input.beds !== undefined) {
      where.push(`(beds = ? OR (${facetPath("minBeds")} <= ? AND ${facetPath("maxBeds")} >= ?))`);
      params.push(input.beds, input.beds, input.beds);
    }
    if (input.baths !== undefined) {
      where.push(
        `(baths = ? OR (${facetPath("minBaths")} <= ? AND ${facetPath("maxBaths")} >= ?))`,
      );
      params.push(input.baths, input.baths, input.baths);
    }
    if (input.minPrice !== undefined) {
      // Range-overlap: a building matches if its top rent (raw.maxPrice) clears the floor.
      // (price === raw.minPrice for range sources, so the maxPrice clause below is already correct.)
      where.push(`(price >= ? OR ${facetPath("maxPrice")} >= ?)`);
      params.push(input.minPrice, input.minPrice);
    }
    if (input.maxPrice !== undefined) {
      where.push("price <= ?");
      params.push(input.maxPrice);
    }
    if (input.source) {
      where.push("source = ?");
      params.push(input.source);
    }
    if (input.match) {
      // Match title / address / amenity VALUE only (never the raw JSON key names),
      // with LIKE wildcards (% _ \) in the user term escaped.
      where.push(
        "(lower(coalesce(title,'')) LIKE ? ESCAPE '\\' " +
          "OR lower(coalesce(address,'')) LIKE ? ESCAPE '\\' " +
          "OR lower(coalesce(" +
          facetPath("amenities") +
          ",'')) LIKE ? ESCAPE '\\')",
      );
      const esc = input.match.toLowerCase().replace(/[\\%_]/g, "\\$&");
      const m = `%${esc}%`;
      params.push(m, m, m);
    }

    const db = new DatabaseSync(env.HOUSING_DB);
    const rows = db
      .prepare(
        `SELECT source, title, address, neighborhood, price, beds, baths, lat, lon, url, raw, commute_min, commute_route
         FROM listings WHERE ${where.join(" AND ")}`,
      )
      .all(...params) as unknown as Row[];
    db.close();

    let anchor: { lat: number; lon: number } | null = null;
    const nearStr = input.near ?? env.HOUSING_ANCHOR;
    if (nearStr) {
      const [la, lo] = nearStr.split(",").map((s) => Number(s.trim()));
      if (!Number.isFinite(la) || !Number.isFinite(lo)) {
        throw new Error(`--near must be 'lat,lon' (got '${nearStr}')`);
      }
      anchor = { lat: la, lon: lo };
    }

    const zones = loadZones();

    let results = rows.map((r) => {
      const raw = parseRaw(r.raw);
      const amenities = String(raw.amenities ?? "").toLowerCase();
      const gym =
        /gym|fitness/.test(amenities) || /gym|fitness/.test((r.title ?? "").toLowerCase());
      const distanceKm =
        anchor && r.lat != null && r.lon != null
          ? round(haversine(anchor.lat, anchor.lon, r.lat, r.lon))
          : null;
      // Commute minutes, best source first: exact door-to-door Routes total →
      // the matrix transit time → the pre-baked isochrone zone.
      const route = parseRoute(r.commute_route);
      const zoneMin =
        zones.length > 0 && r.lat != null && r.lon != null
          ? commuteZone(r.lat, r.lon, zones)
          : null;
      const commuteMin = route?.mins ?? r.commute_min ?? zoneMin;
      const legs = route && route.legs.length > 0 ? formatLegs(route.legs) : null;
      // Always prefer PIP from coordinates (canonical name); fall back to
      // whatever the source provided only when there are no coordinates.
      const neighborhood = neighborhoodAt(r.lat, r.lon) ?? r.neighborhood ?? null;
      return {
        source: r.source,
        building: (raw.buildingName as string | null) ?? null,
        title: r.title,
        address: r.address,
        neighborhood,
        price: r.price ?? (typeof raw.minPrice === "number" ? raw.minPrice : null),
        beds: label(r.beds, raw.minBeds, raw.maxBeds, "BR"),
        baths: label(r.baths, raw.minBaths, raw.maxBaths, "BA"),
        gym,
        distanceKm,
        commuteMin,
        legs,
        url: r.url,
      };
    });

    let hiddenNoCoord = 0;
    if (anchor) {
      // A radius query can't place a coordinate-less listing, so it's excluded — but
      // report the count instead of silently dropping matching-but-unlocatable rows.
      hiddenNoCoord = results.filter((r) => r.distanceKm == null).length;
      results = results.filter((r) => r.distanceKm != null && r.distanceKm <= input.radius);
    }
    if (input.minCommute !== undefined) {
      results = results.filter((r) => r.commuteMin == null || r.commuteMin >= input.minCommute!);
    }
    if (input.maxCommute !== undefined) {
      const before = results.length;
      results = results.filter((r) => r.commuteMin != null && r.commuteMin <= input.maxCommute!);
      const dropped = before - results.length;
      if (dropped > 0)
        log.print(
          `  (${dropped} listing(s) outside ${input.maxCommute}-min commute zone or no coordinates)`,
        );
    }

    if (input.neighborhood) {
      const needle = input.neighborhood.toLowerCase();
      results = results.filter((r) => r.neighborhood?.toLowerCase().includes(needle));
    }

    results.sort(
      (a, b) =>
        (a.commuteMin ?? 1e9) - (b.commuteMin ?? 1e9) ||
        (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) ||
        (a.price ?? 1e9) - (b.price ?? 1e9),
    );
    results = results.slice(0, input.limit);

    log.print(
      `\n${results.length} match(es)` +
        (anchor ? ` within ${input.radius}km of ${anchor.lat},${anchor.lon}` : "") +
        (input.minCommute ? ` · ≥${input.minCommute}-min commute` : "") +
        (input.maxCommute ? ` · ≤${input.maxCommute}-min commute` : "") +
        "\n",
    );
    for (const r of results) {
      const dist = r.distanceKm != null ? `${r.distanceKm}km` : "—";
      const commute = r.commuteMin != null ? `~${r.commuteMin}min` : "     ";
      const price = r.price ? `$${r.price.toLocaleString()}` : "n/a";
      const name = (r.building ?? r.title ?? r.address ?? "").slice(0, 40);
      log.print(
        `  ${commute.padEnd(7)} ${dist.padStart(6)}  ${`${r.beds}/${r.baths}`.padEnd(11)} ${price.padStart(8)}  ${r.gym ? "🏋️ gym " : "       "}${name}  [${r.source}]`,
      );
      if (r.legs) log.print(`          ${r.legs}`);
      log.print(`                   ${r.neighborhood ?? ""}  ${r.url}`);
    }
    if (hiddenNoCoord > 0) {
      log.print(`  (${hiddenNoCoord} more match(es) hidden — no coordinates to check distance)`);
    }
    return results;
  },
});

// --- commute zone (point-in-polygon against pre-baked GeoJSON isochrones) ---

interface Zone {
  contour: number;
  // All exterior rings for this zone (one per polygon in a MultiPolygon).
  rings: [number, number][][]; // each ring: [lon, lat] pairs (GeoJSON order)
}

let ZONES: Zone[] | null = null;

function loadZones(): Zone[] {
  if (ZONES !== null) return ZONES;
  const path = "data/commute-zones.geojson";
  if (!existsSync(path)) return (ZONES = []);
  try {
    const g = JSON.parse(readFileSync(path, "utf8"));
    type GeoFeature = {
      properties: { contour: number };
      geometry: { type: string; coordinates: unknown };
    };
    ZONES = (g.features as GeoFeature[])
      .filter((f) => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon")
      .map((f) => {
        const rings: [number, number][][] =
          f.geometry.type === "Polygon"
            ? [(f.geometry.coordinates as [number, number][][])[0]]
            : (f.geometry.coordinates as [number, number][][][]).map((poly) => poly[0]);
        return { contour: f.properties.contour, rings };
      })
      .sort((a, b) => a.contour - b.contour); // smallest zone first → early exit
    return ZONES;
  } catch {
    return (ZONES = []);
  }
}

/** Returns the smallest zone contour (minutes) containing the point, or null if outside all zones. */
function commuteZone(lat: number, lon: number, zones: Zone[]): number | null {
  for (const z of zones) {
    if (z.rings.some((ring) => pointInPolygon(lat, lon, ring))) return z.contour;
  }
  return null;
}

// --- helpers ---

function parseRoute(json: string | null): CommuteRoute | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as CommuteRoute;
    return v && typeof v.mins === "number" && Array.isArray(v.legs) ? v : null;
  } catch {
    return null;
  }
}

function parseRaw(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function label(col: number | null, min: unknown, max: unknown, unit: string): string {
  const hasRange = typeof min === "number" && typeof max === "number";
  if (hasRange && min !== max) return `${min}-${max}${unit}`;
  const single = col ?? (hasRange ? (min as number) : null);
  return single != null ? `${single}${unit}` : `?${unit}`;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Great-circle distance in km. */
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
