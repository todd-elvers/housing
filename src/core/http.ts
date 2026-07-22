import { Cause, Data, Duration, Effect, Exit, Schedule } from "effect";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
}

// Internally modelled with Effect: a network failure is retryable and, if it
// outlives the retries, is re-thrown as the original error; a 5xx is retried too
// but, once retries are spent, the Response is returned (matching the pre-Effect
// behaviour). The exported functions stay Promise-based so adapters don't change.

class NetworkError extends Data.TaggedError("NetworkError")<{ cause: unknown }> {}
class ServerError extends Data.TaggedError("ServerError")<{ res: Response }> {}

function fetchOnce(url: string, opts: FetchOpts): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 25_000);
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers: { "user-agent": DEFAULT_UA, ...opts.headers },
    signal: ctl.signal,
  };
  if (opts.body !== undefined) init.body = opts.body;
  return fetch(url, init).finally(() => clearTimeout(timer));
}

function httpEffect(url: string, opts: FetchOpts): Effect.Effect<Response, unknown> {
  const retries = opts.retries ?? 2;
  const attempt = Effect.tryPromise({
    try: () => fetchOnce(url, opts),
    catch: (cause) => new NetworkError({ cause }),
  }).pipe(
    // Treat a 5xx as a (retryable) failure while attempts remain.
    Effect.flatMap((res) =>
      res.status >= 500 ? Effect.fail(new ServerError({ res })) : Effect.succeed(res),
    ),
  );

  return attempt.pipe(
    Effect.retry({ times: retries, schedule: Schedule.exponential(Duration.millis(600)) }),
    // Retries spent: a 5xx yields its Response; a network error re-throws its cause.
    Effect.catchTag("ServerError", (e) => Effect.succeed(e.res)),
    Effect.mapError((e: NetworkError) => e.cause),
  );
}

/** fetch() with a default browser UA, timeout, and retry on network error / 5xx. */
export async function httpFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  const exit = await Effect.runPromiseExit(httpEffect(url, opts));
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}

/**
 * An HTTP request that returned a non-2xx status. Carries the numeric `status`
 * so callers can distinguish "out of quota / bad key" (401/402/403/429) from an
 * ordinary failure without regex-scraping the message.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * If a status means a keyed/metered API is out of juice (or the key is bad),
 * return a plain-language hint; otherwise null. Turns a cryptic "HTTP 429" into
 * a loud, actionable warning about quota/credits.
 */
export function apiLimitHint(status: number): string | null {
  switch (status) {
    case 401:
      return "API key rejected (401 unauthorized) — check the key is set and valid";
    case 402:
      return "out of credits (402 payment required) — top up the plan";
    case 403:
      return "forbidden (403) — key invalid, or the plan/quota is exhausted";
    case 429:
      return "rate-limited or monthly quota exceeded (429) — slow down or top up the plan";
    default:
      return null;
  }
}

/** Strip anti-JSON-hijack guards some endpoints prepend (Redfin `{}&&`, `)]}'`). */
export function stripJsonGuard(s: string): string {
  let out = s.replace(/^﻿/, "");
  if (out.startsWith("{}&&")) return out.slice(4);
  const m = out.match(/^\)\]\}'?,?\s*/);
  if (m) out = out.slice(m[0].length);
  return out;
}

/** Origin + path only — drops any query string so a URL-embedded credential can't leak into logs. */
function safeUrl(u: string): string {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return "[url]";
  }
}

export async function fetchJson<T = unknown>(url: string, opts?: FetchOpts): Promise<T> {
  const res = await httpFetch(url, opts);
  if (!res.ok) throw new HttpError(res.status, `${safeUrl(url)} → HTTP ${res.status}`);
  const text = await res.text();
  return JSON.parse(stripJsonGuard(text)) as T;
}

export async function fetchText(url: string, opts?: FetchOpts): Promise<string> {
  const res = await httpFetch(url, opts);
  if (!res.ok) throw new HttpError(res.status, `${safeUrl(url)} → HTTP ${res.status}`);
  return res.text();
}
