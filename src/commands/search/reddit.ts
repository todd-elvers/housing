import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { httpFetch } from "../../core/http.ts";
import { facet } from "../../core/facet.ts";
import type { RawListing } from "../../core/types.ts";

// Reddit OAuth Data API — NEW-lead intel (private landlords / sublets posted in
// SF housing subs), not structured listings. Needs a free "script" app
// (reddit.com/prefs/apps) whose id/secret exchange for an app-only bearer token.
//
// Endpoints (documented, https://www.reddit.com/dev/api):
//   • POST https://www.reddit.com/api/v1/access_token
//       Auth: HTTP Basic <client_id:client_secret>; body grant_type=client_credentials
//       → { access_token, token_type:"bearer", expires_in:3600, scope:"*" }.
//       (client_credentials = "application-only OAuth"; valid for confidential
//        script/web apps that carry a secret — no username/password needed.)
//   • GET  https://oauth.reddit.com/r/{sub}/search
//       Headers: Authorization: Bearer <token>, User-Agent: <descriptive>
//       Params: q, restrict_sr, sort(relevance|hot|top|new|comments), t(hour|day|
//               week|month|year|all), type(link), limit(<=100), after, raw_json=1.
//       → { kind:"Listing", data:{ after, children:[{ kind:"t3", data:{…link…} }] } }.
//
// Reddit REQUIRES a unique, descriptive User-Agent or it 429s / blocks; we build
// one in the recommended `platform:app:version (by /u/user)` form and reuse it.
//
// NOTE (2026-07): could NOT live-verify — REDDIT_CLIENT_ID/SECRET are unset here
// and Reddit 403-blocks unauthenticated .json from this host, so the response
// shape below is driven by Reddit's documented `t3` link schema, not a captured
// body. The mapping is null-safe against every field being absent.
//
// Link `data` has NO structured price/beds/baths — those live in free text
// (title/selftext). We best-effort extract them with high-precision patterns
// (see extract*()) and otherwise leave them null rather than guess.

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";
const PER_REQUEST_MAX = 100; // Reddit caps search `limit` at 100 per request.
const MAX_PAGES = 10; // safety valve on `after` pagination per subreddit.
const PAGE_DELAY_MS = 350; // be gentle between paginated requests.
const DEFAULT_QUERY = "apartment OR rent OR sublet OR lease OR housing";
const SORTS = ["relevance", "hot", "top", "new", "comments"] as const;
const TIMES = ["hour", "day", "week", "month", "year", "all"] as const;

