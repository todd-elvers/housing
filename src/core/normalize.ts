import { createHash } from "node:crypto";
import type { RawListing } from "./types.ts";

/** Stable short hash over the fields whose change should count as "changed". */
export function contentHash(l: RawListing): string {
  const parts = [
    l.price ?? "",
    l.beds ?? "",
    l.baths ?? "",
    l.sqft ?? "",
    l.propertyType ?? "",
    (l.title ?? "").trim(),
    l.changeTag ?? "",
  ];
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16);
}

/** Loose address normalization for future cross-source dedup. Not authoritative. */
export function normalizeAddress(addr?: string | null): string | null {
  if (!addr) return null;
  return addr
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\bapartment\b|\bapt\b|\bunit\b/g, "")
    .replace(/\s+/g, " ")
    .trim() || null;
}
