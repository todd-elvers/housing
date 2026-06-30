import { httpFetch } from "../core/http.ts";
import type { Adapter, RawListing } from "../core/types.ts";

// Reddit OAuth Data API — NEW-lead intel (private landlords / sublets posted in
// SF housing subs), not structured listings. Posts are immutable so this is a
// new-only feed. Needs a free "script" app (reddit.com/prefs/apps).
const SUBS = (process.env.REDDIT_SUBS || "sanfrancisco,bayarea,AskSF")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const QUERY = "apartment OR rent OR sublet OR lease OR housing";

interface RedditChild {
  data: {
    name: string; // t3_xxx fullname
    title: string;
    permalink: string;
    url?: string;
    created_utc: number;
    subreddit: string;
    author?: string;
  };
}

export const reddit: Adapter = {
  name: "reddit",
  snapshotComplete: false,
  enabled() {
    return process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET
      ? { ok: true }
      : { ok: false, reason: "set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET" };
  },
  async fetch(): Promise<RawListing[]> {
    const token = await getToken();
    const ua = `housing-monitor/0.1 by ${process.env.REDDIT_USERNAME || "anonymous"}`;
    const out: RawListing[] = [];
    for (const sub of SUBS) {
      const url =
        `https://oauth.reddit.com/r/${encodeURIComponent(sub)}/search` +
        `?q=${encodeURIComponent(QUERY)}&restrict_sr=1&sort=new&limit=50&t=week`;
      const res = await httpFetch(url, {
        headers: { authorization: `Bearer ${token}`, "user-agent": ua },
      });
      if (!res.ok) continue; // a missing/blocked sub shouldn't kill the run
      const json = (await res.json()) as { data?: { children?: RedditChild[] } };
      for (const c of json.data?.children ?? []) out.push(map(c));
    }
    return out;
  },
};

async function getToken(): Promise<string> {
  const id = process.env.REDDIT_CLIENT_ID!;
  const secret = process.env.REDDIT_CLIENT_SECRET!;
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await httpFetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": `housing-monitor/0.1 by ${process.env.REDDIT_USERNAME || "anonymous"}`,
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`reddit token → HTTP ${res.status}`);
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("reddit token missing");
  return json.access_token;
}

function map(c: RedditChild): RawListing {
  const d = c.data;
  return {
    sourceId: d.name,
    url: `https://www.reddit.com${d.permalink}`,
    title: d.title,
    neighborhood: d.subreddit,
    postedAt: d.created_utc * 1000,
    propertyType: "reddit-post",
    changeTag: d.title, // posts are immutable
    raw: { author: d.author, sub: d.subreddit },
  };
}
