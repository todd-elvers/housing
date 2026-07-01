import { defineCommand, type CommandDef } from "citty";
import { z } from "zod";
import { zodToCittyArgs } from "./args.ts";
import { renderDescription, structuredFail } from "./tool-help.ts";
import { validateEnv, type EnvDecl, type EnvValues } from "./env/spec.ts";
import { log, type Logger } from "./core/log.ts";

/** The introspector reads a command's schemas + metadata off this symbol. */
export const META = Symbol("housing.tool");

export interface ToolContext<I, E extends EnvDecl> {
  input: I;
  env: EnvValues<E>;
  log: Logger;
}

export interface ToolDef<I extends z.ZodObject<z.ZodRawShape>, E extends EnvDecl> {
  /** One line: WHAT this does. */
  summary: string;
  /** WHEN an LLM/operator should reach for this. */
  when: string;
  /** query = read-only; mutation = writes/notifies. */
  kind: "query" | "mutation";
  /** Args as a flat zod object — the single source of truth for parsing, validation, help, and introspection. */
  input?: I;
  /** Env this command needs; validated BEFORE run(). */
  requires?: E;
  examples?: string[];
  run(ctx: ToolContext<I extends z.ZodObject<z.ZodRawShape> ? z.infer<I> : Record<never, never>, E>): unknown | Promise<unknown>;
}

/** Author a command. A file that default-exports this becomes a registered, nested, introspectable command. */
export function defineTool<
  I extends z.ZodObject<z.ZodRawShape> = z.ZodObject<Record<never, never>>,
  E extends EnvDecl = Record<never, never>,
>(def: ToolDef<I, E>): CommandDef {
  const cmd = defineCommand({
    meta: { description: renderDescription(def) },
    args: { ...zodToCittyArgs(def.input), json: { type: "boolean", description: "Emit the result as JSON" } },
    async run({ args }) {
      const asJson = Boolean((args as Record<string, unknown>).json);

      // (1) Fail fast on env, before any I/O.
      let env: EnvValues<E>;
      try {
        env = (def.requires ? validateEnv(def.requires) : {}) as EnvValues<E>;
      } catch (e) {
        structuredFail(e, asJson);
      }

      // (2) zod is the arg authority (parse/coerce the tokenized flags).
      const raw = strip(args as Record<string, unknown>);
      const parsed = def.input ? def.input.safeParse(raw) : ({ success: true, data: {} } as const);
      if (!parsed.success) {
        const msg = parsed.error.issues.map((i) => `--${i.path.join(".")}: ${i.message}`).join("; ");
        structuredFail(new Error(msg), asJson);
      }

      // (3) run, with structured errors.
      let result: unknown;
      try {
        result = await def.run({ input: parsed.data as never, env, log });
      } catch (e) {
        structuredFail(e, asJson);
      }
      if (result !== undefined) {
        if (asJson) log.out(JSON.stringify(result, null, 2));
        else log.print(`(${Array.isArray(result) ? `${result.length} result(s)` : "done"} — add --json for full output)`);
      }
    },
  }) as CommandDef;
  (cmd as Record<symbol, unknown>)[META] = def;
  return cmd;
}

const DROPPED_KEYS = new Set(["_", "json", "verbose", "v", "quiet", "q"]);
/** Drop citty's bookkeeping + global flags before handing values to zod. */
function strip(a: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(a).filter(([k]) => !DROPPED_KEYS.has(k)));
}
