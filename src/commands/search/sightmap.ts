import { defineSource } from "../../source.ts";
import { facet } from "../../core/facet.ts";
import { fetchJson, fetchText } from "../../core/http.ts";
import type { RawListing } from "../../core/types.ts";

// Engrain SightMap — the interactive availability map embedded on many SF tower
// marketing sites. Each embed is backed by a public, unauthenticated JSON API
// (https://sightmap.com/app/api/v1/<key>/sightmaps/<id>) returning every
// currently-available unit with unit number, exact rent, sqft, floor and
// available-on date. The <key>/<id> pair is re-derived from the embed page HTML
// on every run (they can rotate when a property re-provisions), so the registry
// below only pins the stable embed id found in each building's floorplans page.
//
// Availability semantics: `units[]` contains only leasable inventory, and a
// unit with price/available_on null (38 Dolores does this at zero availability)
// is not actually listed — filtered out below. Absence ⇒ delisted, so the
// source is snapshot-complete. If ANY building fails to fetch we throw instead
// of returning a partial set: a partial snapshot would false-remove every
// listing of the missing building.
//
// Registry researched + verified 2026-08-02 (per-building agents fetched each
// embed + API live). Note The Ansel's own site (RentCafe) sits behind Cloudflare
// Turnstile — its SightMap is the only anonymously reachable feed. The Oak's
// SightMap unit feed is currently empty (plan-level pricing comes from the
// separate `theoak` source); it stays here so units flow the day Engrain's feed
// is switched on.
interface Building {
  /** Stable slug used in sourceId ("<slug>:<unit_number>"). */
  slug: string;
  name: string;
  address: string;
  neighborhood: string;
  lat: number;
  lon: number;
  /** sightmap.com/embed/<embedId> as found in the building's floorplans page. */
  embedId: string;
  /** Human-facing availability page (listing URL base). */
  pageUrl: string;
}

const BUILDINGS: Building[] = [
  {
    slug: "brady",
    name: "The Brady",
    address: "1 Brady St",
    neighborhood: "Market Octavia / Hub",
    lat: 37.7719,
    lon: -122.4222,
    embedId: "jlw0nexgp2y",
    pageUrl: "https://www.thebradysf.com/floorplans/",
  },
  {
    slug: "38dolores",
    name: "38 Dolores",
    address: "38 Dolores St",
    neighborhood: "Duboce / Market Octavia",
    lat: 37.7683,
    lon: -122.4269,
    embedId: "5evejxr2wqo",
    pageUrl: "https://38doloressf.com/floorplans/",
  },
  {
    slug: "100vanness",
    name: "100 Van Ness",
    address: "100 Van Ness Ave",
    neighborhood: "Civic Center / Van Ness corridor",
    lat: 37.777,
    lon: -122.4194,
    embedId: "dqw97o85vo9",
    pageUrl: "https://100vanness.com/floorplans/",
  },
  {
    slug: "ansel",
    name: "The Ansel",
    address: "1699 Market St",
    neighborhood: "Hub / Mid-Market",
    lat: 37.771,
    lon: -122.423,
    embedId: "y8px5g93v19",
    pageUrl: "https://www.liveanselsf.com/floorplans",
  },
  {
    slug: "chorus",
    name: "Chorus",
    address: "30 Otis St",
    neighborhood: "Hub / Market Octavia",
    lat: 37.7716,
    lon: -122.421,
    embedId: "0n9w6r13w71",
    pageUrl: "https://www.rentchorus.com/floor-plans",
  },
  {
    slug: "theoak",
    name: "The Oak",
    address: "55 Oak St",
    neighborhood: "Hub / Hayes Valley",
    lat: 37.7752,
    lon: -122.4213,
    embedId: "n9w60rrew71",
    pageUrl: "https://www.theoaksf.com/residences",
  },
];

const PAGE_DELAY_MS = 250;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SmUnit {
  id: string;
  unit_number: string;
  display_unit_number?: string | null;
  price: number | null;
  display_price: string | null;
  total_price: unknown;
  area: number | null;
  available_on: string | null;
  display_available_on: string | null;
  floor_id: string | null;
  floor_plan_id: string | null;
  specials_description?: string | null;
}

interface SmPayload {
  data: {
    asset?: { id: string; name: string };
    units: SmUnit[];
    floor_plans: {
      id: string;
      /** Usually a string; The Brady nests it as {name, provider_id}. */
      name: string | { name?: string } | null;
      bedroom_count: number | string | null;
      bathroom_count: number | string | null;
    }[];
    floors: { id: string; filter_label: string | null }[];
  };
}

