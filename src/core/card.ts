import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { CommuteRoute } from "./commute.ts";
import { formatLegs } from "./commute.ts";
import { log } from "./log.ts";

// Renders one listing into a shareable PNG "card": a listing photo + summary text
// across the top, and an OpenStreetMap map below with the real home→office transit
// path drawn on it. No paid map API — we fetch OSM raster tiles directly, stitch
// them, and draw the route + markers ourselves with a 2D canvas.
//
// Everything degrades: no photo, no coordinates, or a failed tile fetch just drops
// that piece rather than failing the card, and renderCard() returns null only when
// it can't produce anything useful (so the caller can fall back to a text embed).

const CARD_W = 800;
const CARD_H = 500;
const TOP_H = 170; // photo + text band
const PHOTO_W = 260;
const TILE = 256;
const MAX_ZOOM = 17;
const PIN_HEADROOM = 16; // px of extra top space so pin heads don't clip the map edge
// OSM's tile usage policy requires a truthful, identifying User-Agent.
const TILE_UA = "housing-rental-radar/0.1 (+personal SF rental monitor)";
const TILE_BASE = "https://tile.openstreetmap.org";

const COLORS = {
  bg: "#0f172a", // slate-900
  panel: "#1e293b", // slate-800
  text: "#f1f5f9", // slate-100
  sub: "#94a3b8", // slate-400
  price: "#4ade80", // green-400
  changed: "#fbbf24", // amber-400
  home: "#3b82f6", // blue-500
  office: "#ef4444", // red-500
  route: "#2563eb", // blue-600
  routeCasing: "#ffffff",
} as const;

export interface CardInput {
  kind: "new" | "changed";
  source: string;
  url: string;
  title: string | null;
  address: string | null;
  neighborhood: string | null;
  lat: number | null;
  lon: number | null;
  price: number | null;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  /** Resolved listing photo URL, if any. */
  photoUrl: string | null;
  commuteMin: number | null;
  route: CommuteRoute | null;
  /** For changed cards: the "price ↓ … / 2Bd → 1Bd" detail line. */
  changeDetail?: string | null;
}

export interface Anchor {
  lat: number;
  lon: number;
}

/** In-run cache of fetched tiles (key "z/x/y") so nearby cards share downloads. */
export type TileCache = Map<string, Promise<Buffer | null>>;

/** Pull a usable photo URL out of a source's raw JSON payload (keys vary by source). */
export function resolvePhotoUrl(rawJson: string | null): string | null {
  if (!rawJson) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const direct = raw.imageUrl ?? raw.imageURL ?? raw.image ?? raw.photo ?? raw.heroImage;
  if (typeof direct === "string" && /^https?:\/\//.test(direct)) return direct;
  for (const key of ["image_urls", "imageUrls", "photos", "images"]) {
    const arr = raw[key];
    if (Array.isArray(arr) && typeof arr[0] === "string" && /^https?:\/\//.test(arr[0])) {
      return arr[0];
    }
  }
  return null;
}

/**
 * Render a listing card to a PNG buffer, or null if nothing renderable could be
 * produced. Never throws — failures are logged and downgraded.
 */
export async function renderCard(
  input: CardInput,
  anchor: Anchor | null,
  tileCache: TileCache,
): Promise<Buffer | null> {
  try {
    const canvas = createCanvas(CARD_W, CARD_H);
    const ctx = canvas.getContext("2d");

    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, CARD_W, CARD_H);

    // Load the photo first so the layout can adapt: with a photo → a photo+text
    // band over the map; without one (e.g. Redfin) → a full-bleed map with the
    // summary overlaid on a scrim, so the card still looks intentional.
    const photo = await loadPhoto(input.photoUrl);
    if (photo) {
      drawPhoto(ctx, photo);
      drawSummary(ctx, input, PHOTO_W + 24);
      await drawMap(ctx, input, anchor, tileCache, TOP_H);
    } else {
      await drawMap(ctx, input, anchor, tileCache, 0);
      drawSummaryOverlay(ctx, input);
    }

    return canvas.toBuffer("image/png");
  } catch (err) {
    log.warn(`card render failed (${input.source}): ${(err as Error).message}`);
    return null;
  }
}

