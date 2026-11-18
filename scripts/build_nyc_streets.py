#!/usr/bin/env python3
"""Builds data/nyc_streets.json: geometry of New York City's highway and critical snow routes,
keyed by the PhysicalID that the PlowNYC "last visited" dataset uses.
Output: {physicalId: [streetName, [[lon,lat],...]]}"""
import json, urllib.request, urllib.parse

URL = 'https://services.arcgis.com/uKN48PkxmWiqJM9q/arcgis/rest/services/DSNY_snow_priority_single_OFFICIAL/FeatureServer/1/query'
out, offset = {}, 0
while True:
    qs = urllib.parse.urlencode({
        'where': "SnowPriority IN ('H','C')", 'outFields': 'PhysicalID,StreetName', 'outSR': 4326, 'f': 'json',
        'maxAllowableOffset': 0.00005, 'geometryPrecision': 5, 'orderByFields': 'OBJECTID',
        'resultOffset': offset, 'resultRecordCount': 2000})
    data = json.load(urllib.request.urlopen(f'{URL}?{qs}', timeout=120))
    feats = data.get('features', [])
    for f in feats:
        paths = (f.get('geometry') or {}).get('paths')
        if paths:
            out[str(f['attributes']['PhysicalID'])] = [(f['attributes']['StreetName'] or '').title(), max(paths, key=len)]
    offset += len(feats)
    print(offset, flush=True)
    if not feats or not data.get('exceededTransferLimit'):
        break
json.dump(out, open('data/nyc_streets.json', 'w'), separators=(',', ':'))
print(len(out), 'streets')
