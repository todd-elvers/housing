import { z } from "zod";
import { defineTool } from "../tool.ts";
import { envSpec } from "../env/spec.ts";
import { loadSources } from "../source.ts";
import { ingestSources } from "../core/run.ts";

export default defineTool({
  summary: "Fetch all enabled sources, diff against the DB, and notify on new/changed/removed listings.",
  when: "Run on a schedule (or by hand) to refresh the SF rental database and surface what changed since last run.",
  kind: "mutation",
  input: z.object({
    source: z
      .string()
      .optional()
      .describe("Comma-separated source names to limit to (default: all enabled)"),
  }),
  requires: {
    HOUSING_DB: envSpec(z.string().default("data/housing.db"), "SQLite database path", ""),
    PUSHOVER_TOKEN: envSpec(
      z.string().optional(),
      "Pushover app token (optional; enables push notifications)",
      "https://pushover.net/apps/build",
    ),
    PUSHOVER_USER: envSpec(
      z.string().optional(),
      "Pushover user key (optional; enables push notifications)",
      "https://pushover.net",
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
      sources = sources.filter((s) => want.has(s.name));
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
