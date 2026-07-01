import { defineSource } from "../../source.ts";
import { fetchJson } from "../../core/http.ts";
import type { RawListing } from "../../core/types.ts";

// DAHLIA — SF's official affordable/BMR housing portal. Free, no auth, no
// anti-bot. These are income-capped lottery units (mostly application-gated),
// so scope-limited for a market-rate hunt, but the authoritative affordable feed.
const URL = "https://housing.sfgov.org/api/v1/listings.json?type=rental";

interface DahliaResponse {
  listings?: DahliaListing[];
}
interface DahliaListing {
  Id: string;
  Name?: string;
  Building_Street_Address?: string;
  Building_City?: string;
  Status?: string;
  Lottery_Status?: string;
  Units_Available?: number;
  Application_Due_Date?: string;
  LastModifiedDate?: string;
  unitSummaries?: { general?: { minMonthlyRent?: number; unitType?: string }[] };
}

export default defineSource({
  name: "dahlia",
  summary:
    "SF DAHLIA affordable/BMR housing portal — the authoritative feed for income-capped lottery rentals.",
  when: "Use for SF affordable/below-market-rate units; mostly application-gated lottery listings, so skip it for a market-rate hunt.",
  snapshotComplete: true,
  async fetch(): Promise<RawListing[]> {
    const data = await fetchJson<DahliaResponse>(URL);
    return (data.listings ?? []).map(map);
  },
});

function map(l: DahliaListing): RawListing {
  const rents = (l.unitSummaries?.general ?? [])
    .map((u) => u.minMonthlyRent)
    .filter((r): r is number => typeof r === "number");
  const price = rents.length ? Math.min(...rents) : null;
  return {
    sourceId: l.Id,
    url: `https://housing.sfgov.org/listings/${l.Id}`,
    title: l.Name ?? null,
    address: l.Building_Street_Address ?? null,
    city: l.Building_City ?? "San Francisco",
    price,
    propertyType: "affordable",
    changeTag: [
      l.Status,
      l.Lottery_Status,
      l.Units_Available,
      l.Application_Due_Date,
      l.LastModifiedDate,
    ]
      .map((v) => v ?? "")
      .join("|"),
    raw: {
      status: l.Status,
      lotteryStatus: l.Lottery_Status,
      unitsAvailable: l.Units_Available,
      applicationDue: l.Application_Due_Date,
    },
  };
}
