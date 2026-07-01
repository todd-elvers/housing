import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";

/**
 * Load a gitignored `.env` into process.env. Uses Node's built-in
 * util.parseEnv (handles quotes/escapes/comments). Non-override: a real
 * environment variable always wins over the file. No-op if `.env` is absent —
 * the no-auth sources run on an empty environment.
 */
export function loadEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, "utf8")) as Record<string, string>;
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
