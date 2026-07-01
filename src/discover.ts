import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CommandDef } from "citty";

/**
 * Turn a directory into a citty subCommands map. Folders become nested groups;
 * `.ts` files become lazily-imported leaf commands (their default export).
 * Files/dirs starting with `_` are ignored (colocated helpers). This is the
 * whole registration mechanism — dropping a file under src/commands/ registers
 * a command; there is no central array to edit.
 */
export function loadCommands(dir: string): Record<string, () => Promise<CommandDef>> {
  const out: Record<string, () => Promise<CommandDef>> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith("_")) continue;
    if (entry.isDirectory()) {
      const sub = join(dir, entry.name);
      out[entry.name] = async () =>
        ({ meta: { name: entry.name, description: `${entry.name} commands` }, subCommands: loadCommands(sub) }) as CommandDef;
    } else if (entry.name.endsWith(".ts")) {
      const name = entry.name.slice(0, -3);
      out[name] = () =>
        import(pathToFileURL(join(dir, entry.name)).href).then((m) => {
          const cmd = m.default as CommandDef;
          // Inject the command name from the filename so citty's usage/help shows
          // "housing search rentcast" instead of the script path.
          if (cmd.meta && typeof cmd.meta === "object" && !(cmd.meta as { name?: string }).name) {
            (cmd.meta as { name?: string }).name = name;
          }
          return cmd;
        });
    }
  }
  return out;
}
