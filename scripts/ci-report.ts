import { readFileSync } from "node:fs";
import { loadEnv } from "../src/env/dotenv.ts";

// CI tail step: report a failed/degraded ingest run to Discord. Reads the JSON
// result `housing ingest --json` wrote (path in argv[2]; may be absent if the
// run crashed before producing output) plus the step outcome GitHub passes in
// INGEST_OUTCOME. Posts to DISCORD_ERROR_WEBHOOK — a plain text channel, NOT the
// forum-board webhook (forum webhooks reject messages without a thread target).
// Always exits 0: the ingest step itself is what reddens the workflow run.

loadEnv();

const outcome = process.env.INGEST_OUTCOME ?? "unknown";
const resultPath = process.argv[2];

interface IngestResult {
  sources?: number;
  new?: number;
  changed?: number;
  removed?: number;
  errors?: { source: string; error: string }[];
}

let result: IngestResult | null = null;
try {
  if (resultPath) result = JSON.parse(readFileSync(resultPath, "utf8")) as IngestResult;
} catch {
  /* missing or unparseable — treated as a hard failure below */
}

const sourceErrors = result?.errors ?? [];
const hardFailure = outcome !== "success";
if (!hardFailure && sourceErrors.length === 0) {
  console.log("ci-report: ingest clean — nothing to report");
  process.exit(0);
}

const webhook = process.env.DISCORD_ERROR_WEBHOOK;
if (!webhook) {
  console.error("ci-report: DISCORD_ERROR_WEBHOOK not set — cannot report the failure");
  process.exit(0);
}

const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : null;

const lines: string[] = [];
if (hardFailure) {
  lines.push(`🚨 **housing ingest failed** (step outcome: ${outcome})`);
  if (!result) lines.push("No JSON result was produced — the run crashed before finishing.");
} else {
  lines.push(`⚠️ **housing ingest finished with source errors**`);
}
if (result) {
  lines.push(
    `${result.sources ?? 0} source(s) · ${result.new ?? 0} new · ${result.changed ?? 0} changed · ${result.removed ?? 0} removed`,
  );
}
for (const e of sourceErrors.slice(0, 8)) {
  lines.push(`• \`${e.source}\`: ${e.error.slice(0, 200)}`);
}
if (sourceErrors.length > 8) lines.push(`… and ${sourceErrors.length - 8} more`);
if (runUrl) lines.push(runUrl);

const res = await fetch(`${webhook}?wait=true`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    username: "SF Rent Radar",
    content: lines.join("\n").slice(0, 1900), // hard Discord content cap is 2000
    allowed_mentions: { parse: [] },
  }),
});
if (!res.ok) {
  console.error(`ci-report: Discord webhook returned HTTP ${res.status}`);
} else {
  console.log(`ci-report: posted ${hardFailure ? "failure" : "source-error"} alert to Discord`);
}
