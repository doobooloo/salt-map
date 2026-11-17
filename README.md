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
| Blue | A truck reported applying salt/brine on this stretch within the chosen time window |
| Amber | A plow truck was on this stretch but reported no material |
| Red | The state reports material use, and nothing was reported here |
| Grey | The state publishes no feed this map can read (or positions only) |

Dots are individual plow trucks. Click any road or truck for details.

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
- Outside of a winter storm the reporting states will show as untreated.