/** Plan name is a plain string on most assets; The Brady serves a JSON-encoded {name, provider_id} string. */
function parsePlanName(v: string | { name?: string } | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "object") return v.name?.trim() || null;
  const s = v.trim();
  if (s.startsWith("{")) {
    try {
      return parsePlanName(JSON.parse(s) as { name?: string });
    } catch {
      return s;
    }
  }
  return s || null;
}

const num = (v: number | string | null | undefined): number | null => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

async function fetchBuilding(b: Building): Promise<RawListing[]> {
  // Embed page → current API key/id (self-healing if the ids rotate).
  const embedHtml = await fetchText(`https://sightmap.com/embed/${b.embedId}`, {
    timeoutMs: 20_000,
    retries: 2,
  });
  const m = embedHtml.match(/app\/api\/v1\/([a-z0-9]+)\/sightmaps\/(\d+)/);
  if (!m) throw new Error(`${b.slug}: no API path in embed page (embed ${b.embedId})`);

  const payload = await fetchJson<SmPayload>(
    `https://sightmap.com/app/api/v1/${m[1]}/sightmaps/${m[2]}`,
    { headers: { accept: "application/json" }, timeoutMs: 20_000, retries: 2 },
  );
  const plans = new Map(payload.data.floor_plans.map((p) => [p.id, p]));
  const floors = new Map(payload.data.floors.map((f) => [f.id, f.filter_label]));

  const out: RawListing[] = [];
  for (const u of payload.data.units) {
    if (u.price == null && u.available_on == null) continue; // map-only stub, not listed
    const plan = u.floor_plan_id ? plans.get(u.floor_plan_id) : undefined;
    const planName = parsePlanName(plan?.name);
    const floorLabel = (u.floor_id ? floors.get(u.floor_id) : null) ?? null;
    const beds = num(plan?.bedroom_count);
    const baths = num(plan?.bathroom_count);
    // display_unit_number can carry a marketing prefix ("APT A-122").
    const unitNo = (u.display_unit_number || u.unit_number).replace(/^(APT|UNIT)\s+/i, "");
    out.push({
      sourceId: `${b.slug}:${u.unit_number}`,
      url: `${b.pageUrl}#unit-${encodeURIComponent(u.unit_number)}`,
      title: [`${b.name} #${unitNo}`, planName, floorLabel].filter(Boolean).join(" · "),
      address: `${b.address} #${unitNo}`,
      city: "San Francisco",
      neighborhood: b.neighborhood,
      lat: b.lat,
      lon: b.lon,
      price: u.price,
      beds,
      baths,
      sqft: u.area,
      propertyType: "apartment",
      changeTag: `${u.price ?? ""}|${u.available_on ?? ""}|${u.specials_description ?? ""}`,
      raw: {
        ...facet({
          buildingName: b.name,
          minBeds: beds,
          maxBeds: beds,
          minBaths: baths,
          maxBaths: baths,
          minPrice: u.price,
          maxPrice: u.price,
          amenities: [b.name, planName, floorLabel, u.specials_description]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
        }),
        unitNumber: unitNo,
        floor: floorLabel,
        floorPlan: planName,
        availableOn: u.available_on,
        specials: u.specials_description ?? null,
      },
    });
  }
  return out;
}

export default defineSource({
  name: "sightmap",
  summary:
    "Engrain SightMap availability APIs on SF tower marketing sites (The Brady, 38 Dolores, 100 Van Ness, The Ansel, Chorus, The Oak) — unit-level rent, sqft, floor and available-on, straight from each building's own leasing feed.",
  when: "Use for first-party unit-level availability at the registered Hub/Market-Octavia towers; snapshot-complete (absence ⇒ delisted). No filters — the full set is small.",
  snapshotComplete: true,
  async fetch(_env, { log }): Promise<RawListing[]> {
    const out: RawListing[] = [];
    const errors: string[] = [];
    for (const [i, b] of BUILDINGS.entries()) {
      if (i > 0) await sleep(PAGE_DELAY_MS);
      try {
        const listings = await fetchBuilding(b);
        log.info(`sightmap: ${b.slug} → ${listings.length} units`);
        out.push(...listings);
      } catch (err) {
        errors.push(`${b.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Partial snapshot would false-remove every unit of a failed building.
    if (errors.length) throw new Error(`sightmap: ${errors.join("; ")}`);
    return out;
  },
});
