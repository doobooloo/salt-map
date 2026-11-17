# Salt Map

An interactive map of the US Interstate network showing where state DOT trucks
have reported spreading salt or brine.

## Run it

It is a static site with no build step. Serve the folder and open it:

```bash
python3 -m http.server 8000
```

Then visit <http://localhost:8000>. Add `?demo` to the URL to see a clearly
labelled simulated storm (useful when no plows are out).

## What the colours mean

| Colour | Meaning |
| --- | --- |
| Blue | Salted this season: a truck has reported applying salt/brine here at least once |
| Red | Not salted yet, in a state that reports material use |
| Grey | The state publishes no feed this map can read (or plow positions only) |

Dots are plow trucks out right now. Click any road or truck for details.

## How the season record works

State feeds only look back a day or two, so `scripts/update_season.mjs` runs
every 30 minutes (`.github/workflows/season.yml`), and the first time a stretch
is reported salted it is written to `data/season.json`. It stays there until
the season resets on 1 October. Salting that happened before the recorder
started is not known.

## Data

There is no national dataset of road salting. The map reads the public feeds
that exist, straight from the browser, and refreshes every two minutes:

| State | Feed | Says whether material was applied? |
| --- | --- | --- |
| Iowa | Winter Storm Analysis, past 48 h (road segments with passes and material quantities) | Yes |
| Iowa | Snow plow truck locations (live, with material and rate) | Yes |
| Utah | Snow plow locations (live) | No, positions only |

Every other state is grey. Road geometry comes from the USDOT/BTS National
Highway System layer, pre-processed into `data/interstates.json` by
`scripts/build_interstates.py`.

## Adding a state

Add an entry to `js/feeds.js`. A feed returns either road `segments` or
`trucks` in the normalized shape described at the top of that file; the map
matches them to the interstate geometry. Set `material: true` only if the feed
actually reports salt/brine application.

## Limits

- "Treated" means a truck reported spreading there. It does not measure how
  much material is still on the pavement.
- Feed geometry is matched to interstates by distance (500 m), so a truck on an
  overpass or adjacent ramp can briefly colour the interstate beneath it.
- The season record only covers the period the recorder has been running.

## Hosting

The site is served by GitHub Pages at `salt.constantforce.com` (see `CNAME`).
