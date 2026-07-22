#!/usr/bin/env python3
"""Bridge: fetch recent Realtor.com rentals via HomeHarvest, emit JSON on stdout.

Invoked by the TS homeharvest adapter through `uv run`. Keep stdout pure JSON;
log anything human-facing to stderr.
"""
import argparse
import json
import sys


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--location", required=True)
    ap.add_argument("--past-days", type=int, default=3)
    ap.add_argument("--listing-type", default="for_rent")
    args = ap.parse_args()

    try:
        import pandas as pd
        from homeharvest import scrape_property
    except ImportError:
        print("homeharvest not installed; run `uv sync`", file=sys.stderr)
        sys.exit(2)

    df = scrape_property(
        location=args.location,
        listing_type=args.listing_type,
        past_days=args.past_days,
    )

    _MISSING = {"nan", "<NA>", "NaT", "None", ""}

    def g(row, *keys):
        for k in keys:
            if k not in row:
                continue
            v = row[k]
            try:
                if pd.isna(v):
                    continue
            except (TypeError, ValueError):
                pass
            if v is None or str(v) in _MISSING:
                continue
            return v
        return None

    def num(v):
        if v is None:
            return None
        try:
            f = float(v)
            return int(f) if f.is_integer() else f
        except (TypeError, ValueError):
            return None

    def photo(row):
        """A single hero-image URL: primary_photo, else the first alt photo."""
        p = g(row, "primary_photo")
        if isinstance(p, str) and p.startswith("http"):
            return p
        alts = g(row, "alt_photos")
        if isinstance(alts, str) and alts.strip():
            first = alts.split(",")[0].strip()
            return first if first.startswith("http") else None
        if isinstance(alts, (list, tuple)) and alts and isinstance(alts[0], str):
            return alts[0]
        return None

    out = []
    for _, row in df.iterrows():
        addr = g(row, "full_street_line", "street")
        out.append(
            {
                "id": str(g(row, "property_id", "mls_id", "listing_id") or g(row, "property_url") or addr),
                "url": g(row, "property_url"),
                "address": addr,
                "city": g(row, "city"),
                "lat": num(g(row, "latitude")),
                "lon": num(g(row, "longitude")),
                "price": num(g(row, "list_price", "list_price_min")),
                "beds": num(g(row, "beds")),
                "baths": num(g(row, "full_baths")),
                "sqft": num(g(row, "sqft")),
                "property_type": g(row, "style", "property_type"),
                "list_date": str(g(row, "list_date") or "") or None,
                # Realtor.com hero image for the notification card, when present.
                "primary_photo": photo(row),
            }
        )

    json.dump(out, sys.stdout, default=str)


if __name__ == "__main__":
    main()
