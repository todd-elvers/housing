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

/**
 * Unit-level dedup key for cross-source matching (SF): keeps the street number +
 * name AND the apartment/unit, but drops city/state/zip and normalizes unit
 * markers to "#". So the same unit across sources collapses ("500 Valencia St,
 * #206, San Francisco, CA 94110" ≡ "500 Valencia St Apt 206"), while different
 * apartments at one address stay distinct. Loose, not authoritative.
 */
export function normalizeAddress(addr?: string | null): string | null {
  if (!addr) return null;
  const s = addr
    .toLowerCase()
    // Drop the SF city/state/zip tail.
    .replace(/\bsan francisco\b/g, "")
    .replace(/\bca\b/g, "")
    .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
    // Unit markers → "#"; abbreviate common street types.
    .replace(/\b(?:apartment|apt|unit|suite|ste)\b\.?\s*/g, "#")
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bdrive\b/g, "dr")
    .replace(/[.,]/g, " ")
    .replace(/#\s+/g, "#") // "# 206" → "#206"
    .replace(/\s+/g, " ")
    .trim();
  return s || null;
}
