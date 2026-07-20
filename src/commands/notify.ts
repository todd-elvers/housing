import { z } from "zod";
import { existsSync } from "node:fs";
import { defineTool } from "../tool.ts";
import { envSpec } from "../env/spec.ts";
import { Store } from "../core/db.ts";
import { syncDiscord } from "../core/notify.ts";

// Post-only Discord sync. `ingest` already reconciles the board at the end of
// every run; this command does *just* the posting from the existing DB — no
// source fetching, no commute enrichment — so it never spends a metered API call.
// Handy for draining the going-forward backlog on its own schedule.
export default defineTool({
  summary:
    "Post eligible listings that aren't on the Discord board yet, from the existing DB — no source fetching, so it costs nothing.",
  when: "Run to drain/trickle the Discord board without a full `ingest` (which hits the metered source + commute APIs). Respects the same commute/pacing/cap env as ingest.",
  kind: "mutation",
  input: z.object({
    limit: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Max cards to post this run (default: HOUSING_NOTIFY_MAX_PER_RUN, or all eligible)",
      ),
  }),
  requires: {
    HOUSING_DB: envSpec(z.string().default("data/housing.db"), "SQLite database path", ""),
    DISCORD_WEBHOOK: envSpec(
      z.string().url(),
      "Discord webhook URL — the board is posted here",
      "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
    ),
  },
  async run({ input, env }) {
    if (!existsSync(env.HOUSING_DB)) {
      throw new Error(`no database at ${env.HOUSING_DB} — run \`housing ingest\` first`);
    }
    const store = new Store(env.HOUSING_DB);
    try {
      return await syncDiscord(store, [], [], input.limit);
    } finally {
      store.close();
    }
  },
});
