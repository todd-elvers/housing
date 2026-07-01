import { spawnSync } from "node:child_process";
import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import type { RawListing } from "../../core/types.ts";

// HomeHarvest (Realtor.com) has no usable JS path, so we shell out to a Python
// bridge via uv. Disabled by default — set HOUSING_HOMEHARVEST=1 after `uv sync`.
interface HhRow {
  id?: string;
  url?: string;
  address?: string;
  city?: string;
  lat?: number;
  lon?: number;
  price?: number;
  beds?: number;
  baths?: number;
  sqft?: number;
  property_type?: string;
  list_date?: string;
}

export default defineSource({
  name: "homeharvest",
  summary:
    "Realtor.com rentals via the HomeHarvest Python scraper, shelled out through a `uv run` bridge.",
  when: "Use for Realtor.com/MLS inventory not covered by the JS sources; requires local `uv sync` and HOUSING_HOMEHARVEST=1.",
  snapshotComplete: false,
  requires: {
    HOUSING_HOMEHARVEST: envSpec(
      z.literal("1"),
      "Set to 1 to enable (needs `uv sync` first)",
      "run: uv sync",
    ),
    HOMEHARVEST_LOCATION: envSpec(
      z.string().default("San Francisco, CA"),
      "Location to scrape",
      "",
    ),
    HOMEHARVEST_PAST_DAYS: envSpec(
      z.coerce.number().default(3),
      "Only listings from the last N days",
      "",
    ),
  },
  async fetch(env): Promise<RawListing[]> {
    const res = spawnSync(
      "uv",
      [
        "run",
        "python",
        "scripts/homeharvest_fetch.py",
        "--location",
        env.HOMEHARVEST_LOCATION,
        "--past-days",
        String(env.HOMEHARVEST_PAST_DAYS),
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (res.status !== 0) {
      throw new Error(`homeharvest bridge failed: ${(res.stderr || "").trim().slice(0, 300)}`);
    }
    const rows = JSON.parse(res.stdout) as HhRow[];
    return rows.map(map);
  },
});

function map(r: HhRow): RawListing {
  return {
    sourceId: r.id || r.url || `${r.address}`,
    url: r.url || "https://www.realtor.com/",
    title: r.address ?? null,
    address: r.address ?? null,
    city: r.city ?? null,
    lat: r.lat ?? null,
    lon: r.lon ?? null,
    price: r.price ?? null,
    beds: r.beds ?? null,
    baths: r.baths ?? null,
    sqft: r.sqft ?? null,
    propertyType: r.property_type ?? null,
    postedAt: r.list_date ? Date.parse(r.list_date) || null : null,
    changeTag: `${r.price ?? ""}`,
  };
}
