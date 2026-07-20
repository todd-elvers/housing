import type { ListingEvent } from "./types.ts";

// Discord incoming-webhook notifier. Renders a run's new/changed/removed events as
// a single, scannable "sectioned digest": a header embed + one color-coded embed
// per category, with one field per listing (masked link in the field value —
// masked links only render inside embeds, never in plain content).
//
// Everything here is defensive about Discord's hard limits: it rejects (400) the
// WHOLE message if any is exceeded — it never truncates for you — and the 6000 is
// summed across every embed in the message, not per embed. So we pre-truncate and
// budget-trim before sending. Numbers per docs.discord.com/developers.
const WEBHOOK_USERNAME = "SF Rent Radar";

const COLOR = {
  header: 0x5865f2, // blurple
  new: 0x57f287, // green
  changed: 0xfaa61a, // amber
  removed: 0xed4245, // red
} as const;

// Discord limits (exact) — we stay comfortably inside them.
const LIMIT = {
  title: 256,
  fieldName: 256,
  fieldValue: 1024,
  fieldsPerEmbed: 25,
  embedsPerMessage: 10,
  totalChars: 6000,
} as const;
const TOTAL_BUDGET = 5500; // leave headroom under the 6000 aggregate
const MAX_ROWS_PER_CATEGORY = 10; // then collapse the rest into a "+N more" row

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}
interface Embed {
  title?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  fields?: EmbedField[];
}
interface WebhookPayload {
  username: string;
  allowed_mentions: { parse: [] };
  embeds: Embed[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function money(p?: number | null): string {
  return typeof p === "number" ? `$${p.toLocaleString()}/mo` : "price n/a";
}

/** "2Bd/1Ba", "Studio/1Ba", or "" when neither is known. */
function bedsBaths(e: ListingEvent): string {
  const beds = e.beds == null ? null : e.beds === 0 ? "Studio" : `${trimNum(e.beds)}Bd`;
  const baths = e.baths == null ? null : `${trimNum(e.baths)}Ba`;
  return [beds, baths].filter(Boolean).join("/");
}
const trimNum = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** One listing → one embed field. Link goes in the value (names can't hold masked links). */
function listingField(e: ListingEvent): EmbedField {
  const head = [money(e.price), bedsBaths(e) || null, e.neighborhood ?? null]
    .filter(Boolean)
    .join(" · ");
  const name = trunc(head || e.title || "listing", LIMIT.fieldName);

  const parts: string[] = [];
  if (e.type === "removed") parts.push("Delisted");
  parts.push(`[View listing](${e.url})`);
  if (e.type === "changed" && e.detail) parts.push(e.detail); // e.g. "price ↓ $3,500 → $3,200"
  parts.push(`via ${e.source}`);
  return { name, value: trunc(parts.join(" · "), LIMIT.fieldValue), inline: false };
}

function categoryEmbed(title: string, color: number, events: ListingEvent[]): Embed | null {
  if (events.length === 0) return null;
  const shown = events.slice(0, MAX_ROWS_PER_CATEGORY);
  const fields = shown.map(listingField);
  const overflow = events.length - shown.length;
  if (overflow > 0) {
    fields.push({
      name: `+${overflow} more`,
      value: "…run `housing find` for the full set",
      inline: false,
    });
  }
  return { title: trunc(title, LIMIT.title), color, fields: fields.slice(0, LIMIT.fieldsPerEmbed) };
}

/** Sum the chars Discord counts toward the 6000-per-message aggregate. */
function embedChars(e: Embed): number {
  let n = (e.title?.length ?? 0) + (e.description?.length ?? 0);
  for (const f of e.fields ?? []) n += f.name.length + f.value.length;
  return n;
}

/** Trim category rows (largest category first) until the message fits the char budget. */
function fitBudget(embeds: Embed[]): void {
  const total = () => embeds.reduce((n, e) => n + embedChars(e), 0);
  while (total() > TOTAL_BUDGET) {
    // find the category embed with the most fields and drop its last listing row
    const withFields = embeds.filter((e) => (e.fields?.length ?? 0) > 0);
    if (withFields.length === 0) break;
    const biggest = withFields.reduce((a, b) =>
      (b.fields?.length ?? 0) > (a.fields?.length ?? 0) ? b : a,
    );
    const fields = biggest.fields!;
    // replace the last row (or the existing overflow row) with a compact overflow note
    const last = fields[fields.length - 1];
    if (last.name.startsWith("+")) fields.pop();
    fields.pop();
    fields.push({
      name: "…more truncated",
      value: "run `housing find` for the full set",
      inline: false,
    });
  }
}

/** Build the one-message digest for a run's events (null if there's nothing to say). */
export function buildDigest(events: ListingEvent[]): WebhookPayload | null {
  if (events.length === 0) return null;
  const news = events.filter((e) => e.type === "new");
  const changed = events.filter((e) => e.type === "changed");
  const removed = events.filter((e) => e.type === "removed");

  const header: Embed = {
    title: "SF Rentals — digest",
    description: `**${news.length} new** · **${changed.length} changed** · **${removed.length} removed**`,
    color: COLOR.header,
    timestamp: new Date().toISOString(),
  };
  const embeds = [
    header,
    categoryEmbed("🟢 New listings", COLOR.new, news),
    categoryEmbed("🟡 Price & status changes", COLOR.changed, changed),
    categoryEmbed("🔴 Removed", COLOR.removed, removed),
  ].filter((e): e is Embed => e !== null);

  fitBudget(embeds);
  return {
    username: WEBHOOK_USERNAME,
    allowed_mentions: { parse: [] }, // scraped text may contain @everyone — never let it ping
    embeds: embeds.slice(0, LIMIT.embedsPerMessage),
  };
}

/**
 * POST one payload to a webhook, rate-limit-safe. Uses ?wait=true so a bad payload
 * returns a real 400 (instead of a silent 204). On 429, honors retry_after (SECONDS,
 * a float — a classic ms/s bug). Never retries other 4xx (the payload is the problem).
 */
export async function sendWebhook(webhookUrl: string, payload: WebhookPayload): Promise<void> {
  const url = `${webhookUrl}${webhookUrl.includes("?") ? "&" : "?"}wait=true`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 429) {
      const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await sleep((Number(body.retry_after) || 1) * 1000 + 250); // seconds → ms
      continue;
    }
    if (!res.ok) throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return;
  }
  throw new Error("Discord: still rate-limited after retries");
}

/** Convenience: build + send a run's digest. No-op when there are no events. */
export async function sendDigest(webhookUrl: string, events: ListingEvent[]): Promise<void> {
  const payload = buildDigest(events);
  if (payload) await sendWebhook(webhookUrl, payload);
}
