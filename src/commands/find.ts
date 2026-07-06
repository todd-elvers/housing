import { z } from "zod";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { defineTool } from "../tool.ts";
import { envSpec } from "../env/spec.ts";
import { log } from "../core/log.ts";
import { facetPath } from "../core/facet.ts";

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
}

export default defineTool({
  summary:
    "Search the ingested rental DB by beds/baths/price/keyword and rank results by distance from a point.",
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
    minPrice: z.coerce.number().optional().describe("Minimum monthly rent"),
    maxPrice: z.coerce.number().optional().describe("Maximum monthly rent"),
    match: z
      .string()
      .optional()
      .describe("Keyword required in title/address/amenities (e.g. gym, tower, luxury)"),
    source: z.string().optional().describe("Limit to one source"),
    limit: z.coerce.number().default(25).describe("Max results"),
  }),
  requires: {
    HOUSING_DB: envSpec(z.string().default("data/housing.db"), "SQLite database path", ""),
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
        `SELECT source, title, address, neighborhood, price, beds, baths, lat, lon, url, raw
         FROM listings WHERE ${where.join(" AND ")}`,
      )
      .all(...params) as unknown as Row[];
    db.close();

    let anchor: { lat: number; lon: number } | null = null;
    if (input.near) {
      const [la, lo] = input.near.split(",").map((s) => Number(s.trim()));
      if (!Number.isFinite(la) || !Number.isFinite(lo)) {
        throw new Error(`--near must be 'lat,lon' (got '${input.near}')`);
      }
      anchor = { lat: la, lon: lo };
    }

    let results = rows.map((r) => {
      const raw = parseRaw(r.raw);
      const amenities = String(raw.amenities ?? "").toLowerCase();
      const gym =
        /gym|fitness/.test(amenities) || /gym|fitness/.test((r.title ?? "").toLowerCase());
      const distanceKm =
        anchor && r.lat != null && r.lon != null
          ? round(haversine(anchor.lat, anchor.lon, r.lat, r.lon))
          : null;
      return {
        source: r.source,
        building: (raw.buildingName as string | null) ?? null,
        title: r.title,
        address: r.address,
        neighborhood: r.neighborhood,
        price: r.price ?? (typeof raw.minPrice === "number" ? raw.minPrice : null),
        beds: label(r.beds, raw.minBeds, raw.maxBeds, "BR"),
        baths: label(r.baths, raw.minBaths, raw.maxBaths, "BA"),
        gym,
        distanceKm,
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
    results.sort(
      (a, b) =>
        (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9) || (a.price ?? 1e9) - (b.price ?? 1e9),
    );
    results = results.slice(0, input.limit);

    log.print(
      `\n${results.length} match(es)` +
        (anchor ? ` within ${input.radius}km of ${anchor.lat},${anchor.lon}` : "") +
        "\n",
    );
    for (const r of results) {
      const dist = r.distanceKm != null ? `${r.distanceKm}km` : "—";
      const price = r.price ? `$${r.price.toLocaleString()}` : "n/a";
      log.print(
        `  ${dist.padStart(6)}  ${`${r.beds}/${r.baths}`.padEnd(11)} ${price.padStart(8)}  ${r.gym ? "🏋️ gym " : "       "}` +
          `${(r.building ?? r.title ?? r.address ?? "").slice(0, 42)}  [${r.source}]`,
      );
      log.print(`          ${r.neighborhood ?? ""}  ${r.url}`);
    }
    if (hiddenNoCoord > 0) {
      log.print(`  (${hiddenNoCoord} more match(es) hidden — no coordinates to check distance)`);
    }
    return results;
  },
});

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
