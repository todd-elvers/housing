import { fetchJson } from "../core/http.ts";
import type { Adapter, RawListing } from "../core/types.ts";

// Craigslist `sapi` returns compact positional arrays + inline decode tables.
// Layout (verified against sfbay/apa): indices 0-5 are fixed scalars, 6+ is a
// mix of tagged sub-arrays and the title string.
//   [0] postingId delta  (+ decode.minPostingId)
//   [1] postedDate delta (+ decode.minPostedDate, seconds)
//   [3] price
//   [4] "locIdx:?:locIdx~lat~lon"  → decode.locations[locIdx] = [type,"sfbay",sub]
//   tagged: [6,slug]  [5,beds,sqft]  [10,"$price"]  [4,...images]  [13,host]
//
// `postedToday=1&sort=date` makes this a NEW-listing feed for the whole Bay
// Area (filter to SF/`sfc` downstream). Requires a residential IP.
const SAPI =
  "https://sapi.craigslist.org/web/v8/postings/search/full" +
  "?batch=1-0-360-1-0&cc=US&lang=en&searchPath=apa&sort=date&postedToday=1";

interface SapiResponse {
  data: {
    items: unknown[][];
    decode: {
      minPostingId: number;
      minPostedDate: number;
      locations: [number, string, string][];
    };
  };
}

export const craigslist: Adapter = {
  name: "craigslist",
  snapshotComplete: false, // "posted today" feed — absence ≠ removed
  enabled() {
    return { ok: true };
  },
  async fetch(): Promise<RawListing[]> {
    const body = await fetchJson<SapiResponse>(SAPI, {
      headers: { referer: "https://sfbay.craigslist.org/search/apa" },
    });
    const { items, decode } = body.data;
    return items.map((it) => decodeItem(it, decode));
  },
};

function decodeItem(it: unknown[], decode: SapiResponse["data"]["decode"]): RawListing {
  const pid = decode.minPostingId + (it[0] as number);
  const postedAt = (decode.minPostedDate + (it[1] as number)) * 1000;
  const price = typeof it[3] === "number" ? it[3] : null;

  let lat: number | null = null;
  let lon: number | null = null;
  let locIdx: number | null = null;
  const geo = String(it[4] ?? "");
  const gm = geo.match(/^(\d+):\d+:(\d+)~(-?[\d.]+)~(-?[\d.]+)/);
  if (gm) {
    locIdx = Number(gm[2]);
    lat = Number(gm[3]);
    lon = Number(gm[4]);
  }

  let slug = "";
  let title = "";
  let beds: number | null = null;
  let sqft: number | null = null;
  for (let i = 6; i < it.length; i++) {
    const el = it[i];
    if (typeof el === "string") {
      title = el;
    } else if (Array.isArray(el)) {
      const code = el[0];
      if (code === 6) slug = String(el[1] ?? "");
      else if (code === 5) {
        beds = typeof el[1] === "number" ? el[1] : null;
        sqft = typeof el[2] === "number" && el[2] > 0 ? el[2] : null;
      }
    }
  }

  const loc = locIdx != null ? decode.locations[locIdx] : undefined;
  const area = loc?.[1] ?? "sfbay";
  const sub = loc?.[2] ?? null;
  const url = sub
    ? `https://${area}.craigslist.org/${sub}/apa/d/${slug}/${pid}.html`
    : `https://${area}.craigslist.org/apa/d/${slug}/${pid}.html`;

  return {
    sourceId: String(pid),
    url,
    title,
    price,
    beds,
    sqft,
    lat,
    lon,
    neighborhood: sub,
    city: null,
    postedAt,
    changeTag: price != null ? String(price) : "",
  };
}
