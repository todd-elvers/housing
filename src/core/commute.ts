import { DatabaseSync } from "node:sqlite";
import { Duration, Effect } from "effect";
import { apiLimitHint } from "./http.ts";
import { log } from "./log.ts";

// Two-tier commute enrichment for ingested listings:
//
//   Tier 1 — MATRIX (/v4/time-filter/fast, many_to_one): one cheap call gets the
//   total transit time from every listing to the office. Up to 100k departures
//   per search, so the whole DB fits in one request. Bucketed to a typical
//   "weekday_morning" (the /fast model has no exact-timestamp option), which is
//   plenty for the headline ~Nmin. Stored in listings.commute_min.
//
//   Tier 2 — ROUTES (/v4/routes): the per-leg walk/transit breakdown, but only
//   for listings the matrix says are within LEG_GATE_MIN transit-minutes — no
//   point spending an expensive Routes call on a 3-hour commute. Uses an exact
//   arrival (9am Tuesday) so the leg times are precise. Stored in
//   listings.commute_route as {mins, legs, geometry} — geometry being the full
//   door-to-office path used to draw the route on notification cards.
//
// Silently no-ops when credentials or HOUSING_ANCHOR aren't set, so ingest keeps
// working without TravelTime configured.

export interface CommuteLeg {
  mode: string; // "walk" | "bus" | "train" | "ferry" | "cable_car" | ...
  mins: number;
  line?: string; // short transit line code when available, e.g. "8AX"
}

export interface CommuteRoute {
  mins: number;
  legs: CommuteLeg[];
  /**
   * The full door-to-office path as [lat, lon] points, concatenated across every
   * part TravelTime returned. Absent on routes enriched before geometry was
   * captured; cards fall back to a straight home→office line in that case.
   */
  geometry?: [number, number][];
}

const MATRIX_URL = "https://api.traveltimeapp.com/v4/time-filter/fast";
const ROUTES_URL = "https://api.traveltimeapp.com/v4/routes";
const MATRIX_CHUNK = 2000; // departure ids per matrix search (well under the 100k cap; keeps payloads sane)
const ROUTES_BATCH = 10; // /v4/routes allows up to 10 searches per request
const MATRIX_MAX_SECS = 10800; // /fast travel_time ceiling (3h)
const ROUTES_MAX_SECS = 7200; // 2h ceiling for the leg-detail search
const RATE_PACE_MS = 11_000; // ~<60 searches/min for trial plans
const MAX_RETRIES = 4;
// Only fetch the expensive per-leg route for listings within this many transit
// minutes (per the matrix). Override via env HOUSING_LEG_GATE_MIN.
const DEFAULT_LEG_GATE_MIN = 30;

interface RoutePart {
  type: string; // road | basic | public_transport | start_end
  mode: string; // walk | bus | train | ferry | cable_car | …
  travel_time: number; // seconds
  line?: string; // verbose transit line, e.g. "8AX / BAYSHORE A EXPRESS (of …)"
  coords?: { lat: number; lng: number }[]; // shape points for this leg (start→end)
}

interface RoutesResponse {
  results: {
    search_id: string;
    locations: {
      id: string;
      properties: { travel_time: number; route: { parts: RoutePart[] } }[];
    }[];
  }[];
}

