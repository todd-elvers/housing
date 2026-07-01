import { z } from "zod";

/** One environment variable a command needs. */
export interface EnvSpec<T = unknown> {
  schema: z.ZodType<T>;
  description: string;
  /** URL / instructions to obtain it. "" for internal defaults. */
  getAt: string;
}

/** Declare an env var. `getAt` is where to obtain it (shown in help + errors). */
export function envSpec<T>(schema: z.ZodType<T>, description: string, getAt = ""): EnvSpec<T> {
  return { schema, description, getAt };
}

export type EnvDecl = Record<string, EnvSpec>;
export type EnvValues<D extends EnvDecl> = {
  [K in keyof D]: D[K] extends EnvSpec<infer T> ? T : never;
};

export class EnvError extends Error {
  constructor(
    public missing: string[],
    public report: string,
  ) {
    super(report);
    this.name = "EnvError";
  }
}

/** Validate a command's declared env. Collects ALL problems, then throws once (fail-fast, before any work). */
export function validateEnv<D extends EnvDecl>(decl: D): EnvValues<D> {
  const out: Record<string, unknown> = {};
  const lines: string[] = [];
  const missing: string[] = [];
  for (const [key, spec] of Object.entries(decl)) {
    const r = spec.schema.safeParse(process.env[key]);
    if (r.success) {
      out[key] = r.data;
      continue;
    }
    missing.push(key);
    const where = spec.getAt ? ` — get it at ${spec.getAt}` : "";
    const why = r.error.issues[0]?.message ?? "invalid";
    lines.push(`    ✗ ${key}: ${spec.description}${where}\n        set it in .env (${why})`);
  }
  if (missing.length) throw new EnvError(missing, `environment not ready:\n${lines.join("\n")}`);
  return out as EnvValues<D>;
}

/** Non-throwing gate used by `sources`/`ingest` to compute enabled/skip instead of aborting the batch. */
export function checkEnv(decl: EnvDecl): { ok: true } | { ok: false; reason: string } {
  try {
    validateEnv(decl);
    return { ok: true };
  } catch (e) {
    if (e instanceof EnvError) {
      const key = e.missing[0];
      const spec = decl[key];
      return { ok: false, reason: spec.getAt ? `set ${key} (${spec.getAt})` : `set ${key}` };
    }
    throw e;
  }
}

/** A var is "required" iff its schema rejects undefined. Public-API only — no schema internals. */
export const isRequired = (spec: EnvSpec): boolean => !spec.schema.safeParse(undefined).success;
