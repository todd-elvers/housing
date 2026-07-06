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
  // Bare `housing` (no subcommand) — show help and exit 0 instead of erroring.
  async run() {
    process.stdout.write((await renderUsage(main)) + "\n");
    process.stdout.write(
      "\nRun `housing introspect --json` for the machine-readable tool catalog.\n",
    );
  },
});

runMain(main).catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
