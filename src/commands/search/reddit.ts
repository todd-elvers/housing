import { z } from "zod";
import { defineSource } from "../../source.ts";
import { envSpec } from "../../env/spec.ts";
import { httpFetch } from "../../core/http.ts";
import type { RawListing } from "../../core/types.ts";

// Reddit OAuth Data API — NEW-lead intel (private landlords / sublets posted in
// SF housing subs), not structured listings. Posts are immutable so this is a
// new-only feed. Needs a free "script" app (reddit.com/prefs/apps).
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

export default defineSource({
  name: "reddit",
  summary: "Reddit OAuth search across SF housing subs — NEW-lead intel on private-landlord/sublet posts, not structured listings.",
  when: "Use to surface off-market leads (private landlords, sublets) posted to r/sanfrancisco, r/bayarea, r/AskSF; immutable posts, so new-only. Needs a free Reddit script app.",
  snapshotComplete: false,
  requires: {
    REDDIT_CLIENT_ID: envSpec(z.string().min(1), "Reddit script-app client id", "https://www.reddit.com/prefs/apps"),
    REDDIT_CLIENT_SECRET: envSpec(z.string().min(1), "Reddit script-app secret", "https://www.reddit.com/prefs/apps"),
    REDDIT_USERNAME: envSpec(z.string().optional(), "Reddit username (used only to build a descriptive User-Agent)", ""),
    REDDIT_SUBS: envSpec(z.string().default("sanfrancisco,bayarea,AskSF"), "Comma-separated housing subreddits", ""),
  },
  async fetch(env): Promise<RawListing[]> {
    const subs = env.REDDIT_SUBS.split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const username = env.REDDIT_USERNAME || "anonymous";
    const token = await getToken(env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, username);
    const ua = `housing-monitor/0.1 by ${username}`;
    const out: RawListing[] = [];
    for (const sub of subs) {
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
});

async function getToken(id: string, secret: string, username: string): Promise<string> {
  const basic = Buffer.from(`${id}:${secret}`).toString("base64");
  const res = await httpFetch("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": `housing-monitor/0.1 by ${username}`,
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
