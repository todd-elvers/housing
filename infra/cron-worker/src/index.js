// Fires `workflow_dispatch` for the housing ingest workflow on a Cloudflare
// cron. GitHub's own `schedule` trigger is best-effort (we measured ~half of
// hourly ticks dropped); API-dispatched runs start immediately and reliably.
// The workflow's `ingest` concurrency group serializes any overlap.

const DISPATCH_URL =
  "https://api.github.com/repos/todd-elvers/housing/actions/workflows/ingest.yml/dispatches";

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env));
  },
};

async function dispatch(env) {
  let lastError = "";
  // One retry on transient failure; GitHub returns 204 on success.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(DISPATCH_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.GITHUB_TOKEN}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "housing-ingest-cron (cloudflare-worker)",
        },
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
