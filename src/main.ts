import { defineCommand, runMain } from "citty";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env/dotenv.ts";
import { loadCommands } from "./discover.ts";
import { log } from "./core/log.ts";

loadEnv();

const commandsDir = fileURLToPath(new URL("./commands/", import.meta.url));

const main = defineCommand({
  meta: {
    name: "housing",
    version: "0.1.0",
    description:
      "Automated San Francisco rental ingest + change monitoring.\n" +
      "Discover every tool + when to use it: `housing introspect --json`.\n" +
      "Add a tool: drop a file in src/commands/ (see SETUP.md). Run logs: ./housing.log.",
  },
  subCommands: loadCommands(commandsDir),
});

runMain(main).catch((err) => {
  log.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
