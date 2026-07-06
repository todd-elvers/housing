import { defineCommand, runMain, renderUsage, type CommandDef } from "citty";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env/dotenv.ts";
import { loadCommands } from "./discover.ts";
import { log } from "./core/log.ts";

loadEnv();

const commandsDir = fileURLToPath(new URL("./commands/", import.meta.url));

const main: CommandDef = defineCommand({
  meta: {
    name: "housing",
    version: "0.1.0",
    description: "Automated San Francisco rental ingest + change monitoring.",
  },
  subCommands: loadCommands(commandsDir),
});

// Bare `housing` (no subcommand, no --help/--version) — print help and exit 0
// instead of citty's "No command specified" error. A root run() can't do this:
// citty would run it for EVERY invocation (polluting subcommand output), so we
// short-circuit here, before runMain does its own subcommand routing.
const argv = process.argv.slice(2);
const hasCommand = argv.some((a) => !a.startsWith("-"));
const wantsMeta = argv.some((a) => /^(--help|-h|--version|-v)$/.test(a));
if (!hasCommand && !wantsMeta) {
  process.stdout.write((await renderUsage(main)) + "\n");
  process.stdout.write(
    "\nRun `housing introspect --json` for the machine-readable tool catalog.\n",
  );
  process.exit(0);
}

runMain(main).catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
