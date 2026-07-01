import { defineTool } from "../tool.ts";
import { loadSources } from "../source.ts";
import { log } from "../core/log.ts";

export default defineTool({
  summary:
    "List every rental source and whether it is currently enabled (its required env is present).",
  when: "Use to see which sources `ingest` will run and what config each still needs.",
  kind: "query",
  async run() {
    const sources = await loadSources();
    log.print("Sources:");
    for (const s of sources) {
      const state = s.enabled();
      const mark = state.ok ? "●" : "○";
      const snap = s.snapshotComplete ? "snapshot" : "feed    ";
      const note = state.ok ? "enabled" : `disabled — ${state.reason}`;
      log.print(`  ${mark} ${s.name.padEnd(12)} [${snap}]  ${note}`);
    }
    log.print("\n  ● enabled   ○ disabled (needs config)");
    log.print("  snapshot = absence ⇒ removed · feed = new-only, no removal inference");
    return sources.map((s) => ({
      name: s.name,
      enabled: s.enabled().ok,
      snapshotComplete: s.snapshotComplete,
    }));
  },
});
