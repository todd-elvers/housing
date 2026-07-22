import { createClient, type Client, type ResultSet } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// The ONE place a libSQL client is built. HOUSING_DB is either a local SQLite
// file path (dev/tests) or a remote libsql:// Turso URL (the shared team DB,
// authenticated via TURSO_AUTH_TOKEN). Everything that opens the DB — Store,
// commute enrichment, find — goes through openDb so both modes behave the same.

export interface DbHandle {
  client: Client;
  isRemote: boolean;
}

/** True when the value is a remote DB URL rather than a local file path. */
export function isRemoteDb(pathOrUrl: string): boolean {
  return /^(libsql|https?|wss?):/.test(pathOrUrl);
}

export function openDb(pathOrUrl = process.env.HOUSING_DB || "data/housing.db"): DbHandle {
  if (isRemoteDb(pathOrUrl)) {
    return {
      client: createClient({ url: pathOrUrl, authToken: process.env.TURSO_AUTH_TOKEN }),
      isRemote: true,
    };
  }
  const path = pathOrUrl.startsWith("file:") ? pathOrUrl.slice("file:".length) : pathOrUrl;
  mkdirSync(dirname(path), { recursive: true });
  return { client: createClient({ url: `file:${path}` }), isRemote: false };
}

/**
 * Materialize a ResultSet's rows as plain objects keyed by column name. libSQL
 * rows are array-backed proxies; downstream code spreads and mutates rows, so
 * hand it real objects.
 */
export function rowsToObjects<T>(rs: ResultSet): T[] {
  return rs.rows.map((r) => Object.fromEntries(rs.columns.map((c, i) => [c, r[i]])) as T);
}

/** Split an array into consecutive chunks of at most `size`. */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