interface MatrixResponse {
  results: {
    search_id: string;
    // NOTE: on /fast, `properties` is a single object, not an array (unlike /v4/routes).
    locations: { id: string; properties: { travel_time: number } }[];
    unreachable: string[];
  }[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Internal marker: this attempt is retryable (it has already waited). */
class TTRetry {
  readonly _tag = "TTRetry";
}

/**
 * POST to a TravelTime endpoint, retrying 429 (rate-limit) and 5xx with
 * exponential backoff (honoring Retry-After). Returns the parsed body, or null
 * when retries are exhausted. Non-429 4xx are fatal (bad request) and throw.
 * Modelled with Effect internally; the Promise signature keeps callers unchanged.
 */
function postWithRetry<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<T | null> {
  let attempt = 0;
  const once = Effect.gen(function* () {
    const res = yield* Effect.promise(() =>
      fetch(url, { method: "POST", headers, body: JSON.stringify(body) }),
    );
    if (res.ok) return (yield* Effect.promise(() => res.json())) as T;

    const retryable = res.status === 429 || res.status >= 500;
    const text = (yield* Effect.promise(() => res.text().catch(() => ""))).slice(0, 200);
    if (!retryable) {
      // A 401/402/403 here means the TravelTime key is bad or its quota is spent —
      // say so plainly (this aborts commute enrichment for the whole run).
      const hint = apiLimitHint(res.status);
      if (hint) log.warn(`⚠ TravelTime: ${hint}`);
      return yield* Effect.fail(new Error(`TravelTime ${res.status}: ${text}`));
    }

    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(2 ** attempt * 1000, 30_000); // 1s, 2s, 4s, 8s…
    attempt++;
    log.warn(
      `  TravelTime ${res.status} — retrying in ${Math.round(waitMs / 1000)}s (attempt ${attempt}/${MAX_RETRIES})`,
    );
    yield* Effect.sleep(Duration.millis(waitMs));
    return yield* Effect.fail(new TTRetry());
  });

  const program = once.pipe(
    Effect.retry({ while: (e) => e instanceof TTRetry, times: MAX_RETRIES }),
    // Retries exhausted → null (matches the pre-Effect contract); fatal errors throw.
    Effect.catchAll((e) => (e instanceof TTRetry ? Effect.succeed(null) : Effect.fail(e as Error))),
  );
  return Effect.runPromise(program) as Promise<T | null>;
}

export interface EnrichResult {
  timed: number; // listings that got a matrix travel time this run
  unreachable: number; // listings the matrix couldn't reach within the ceiling
  legs: number; // listings that got a per-leg route this run
  cleared: number; // rows wiped by force before recomputing
  reason?: string; // set when the run no-oped (missing creds/anchor)
}

export async function enrichCommutes(
  dbPath: string,
  opts: { force?: boolean; legGateMin?: number } = {},
): Promise<EnrichResult> {
  const base: EnrichResult = { timed: 0, unreachable: 0, legs: 0, cleared: 0 };
  const appId = process.env.TRAVELTIME_APPLICATION_ID;
  const apiKey = process.env.TRAVELTIME_API_KEY;
  const anchorStr = process.env.HOUSING_ANCHOR;
  if (!appId || !apiKey || !anchorStr) {
    return { ...base, reason: "TravelTime credentials or HOUSING_ANCHOR not set" };
  }

  const [anchorLat, anchorLon] = anchorStr.split(",").map(Number);
  if (!Number.isFinite(anchorLat) || !Number.isFinite(anchorLon)) {
    return { ...base, reason: "HOUSING_ANCHOR is not a valid 'lat,lon'" };
  }

  const legGateMin =
    opts.legGateMin ?? (Number(process.env.HOUSING_LEG_GATE_MIN) || DEFAULT_LEG_GATE_MIN);
  const office = { id: "_office", coords: { lat: anchorLat, lng: anchorLon } };
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Application-Id": appId,
    "X-Api-Key": apiKey,
  };

  const db = new DatabaseSync(dbPath);
  ensureColumns(db);

  // force = recompute from scratch (e.g. after the arrival time or anchor
  // changed): wipe both tiers so everything is refetched.
  if (opts.force) {
    const info = db
      .prepare(
        "UPDATE listings SET commute_min = NULL, commute_route = NULL WHERE commute_min IS NOT NULL OR commute_route IS NOT NULL",
      )
      .run();
    base.cleared = Number(info.changes ?? 0);
  }

  await matrixPass(db, headers, office, base);
  await routesPass(db, headers, office, legGateMin, base);

  db.close();
  log.info(
    `Commute enrichment done — ${base.timed} timed, ${base.legs} with legs, ${base.unreachable} unreachable` +
      (base.cleared ? `, ${base.cleared} cleared` : "") +
      ".",
  );
  return base;
}

// --- Tier 1: matrix travel times for every un-timed listing ---

async function matrixPass(
  db: DatabaseSync,
  headers: Record<string, string>,
  office: { id: string; coords: { lat: number; lng: number } },
  out: EnrichResult,
): Promise<void> {
  const pending = db
    .prepare(
      "SELECT id, lat, lon FROM listings WHERE status = 'active' AND lat IS NOT NULL AND commute_min IS NULL",
    )
    .all() as { id: string; lat: number; lon: number }[];
  if (pending.length === 0) return;

  log.info(`Matrix: computing transit time for ${pending.length} listing(s)…`);
  const setMin = db.prepare("UPDATE listings SET commute_min = ? WHERE id = ?");
  const chunks = chunk(pending, MATRIX_CHUNK);

  for (let c = 0; c < chunks.length; c++) {
    const group = chunks[c];
    const body = {
      locations: [office, ...group.map((l) => ({ id: l.id, coords: { lat: l.lat, lng: l.lon } }))],
      arrival_searches: {
        many_to_one: [
          {
            id: "commute",
            arrival_location_id: office.id,
            departure_location_ids: group.map((l) => l.id),
            transportation: { type: "public_transport" },
            arrival_time_period: "weekday_morning",
            travel_time: MATRIX_MAX_SECS,
            properties: ["travel_time"],
          },
        ],
        one_to_many: [],
      },
    };

    try {
      const data = await postWithRetry<MatrixResponse>(MATRIX_URL, headers, body);
      if (data === null) {
        log.warn(`  matrix chunk ${c + 1}/${chunks.length}: giving up after retries`);
        continue;
      }
      for (const result of data.results ?? []) {
        for (const loc of result.locations ?? []) {
          setMin.run(Math.round(loc.properties.travel_time / 60), loc.id);
          out.timed++;
        }
        // Unreachable-within-ceiling listings stay commute_min = NULL; they're
        // effectively "no reasonable commute" and simply won't show a time.
        out.unreachable += result.unreachable?.length ?? 0;
      }
    } catch (err) {
      log.warn(`  matrix chunk ${c + 1}/${chunks.length} error: ${(err as Error).message}`);
    }
    const remaining = chunks.length - (c + 1);
    if (chunks.length > 1) {
      log.info(
        progress(
          "  matrix",
          Math.min((c + 1) * MATRIX_CHUNK, pending.length),
          pending.length,
          remaining,
        ),
      );
    }
    if (remaining > 0) await sleep(RATE_PACE_MS);
  }
}

// --- Tier 2: per-leg routes for listings within the transit-time gate ---

async function routesPass(
  db: DatabaseSync,
  headers: Record<string, string>,
  office: { id: string; coords: { lat: number; lng: number } },
  legGateMin: number,
  out: EnrichResult,
): Promise<void> {
  const pending = db
    .prepare(
      "SELECT id, lat, lon FROM listings WHERE status = 'active' AND lat IS NOT NULL AND commute_route IS NULL AND commute_min IS NOT NULL AND commute_min <= ?",
    )
    .all(legGateMin) as { id: string; lat: number; lon: number }[];
  if (pending.length === 0) return;

  log.info(
    `Routes: fetching leg breakdown for ${pending.length} listing(s) within ${legGateMin} min…`,
  );
  const arrivalTime = nextTuesdayMorning();
  const setRoute = db.prepare("UPDATE listings SET commute_route = ? WHERE id = ?");
  const batches = chunk(pending, ROUTES_BATCH);

  for (let b = 0; b < batches.length; b++) {
    const batch = batches[b];
    const body = {
      locations: [office, ...batch.map((l) => ({ id: l.id, coords: { lat: l.lat, lng: l.lon } }))],
      arrival_searches: batch.map((l) => ({
        id: `r:${l.id}`,
        departure_location_ids: [l.id],
        arrival_location_id: office.id,
        transportation: { type: "public_transport" },
        arrival_time: arrivalTime,
        travel_time: ROUTES_MAX_SECS,
        properties: ["travel_time", "route"],
      })),
    };

    try {
      const data = await postWithRetry<RoutesResponse>(ROUTES_URL, headers, body);
      if (data === null) {
        log.warn(`  routes batch ${b + 1}/${batches.length}: giving up after retries`);
        continue;
      }
      for (const result of data.results ?? []) {
        const listingId = result.search_id.replace(/^r:/, "");
        const props = result.locations?.[0]?.properties?.[0];
        if (!props?.route) continue;
        const geometry = buildGeometry(props.route.parts);
        const route: CommuteRoute = {
          mins: Math.round(props.travel_time / 60),
          legs: buildLegs(props.route.parts),
          ...(geometry.length > 1 ? { geometry } : {}),
        };
        setRoute.run(JSON.stringify(route), listingId);
        out.legs++;
      }
    } catch (err) {
      log.warn(`  routes batch ${b + 1}/${batches.length} error: ${(err as Error).message}`);
    }
    const remaining = batches.length - (b + 1);
    log.info(
      progress(
        "  routes",
        Math.min((b + 1) * ROUTES_BATCH, pending.length),
        pending.length,
        remaining,
      ),
    );
    if (remaining > 0) await sleep(RATE_PACE_MS);
  }
}

/**
 * Collapse TravelTime's fine-grained parts into rider-facing legs: consecutive
 * parts sharing a mode (and transit line) merge into one, so three back-to-back
 * "road/basic" walk segments become a single "4m walk". Sub-minute legs are
 * dropped so a 20-second connector doesn't clutter the summary.
 */
function buildLegs(parts: RoutePart[]): CommuteLeg[] {
  const merged: { mode: string; secs: number; line?: string }[] = [];
  for (const p of parts) {
    const line = p.line ? shortLine(p.line) : undefined;
    const last = merged[merged.length - 1];
    if (last && last.mode === p.mode && last.line === line) {
      last.secs += p.travel_time;
    } else {
      merged.push({ mode: p.mode, secs: p.travel_time, line });
    }
  }
  return merged
    .map((m) => ({
      mode: m.mode,
      mins: Math.round(m.secs / 60),
      ...(m.line ? { line: m.line } : {}),
    }))
    .filter((l) => l.mins > 0);
}

/**
 * Flatten every part's shape points into one [lat, lon] polyline, dropping
 * consecutive duplicates (parts share an endpoint with the next). Empty when the
 * source didn't return coords, in which case the card draws a straight line.
 */
function buildGeometry(parts: RoutePart[]): [number, number][] {
  const pts: [number, number][] = [];
  for (const p of parts) {
    for (const c of p.coords ?? []) {
      if (!Number.isFinite(c?.lat) || !Number.isFinite(c?.lng)) continue;
      const last = pts[pts.length - 1];
      if (last && last[0] === c.lat && last[1] === c.lng) continue;
      pts.push([c.lat, c.lng]);
    }
  }
  return pts;
}

/** "8AX / BAYSHORE A EXPRESS (of San Francisco …)" → "8AX". */
function shortLine(line: string): string {
  const slash = line.indexOf(" / ");
  const base = slash >= 0 ? line.slice(0, slash) : line;
  const paren = base.indexOf(" (");
  return (paren >= 0 ? base.slice(0, paren) : base).trim();
}

/** Format stored legs as "4m walk → 34m bus(8AX) → 3m walk". */
export function formatLegs(legs: CommuteLeg[]): string {
  return legs
    .map((l) => {
      const label =
        l.mode === "walk"
          ? "walk"
          : l.mode === "bus"
            ? `bus${l.line ? `(${l.line})` : ""}`
            : l.mode === "train"
              ? `train${l.line ? `(${l.line})` : ""}`
              : l.mode === "ferry"
                ? "ferry"
                : l.line
                  ? `${l.mode}(${l.line})`
                  : l.mode;
      return `${l.mins}m ${label}`;
    })
    .join(" → ");
}

function ensureColumns(db: DatabaseSync): void {
  for (const col of ["commute_min INTEGER", "commute_route TEXT"]) {
    try {
      db.exec(`ALTER TABLE listings ADD COLUMN ${col}`);
    } catch {
      /* already exists */
    }
  }
}

/** "  routes 300/1108 (27%) · ~15m left" — one heartbeat line per paced batch. */
function progress(label: string, done: number, total: number, remainingBatches: number): string {
  const pct = total > 0 ? Math.round((done / total) * 100) : 100;
  const etaSec = remainingBatches * (RATE_PACE_MS / 1000 + 2); // pacing dominates; +2s ≈ request time
  const eta =
    remainingBatches > 0
      ? ` · ~${etaSec < 90 ? `${Math.round(etaSec)}s` : `${Math.round(etaSec / 60)}m`} left`
      : "";
  return `${label} ${done}/${total} (${pct}%)${eta}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
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
