import { Data, Duration, Effect, Schedule } from "effect";

// Discord incoming-webhook notifier. One message PER eligible listing (not a
// batched digest), so each can be edited in place later: a listing that changes
// gets its card updated, and one that's delisted gets its message rewritten to a
// greyed-out "delisted" state. The message id returned on post is stored by the
// caller so those edits can target it.
//
// Operations are Effects. Retries (429 honoring retry_after, plus 5xx) are handled
// here; the caller trickles them through a RateLimiter to respect the per-webhook
// rate limit.

const WEBHOOK_USERNAME = "SF Rent Radar";

const COLOR = {
  new: 0x57f287, // green
  changed: 0xfaa61a, // amber
  delisted: 0xed4245, // red
} as const;

const LIMIT = { title: 256, description: 4096 } as const;

interface EmbedImage {
  url: string;
}
interface Embed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  timestamp?: string;
  image?: EmbedImage;
}

/** One listing rendered for Discord: its embed content + an optional card PNG. */
export interface RenderedCard {
  kind: "new" | "changed";
  title: string; // e.g. "$3,200/mo · 2Bd/1Ba · Mission"
  url: string; // listing URL (makes the title clickable)
  description: string; // commute / change / source line
  png: Buffer | null; // null → embed posts without an image
}

/** Minimal listing identity used to render a delisted (removed) message. */
export interface DelistedInfo {
  title: string;
  url: string;
  source: string;
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

const FILENAME = "card.png";

/** Build the multipart body for a normal (active) listing card. */
function cardForm(card: RenderedCard): FormData {
  const embed: Embed = {
    title: trunc(card.title, LIMIT.title),
    url: card.url,
    description: trunc(card.description, LIMIT.description),
    color: card.kind === "changed" ? COLOR.changed : COLOR.new,
  };
  const form = new FormData();
  const attachments: { id: number; filename: string }[] = [];
  if (card.png) {
    form.append("files[0]", new Blob([new Uint8Array(card.png)], { type: "image/png" }), FILENAME);
    embed.image = { url: `attachment://${FILENAME}` };
    attachments.push({ id: 0, filename: FILENAME });
  }
  form.append(
    "payload_json",
    JSON.stringify({
      username: WEBHOOK_USERNAME,
      allowed_mentions: { parse: [] }, // scraped text may contain @everyone — never ping
      embeds: [embed],
      attachments,
    }),
  );
  return form;
}

/** Build the multipart body that rewrites a message to its delisted state. */
function delistedForm(info: DelistedInfo): FormData {
  const embed: Embed = {
    title: trunc(`🔴 Delisted · ${info.title}`, LIMIT.title),
    url: info.url,
    // Embed titles don't render markdown; put the strikethrough in the description.
    description: `~~${trunc(info.title, 400)}~~\nNo longer listed · via ${info.source}`,
    color: COLOR.delisted,
    timestamp: new Date().toISOString(),
  };
  const form = new FormData();
  // attachments:[] drops the previously-uploaded map image on edit.
  form.append("payload_json", JSON.stringify({ embeds: [embed], attachments: [] }));
  return form;
}

/** A non-retryable Discord failure (bad payload, unknown message, etc.). */
export class DiscordError extends Data.TaggedError("DiscordError")<{
  status: number;
  detail: string;
}> {}
/** Internal marker: this attempt should be retried (already waited if needed). */
class Retry extends Data.TaggedError("DiscordRetry")<{}> {}

/**
 * One POST/PATCH attempt. On 429 it waits retry_after (SECONDS, a float) and on
 * 5xx it backs off, both before failing with Retry so the outer retry re-runs;
 * other non-2xx fail fatally. `makeBody` is re-invoked per attempt for a fresh
 * (un-consumed) FormData.
 */
function attempt(
  url: string,
  method: "POST" | "PATCH",
  makeBody: () => FormData,
): Effect.Effect<{ id?: string } | null, DiscordError | Retry> {
  return Effect.gen(function* () {
    const res = yield* Effect.promise(() => fetch(url, { method, body: makeBody() }));
    if (res.status === 429) {
      const body = (yield* Effect.promise(() => res.json().catch(() => ({})))) as {
        retry_after?: number;
      };
      yield* Effect.sleep(Duration.millis((Number(body.retry_after) || 1) * 1000 + 250));
      return yield* Effect.fail(new Retry());
    }
    if (res.status >= 500) {
      yield* Effect.sleep(Duration.seconds(1));
      return yield* Effect.fail(new Retry());
    }
    if (!res.ok) {
      const text = yield* Effect.promise(() => res.text());
      return yield* Effect.fail(
        new DiscordError({ status: res.status, detail: text.slice(0, 300) }),
      );
    }
    return (yield* Effect.promise(() => res.json().catch(() => null))) as { id?: string } | null;
  });
}

function request(
  url: string,
  method: "POST" | "PATCH",
  makeBody: () => FormData,
): Effect.Effect<{ id?: string } | null, DiscordError> {
  return attempt(url, method, makeBody).pipe(
    Effect.retry({ while: (e) => e._tag === "DiscordRetry", schedule: Schedule.recurs(4) }),
    // Retries exhausted while still rate-limited → surface a fatal error.
    Effect.catchTag("DiscordRetry", () =>
      Effect.fail(new DiscordError({ status: 429, detail: "still rate-limited after retries" })),
    ),
  );
}

/** Base webhook URL with any trailing slash removed. */
const base = (webhook: string): string => webhook.replace(/\/+$/, "");

/** Post a listing card as a new message; yields its message id (or null). */
export function postCard(
  webhook: string,
  card: RenderedCard,
): Effect.Effect<string | null, DiscordError> {
  return request(`${base(webhook)}?wait=true`, "POST", () => cardForm(card)).pipe(
    Effect.map((res) => res?.id ?? null),
  );
}

/** Edit a previously-posted message with a fresh card (e.g. after a change). */
export function editCard(
  webhook: string,
  messageId: string,
  card: RenderedCard,
): Effect.Effect<void, DiscordError> {
  return request(`${base(webhook)}/messages/${messageId}`, "PATCH", () => cardForm(card)).pipe(
    Effect.asVoid,
  );
}

/** Rewrite a previously-posted message to its delisted state. */
export function markDelisted(
  webhook: string,
  messageId: string,
  info: DelistedInfo,
): Effect.Effect<void, DiscordError> {
  return request(`${base(webhook)}/messages/${messageId}`, "PATCH", () => delistedForm(info)).pipe(
    Effect.asVoid,
  );
}
