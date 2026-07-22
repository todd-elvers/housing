import { createHash } from "node:crypto";
import { loadEnv } from "../src/env/dotenv.ts";
import { openDb } from "../src/core/client.ts";
import type { Client } from "@libsql/client";

// One-shot gate for the Turso cutover: proves the remote DB is a wholesale,
// byte-faithful copy of the local SQLite file BEFORE any ingest is allowed to
// run against it. The Discord board state (message/thread ids) lives in this DB;
// a partial copy would double-post the entire board.
//
//   aube exec tsx scripts/verify-migration.ts data/housing.db "libsql://<db>.turso.io"
//
// TURSO_AUTH_TOKEN comes from the environment (.env.age via loadEnv). Exits 0
// only when every check passes.

const [, , localPath, remoteUrl] = process.argv;
if (!localPath || !remoteUrl) {
  console.error("usage: verify-migration.ts <local-sqlite-path> <libsql-url>");
  process.exit(2);
}

loadEnv();
const local = openDb(localPath).client;
const remote = openDb(remoteUrl).client;

let failed = false;
function report(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ✓" : "  ✗ FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
}

async function tableNames(db: Client): Promise<string[]> {
  const rs = await db.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rs.rows.map((r) => String(r["name"]));
}

async function count(db: Client, table: string): Promise<number> {
  const rs = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(rs.rows[0]?.["n"] ?? 0);
}

/** sha256 over every listing's identity + board state, in a deterministic order. */
async function listingsDigest(db: Client): Promise<string> {
  const rs = await db.execute(
    `SELECT id, content_hash, status,
            COALESCE(discord_message_id, '') AS mid, COALESCE(discord_thread_id, '') AS tid
       FROM listings ORDER BY id`,
  );
  const h = createHash("sha256");
  for (const r of rs.rows) {
    h.update(`${r["id"]}|${r["content_hash"]}|${r["status"]}|${r["mid"]}|${r["tid"]}\n`);
  }
  return h.digest("hex");
}

async function firstDivergence(a: Client, b: Client): Promise<string | null> {
  const q = `SELECT id, content_hash, status,
                    COALESCE(discord_message_id, '') AS mid, COALESCE(discord_thread_id, '') AS tid
               FROM listings ORDER BY id`;
  const [ra, rb] = await Promise.all([a.execute(q), b.execute(q)]);
  const key = (r: Record<string, unknown>) =>
    `${r["id"]}|${r["content_hash"]}|${r["status"]}|${r["mid"]}|${r["tid"]}`;
  const max = Math.max(ra.rows.length, rb.rows.length);
  for (let i = 0; i < max; i++) {
    const ka = ra.rows[i] ? key(ra.rows[i]) : "<absent>";
    const kb = rb.rows[i] ? key(rb.rows[i]) : "<absent>";
    if (ka !== kb) return `row ${i}: local=${ka} remote=${kb}`;
  }
  return null;
}

const [localTables, remoteTables] = await Promise.all([tableNames(local), tableNames(remote)]);
report(
  "table set",
  JSON.stringify(localTables) === JSON.stringify(remoteTables),
  `local=[${localTables}] remote=[${remoteTables}]`,
);

for (const table of ["listings", "events", "discord_threads"]) {
  const [nl, nr] = await Promise.all([count(local, table), count(remote, table)]);
  report(`${table} count`, nl === nr, `local=${nl} remote=${nr}`);
}

const [dl, dr] = await Promise.all([listingsDigest(local), listingsDigest(remote)]);
if (dl === dr) {
  report("listings digest (id + content_hash + status + discord ids)", true, dl.slice(0, 16));
} else {
  report("listings digest", false, (await firstDivergence(local, remote)) ?? "digests differ");
}

const threadsQ = "SELECT group_key, thread_id FROM discord_threads ORDER BY group_key";
const [tl, tr] = await Promise.all([local.execute(threadsQ), remote.execute(threadsQ)]);
report(
  "discord_threads rows",
  JSON.stringify(tl.rows) === JSON.stringify(tr.rows),
  `${tl.rows.length} thread(s)`,
);

const maxQ = "SELECT COALESCE(MAX(id), 0) AS m FROM events";
const [ml, mr] = await Promise.all([local.execute(maxQ), remote.execute(maxQ)]);
report("events MAX(id)", Number(ml.rows[0]?.["m"]) === Number(mr.rows[0]?.["m"]));

local.close();
remote.close();

if (failed) {
  console.error("\nMIGRATION VERIFICATION FAILED — DO NOT INGEST against the remote DB.");
  process.exit(1);
}
console.log("\nPASS — remote DB matches the local file wholesale (board state included).");
