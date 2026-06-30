import { spawnSync } from "node:child_process";
import type { Adapter, RawListing } from "../core/types.ts";

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

export const homeharvest: Adapter = {
  name: "homeharvest",
  snapshotComplete: false,
  enabled() {
    return process.env.HOUSING_HOMEHARVEST === "1"
      ? { ok: true }
      : { ok: false, reason: "set HOUSING_HOMEHARVEST=1 (after `uv sync`)" };
  },
  async fetch(): Promise<RawListing[]> {
    const location = process.env.HOMEHARVEST_LOCATION || "San Francisco, CA";
    const pastDays = process.env.HOMEHARVEST_PAST_DAYS || "3";
    const res = spawnSync(
      "uv",
      [
        "run",
        "python",
        "scripts/homeharvest_fetch.py",
        "--location",
        location,
        "--past-days",
        pastDays,
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    if (res.status !== 0) {
      throw new Error(`homeharvest bridge failed: ${(res.stderr || "").trim().slice(0, 300)}`);
    }
    const rows = JSON.parse(res.stdout) as HhRow[];
    return rows.map(map);
  },
};

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
