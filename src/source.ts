import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import type { CommandDef } from "citty";
import { defineTool } from "./tool.ts";
import { checkEnv, validateEnv, type EnvDecl, type EnvValues } from "./env/spec.ts";
import type { RawListing } from "./core/types.ts";
import { log, type Logger } from "./core/log.ts";

/** The source contract (structurally the engine's Adapter) is stashed here for ingest + discovery. */
export const SOURCE = Symbol("housing.source");

export interface SourceContract {
  name: string;
  snapshotComplete: boolean;
  order: number;
  enabled(): { ok: true } | { ok: false; reason: string };
  fetch(): Promise<RawListing[]>;
}

export interface SourceCtx {
  log: Logger;
}

/**
 * Author a rental data source. The returned command is BOTH a `search <name>`
 * command (fail-fast env, --json result) AND an ingestable adapter (skip-on-
 * missing-env). One file = both.
 */
export function defineSource<E extends EnvDecl = Record<never, never>>(def: {
  /** MUST equal the filename. Id for `search <name>` / `ingest --source` / `sources`. */
  name: string;
  summary: string;
  when: string;
  /** true if a full fetch is the complete set (absence ⇒ removed). */
  snapshotComplete: boolean;
  /** ingest run order; lower first, ties alphabetical. Default 100. */
  order?: number;
  requires?: E;
  fetch(env: EnvValues<E>, ctx: SourceCtx): Promise<RawListing[]>;
}): CommandDef {
  const cmd = defineTool({
    summary: def.summary,
    when: def.when,
    kind: "query",
    requires: def.requires,
    examples: [`housing search ${def.name}`],
    run: async ({ env, log }) => {
      const started = Date.now();
      const listings = await def.fetch(env as EnvValues<E>, { log });
      log.info(
        `search ${def.name}: fetched ${listings.length} listings in ${Date.now() - started}ms`,
      );
      return listings;
    },
  });
  const contract: SourceContract = {
    name: def.name,
    snapshotComplete: def.snapshotComplete,
    order: def.order ?? 100,
    enabled: () => (def.requires ? checkEnv(def.requires) : { ok: true }),
    fetch: () =>
      def.fetch((def.requires ? validateEnv(def.requires) : {}) as EnvValues<E>, { log }),
  };
  (cmd as Record<symbol, unknown>)[SOURCE] = contract;
  return cmd;
}

/** Discover every source: import each src/commands/search/*.ts and read its SOURCE contract. */
export async function loadSources(): Promise<SourceContract[]> {
  const dir = fileURLToPath(new URL("./commands/search/", import.meta.url));
  const out: SourceContract[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name.startsWith("_") || !entry.name.endsWith(".ts")) continue;
    const mod = (await import(pathToFileURL(join(dir, entry.name)).href)) as { default?: unknown };
    const contract = (mod.default as Record<symbol, unknown> | undefined)?.[SOURCE] as
      | SourceContract
      | undefined;
    if (contract) out.push(contract);
  }
  out.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return out;
}
