import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEnv } from "../src/env/dotenv.ts";
import { loadSources, isPaid, type SourceContract } from "../src/source.ts";

// ─────────────────────────────────────────────────────────────────────────────
// PAID / METERED API INTEGRATION TEST — spends real money (RapidAPI Zillow,
// Apify Apartments.com). It is DELIBERATELY gated and is NOT part of the normal
// suite: `mise run test` runs only test/tools.test.ts, which never touches these.
//
// Run it on purpose:   mise run test:paid      (sets HOUSING_TEST_PAID=1)
//
// Without HOUSING_TEST_PAID=1 every case here skips, so an accidental
// `tsx --test` over the whole test/ dir cannot bill your API quota.
// ─────────────────────────────────────────────────────────────────────────────

const PAID = process.env.HOUSING_TEST_PAID === "1";

// Keep each paid run small + cheap. The sources read these at fetch time, so
// setting them here bounds cost/latency (a handful of items, one search page).
process.env.ZILLOW_MAX_ITEMS ??= "5";
process.env.APARTMENTS_MAX_ITEMS ??= "3";
process.env.APARTMENTS_MAX_PAGES ??= "1";

let cached: Promise<SourceContract[]> | null = null;
function paidSources() {
  return (cached ??= (async () => {
    loadEnv(); // decrypt .env.age so paid keys are present
    return (await loadSources()).filter(isPaid);
  })());
}

test("paid: at least one metered source exists and each behaves per its key state", async (t) => {
  if (!PAID) {
    t.skip("set HOUSING_TEST_PAID=1 (spends money) — run `mise run test:paid`");
    return;
  }
  const sources = await paidSources();
  assert.ok(sources.length > 0, "at least one paid (tier-2) source is discovered");

  for (const s of sources) {
    const state = s.enabled();
    await t.test(`${s.name} (${state.ok ? "enabled" : "disabled"})`, async (tt) => {
      assert.equal(typeof s.snapshotComplete, "boolean", "declares snapshotComplete");
      assert.ok(isPaid(s), "is a paid tier-2 source");

      if (!state.ok) {
        // Can't bill an API we have no key for — record why and move on.
        assert.match(state.reason, /set [A-Z0-9_]+/, "disabled reason names an env var to set");
        tt.skip(`disabled — ${state.reason}`);
        return;
      }

      // Live, metered fetch — the whole point of this suite.
      const listings = await s.fetch();
      assert.ok(Array.isArray(listings), "fetch() returns an array");
      assert.ok(listings.length > 0, "returns at least one listing");
      for (const l of listings.slice(0, 5)) {
        assert.ok(l.sourceId, "listing has a sourceId");
        assert.ok(l.url && /^https?:\/\//.test(l.url), "listing has an http(s) url");
      }
      // Guard against the "empty shell" regression: a metered call must return
      // REAL enriched data, not just ids/urls. At least one listing should carry
      // a concrete signal (price, beds, or coordinates).
      const enriched = listings.some(
        (l) => l.price != null || l.beds != null || (l.lat != null && l.lon != null),
      );
      assert.ok(enriched, "at least one listing has real data (price/beds/coords)");
    });
  }
});
