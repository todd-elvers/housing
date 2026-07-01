import { isRequired, EnvError, type EnvDecl } from "./env/spec.ts";
import { log } from "./core/log.ts";

/** Fold summary / when / examples / required-env into the citty command description shown in --help. */
export function renderDescription(def: {
  summary: string;
  when: string;
  examples?: string[];
  requires?: EnvDecl;
}): string {
  const lines = [def.summary, "", `When: ${def.when}`];
  if (def.examples?.length) {
    lines.push("", "Examples:");
    for (const e of def.examples) lines.push(`  ${e}`);
  }
  if (def.requires && Object.keys(def.requires).length) {
    lines.push("", "Required env:");
    for (const [key, spec] of Object.entries(def.requires)) {
      const opt = isRequired(spec) ? "" : " (optional)";
      const where = spec.getAt ? ` — ${spec.getAt}` : "";
      lines.push(`  ${key}${opt}: ${spec.description}${where}`);
    }
  }
  return lines.join("\n");
}

/** Emit a structured failure and exit non-zero. Under --json prints {error,code,hint}; otherwise a readable message. */
export function structuredFail(err: unknown, asJson: boolean): never {
  const isEnv = err instanceof EnvError;
  const code = isEnv ? "env_missing" : "error";
  const message = isEnv
    ? "environment not ready"
    : err instanceof Error
      ? err.message
      : String(err);
  if (asJson) {
    const payload: Record<string, unknown> = { error: message, code };
    if (isEnv) {
      payload.missing = err.missing;
      payload.hint = err.report;
    }
    log.out(JSON.stringify(payload));
  } else {
    log.error(message);
    if (isEnv) log.print(err.report);
  }
  process.exit(1);
}