// ── top band ────────────────────────────────────────────────────────────────

/** Fetch + decode the listing photo, or null (no URL, fetch fail, or decode fail). */
async function loadPhoto(photoUrl: string | null): Promise<Image | null> {
  if (!photoUrl) return null;
  try {
    const bytes = await fetchBytes(photoUrl, {});
    if (!bytes) return null;
    return await loadImage(bytes);
  } catch (err) {
    log.warn(`card photo load failed: ${(err as Error).message}`);
    return null;
  }
}

/** Cover-fit the photo into the top-left band. */
function drawPhoto(ctx: SKRSContext2D, img: Image): void {
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(0, 0, PHOTO_W, TOP_H);
  const scale = Math.max(PHOTO_W / img.width, TOP_H / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, PHOTO_W, TOP_H);
  ctx.clip();
  ctx.drawImage(img, (PHOTO_W - w) / 2, (TOP_H - h) / 2, w, h);
  ctx.restore();
}

/** Price / specs / place / source, left-aligned at `x`, starting near the top. */
function drawSummary(ctx: SKRSContext2D, input: CardInput, x: number): void {
  let y = 46;
  ctx.textAlign = "left";
  ctx.fillStyle = input.kind === "changed" ? COLORS.changed : COLORS.price;
  ctx.font = "bold 34px sans-serif";
  ctx.fillText(money(input.price), x, y);

  y += 34;
  ctx.fillStyle = COLORS.text;
  ctx.font = "20px sans-serif";
  const specs = [bedsBaths(input), input.sqft ? `${input.sqft.toLocaleString()} sqft` : null]
    .filter(Boolean)
    .join(" · ");
  if (specs) ctx.fillText(trunc(ctx, specs, CARD_W - x - 20), x, y);

  y += 30;
  ctx.fillStyle = COLORS.sub;
  ctx.font = "18px sans-serif";
  // Neighborhood first (the locality people scan for), then the street address —
  // skipping the street when it's just a repeat of the neighborhood.
  const street = input.address ?? input.title ?? null;
  const place = [input.neighborhood, street === input.neighborhood ? null : street]
    .filter(Boolean)
    .join(" · ");
  if (place) ctx.fillText(trunc(ctx, place, CARD_W - x - 20), x, y);

  y += 26;
  ctx.fillStyle = input.kind === "changed" ? COLORS.changed : COLORS.sub;
  ctx.font = "15px sans-serif";
  const tail =
    input.kind === "changed" && input.changeDetail ? input.changeDetail : `via ${input.source}`;
  ctx.fillText(trunc(ctx, tail, CARD_W - x - 20), x, y);
}

