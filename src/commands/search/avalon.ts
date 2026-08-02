import { defineSource } from "../../source.ts";
import { facet } from "../../core/facet.ts";
import { fetchJson } from "../../core/http.ts";
import type { RawListing } from "../../core/types.ts";

// AvalonBay Communities — first-party availability for AVA 55 Ninth (and any
// other Avalon community added to the registry). Their Arc Publishing site
// exposes an unauthenticated content API:
//   /pf/api/v3/content/fetch/community-units?query={"communityId":"AVB-CA100"}
// returning every available unit with the explicit unit number AND floor number
// (the 17th-floor watch keys off both), price, sqft, beds/baths and available
// date. Verified 2026-08-02: 200 to a bare fetch, no bot challenge (Akamai in
// front but passive), CDN-cached ~2min. The same JSON is also server-rendered
// into the community page HTML (Fusion.contentCache) if this endpoint ever
// moves. Absence from the feed ⇒ no longer listed, so snapshot-complete.
//
// Photos: `raw.imageUrl` is the unit's floor-plan diagram from
// resource.avalonbay.com (no real per-unit interior photo in this feed).
// card.ts's resolvePhotos() picks this key up automatically.
interface Community {
  /** AvalonBay community id, e.g. "AVB-CA100" (AVA 55 Ninth). */
  id: string;
  name: string;
  address: string;
  neighborhood: string;
  lat: number;
  lon: number;
}

const COMMUNITIES: Community[] = [
  {
    id: "AVB-CA100",
    name: "AVA 55 Ninth",
    address: "55 9th St",
    neighborhood: "Mid-Market",
    lat: 37.7768,
    lon: -122.4152,
  },
];

interface AvalonUnit {
  unitId: string;
  unitName: string;
  floorNumber: string | null;
  bedroomNumber: number | null;
  bathroomNumber: number | null;
  squareFeet: number | null;
  unitStatus: string | null;
  furnishStatus: string | null;
  availableDateUnfurnished: string | null;
  availableDateFurnished: string | null;
  url: string;
  address?: { addressLine1?: string; city?: string } | null;
  /** highResolution/lowResolution are paths relative to resource.avalonbay.com. */
  floorPlan?: { name?: string | null; highResolution?: string | null } | null;
  startingAtPricesUnfurnished?: { prices?: { price?: number | null } | null } | null;
  startingAtPricesFurnished?: { prices?: { price?: number | null } | null } | null;
}

const api = (communityId: string) =>
  "https://www.avaloncommunities.com/pf/api/v3/content/fetch/community-units?query=" +
  encodeURIComponent(JSON.stringify({ communityId }));

// Floor-plan diagrams live on a separate asset host, not avaloncommunities.com.
const IMAGE_BASE = "https://resource.avalonbay.com";

export default defineSource({
  name: "avalon",
  summary:
    "AvalonBay first-party availability API — unit-level price, sqft, unit number and explicit floor number for registered communities (currently AVA 55 Ninth).",
  when: "Use for first-party AVA 55 Ninth availability (the 17th-floor watch's authoritative feed — floorNumber is explicit); snapshot-complete (absence ⇒ delisted).",
  snapshotComplete: true,
  async fetch(_env, { log }): Promise<RawListing[]> {
    const out: RawListing[] = [];
    const errors: string[] = [];
    for (const c of COMMUNITIES) {
      try {
        const payload = await fetchJson<{ units?: AvalonUnit[] }>(api(c.id), {
          headers: { accept: "application/json" },
          timeoutMs: 20_000,
          retries: 2,
        });
        const units = payload.units ?? [];
        log.info(`avalon: ${c.name} → ${units.length} units`);
        for (const u of units) {
          const price =
            u.startingAtPricesUnfurnished?.prices?.price ??
            u.startingAtPricesFurnished?.prices?.price ??
            null;
          const availableOn = u.availableDateUnfurnished ?? u.availableDateFurnished ?? null;
          const imageUrl = u.floorPlan?.highResolution
            ? `${IMAGE_BASE}${u.floorPlan.highResolution}`
            : null;
          out.push({
            sourceId: u.unitId,
            url: u.url,
            title: [
              `${c.name} #${u.unitName}`,
              u.floorPlan?.name,
              u.floorNumber ? `floor ${u.floorNumber}` : null,
            ]
              .filter(Boolean)
              .join(" · "),
            address: u.address?.addressLine1 ?? `${c.address} #${u.unitName}`,
            city: u.address?.city ?? "San Francisco",
            neighborhood: c.neighborhood,
            lat: c.lat,
            lon: c.lon,
            price,
            beds: u.bedroomNumber,
            baths: u.bathroomNumber,
            sqft: u.squareFeet,
            propertyType: "apartment",
            changeTag: `${price ?? ""}|${availableOn ?? ""}|${u.unitStatus ?? ""}`,
            raw: {
              ...facet({
                buildingName: c.name,
                minBeds: u.bedroomNumber,
                maxBeds: u.bedroomNumber,
                minBaths: u.bathroomNumber,
                maxBaths: u.bathroomNumber,
                minPrice: price,
                maxPrice: price,
                amenities: [
                  c.name,
                  u.floorPlan?.name,
                  u.floorNumber ? `floor ${u.floorNumber}` : "",
                  u.furnishStatus,
                ]
                  .filter(Boolean)
                  .join(" ")
                  .toLowerCase(),
              }),
              unitNumber: u.unitName,
              floorNumber: u.floorNumber,
              unitStatus: u.unitStatus,
              furnishStatus: u.furnishStatus,
              availableOn,
              floorPlan: u.floorPlan?.name ?? null,
              imageUrl,
            },
          });
        }
      } catch (err) {
        errors.push(`${c.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // Partial snapshot would false-remove a failed community's units.
    if (errors.length) throw new Error(`avalon: ${errors.join("; ")}`);
    return out;
  },
});
