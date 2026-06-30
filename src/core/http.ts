const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export interface FetchOpts {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch() with a default browser UA, timeout, and retry on network error / 5xx. */
export async function httpFetch(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { timeoutMs = 25_000, retries = 2 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const init: RequestInit = {
        method: opts.method ?? "GET",
        headers: { "user-agent": DEFAULT_UA, ...opts.headers },
        signal: ctl.signal,
      };
      if (opts.body !== undefined) init.body = opts.body;
      const res = await fetch(url, init);
      clearTimeout(timer);
      if (res.status >= 500 && attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(600 * (attempt + 1));
        continue;
      }
    }
  }
  throw lastErr;
}

/** Strip anti-JSON-hijack guards some endpoints prepend (Redfin `{}&&`, `)]}'`). */
export function stripJsonGuard(s: string): string {
  let out = s.replace(/^﻿/, "");
  if (out.startsWith("{}&&")) return out.slice(4);
  const m = out.match(/^\)\]\}'?,?\s*/);
  if (m) out = out.slice(m[0].length);
  return out;
}

export async function fetchJson<T = unknown>(url: string, opts?: FetchOpts): Promise<T> {
  const res = await httpFetch(url, opts);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const text = await res.text();
  return JSON.parse(stripJsonGuard(text)) as T;
}

export async function fetchText(url: string, opts?: FetchOpts): Promise<string> {
  const res = await httpFetch(url, opts);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}
