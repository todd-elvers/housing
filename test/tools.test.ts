import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import type { CommandDef } from "citty";
import { loadEnv } from "../src/env/dotenv.ts";
import { loadCommands } from "../src/discover.ts";
import { buildCatalog, type CatalogNode } from "../src/catalog.ts";
import { loadSources, type SourceContract } from "../src/source.ts";

// This test is SELF-MAINTAINING: it discovers every command + source the same
// way the CLI does (loadCommands / loadSources / introspect), so adding a tool
// needs NO test changes — it is picked up and exercised automatically.
//
// Live source fetches hit the network and are ON by default (they prove the
// tools actually work). Set HOUSING_TEST_LIVE=0 to run only the offline tiers.

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const COMMANDS_DIR = fileURLToPath(new URL("../src/commands/", import.meta.url));
const LIVE = process.env.HOUSING_TEST_LIVE !== "0";
// Tier-2 sources hit paid/managed APIs — never live-fetch them unless explicitly opted in.
const PAID = process.env.HOUSING_TEST_PAID === "1";
const TEST_DB = join(tmpdir(), "housing-integration-test.db");

/** Run the real CLI entrypoint through the toolchain and capture its result. */
function runCli(args: string[]) {
  return spawnSync("aube", ["exec", "tsx", MAIN, ...args], {
    encoding: "utf8",
    timeout: 90_000,
    env: { ...process.env, HOUSING_DB: TEST_DB },
  });
}

/** Discover the whole tree + sources once (memoized). Loads .env so enabled()
 *  state matches what the CLI sees. */
let cached: Promise<{ leaves: CatalogNode[]; sources: SourceContract[] }> | null = null;
function discover() {
  return (cached ??= (async () => {
    loadEnv();
    const root: CommandDef = { meta: { name: "housing" }, subCommands: loadCommands(COMMANDS_DIR) };
    const catalog = await buildCatalog(root);
    const leaves: CatalogNode[] = [];
    (function walk(n: CatalogNode) {
      if (n.kind !== "group") leaves.push(n);
      n.children?.forEach(walk);
    })(catalog);
    const sources = await loadSources();
    return { leaves, sources };
  })());
}

// ── Tier A: every discovered tool is well-formed (offline; buildCatalog already
//    proved every file imports cleanly) ──────────────────────────────────────
test("contract: every tool is well-formed", async (t) => {
  const { leaves } = await discover();
  assert.ok(leaves.length > 0, "at least one command is discovered");
  const seen = new Set<string>();
  for (const leaf of leaves) {
    await t.test(leaf.argv, () => {
      assert.ok(leaf.summary && leaf.summary.length > 0, "has a summary (WHAT)");
      assert.ok(leaf.when && leaf.when.length > 0, "has a when (WHEN to use)");
      assert.ok(
        leaf.kind === "query" || leaf.kind === "mutation",
        `kind is query|mutation (got ${leaf.kind})`,
      );
      for (const a of leaf.args ?? []) assert.ok(a.name && a.type, "each arg has name + type");
      for (const r of leaf.requires ?? [])
        assert.ok(r.key && r.description, "each env decl has key + description");
      assert.ok(!seen.has(leaf.argv), `command path is unique: ${leaf.argv}`);
      seen.add(leaf.argv);
    });
  }
});

// ── Tier B: the real CLI entrypoint works (bounded spawns; generic) ─────────
test("cli: entrypoint, help, and the introspect manifest work", async (t) => {
  const { leaves, sources } = await discover();

  await t.test("`--help` exits 0 and shows usage", () => {
    const r = runCli(["--help"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /USAGE/);
  });

  await t.test("`introspect --json` is valid and covers every tool", () => {
    const r = runCli(["introspect", "--json"]);
    assert.equal(r.status, 0, r.stderr);
    const manifest = JSON.parse(r.stdout);
    const argvs = new Set<string>();
    (function walk(n: { argv: string; children?: unknown[] }) {
      argvs.add(n.argv);
      (n.children as (typeof n)[] | undefined)?.forEach(walk);
    })(manifest);
    for (const leaf of leaves) assert.ok(argvs.has(leaf.argv), `manifest includes ${leaf.argv}`);
  });

  await t.test("`sources` lists every discovered source", () => {
    const r = runCli(["sources"]);
    assert.equal(r.status, 0, r.stderr);
    for (const s of sources)
      assert.match(r.stdout, new RegExp(`\\b${s.name}\\b`), `lists ${s.name}`);
  });

  // A disabled source proves the structured fail-fast CLI path (picked dynamically).
  const disabled = sources.find((s) => !s.enabled().ok);
  await t.test(
    disabled
      ? `disabled source '${disabled.name}' fails fast with env_missing`
      : "no disabled source (skipped)",
    { skip: !disabled },
    () => {
      const r = runCli(["search", disabled!.name, "--json"]);
      assert.equal(r.status, 1, "exits non-zero");
      const err = JSON.parse(r.stdout);
      assert.equal(err.code, "env_missing");
      assert.ok(Array.isArray(err.missing) && err.missing.length > 0, "names the missing var(s)");
    },
  );

  // A full ingest against a throwaway DB proves the mutation pipeline end-to-end
  // (fresh seed ⇒ 0 events ⇒ no notification side effects). Use a free tier-1 source.
  const enabled = sources.find((s) => s.enabled().ok && s.tier === 1);
  await t.test(
    enabled
      ? `ingest --source ${enabled.name} runs end-to-end`
      : "no enabled source to ingest (skipped)",
    { skip: !enabled || !LIVE },
    () => {
      rmSync(TEST_DB, { force: true });
      const r = runCli(["ingest", "--source", enabled!.name, "--json"]);
      assert.equal(r.status, 0, r.stderr);
      const summary = JSON.parse(r.stdout);
      assert.equal(summary.sources, 1);
      assert.ok(Array.isArray(summary.errors) && summary.errors.length === 0, "no source errors");
      rmSync(TEST_DB, { force: true });
    },
  );
});

// ── Tier C: every source behaves per its enabled state (in-process, generic) ─
test("sources: each one fetches (enabled) or fails fast (disabled)", async (t) => {
  const { sources } = await discover();
  assert.ok(sources.length > 0, "at least one source is discovered");
  for (const s of sources) {
    const state = s.enabled();
    await t.test(`${s.name} (${state.ok ? "enabled" : "disabled"})`, async (tt) => {
      assert.equal(typeof s.snapshotComplete, "boolean", "declares snapshotComplete");
      if (!state.ok) {
        assert.match(state.reason, /set [A-Z0-9_]+/, "disabled reason names an env var to set");
        return;
      }
      if (!LIVE) {
        tt.skip("HOUSING_TEST_LIVE=0");
        return;
      }
      if (s.tier >= 2 && !PAID) {
        tt.skip("tier-2 paid source — set HOUSING_TEST_PAID=1 to live-fetch");
        return;
      }
      const listings = await s.fetch();
      assert.ok(Array.isArray(listings), "fetch() returns an array");
      assert.ok(listings.length > 0, "returns at least one listing");
      for (const l of listings.slice(0, 5)) {
        assert.ok(l.sourceId, "listing has a sourceId");
        assert.ok(l.url && /^https?:\/\//.test(l.url), "listing has an http(s) url");
      }
    });
  }
});
