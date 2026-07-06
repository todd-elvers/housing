/**
 * The `raw` JSON "facet" that the `find` command queries (via json_extract) and
 * displays. Producers (rental sources) build it with facet(); the query
 * references keys through facetPath(k: keyof RawFacet) — so a mis-spelled key is
 * a compile error on BOTH ends, instead of a silently-empty filter result.
 */
export interface RawFacet {
  buildingName: string | null;
  minBeds: number | null;
  maxBeds: number | null;
  minBaths: number | null;
  maxBaths: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** Pre-flattened, lowercased amenity text for LIKE matching. */
  amenities: string;
}

export function facet(f: Partial<RawFacet>): RawFacet {
  return {
    buildingName: f.buildingName ?? null,
    minBeds: f.minBeds ?? null,
    maxBeds: f.maxBeds ?? null,
    minBaths: f.minBaths ?? null,
    maxBaths: f.maxBaths ?? null,
    minPrice: f.minPrice ?? null,
    maxPrice: f.maxPrice ?? null,
    amenities: f.amenities ?? "",
  };
}

/** SQLite json path for a facet key, key-checked against RawFacet. */
export const facetPath = (k: keyof RawFacet): string => `json_extract(raw,'$.${k}')`;
