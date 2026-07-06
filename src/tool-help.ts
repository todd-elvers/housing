import { EnvError } from "./env/spec.ts";
import { log } from "./core/log.ts";

/**
 * citty prints this string BOTH in a parent's COMMANDS list (once per subcommand)
 * AND at the top of the command's own --help. Keep it to ONE line so the command
 * tree stays readable — a multi-line description gets dumped verbatim into the
 * parent list. The full metadata (when / args / required-env / examples) lives in
 * `housing introspect --json`, is surfaced by `sources`, and is printed by the
 * fail-fast env error when a command actually needs a missing key.
 */
export function renderDescription(def: { summary: string }): string {
  return def.summary;
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
