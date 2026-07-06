import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const AGE_IDENTITY = join(homedir(), ".age", "key.txt");

/**
 * Populate process.env in precedence order (highest first; each layer only fills
 * vars not already set, so a higher layer never clobbers a lower one):
 *   1. the real shell environment       — always wins,
 *   2. `.env.local`  — plaintext, gitignored: YOUR personal secrets/overrides
 *                      (e.g. a personal PUSHOVER_TOKEN you don't want to share),
 *   3. `.env`        — plaintext, gitignored: local working copy,
 *   4. `.env.age`    — age-encrypted, COMMITTED shared team secrets; decrypted IN
 *                      MEMORY with ~/.age/key.txt so a fresh clone just works.
 */
export function loadEnv(): void {
  for (const path of [".env.local", ".env"]) {
    if (existsSync(path)) merge(parseEnv(readFileSync(path, "utf8")) as Record<string, string>);
  }
  const decrypted = decryptAge(".env.age");
  if (decrypted) merge(decrypted);
}

function merge(vars: Record<string, string>): void {
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Decrypt an age-encrypted env file with ~/.age/key.txt. Returns null (with a
 * hint to stderr) if the file is absent, the identity is missing, or `age` fails
 * — the no-auth sources still run, so a missing key is never fatal.
 */
function decryptAge(agePath: string): Record<string, string> | null {
  if (!existsSync(agePath)) return null;
  if (!existsSync(AGE_IDENTITY)) {
    console.error(
      `! ${agePath} is encrypted but no age key at ${AGE_IDENTITY} — ` +
        `run 'mise run secrets:keygen' and have a maintainer add your public key.`,
    );
    return null;
  }
  try {
    const out = execFileSync("age", ["--decrypt", "-i", AGE_IDENTITY, agePath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"], // capture stderr instead of leaking it
    });
    return parseEnv(out) as Record<string, string>;
  } catch (err) {
    console.error(`! could not decrypt ${agePath}: ${(err as Error).message}`);
    return null;
  }
}
