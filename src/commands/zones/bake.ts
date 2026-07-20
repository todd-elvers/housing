import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { defineTool } from "../../tool.ts";
import { envSpec } from "../../env/spec.ts";
import { log } from "../../core/log.ts";

// Fetch transit isochrone polygons from TravelTime and save them to
// data/commute-zones.geojson. This is a one-time bake — the result is
// committed to the repo and used by `housing find --maxCommute` at zero
// runtime cost (no API calls during search).
//
// Uses an ARRIVAL search: "to reach the office by 9am on a Tuesday, where
// can you depart from?" — this correctly models the peak inbound commute.
//
// TravelTime allows up to 10 arrival_searches per request, so large contour
// sets are automatically batched.

interface LatLng {
  lat: number;
  lng: number;
}
interface TravelTimeShape {
  shell: LatLng[];
  holes: LatLng[][];
}
interface TravelTimeResult {
  search_id: string;
  shapes: TravelTimeShape[];
}
interface TravelTimeResponse {
  results: TravelTimeResult[];
}

const BATCH_SIZE = 10;

export default defineTool({
  summary:
    "Fetch per-minute transit isochrone polygons from TravelTime and bake them into data/commute-zones.geojson.",
  when: "Run once (or re-run after moving the anchor) to refresh the commute-zone polygons used by `housing find --maxCommute`.",
  kind: "mutation",
  input: z.object({
    contours: z
      .string()
      .default("1-40")
      .describe(
        "Minutes to bake: a range like '1-30', explicit list '5,10,15', or mixed '1-20,25,30'",
      ),
    departureTime: z
      .string()
      .optional()
      .describe("ISO 8601 arrival time at office (default: next Tuesday 09:00 SF local time)"),
  }),
  requires: {
    TRAVELTIME_APPLICATION_ID: envSpec(
      z.string().min(1),
      "TravelTime application ID",
      "https://account.traveltime.com",
    ),
    TRAVELTIME_API_KEY: envSpec(
      z.string().min(1),
      "TravelTime API key",
      "https://account.traveltime.com",
    ),
    HOUSING_ANCHOR: envSpec(
      z.string().regex(/^-?\d+\.?\d*,-?\d+\.?\d*$/),
      "Office anchor 'lat,lon' — source of the isochrones",
      "",
    ),
  },
  async run({ input, env }) {
    const [anchorLat, anchorLon] = env.HOUSING_ANCHOR.split(",").map(Number);
    const contours = parseContours(input.contours);
    if (contours.length === 0) throw new Error("No valid contours parsed from: " + input.contours);

    const arrivalTime = input.departureTime ?? nextTuesdayMorning();
    log.print(`Anchor: ${anchorLat},${anchorLon}  |  arrival: ${arrivalTime}`);
    log.print(
      `Contours: ${contours[0]}–${contours[contours.length - 1]} min (${contours.length} zones, ${Math.ceil(contours.length / BATCH_SIZE)} batch(es))`,
    );

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-Application-Id": env.TRAVELTIME_APPLICATION_ID,
      "X-Api-Key": env.TRAVELTIME_API_KEY,
    };

    // Batch requests — TravelTime allows up to BATCH_SIZE arrival_searches per call.
    const allResults: TravelTimeResult[] = [];
    const batches = chunk(contours, BATCH_SIZE);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      log.print(`  batch ${i + 1}/${batches.length}: ${batch[0]}–${batch[batch.length - 1]} min…`);
      const body = {
        arrival_searches: batch.map((min) => ({
          id: `zone-${min}`,
          coords: { lat: anchorLat, lng: anchorLon },
          transportation: { type: "public_transport" },
          arrival_time: arrivalTime,
          travel_time: min * 60,
          properties: [],
        })),
      };
      const res = await fetch("https://api.traveltimeapp.com/v4/time-map", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`TravelTime ${res.status} (batch ${i + 1}): ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as TravelTimeResponse;
      allResults.push(...data.results);
    }

    // Build a GeoJSON FeatureCollection sorted smallest-contour-first (for
    // point-in-polygon early-exit in `housing find`).
    const features = contours.map((min) => {
      const result = allResults.find((r) => r.search_id === `zone-${min}`);
      if (!result || result.shapes.length === 0) {
        throw new Error(`TravelTime returned no shapes for ${min}-min zone`);
      }
      const polygons = result.shapes.map((s) => [toRing(s.shell), ...s.holes.map(toRing)]);
      const geometry =
        polygons.length === 1
          ? { type: "Polygon", coordinates: polygons[0] }
          : { type: "MultiPolygon", coordinates: polygons };
      return {
        type: "Feature",
        properties: { contour: min },
        geometry,
      };
    });

    const geojson = { type: "FeatureCollection", features };
    mkdirSync("data", { recursive: true });
    writeFileSync("data/commute-zones.geojson", JSON.stringify(geojson));
    const kb = Math.round(JSON.stringify(geojson).length / 1024);
    log.print(`Saved data/commute-zones.geojson (${features.length} zones, ${kb}KB)`);
    return {
      zones: contours.length,
      range: `${contours[0]}–${contours[contours.length - 1]}`,
      anchor: env.HOUSING_ANCHOR,
      arrivalTime,
    };
  },
});

/** Parse "1-30", "5,10,15", or mixed "1-20,25,30" into a sorted unique list. */
function parseContours(s: string): number[] {
  const nums = new Set<number>();
  for (const part of s.split(",").map((p) => p.trim())) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [, a, b] = range.map(Number);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) nums.add(i);
    } else {
      const n = parseInt(part, 10);
      if (n > 0) nums.add(n);
    }
  }
  return [...nums].sort((a, b) => a - b);
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Convert a TravelTime ring ({lat,lng}[]) to GeoJSON [lon,lat] pairs, closed. */
function toRing(pts: LatLng[]): [number, number][] {
  const ring: [number, number][] = pts.map((p) => [p.lng, p.lat]);
  if (
    ring.length > 0 &&
    (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])
  ) {
    ring.push(ring[0]);
  }
  return ring;
}

/** Next Tuesday at 09:00 America/Los_Angeles as a UTC ISO string. */
function nextTuesdayMorning(): string {
  const now = new Date();
  const daysUntilTuesday = (2 - now.getDay() + 7) % 7 || 7;
  const tuesday = new Date(now);
  tuesday.setDate(now.getDate() + daysUntilTuesday);
  tuesday.setUTCHours(16, 0, 0, 0); // 09:00 PDT = 16:00 UTC
  return tuesday.toISOString().replace(/\.\d{3}Z$/, "Z");
}
