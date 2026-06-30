import type { Adapter } from "../core/types.ts";
import { craigslist } from "./craigslist.ts";
import { redfin } from "./redfin.ts";
import { dahlia } from "./dahlia.ts";
import { zumper } from "./zumper.ts";
import { rentsfnow } from "./rentsfnow.ts";
import { rentcast } from "./rentcast.ts";
import { reddit } from "./reddit.ts";
import { homeharvest } from "./homeharvest.ts";

/** All Tier 1 adapters, in run order. */
export const ADAPTERS: Adapter[] = [
  craigslist,
  redfin,
  dahlia,
  zumper,
  rentsfnow,
  rentcast,
  reddit,
  homeharvest,
];

export function getAdapters(names?: string[]): Adapter[] {
  if (!names || names.length === 0) return ADAPTERS;
  const set = new Set(names.map((n) => n.trim().toLowerCase()));
  const picked = ADAPTERS.filter((a) => set.has(a.name));
  const unknown = [...set].filter((n) => !ADAPTERS.some((a) => a.name === n));
  if (unknown.length) throw new Error(`unknown source(s): ${unknown.join(", ")}`);
  return picked;
}
