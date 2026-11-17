#!/usr/bin/env python3
"""Build data/interstates.json from the USDOT/BTS National Highway System layer.

Downloads every Interstate-signed NHS feature, simplifies it, and groups the
pieces into ~6 mile chunks keyed by (state, route, 0.1 degree grid cell).
Each chunk is the unit the map colours by treatment status.

Usage: python3 scripts/build_interstates.py
"""
import json
import os
import urllib.parse
import urllib.request
from collections import defaultdict

SRC = ("https://services.arcgis.com/xOi1kZaI0eWDREZv/ArcGIS/rest/services/"
       "NTAD_National_Highway_System/FeatureServer/0/query")
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "interstates.json")
PAGE = 2000
CELL = 0.1  # degrees

FIPS = {1: "AL", 2: "AK", 4: "AZ", 5: "AR", 6: "CA", 8: "CO", 9: "CT", 10: "DE", 11: "DC", 12: "FL",
        13: "GA", 15: "HI", 16: "ID", 17: "IL", 18: "IN", 19: "IA", 20: "KS", 21: "KY", 22: "LA",
        23: "ME", 24: "MD", 25: "MA", 26: "MI", 27: "MN", 28: "MS", 29: "MO", 30: "MT", 31: "NE",
        32: "NV", 33: "NH", 34: "NJ", 35: "NM", 36: "NY", 37: "NC", 38: "ND", 39: "OH", 40: "OK",
        41: "OR", 42: "PA", 44: "RI", 45: "SC", 46: "SD", 47: "TN", 48: "TX", 49: "UT", 50: "VT",
        51: "VA", 53: "WA", 54: "WV", 55: "WI", 56: "WY", 72: "PR"}


def fetch(offset):
    params = {
        "where": "SIGNT1='I'",
        "outFields": "STFIPS,SIGNN1",
        "outSR": 4326,
        "maxAllowableOffset": 0.0015,
        "geometryPrecision": 4,
        "orderByFields": "OBJECTID",
        "resultOffset": offset,
        "resultRecordCount": PAGE,
        "f": "json",
    }
    url = SRC + "?" + urllib.parse.urlencode(params)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as r:
                d = json.load(r)
            if "error" in d:
                raise RuntimeError(d["error"])
            return d
        except Exception as e:  # retry transient failures
            if attempt == 3:
                raise
            print("  retry:", e)


def main():
    groups = defaultdict(list)
    offset = 0
    while True:
        d = fetch(offset)
        feats = d.get("features", [])
        for f in feats:
            a = f["attributes"]
            st = FIPS.get(int(a["STFIPS"] or 0))
            route = (a["SIGNN1"] or "").strip()
            paths = (f.get("geometry") or {}).get("paths") or []
            if not st or not route:
                continue
            for p in paths:
                if len(p) < 2:
                    continue
                mid = p[len(p) // 2]
                key = (st, route, int(mid[0] // CELL), int(mid[1] // CELL))
                groups[key].append([[round(x, 4), round(y, 4)] for x, y in p])
        offset += len(feats)
        print(f"fetched {offset}")
        if not feats or not d.get("exceededTransferLimit"):
            break
    chunks = [{"s": k[0], "r": k[1], "c": v} for k, v in sorted(groups.items())]
    with open(OUT, "w") as fh:
        json.dump(chunks, fh, separators=(",", ":"))
    print(f"{len(chunks)} chunks -> {OUT} ({os.path.getsize(OUT) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
