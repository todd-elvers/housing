import { loadEnv } from "./core/env.ts";
import { runIngest } from "./core/run.ts";
import { ADAPTERS } from "./adapters/index.ts";

loadEnv();

function parseFlags(argv: string[]): Map<string, string | boolean> {
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(key, next);
      i++;
    } else {
      flags.set(key, true);
    }
  }
  return flags;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (cmd) {
    case "ingest": {
      const sourcesArg = flags.get("source") || flags.get("sources");
      const sources =
        typeof sourcesArg === "string" ? sourcesArg.split(",").map((s) => s.trim()) : undefined;
      const noNotify = flags.get("no-notify") === true;
      await runIngest({ sources, notify: !noNotify });
      break;
    }
    case "sources": {
      console.log("Adapters:");
      for (const a of ADAPTERS) {
        const s = a.enabled();
        const mark = s.ok ? "●" : "○";
        const snap = a.snapshotComplete ? "snapshot" : "feed    ";
        const note = s.ok ? "enabled" : `disabled — ${s.reason ?? ""}`;
        console.log(`  ${mark} ${a.name.padEnd(12)} [${snap}]  ${note}`);
      }
      console.log("\n  ● enabled   ○ disabled (needs config)");
      console.log("  snapshot = absence ⇒ removed · feed = new-only, no removal inference");
      break;
    }
    default:
      console.log(`housing — SF rental ingest

Usage:
  tsx src/cli.ts ingest [--source a,b]   fetch sources, diff, notify
  tsx src/cli.ts ingest --no-notify      run without the webhook POST
  tsx src/cli.ts sources                 list adapters + enabled state

Or via mise:  mise run ingest   |   mise run sources`);
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
