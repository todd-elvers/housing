import { z } from "zod";
import { defineTool } from "../tool.ts";
import { envSpec } from "../env/spec.ts";
import { loadSources, isPaid } from "../source.ts";
import { ingestSources } from "../core/run.ts";

export default defineTool({
  summary:
    "Fetch enabled sources (free tier-1 by default; --paid adds tier-2), diff against the DB, and notify on new/changed/removed listings.",
  when: "Run on a schedule (or by hand) to refresh the SF rental database and surface what changed. Plain runs stay free; add --paid (or --source <name>) to include tier-2 paid sources.",
  kind: "mutation",
  input: z.object({
    source: z
      .string()
      .optional()
      .describe("Comma-separated source names to limit to (default: all enabled)"),
    paid: z
      .boolean()
      .optional()
      .describe("Include tier-2 paid/managed sources (they cost money per call)"),
  }),
  requires: {
    HOUSING_DB: envSpec(z.string().default("data/housing.db"), "SQLite database path", ""),
    DISCORD_WEBHOOK: envSpec(
      z.string().url().optional(),
      "Discord webhook URL (optional; posts a digest to the shared channel on new/changed/removed)",
      "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks",
    ),
  },
  async run({ input, env }) {
    let sources = await loadSources();
    if (input.source) {
      const want = new Set(
        input.source
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
      const known = new Set(sources.map((s) => s.name));
      const unknown = [...want].filter((n) => !known.has(n));
      if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(", ")}`);
      sources = sources.filter((s) => want.has(s.name)); // explicit names → any tier
    } else if (!input.paid) {
      sources = sources.filter((s) => !isPaid(s)); // default: free sources only, never spend money
    }
    const summaries = await ingestSources(sources, env.HOUSING_DB);
    return {
      sources: summaries.length,
      new: summaries.reduce((n, s) => n + s.newCount, 0),
      changed: summaries.reduce((n, s) => n + s.changedCount, 0),
      removed: summaries.reduce((n, s) => n + s.removedCount, 0),
      errors: summaries.filter((s) => s.error).map((s) => ({ source: s.source, error: s.error })),
    };
  },
});
