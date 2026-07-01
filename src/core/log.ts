import { openSync, writeSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// The log file always lives at the repo root, resolved from THIS module's
// location (not cwd) so it lands in the same place no matter where the CLI is
// invoked from. Truncated on every run — it always reflects the latest run.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const LOG_FILE = join(REPO_ROOT, "housing.log");

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function argvHas(...flags: string[]): boolean {
  return process.argv.slice(2).some((a) => flags.includes(a));
}

/**
 * Dual-writing logger. Every line is timestamped and written to housing.log
 * (full detail, always). Stdout mirrors it, filtered by verbosity. Under
 * --json, human output is suppressed from stdout (kept in the file) so stdout
 * stays pure machine-readable JSON.
 */
class Logger {
  private fd: number;
  private threshold: number;
  readonly jsonMode: boolean;

  constructor() {
    this.jsonMode = argvHas("--json");
    this.threshold =
      argvHas("--verbose", "-v") || process.env.HOUSING_VERBOSE === "1"
        ? ORDER.debug
        : argvHas("--quiet", "-q")
          ? ORDER.warn
          : ORDER.info;
    try {
      mkdirSync(REPO_ROOT, { recursive: true });
      this.fd = openSync(LOG_FILE, "w"); // "w" truncates any previous log
    } catch {
      this.fd = -1;
    }
  }

  private toFile(line: string): void {
    if (this.fd >= 0) {
      try {
        writeSync(this.fd, line + "\n");
      } catch {
        /* best-effort */
      }
    }
  }

  private stamp(): string {
    return new Date().toISOString();
  }

  private emit(level: Level, msg: string): void {
    this.toFile(`${this.stamp()} ${level.toUpperCase().padEnd(5)} ${msg}`);
    if (ORDER[level] < this.threshold) return;
    if (level === "warn" || level === "error") {
      process.stderr.write(msg + "\n"); // stderr never pollutes --json stdout
    } else if (!this.jsonMode) {
      process.stdout.write(msg + "\n");
    }
  }

  debug(msg: string): void {
    this.emit("debug", msg);
  }
  info(msg: string): void {
    this.emit("info", msg);
  }
  warn(msg: string): void {
    this.emit("warn", msg);
  }
  error(msg: string): void {
    this.emit("error", msg);
  }

  /** Human-facing output (digests, tables). Mirrored to file; suppressed from stdout under --json. */
  print(msg = ""): void {
    this.toFile(msg);
    if (!this.jsonMode) process.stdout.write(msg + "\n");
  }

  /** Machine-readable output (JSON results). Always to stdout + file, even under --json. */
  out(msg = ""): void {
    this.toFile(msg);
    process.stdout.write(msg + "\n");
  }
}

export const log = new Logger();
export type { Logger };
