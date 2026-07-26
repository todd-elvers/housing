import { z } from "zod";
import { existsSync } from "node:fs";
import { defineTool } from "../tool.ts";
import { envSpec } from "../env/spec.ts";
import { isRemoteDb } from "../core/client.ts";
import { enrichCommutes } from "../core/commute.ts";

// Recompute door-to-door travel times for the ingested listings. Normally this
// runs automatically at the tail of `housing ingest` (filling only the listings
// that lack one). Use this command directly to force a full recompute — e.g.
// after changing the arrival time or moving the office anchor, when every stored
// time is now stale and must be refetched against the new parameters.
export default defineTool({
  summary:
    "Recompute TravelTime travel times to the office anchor — transit, walking and driving totals, plus a per-leg transit breakdown for close-in listings.",
  when: "Run after changing the office anchor or arrival time (with --force to wipe + recompute), or to backfill travel times without a full ingest.",
  kind: "mutation",
  input: z.object({
    force: z.coerce
      .boolean()
      .default(false)
      .describe(
        "Wipe stored travel data first, then recompute (use after the anchor or arrival time changes)",
      ),
    legGate: z.coerce
      .number()
      .optional()
      .describe(
        "Transit-minute cutoff for fetching the per-leg route breakdown (default 30; all listings still get matrix times for every mode)",
      ),
  }),
  requires: {
    HOUSING_DB: envSpec(
      z.string().default("data/housing.db"),
      "SQLite file path or libsql:// Turso URL",
      "",
    ),
    TURSO_AUTH_TOKEN: envSpec(
      z.string().optional(),
      "Turso auth token (required when HOUSING_DB is a libsql:// URL)",
      "https://docs.turso.tech/cli/db/tokens/create",
    ),
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
    if (!isRemoteDb(env.HOUSING_DB) && !existsSync(env.HOUSING_DB)) {
      throw new Error(`no database at ${env.HOUSING_DB} — run \`housing ingest\` first`);
    }

    if (input.force) log.print("Forcing a full recompute — clearing existing travel data first…");
    const result = await enrichCommutes(env.HOUSING_DB, {
      force: input.force,
      legGateMin: input.legGate,
    });

    if (result.reason) {
      throw new Error(`cannot enrich: ${result.reason}`);
    }
    const modes = Object.entries(result.matrix)
      .map(
        ([label, t]) =>
          `${label} ${t.timed}${t.unreachable ? ` (+${t.unreachable} out of range)` : ""}`,
      )
      .join(", ");
    log.print(
      `\nTravel times: ${modes}; ${result.legs} with a transit leg breakdown` +
        (result.cleared ? `, ${result.cleared} cleared` : "") +
        ".",
    );
    return result;
  },
});
