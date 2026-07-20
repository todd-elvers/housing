import { z } from "zod";
import { existsSync } from "node:fs";
import { defineTool } from "../tool.ts";
import { envSpec } from "../env/spec.ts";
import { enrichCommutes } from "../core/commute.ts";

// Recompute door-to-door commute routes for the ingested listings. Normally this
// runs automatically at the tail of `housing ingest` (filling only the listings
// that lack a route). Use this command directly to force a full recompute — e.g.
// after changing the arrival time or moving the office anchor, when every stored
// route is now stale and must be refetched against the new parameters.
export default defineTool({
  summary:
    "Recompute TravelTime commute routes for ingested listings (per-leg walk/transit breakdown), gated by distance.",
  when: "Run after changing the office anchor or arrival time (with --force to wipe + recompute), or to backfill routes without a full ingest.",
  kind: "mutation",
  input: z.object({
    force: z.coerce
      .boolean()
      .default(false)
      .describe(
        "Wipe stored commute data first, then recompute (use after the anchor or arrival time changes)",
      ),
    legGate: z.coerce
      .number()
      .optional()
      .describe(
        "Transit-minute cutoff for fetching the per-leg route breakdown (default 30; all listings still get a matrix time)",
      ),
  }),
  requires: {
    HOUSING_DB: envSpec(z.string().default("data/housing.db"), "SQLite database path", ""),
    HOUSING_ANCHOR: envSpec(
      z.string().regex(/^-?\d+\.?\d*,-?\d+\.?\d*$/),
      "Office anchor 'lat,lon' — routes are computed to here",
      "",
    ),
    TRAVELTIME_APPLICATION_ID: envSpec(
      z.string().min(1),
      "TravelTime application ID",
      "https://account.traveltime.com",
    ),
    TRAVELTIME_API_KEY: envSpec(
      z.string().min(1),
      "TravelTime API key",
      "https://account.traveltime.com",
    ),
  },
  async run({ input, env, log }) {
    if (!existsSync(env.HOUSING_DB)) {
      throw new Error(`no database at ${env.HOUSING_DB} — run \`housing ingest\` first`);
    }

    if (input.force) log.print("Forcing a full recompute — clearing existing commute data first…");
    const result = await enrichCommutes(env.HOUSING_DB, {
      force: input.force,
      legGateMin: input.legGate,
    });

    if (result.reason) {
      throw new Error(`cannot enrich: ${result.reason}`);
    }
    log.print(
      `\nCommute: ${result.timed} timed (matrix), ${result.legs} with leg breakdown` +
        (result.unreachable ? `, ${result.unreachable} unreachable` : "") +
        (result.cleared ? `, ${result.cleared} cleared` : "") +
        ".",
    );
    return result;
  },
});