/** A Reddit link (t3) `data` object — every field optional/defensive. */
interface RedditLink {
  name?: string; // fullname, e.g. "t3_abc123" (stable id)
  id?: string;
  title?: string;
  permalink?: string; // relative, e.g. "/r/sanfrancisco/comments/…/title/"
  url?: string; // external link for link-posts; permalink URL for self-posts
  selftext?: string;
  link_flair_text?: string | null;
  created_utc?: number; // epoch SECONDS (float)
  edited?: number | boolean; // false, or epoch seconds when the body was edited
  subreddit?: string;
  subreddit_name_prefixed?: string; // "r/sanfrancisco"
  author?: string;
  domain?: string;
  num_comments?: number;
  score?: number;
  ups?: number;
  is_self?: boolean;
  over_18?: boolean;
  stickied?: boolean;
}
interface RedditChild {
  kind?: string; // "t3" for links
  data?: RedditLink;
}
interface RedditListing {
  kind?: string;
  data?: { after?: string | null; children?: RedditChild[] };
}
interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const splitCsv = (s: string | undefined): string[] =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export default defineSource({
  name: "reddit",
  summary:
    "Reddit OAuth search across SF housing subs — NEW-lead intel on private-landlord/sublet posts, not structured listings. Best-effort price/beds/baths pulled from post text.",
  when: "Use to surface off-market leads (private landlords, sublets) posted to r/sanfrancisco, r/bayarea, r/AskSF; posts are near-immutable so treat as a new-only feed. Needs a free Reddit script app.",
  snapshotComplete: false,
  // All optional: `ingest` runs with none set (env config drives the query); an
  // operator/LLM passes any combination to `search reddit` for ad-hoc lookups.
  input: z.object({
    subs: z
      .string()
      .optional()
      .describe(
        "Comma-separated subreddits to search (overrides REDDIT_SUBS), e.g. sanfrancisco,bayarea,AskSF",
      ),
    query: z
      .string()
      .optional()
      .describe('Reddit search query (boolean syntax ok), e.g. "apartment OR rent OR sublet"'),
    sort: z
      .enum(SORTS)
      .optional()
      .describe("Result sort: relevance|hot|top|new|comments (default new)"),
    time: z
      .enum(TIMES)
      .optional()
      .describe("Time window; only affects top/relevance/comments sorts (default week)"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PER_REQUEST_MAX * MAX_PAGES)
      .optional()
      .describe(`Max posts per subreddit (paginates in ${PER_REQUEST_MAX}s, default 50)`),
  }),
  requires: {
    REDDIT_CLIENT_ID: envSpec(
      z.string().min(1),
      "Reddit script-app client id",
      "https://www.reddit.com/prefs/apps",
    ),
    REDDIT_CLIENT_SECRET: envSpec(
      z.string().min(1),
      "Reddit script-app secret",
      "https://www.reddit.com/prefs/apps",
    ),
    REDDIT_USERNAME: envSpec(
      z.string().default(""),
      "Reddit username (used only to build a descriptive User-Agent)",
      "",
    ),
    REDDIT_SUBS: envSpec(
      z.string().default("sanfrancisco,bayarea,AskSF"),
      "Comma-separated housing subreddits",
      "",
    ),
    REDDIT_QUERY: envSpec(
      z.string().default(DEFAULT_QUERY),
      "Default search query used by `ingest`",
      "",
    ),
    REDDIT_LIMIT: envSpec(
      z.coerce
        .number()
        .int()
        .min(1)
        .max(PER_REQUEST_MAX * MAX_PAGES)
        .default(50),
      "Default max posts fetched per subreddit per run",
      "",
    ),
  },
  async fetch(env, { input, log }): Promise<RawListing[]> {
    const subs = splitCsv(input.subs ?? env.REDDIT_SUBS);
    if (!subs.length) {
      throw new Error("reddit: no subreddits configured (set REDDIT_SUBS or pass --subs)");
    }
    const query = input.query ?? env.REDDIT_QUERY;
    const sort = input.sort ?? "new";
    const time = input.time ?? "week";
    const perSubLimit = input.limit ?? env.REDDIT_LIMIT;

    const username = (env.REDDIT_USERNAME || "anonymous").trim() || "anonymous";
    // Reddit's recommended UA format; a descriptive UA is mandatory for the API.
    const ua = `web:housing-monitor:v0.1 (by /u/${username})`;
    const token = await getToken(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, ua);
    const headers = { authorization: `Bearer ${token}`, "user-agent": ua };

    // Dedup by stable fullname across subs (a post lives in one sub, but guard anyway).
    const byId = new Map<string, RawListing>();
    for (const sub of subs) {
      try {
        const links = await fetchSub(sub, { query, sort, time, limit: perSubLimit, headers });
        for (const link of links) {
          const listing = map(link, sub);
          if (listing && !byId.has(listing.sourceId)) byId.set(listing.sourceId, listing);
        }
      } catch (err) {
        // A private/banned/missing sub or a transient block shouldn't kill the run.
        log.info(`reddit: r/${sub} skipped — ${(err as Error).message}`);
      }
    }
    log.info(`reddit: ${byId.size} post(s) across ${subs.length} sub(s)`);
    return [...byId.values()];
  },
});

/** Exchange client id/secret for an app-only bearer token (never logs the secret). */
async function getToken(id: string, secret: string, ua: string): Promise<string> {
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await httpFetch(TOKEN_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": ua,
    },
    body: "grant_type=client_credentials",
    timeoutMs: 20_000,
  });
  if (!res.ok) {
    // Status only — the Basic credential is in a header and never surfaced.
    throw new Error(
      `reddit: token request failed (HTTP ${res.status}) — check REDDIT_CLIENT_ID/SECRET`,
    );
  }
  const json = (await res.json().catch(() => ({}) as TokenResponse)) as TokenResponse;
  if (json.error) throw new Error(`reddit: token error — ${json.error}`);
  if (!json.access_token) throw new Error("reddit: token response missing access_token");
  return json.access_token;
}

/** Search one subreddit, paginating with `after` up to `limit` link posts. */
async function fetchSub(
  sub: string,
  opts: {
    query: string;
    sort: (typeof SORTS)[number];
    time: (typeof TIMES)[number];
    limit: number;
    headers: Record<string, string>;
  },
): Promise<RedditLink[]> {
  const out: RedditLink[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PAGES && out.length < opts.limit; page++) {
    const want = Math.min(PER_REQUEST_MAX, opts.limit - out.length);
    const params = new URLSearchParams({
      q: opts.query,
      restrict_sr: "1", // stay within the sub (we iterate per-sub)
      sort: opts.sort,
      t: opts.time, // honored for top/relevance/comments; ignored for new/hot
      type: "link",
      limit: String(want),
      raw_json: "1", // don't HTML-escape &,<,> in title/selftext
    });
    if (after) params.set("after", after);
    const url = `${API_BASE}/r/${encodeURIComponent(sub)}/search?${params.toString()}`;
    const res = await httpFetch(url, { headers: opts.headers, timeoutMs: 20_000 });
    if (res.status === 429) throw new Error("rate limited (HTTP 429)");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json().catch(() => null)) as RedditListing | null;
    const children = json?.data?.children ?? [];
    if (!children.length) break;
    for (const c of children) {
      if (c?.kind === "t3" && c.data?.name) out.push(c.data);
    }
    after = json?.data?.after ?? null;
    if (!after) break; // last page
    if (out.length < opts.limit) await sleep(PAGE_DELAY_MS);
  }
  return out;
}

