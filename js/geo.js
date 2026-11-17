// Geometry + matching shared by the browser map and the season recorder (Node).

const R = 6371000, RAD = Math.PI / 180;
export const MATCH_M = 500;   // how close feed geometry must be to a road to count
export const SAMPLE_M = 400;  // spacing of sample points along roads
export const COVER = 0.5;     // share of a chunk a feed segment must cover
export const TRUCK_FRESH_MS = 45 * 60e3; // older positions are drawn as stale
const RECENT_MS = 72 * 3600e3;            // ignore reports older than this (stale rows left in a feed)

export function dist(a, b) {
  const x = (b[0] - a[0]) * RAD * Math.cos(((a[1] + b[1]) / 2) * RAD);
  const y = (b[1] - a[1]) * RAD;
  return Math.sqrt(x * x + y * y) * R;
}
export function samplePaths(paths, step = SAMPLE_M) {
  const pts = [];
  for (const p of paths) {
    if (!p.length) continue;
    pts.push(p[0]);
    for (let i = 1; i < p.length; i++) {
      const n = Math.max(1, Math.ceil(dist(p[i - 1], p[i]) / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        pts.push([p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t]);
      }
    }
  }
  return pts;
}
export function pathsLength(paths) {
  let m = 0;
  for (const p of paths) for (let i = 1; i < p.length; i++) m += dist(p[i - 1], p[i]);
  return m;
}
const CELL = 0.01; // ~1 km grid
class Grid {
  constructor() { this.m = new Map(); }
  add(pt, item) {
    const k = `${Math.floor(pt[0] / CELL)},${Math.floor(pt[1] / CELL)}`;
    let a = this.m.get(k);
    if (!a) this.m.set(k, (a = []));
    a.push([pt, item]);
  }
  near(pt, max, each) {
    const cx = Math.floor(pt[0] / CELL), cy = Math.floor(pt[1] / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = this.m.get(`${cx + dx},${cy + dy}`);
      if (a) for (const [p, item] of a) if (dist(pt, p) <= max) each(item);
    }
  }
}

// Stable identifier for a road chunk, used as the key in data/season.json.
export const chunkKey = (c) => `${c.s}|${c.r}|${c.c[0][0][0]},${c.c[0][0][1]}`;

const samplesOf = (c) => c.samples || (c.samples = samplePaths(c.c));

// Given feed results, return Map(chunk -> { time, detail, source }) for every
// chunk on which a truck reported applying material.
export function saltedChunks(chunks, results, now = Date.now()) {
  const byState = new Map();
  for (const c of chunks) {
    if (!byState.has(c.s)) byState.set(c.s, []);
    byState.get(c.s).push(c);
  }
  const out = new Map();
  const mark = (c, time, detail, source) => {
    const cur = out.get(c);
    if (!cur || (time || 0) > (cur.time || 0)) out.set(c, { time, detail, source });
  };
  for (const r of results) {
    if (!r.ok || !r.feed.material) continue;
    const stateChunks = byState.get(r.feed.state) || [];
    if (r.feed.kind === 'segments') {
      const grid = new Grid();
      for (const it of r.items) if (it.status === 'treated') for (const pt of samplePaths(it.paths)) grid.add(pt, it);
      for (const c of stateChunks) {
        const pts = samplesOf(c);
        let hit = 0, newest = null;
        for (const pt of pts) {
          let any = false;
          grid.near(pt, MATCH_M, (it) => { any = true; if (!newest || (it.time || 0) > (newest.time || 0)) newest = it; });
          if (any) hit++;
        }
        if (hit / pts.length >= COVER) mark(c, newest.time, newest.detail, r.feed.name);
      }
    } else {
      const grid = new Grid();
      for (const c of stateChunks) for (const pt of samplesOf(c)) grid.add(pt, c);
      for (const t of r.items) {
        if (!t.applying || !t.time || now - t.time > RECENT_MS) continue;
        let route = null;
        if (t.route) {
          const m = /^I-?\s*(\d+[A-Z]?)$/i.exec(t.route.trim());
          if (!m) continue; // the feed says this truck is on a non-interstate road
          route = m[1].toUpperCase();
        }
        const near = new Set();
        grid.near([t.lon, t.lat], MATCH_M, (c) => { if (!route || c.r === route) near.add(c); });
        for (const c of near) mark(c, t.time, `${t.label}: ${t.detail}`, r.feed.name);
      }
    }
  }
  return out;
}

// Winter season containing `d`: runs 1 Oct – 30 Sep, named e.g. "2026-27".
export function seasonOf(d = new Date()) {
  const y = d.getUTCMonth() >= 9 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
}

// Start of a season ("2026-27") as epoch ms: 1 October, UTC.
export const seasonStart = (name) => Date.UTC(+name.slice(0, 4), 9, 1);
