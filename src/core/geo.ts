import { existsSync, readFileSync } from "node:fs";

// Point-in-polygon geo lookups against the committed GeoJSON in data/. Used by
// `find` (neighborhood filter) and by the notification cards (to label a listing
// whose source didn't provide a neighborhood). Parsing is cached per process.

/** Ray-casting point-in-polygon. `ring` is GeoJSON [lon, lat] pairs. */
export function pointInPolygon(lat: number, lon: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]; // xi=lon, yi=lat
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

interface Hood {
  name: string;
  rings: [number, number][][]; // exterior ring per polygon (MultiPolygon → many)
}

let HOODS: Hood[] | null = null;

function loadNeighborhoods(): Hood[] {
  if (HOODS !== null) return HOODS;
  const path = "data/neighborhoods.geojson";
  if (!existsSync(path)) return (HOODS = []);
  try {
    const g = JSON.parse(readFileSync(path, "utf8"));
    type GeoFeature = {
      properties: { name: string };
      geometry: { type: string; coordinates: unknown };
    };
    HOODS = (g.features as GeoFeature[])
      .filter((f) => f.geometry?.type === "Polygon" || f.geometry?.type === "MultiPolygon")
      .map((f) => {
        const rings: [number, number][][] =
          f.geometry.type === "Polygon"
            ? [(f.geometry.coordinates as [number, number][][])[0]]
            : (f.geometry.coordinates as [number, number][][][]).map((poly) => poly[0]);
        return { name: f.properties.name, rings };
      });
    return HOODS;
  } catch {
    return (HOODS = []);
  }
}

/** The SF neighborhood containing the point, or null (no data / outside all). */
export function neighborhoodAt(
  lat: number | null | undefined,
  lon: number | null | undefined,
): string | null {
  if (lat == null || lon == null) return null;
  for (const h of loadNeighborhoods()) {
    if (h.rings.some((ring) => pointInPolygon(lat, lon, ring))) return h.name;
  }
  return null;
}