// ── Best-effort extraction from free-form post text ────────────────────────────
// Reddit exposes no structured price/beds/baths/sqft, so we only accept patterns
// tight enough to avoid false positives (e.g. "$500 deposit"); ambiguous → null.

/** Monthly rent — requires an explicit month qualifier so deposits/fees don't match. */
function extractPrice(text: string): number | null {
  const re =
    /\$?\s*(\d{3,5}|\d{1,2},\d{3})\s*(?:\/\s*mo|\/\s*month|\bper\s+month|\ba\s+month|\bmonthly|\bmo\b|\bmonth\b)/gi;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 500 && n <= 25_000) return n;
  }
  return null;
}

function extractBeds(text: string): number | null {
  if (/\bstudios?\b/i.test(text)) return 0;
  const m = text.match(/\b(\d{1,2})\s*(?:bed(?:room)?s?|bd|br)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 && n <= 12 ? n : null;
}

function extractBaths(text: string): number | null {
  const m = text.match(/\b(\d{1,2}(?:\.\d)?)\s*(?:bath(?:room)?s?|ba)\b/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 && n <= 12 ? n : null;
}

function extractSqft(text: string): number | null {
  const m = text.match(/\b(\d{3,5}|\d,\d{3})\s*(?:sq\s*\.?\s*ft|sqft|square\s*feet|sf)\b/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n >= 100 && n <= 20_000 ? n : null;
}

function map(d: RedditLink, sub: string): RawListing | null {
  const id = d.name;
  if (!id) return null;
  const url = d.permalink
    ? `https://www.reddit.com${d.permalink}`
    : `https://www.reddit.com/r/${encodeURIComponent(d.subreddit ?? sub)}/`;
  const title = d.title ?? "";
  const body = d.selftext ?? "";
  const flair = d.link_flair_text ?? null;
  const text = `${title}\n${body}`;

  const price = extractPrice(text);
  const beds = extractBeds(text);
  const baths = extractBaths(text);
  const sqft = extractSqft(text);

  const subLabel = d.subreddit_name_prefixed ?? `r/${d.subreddit ?? sub}`;
  // Full-text amenity blob for `find`'s LIKE match: title + body + flair + sub.
  const amenities = `${title} ${body} ${flair ?? ""} ${subLabel}`
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
  const editedTag = typeof d.edited === "number" ? String(Math.round(d.edited)) : "";
  const postedAt = typeof d.created_utc === "number" ? Math.round(d.created_utc * 1000) : null;

  return {
    sourceId: id,
    url,
    title: title || null,
    address: null,
    city: null,
    // Reddit posts carry no structured neighborhood; the subreddit is the only
    // geographic signal and `find` displays this column, so surface it here.
    neighborhood: subLabel,
    lat: null,
    lon: null,
    price,
    beds,
    baths,
    sqft,
    propertyType: "reddit-post",
    postedAt,
    // Mutation signal: title is immutable, but a body edit sets `edited` and OPs
    // flip flair (e.g. "RENTED"). Score/comment churn is deliberately excluded.
    changeTag: `${title}|${editedTag}|${flair ?? ""}`,
    raw: {
      ...facet({
        minBeds: beds,
        maxBeds: beds,
        minBaths: baths,
        maxBaths: baths,
        minPrice: price,
        maxPrice: price,
        amenities,
        buildingName: null,
      }),
      // Extra Reddit context preserved for triage / later enrichment.
      subreddit: d.subreddit ?? sub,
      subredditPrefixed: subLabel,
      author: d.author ?? null,
      permalink: d.permalink ?? null,
      linkUrl: d.url ?? null, // external link for link-posts
      domain: d.domain ?? null,
      isSelf: d.is_self ?? null,
      flair,
      numComments: d.num_comments ?? null,
      score: d.score ?? d.ups ?? null,
      over18: d.over_18 ?? null,
      stickied: d.stickied ?? null,
      edited: editedTag || false,
      selftext: body ? body.slice(0, 2000) : null,
    },
  };
}
