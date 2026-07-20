import { createCanvas, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import type { CommuteRoute } from "./commute.ts";
import { log } from "./log.ts";

// Renders one listing into a shareable PNG "card": purely visual — a collage of
// property photos with the OpenStreetMap commute map (route + home/office pins)
// in the bottom-right grid cell. All the text metadata lives in the Discord embed
// above the image. No paid map API — we fetch OSM raster tiles directly, stitch
// them, and draw the route + markers ourselves.
//
// Everything degrades: no photo, no coordinates, or a failed tile fetch just drops
// that piece rather than failing the card, and renderCard() returns null only when
// it can't produce anything useful (so the caller can fall back to a text embed).

const CARD_W = 800;
const CARD_H = 500;
const MAX_PHOTOS = 3; // property photos shown alongside the map cell
const MAIN_W = Math.round(800 * 0.62); // main photo column width (matches CARD_W)
const TILE = 256;
const MAX_ZOOM = 17;
const PIN_HEADROOM = 16; // px of extra top space so pin heads don't clip the map edge
// OSM's tile usage policy requires a truthful, identifying User-Agent.
const TILE_UA = "housing-rental-radar/0.1 (+personal SF rental monitor)";
const TILE_BASE = "https://tile.openstreetmap.org";

const COLORS = {
  bg: "#0f172a", // slate-900
  panel: "#1e293b", // slate-800
  sub: "#94a3b8", // slate-400
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
  /** Resolved listing photo URLs (the collage shows up to MAX_PHOTOS). */
  photoUrls: string[];
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

/** Pull usable photo URLs out of a source's raw JSON payload (keys vary by source). */
export function resolvePhotos(rawJson: string | null): string[] {
  if (!rawJson) return [];
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return [];
  }
  const urls: string[] = [];
  const push = (v: unknown) => {
    if (typeof v === "string" && /^https?:\/\//.test(v) && !urls.includes(v)) urls.push(v);
  };

  // Arrays of URLs (craigslist imageUrls, zillow image_urls, homeharvest alt_photos…).
  for (const key of ["imageUrls", "image_urls", "photos", "images", "alt_photos"]) {
    const arr = raw[key];
    if (Array.isArray(arr)) arr.forEach(push);
  }
  // Single hero-image keys.
  for (const key of ["imageUrl", "imageURL", "image", "photo", "heroImage", "primary_photo"]) {
    push(raw[key]);
  }
  // Zumper stores numeric image ids → build CDN URLs.
  const imageIds = raw.imageIds;
  if (Array.isArray(imageIds)) {
    for (const id of imageIds) {
      if (id != null) push(`https://img.zumpercdn.com/${id}/1280x960?auto=format`);
    }
  }
  return urls.slice(0, MAX_PHOTOS);
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

    // Photos form a collage (big photo left, more stacked top-right) with the map
    // occupying the bottom-right grid cell. With no photos the map goes full-bleed.
    const photos = await loadPhotos(input.photoUrls);
    if (photos.length > 0) {
      const { cells, map } = collageLayout(photos.length);
      ctx.fillStyle = COLORS.panel;
      ctx.fillRect(0, 0, CARD_W, CARD_H);
      cells.forEach((rect, i) => coverInto(ctx, photos[i], rect));
      await drawMap(ctx, input, anchor, tileCache, {
        x: map[0],
        y: map[1],
        w: map[2],
        h: map[3],
        compact: true,
      });
    } else {
      await drawMap(ctx, input, anchor, tileCache, { x: 0, y: 0, w: CARD_W, h: CARD_H });
    }

    return canvas.toBuffer("image/png");
  } catch (err) {
    log.warn(`card render failed (${input.source}): ${(err as Error).message}`);
    return null;
  }
}

// ── photo collage ─────────────────────────────────────────────────────────────

/** Fetch + decode a single photo, or null (no URL, fetch fail, or decode fail). */
async function loadPhoto(photoUrl: string): Promise<Image | null> {
  try {
    const bytes = await fetchBytes(photoUrl, {});
    if (!bytes) return null;
    return await loadImage(bytes);
  } catch (err) {
    log.warn(`card photo load failed: ${(err as Error).message}`);
    return null;
  }
}

/** Load up to MAX_PHOTOS photos concurrently, keeping only those that decoded. */
async function loadPhotos(urls: string[]): Promise<Image[]> {
  const imgs = await Promise.all(urls.slice(0, MAX_PHOTOS).map(loadPhoto));
  return imgs.filter((i): i is Image => i !== null);
}

type Rect = [number, number, number, number];

/**
 * Collage grid: a big main photo on the left, up to two photos stacked in the
 * top-right, and the map occupying the bottom-right cell. Returns the photo cells
 * (main first) plus the map cell.
 */
function collageLayout(nPhotos: number): { cells: Rect[]; map: Rect } {
  const W = CARD_W;
  const H = CARD_H;
  const g = 3; // gap between cells
  const rx = MAIN_W + g;
  const rw = W - rx;
  const rightPhotos = Math.max(0, Math.min(nPhotos - 1, MAX_PHOTOS - 1));
  const rows = rightPhotos + 1; // right-column rows including the map cell
  const rh = (H - (rows - 1) * g) / rows;
  const cells: Rect[] = [[0, 0, MAIN_W, H]];
  for (let i = 0; i < rightPhotos; i++) {
    cells.push([rx, Math.round(i * (rh + g)), rw, Math.round(rh)]);
  }
  const mapY = Math.round(rightPhotos * (rh + g));
  return { cells, map: [rx, mapY, rw, H - mapY] };
}

/** Cover-fit an image into a rect (clipped, centered). */
function coverInto(
  ctx: SKRSContext2D,
  img: Image,
  [x, y, w, h]: [number, number, number, number],
): void {
  const scale = Math.max(w / img.width, h / img.height);
  const dw = img.width * scale;
  const dh = img.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

// ── map ───────────────────────────────────────────────────────────────────────

interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Rounded corners + shadow + white border (a floating tile, not a grid cell). */
  rounded?: boolean;
  /** Small region → use the compact "N min" chip instead of the full badge. */
  compact?: boolean;
}

async function drawMap(
  ctx: SKRSContext2D,
  input: CardInput,
  anchor: Anchor | null,
  tileCache: TileCache,
  region: Region,
): Promise<void> {
  const { x, y, w, h } = region;
  const r = region.rounded ? 10 : 0;
  const clip = () => roundRect(ctx, x, y, w, h, r);

  // Background (with a drop shadow when it's the floating corner tile).
  ctx.save();
  if (region.rounded) {
    ctx.shadowColor = "rgba(0,0,0,0.45)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
  }
  ctx.fillStyle = COLORS.panel;
  clip();
  ctx.fill();
  ctx.restore();

  if (input.lat != null && input.lon != null) {
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
    const view = fitView(pts, w, h);

    ctx.save();
    clip();
    ctx.clip();

    // Fetch + paint the tiles that cover the viewport.
    const n = 1 << view.zoom;
    const xLeft = Math.floor(view.originX / TILE);
    const xRight = Math.floor((view.originX + w) / TILE);
    const yTop = Math.floor(view.originY / TILE);
    const yBot = Math.floor((view.originY + h) / TILE);

    const jobs: Promise<void>[] = [];
    for (let tx = xLeft; tx <= xRight; tx++) {
      for (let ty = yTop; ty <= yBot; ty++) {
        const wx = ((tx % n) + n) % n; // wrap horizontally
        if (ty < 0 || ty >= n) continue;
        const key = `${view.zoom}/${wx}/${ty}`;
        const px = x + (tx * TILE - view.originX);
        const py = y + (ty * TILE - view.originY);
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

    drawRoute(ctx, path, view, region);
    if (office) drawMarker(ctx, project(office, view, region), COLORS.office, "W");
    drawMarker(ctx, project(home, view, region), COLORS.home, "H");

    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("© OSM", x + w - 4, y + h - 4);
    ctx.textAlign = "left";
    ctx.restore();
  } else {
    placeholder(ctx, "location unknown", region);
  }

  // White border around the floating tile.
  if (region.rounded) {
    clip();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.stroke();
  }
}

function drawRoute(ctx: SKRSContext2D, path: LngLat[], view: View, region: Region): void {
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
      const { x, y } = project(p, view, region);
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

function placeholder(ctx: SKRSContext2D, msg: string, region: Region): void {
  ctx.fillStyle = COLORS.sub;
  ctx.font = `${region.compact ? 12 : 18}px sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(msg, region.x + region.w / 2, region.y + region.h / 2);
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

function project(p: LngLat, view: View, region: Region): { x: number; y: number } {
  const size = TILE * (1 << view.zoom);
  return {
    x: region.x + (normX(p.lon) * size - view.originX),
    y: region.y + (normY(p.lat) * size - view.originY),
  };
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
