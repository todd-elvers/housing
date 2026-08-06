// Fires `workflow_dispatch` for the housing ingest workflow on a Cloudflare
// cron. GitHub's own `schedule` trigger is best-effort (we measured ~half of
// hourly ticks dropped); API-dispatched runs start immediately and reliably.
// The workflow's `ingest` concurrency group serializes any overlap.

const API_BASE = "https://api.github.com/repos/todd-elvers/housing/actions/workflows/ingest.yml";
const DISPATCH_URL = `${API_BASE}/dispatches`;

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
};

function ghHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "housing-ingest-cron (cloudflare-worker)",
  };
}

// True when an ingest run is already queued or executing. GitHub's concurrency
// queue holds only ONE pending run per group and CANCELS the older one when a
// newer arrives — so dispatching while a run is waiting for a runner (as during
// the Aug 6 2026 Actions outage, when pickup took 15+ min) manufactures
// cancelled/failed runs out of thin air. Skipping the tick instead loses
// nothing: each run ingests the full current state, and the next tick fires
// 10 minutes later. Fails open (false) — if this check is down, GitHub is
// probably down too, but the dispatch attempt is still the right default.
async function hasActiveRun(env) {
  const ACTIVE = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
  try {
    const res = await fetch(`${API_BASE}/runs?per_page=10`, { headers: ghHeaders(env) });
    if (!res.ok) return false;
    const body = await res.json();
    return (body.workflow_runs ?? []).some((r) => ACTIVE.has(r.status));
  } catch {
    return false;
  }
}

async function dispatch(env) {
  if (await hasActiveRun(env)) {
    console.log("skipped dispatch: an ingest run is already queued or in progress");
    return;
  }
  let lastError = "";
  // One retry on transient failure; GitHub returns 204 on success.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(DISPATCH_URL, {
        method: "POST",
        headers: ghHeaders(env),
        body: JSON.stringify({ ref: "main" }),
      });
      if (res.status === 204) {
        console.log("dispatched ingest workflow");
        return;
      }
      lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
      // 4xx won't improve on retry (bad/expired token, workflow renamed) — bail.
      if (res.status < 500) break;
    } catch (err) {
      lastError = String(err);
    }
  }
  console.error(`dispatch failed: ${lastError}`);
  await alertDiscord(env, lastError);
}

// Best-effort alert so an expired PAT doesn't fail silently for days.
async function alertDiscord(env, detail) {
  if (!env.DISCORD_ERROR_WEBHOOK) return;
  try {
    await fetch(env.DISCORD_ERROR_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "SF Rent Radar",
        content: `🚨 **housing cron worker couldn't dispatch the ingest workflow**\n${detail.slice(0, 500)}\n(Is the GITHUB_TOKEN secret expired? \`wrangler secret put GITHUB_TOKEN\` in infra/cron-worker.)`,
        allowed_mentions: { parse: [] },
      }),
    });
  } catch {
    /* alerting is best-effort */
  }
}
