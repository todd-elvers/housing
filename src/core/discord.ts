import { Data, Duration, Effect, Schedule } from "effect";

// Discord incoming-webhook notifier. One message PER eligible listing (not a
// batched digest), so each can be edited in place later: a listing that changes
// gets its card updated, and one that's no longer available has its message
// deleted outright. The message id returned on post is stored by the caller so
// those edits/deletes can target it.
//
// Operations are Effects. Retries (429 honoring retry_after, plus 5xx) are handled
// here; the caller trickles them through a RateLimiter to respect the per-webhook
// rate limit.

const WEBHOOK_USERNAME = "SF Rent Radar";

const COLOR = {
  new: 0x57f287, // green
  changed: 0xfaa61a, // amber
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
  image?: EmbedImage;
}

/** One listing rendered for Discord: its embed content + an optional card PNG. */
export interface RenderedCard {
  kind: "new" | "changed";
  title: string; // e.g. "$3,200/mo · 2Bd/1Ba · Mission"
  url: string; // listing URL (makes the title clickable)
  description: string; // commute / change / source line
  png: Buffer | null; // null → embed posts without an image
  neighborhood: string | null; // routes the card to its forum thread
}

function trunc(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

const FILENAME = "card.png";

/**
 * Build the multipart body for a normal (active) listing card. When `threadName`
 * is given (creating a new forum thread) it's included so the post opens the
 * thread with that title.
 */
function cardForm(card: RenderedCard, threadName?: string): FormData {
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
      ...(threadName ? { thread_name: trunc(threadName, 100) } : {}),
      embeds: [embed],
      attachments,
    }),
  );
  return form;
}

/** A non-retryable Discord failure (bad payload, unknown message, etc.). */
export class DiscordError extends Data.TaggedError("DiscordError")<{
  status: number;
  detail: string;
}> {}
/** Internal marker: this attempt should be retried (already waited if needed). */
class Retry extends Data.TaggedError("DiscordRetry")<{}> {}

/** The Discord message fields we use: its id and the (thread) channel it's in. */
interface MessageRef {
  id?: string;
  channel_id?: string;
}

/**
 * One POST/PATCH attempt. On 429 it waits retry_after (SECONDS, a float) and on
 * 5xx it backs off, both before failing with Retry so the outer retry re-runs;
 * other non-2xx fail fatally. `makeBody` is re-invoked per attempt for a fresh
 * (un-consumed) FormData.
 */
function attempt(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  makeBody?: () => FormData,
): Effect.Effect<MessageRef | null, DiscordError | Retry> {
  return Effect.gen(function* () {
    const res = yield* Effect.promise(() => fetch(url, { method, body: makeBody?.() }));
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
    return (yield* Effect.promise(() => res.json().catch(() => null))) as MessageRef | null;
  });
}

function request(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  makeBody?: () => FormData,
): Effect.Effect<MessageRef | null, DiscordError> {
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
const threadQ = (id: string | null): string => (id ? `&thread_id=${id}` : "");

/** Where a card is posted: into an existing thread, or a new one to create. */
export type ThreadTarget = { threadId: string } | { threadName: string };

/** A posted card's coordinates: the message id and the thread it landed in. */
export interface PostedRef {
  messageId: string;
  threadId: string;
}

/**
 * Post a listing card — into an existing forum thread (threadId) or, given a
 * threadName, opening a new thread with that title. Yields the message id + the
 * thread it landed in (null if Discord returned no id).
 */
export function postCard(
  webhook: string,
  card: RenderedCard,
  target: ThreadTarget,
): Effect.Effect<PostedRef | null, DiscordError> {
  const intoThread = "threadId" in target;
  const url = `${base(webhook)}?wait=true${intoThread ? `&thread_id=${target.threadId}` : ""}`;
  return request(url, "POST", () =>
    cardForm(card, intoThread ? undefined : target.threadName),
  ).pipe(
    Effect.map((res) =>
      res?.id
        ? { messageId: res.id, threadId: res.channel_id ?? (intoThread ? target.threadId : res.id) }
        : null,
    ),
  );
}

/** Edit a previously-posted message with a fresh card (e.g. after a change). */
export function editCard(
  webhook: string,
  messageId: string,
  threadId: string | null,
  card: RenderedCard,
): Effect.Effect<void, DiscordError> {
  const url = `${base(webhook)}/messages/${messageId}?wait=true${threadQ(threadId)}`;
  return request(url, "PATCH", () => cardForm(card)).pipe(Effect.asVoid);
}

/** Delete a previously-posted message (its listing is no longer available). */
export function deleteCard(
  webhook: string,
  messageId: string,
  threadId: string | null,
): Effect.Effect<void, DiscordError> {
  const url = `${base(webhook)}/messages/${messageId}?wait=true${threadQ(threadId)}`;
  return request(url, "DELETE").pipe(
    Effect.asVoid,
    // A 404 means it's already gone — that's the desired end state, not a failure.
    Effect.catchAll((e) => (e.status === 404 ? Effect.void : Effect.fail(e))),
  );
}