/** No-photo layout: a dark top scrim over the full-bleed map, then the summary. */
function drawSummaryOverlay(ctx: SKRSContext2D, input: CardInput): void {
  const scrimH = 180;
  const grad = ctx.createLinearGradient(0, 0, 0, scrimH);
  grad.addColorStop(0, "rgba(15,23,42,0.95)");
  grad.addColorStop(0.65, "rgba(15,23,42,0.82)");
  grad.addColorStop(1, "rgba(15,23,42,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, CARD_W, scrimH);
  // A soft shadow keeps the lower (grey) lines legible where the scrim thins out
  // over light map tiles.
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;
  drawSummary(ctx, input, 20);
  ctx.restore();
}

// ── map ───────────────────────────────────────────────────────────────────────

async function drawMap(
  ctx: SKRSContext2D,
  input: CardInput,
  anchor: Anchor | null,
  tileCache: TileCache,
  top: number,
): Promise<void> {
  const mapH = CARD_H - top;
  ctx.fillStyle = COLORS.panel;
  ctx.fillRect(0, top, CARD_W, mapH);

  if (input.lat == null || input.lon == null) {
    placeholder(ctx, "location unknown", top);
    return;
  }

  const home: LngLat = { lon: input.lon, lat: input.lat };
  const office = anchor ? { lon: anchor.lon, lat: anchor.lat } : null;
  // Prefer the true transit path; fall back to a straight home→office line.
  const path: LngLat[] =
    input.route?.geometry && input.route.geometry.length > 1
      ? input.route.geometry.map(([lat, lon]) => ({ lat, lon }))
      : office
        ? [home, office]
        : [home];

  const pts = office ? [home, office, ...path] : [home, ...path];
  const view = fitView(pts, CARD_W, mapH);

  // Everything map-related is clipped to the map region so tiles/route can't
  // bleed over the band (or scrim) above it.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, CARD_W, mapH);
  ctx.clip();

  // Fetch + paint the tiles that cover the viewport.
  const n = 1 << view.zoom;
  const xLeft = Math.floor(view.originX / TILE);
  const xRight = Math.floor((view.originX + CARD_W) / TILE);
  const yTop = Math.floor(view.originY / TILE);
  const yBot = Math.floor((view.originY + mapH) / TILE);

  const jobs: Promise<void>[] = [];
  for (let tx = xLeft; tx <= xRight; tx++) {
    for (let ty = yTop; ty <= yBot; ty++) {
      const wx = ((tx % n) + n) % n; // wrap horizontally
      if (ty < 0 || ty >= n) continue;
      const key = `${view.zoom}/${wx}/${ty}`;
      const px = tx * TILE - view.originX;
      const py = top + (ty * TILE - view.originY);
      jobs.push(
        getTile(key, tileCache).then((buf) => {
          if (!buf) return;
          return loadImage(buf).then((img) => {
            ctx.drawImage(img, px, py, TILE, TILE);
          });
        }),
      );
    }
  }
  await Promise.all(jobs);

  drawRoute(ctx, path, view, top);
  if (office) drawMarker(ctx, project(office, view, top), COLORS.office, "W");
  drawMarker(ctx, project(home, view, top), COLORS.home, "H");

  ctx.restore();

  drawCommuteBadge(ctx, input);
  // subtle attribution required by OSM
  ctx.fillStyle = "rgba(255,255,255,0.6)";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "right";
  ctx.fillText("© OpenStreetMap", CARD_W - 6, CARD_H - 6);
  ctx.textAlign = "left";
}

function drawRoute(ctx: SKRSContext2D, path: LngLat[], view: View, top: number): void {
  if (path.length < 2) return;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  // white casing, then the colored line on top
  for (const [width, color] of [
    [7, COLORS.routeCasing],
    [4, COLORS.route],
  ] as const) {
    ctx.beginPath();
    path.forEach((p, i) => {
      const { x, y } = project(p, view, top);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  }
}

/**
 * A teardrop map pin whose *tip* sits exactly on `at` (the projected coordinate),
 * matching the usual map convention — the point, not a disc's center, marks the
 * location. The rounded head carries the H/W label.
 */
function drawMarker(
  ctx: SKRSContext2D,
  at: { x: number; y: number },
  color: string,
  label: string,
): void {
  const r = 11; // head radius
  const cy = at.y - r * 2.1; // head center sits above the tip
  ctx.save();

  // soft shadow so the pin reads on busy map tiles
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 4;
  ctx.shadowOffsetY = 1;

  // head (circle) + tapered body meeting at the tip
  ctx.beginPath();
  const tan = Math.acos(r / (at.y - cy)); // where the tangent lines touch the circle
  ctx.arc(at.x, cy, r, Math.PI / 2 + tan, Math.PI / 2 - tan, false);
  ctx.lineTo(at.x, at.y);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowColor = "transparent"; // don't shadow the stroke/label
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 12px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, at.x, cy + 0.5);
  ctx.restore();
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
}

function drawCommuteBadge(ctx: SKRSContext2D, input: CardInput): void {
  const mins = input.route?.mins ?? input.commuteMin;
  if (mins == null) return;
  const legs = input.route?.legs?.length ? formatLegs(input.route.legs) : null;
  const label = legs ? `${mins} min  ·  ${legs}` : `~${mins} min to work`;
  ctx.font = "14px sans-serif";
  const h = 26;
  const x = 10;
  // bottom-left, leaving room for the OSM attribution at bottom-right
  const w = Math.min(ctx.measureText(label).width + 20, CARD_W - 150);
  const y = CARD_H - h - 10;
  ctx.fillStyle = "rgba(15,23,42,0.82)";
  roundRect(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.fillStyle = COLORS.text;
  ctx.fillText(trunc(ctx, label, CARD_W - 40), x + 10, y + 18);
}

function placeholder(ctx: SKRSContext2D, msg: string, top: number): void {
  ctx.fillStyle = COLORS.sub;
  ctx.font = "18px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(msg, CARD_W / 2, top + (CARD_H - top) / 2);
  ctx.textAlign = "left";
}

// ── slippy-map projection ─────────────────────────────────────────────────────

interface LngLat {
  lon: number;
  lat: number;
}
interface View {
  zoom: number;
  originX: number; // world-pixel of the viewport's left edge
  originY: number; // world-pixel of the viewport's top edge
}

const normX = (lon: number): number => (lon + 180) / 360;
function normY(lat: number): number {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
}

/** Pick the tightest zoom that fits all points (with padding) in vw×vh, and the viewport origin. */
function fitView(pts: LngLat[], vw: number, vh: number): View {
  const xs = pts.map((p) => normX(p.lon));
  const ys = pts.map((p) => normY(p.lat));
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const pad = 0.82; // use ~82% of the box so markers aren't on the edge

  let zoom = MAX_ZOOM;
  for (; zoom >= 1; zoom--) {
    const size = TILE * (1 << zoom);
    const spanX = (maxX - minX) * size;
    const spanY = (maxY - minY) * size;
    if (spanX <= vw * pad && spanY <= vh * pad) break;
  }
  zoom = Math.max(1, Math.min(MAX_ZOOM, zoom));
  const size = TILE * (1 << zoom);
  // Shift content down a touch so a pin sitting near the top edge has room for its
  // upward-pointing head (the tip still marks the exact spot).
  return { zoom, originX: cx * size - vw / 2, originY: cy * size - vh / 2 - PIN_HEADROOM };
}

function project(p: LngLat, view: View, top: number): { x: number; y: number } {
  const size = TILE * (1 << view.zoom);
  return { x: normX(p.lon) * size - view.originX, y: top + (normY(p.lat) * size - view.originY) };
}

// ── tiles + fetch ─────────────────────────────────────────────────────────────

function getTile(key: string, cache: TileCache): Promise<Buffer | null> {
  const hit = cache.get(key);
  if (hit) return hit;
  const p = fetchBytes(`${TILE_BASE}/${key}.png`, { "User-Agent": TILE_UA }).catch(() => null);
  cache.set(key, p);
  return p;
}

async function fetchBytes(url: string, headers: Record<string, string>): Promise<Buffer | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── small text/shape helpers ──────────────────────────────────────────────────

function roundRect(
  ctx: SKRSContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function trunc(ctx: SKRSContext2D, s: string, maxWidth: number): string {
  if (ctx.measureText(s).width <= maxWidth) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(`${s.slice(0, mid)}…`).width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return `${s.slice(0, lo)}…`;
}

function money(p: number | null): string {
  return typeof p === "number" ? `$${p.toLocaleString()}/mo` : "price n/a";
}
function bedsBaths(input: CardInput): string {
  const beds = input.beds == null ? null : input.beds === 0 ? "Studio" : `${num(input.beds)}Bd`;
  const baths = input.baths == null ? null : `${num(input.baths)}Ba`;
  return [beds, baths].filter(Boolean).join("/");
}
const num = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));
