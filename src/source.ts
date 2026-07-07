import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import type { CommandDef } from "citty";
import { z } from "zod";
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
  /** 1 = free/direct (run by default). 2 = paid/managed anti-bot (opt-in via ingest --paid). */
  tier: number;
  enabled(): { ok: true } | { ok: false; reason: string };
  fetch(): Promise<RawListing[]>;
}

/** A source is "paid" (tier 2+) if it hits a metered/managed API — gated out of a plain `ingest`. */
export const isPaid = (s: { tier: number }): boolean => s.tier >= 2;

/** What a source's fetch receives besides its env: the logger and any parsed CLI args. */
export interface SourceCtx<I = Record<never, never>> {
  log: Logger;
  /**
   * Parsed CLI args when the source is invoked as `search <name> --flag …`.
   * On the `ingest` path there are no CLI args, so every field is its schema
   * default (all-optional ⇒ `{}`), and the source falls back to its env config.
   */
  input: I;
}

type InputOf<I> = I extends z.ZodObject<z.ZodRawShape> ? z.infer<I> : Record<never, never>;

/**
 * Author a rental data source. The returned command is BOTH a `search <name>`
 * command (fail-fast env, --json result) AND an ingestable adapter (skip-on-
 * missing-env). One file = both.
 *
 * A source may also declare `input` (a flat zod object): those become real CLI
 * flags an operator/LLM can pass to `search <name>`, and arrive in `ctx.input`.
 * `ingest` never passes flags, so keep every input field optional and resolve
 * defaults from env inside `fetch` (input overrides env when present).
 */
export function defineSource<
  E extends EnvDecl = Record<never, never>,
  I extends z.ZodObject<z.ZodRawShape> = z.ZodObject<Record<never, never>>,
>(def: {
  /** MUST equal the filename. Id for `search <name>` / `ingest --source` / `sources`. */
  name: string;
  summary: string;
  when: string;
  /** true if a full fetch is the complete set (absence ⇒ removed). */
  snapshotComplete: boolean;
  /** ingest run order; lower first, ties alphabetical. Default 100. */
  order?: number;
  /** 1 = free/direct (default). 2 = paid/managed anti-bot — skipped by a plain `ingest`. */
  tier?: number;
  requires?: E;
  /** Optional flat zod object exposed as CLI flags (arrives in ctx.input). */
  input?: I;
  fetch(env: EnvValues<E>, ctx: SourceCtx<InputOf<I>>): Promise<RawListing[]>;
}): CommandDef {
  const defaultInput = () => (def.input ? def.input.parse({}) : {}) as InputOf<I>;
  const cmd = defineTool({
    summary: def.summary,
    when: def.when,
    kind: "query",
    input: def.input,
    requires: def.requires,
    examples: [`housing search ${def.name}`],
    run: async ({ env, log, input }) => {
      const started = Date.now();
      const listings = await def.fetch(env as EnvValues<E>, { log, input: input as InputOf<I> });
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
    tier: def.tier ?? 1,
    enabled: () => (def.requires ? checkEnv(def.requires) : { ok: true }),
    // ingest passes no CLI args → schema defaults (env config drives the fetch).
    fetch: () =>
      def.fetch((def.requires ? validateEnv(def.requires) : {}) as EnvValues<E>, {
        log,
        input: defaultInput(),
      }),
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
