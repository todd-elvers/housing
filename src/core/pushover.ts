import { fetchJson } from "./http.ts";

/**
 * Send a phone notification via Pushover (https://pushover.net/api). Reads
 * PUSHOVER_TOKEN / PUSHOVER_USER from the environment (decrypted from .env.age
 * at startup, like every other credential). Throws on missing config or a
 * rejected send so callers can decide whether delivery matters — the Van Ness
 * watcher, for instance, refuses to advance its snapshot on failure so the
 * update is retried next run instead of silently lost.
 */
export function pushoverConfigured(): boolean {
  return Boolean(process.env.PUSHOVER_TOKEN && process.env.PUSHOVER_USER);
}

export async function sendPushover(opts: {
  message: string;
  title?: string;
  url?: string;
  urlTitle?: string;
}): Promise<void> {
  const token = process.env.PUSHOVER_TOKEN;
  const user = process.env.PUSHOVER_USER;
  if (!token || !user) throw new Error("PUSHOVER_TOKEN / PUSHOVER_USER not set");

  const res = await fetchJson<{ status: number; errors?: string[] }>(
    "https://api.pushover.net/1/messages.json",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        user,
        message: opts.message,
        ...(opts.title ? { title: opts.title } : {}),
        ...(opts.url ? { url: opts.url } : {}),
        ...(opts.urlTitle ? { url_title: opts.urlTitle } : {}),
      }),
      timeoutMs: 15_000,
      retries: 2,
    },
  );
  if (res.status !== 1)
    throw new Error(`pushover rejected: ${res.errors?.join("; ") ?? "unknown"}`);
}
