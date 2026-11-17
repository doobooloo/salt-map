import { FEEDS, STATE_NAMES, demoFeeds } from './feeds.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const REFRESH_MS = 2 * 60e3;
const HOUR = 3600e3;
const TRUCK_FRESH_MS = 45 * 60e3; // a truck position older than this no longer counts as "now"
const MATCH_M = 500;              // how close feed geometry must be to a road to count
const SAMPLE_M = 400;             // spacing of sample points along roads
const COVER = 0.5;                // share of a chunk a feed segment must cover

const STATUS = {
  treated: { label: 'Salt / brine applied', color: '#1f6fe5', weight: 4 },
  plowed: { label: 'Plow truck on road, no material reported', color: '#e0a100', weight: 4 },
  none: { label: 'No treatment reported', color: '#d1495b', weight: 3 },
  nodata: { label: 'No public data from this state', color: '#9aa3ad', weight: 1.5 },
};

// ---------- geometry helpers ----------
const R = 6371000, RAD = Math.PI / 180;
function dist(a, b) {
  const x = (b[0] - a[0]) * RAD * Math.cos(((a[1] + b[1]) / 2) * RAD);
  const y = (b[1] - a[1]) * RAD;
  return Math.sqrt(x * x + y * y) * R;
}
function samplePaths(paths, step) {
  const pts = [];
  for (const p of paths) {
    if (!p.length) continue;
    pts.push(p[0]);
    for (let i = 1; i < p.length; i++) {
      const d = dist(p[i - 1], p[i]);
      const n = Math.max(1, Math.ceil(d / step));
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        pts.push([p[i - 1][0] + (p[i][0] - p[i - 1][0]) * t, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * t]);
      }
    }
  }
  return pts;
}
function pathsLength(paths) {
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
  // nearest item within `max` metres of pt, preferring `better(a, b)` on ties of presence
  near(pt, max, each) {
    const cx = Math.floor(pt[0] / CELL), cy = Math.floor(pt[1] / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const a = this.m.get(`${cx + dx},${cy + dy}`);
      if (a) for (const [p, item] of a) if (dist(pt, p) <= max) each(item);
    }
  }
}

// ---------- map ----------
const map = L.map('map', { preferCanvas: true, zoomControl: false, minZoom: 3 }).setView([39.5, -96.5], 5);
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 18,
  className: 'basemap',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · Roads: USDOT/BTS NHS',
}).addTo(map);
const roadRenderer = L.canvas({ padding: 0.3, tolerance: 6 });
const truckLayer = L.layerGroup().addTo(map);

let chunks = [];
let windowHours = 48;
let lastResults = [];
const byState = new Map();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function ago(t) {
  if (!t) return 'time not reported';
  const m = Math.max(0, Math.round((Date.now() - t) / 60e3));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function popupHtml(c) {
  const s = STATUS[c.status];
  let h = `<div class="pop"><strong>I-${esc(c.r)}</strong> · ${esc(STATE_NAMES[c.s] || c.s)}<br><span class="dot" style="background:${s.color}"></span>${s.label}`;
  if (c.status === 'nodata') {
    h += c.partial
      ? '<br><small>This state publishes plow positions only, so the map cannot say whether this stretch was salted.</small>'
      : c.feedError
        ? '<br><small>This state\'s feed could not be loaded just now.</small>'
        : '<br><small>This state does not publish a feed this map can read.</small>';
  } else if (c.status === 'none') {
    h += `<br><small>No plow pass or material reported here in the last ${windowHours} h.</small>`;
  } else {
    h += `<br>${esc(c.detail || '')}<br><small>${ago(c.time)} · ${esc(c.source || '')}</small>`;
  }
  return h + '</div>';
}

function drawRoads() {
  for (const c of chunks) {
    c.len = pathsLength(c.c);
    c.status = 'nodata';
    c.layer = L.polyline(c.c.map((p) => p.map(([x, y]) => [y, x])), { renderer: roadRenderer, ...styleFor('nodata') })
      .bindPopup(() => popupHtml(c))
      .addTo(map);
    if (!byState.has(c.s)) byState.set(c.s, []);
    byState.get(c.s).push(c);
  }
}
const styleFor = (st) => ({ color: STATUS[st].color, weight: STATUS[st].weight, opacity: st === 'nodata' ? 0.7 : 0.95 });

function samplesOf(c) {
  return c.samples || (c.samples = samplePaths(c.c, SAMPLE_M));
}

// ---------- status computation ----------
const RANK = { treated: 3, plowed: 2, none: 1, nodata: 0 };

function applyResults(results) {
  lastResults = results;
  const since = Date.now() - windowHours * HOUR;
  truckLayer.clearLayers();

  const okStates = new Map(); // state -> { material: bool }
  for (const r of results) {
    if (!r.ok) continue;
    const s = okStates.get(r.feed.state) || { material: false };
    s.material = s.material || r.feed.material;
    okStates.set(r.feed.state, s);
  }
  const failedStates = new Set(results.filter((r) => !r.ok).map((r) => r.feed.state));

  for (const c of chunks) {
    const st = okStates.get(c.s);
    c.status = st && st.material ? 'none' : 'nodata';
    c.partial = !!st && !st.material;
    c.feedError = !st && failedStates.has(c.s);
    c.time = c.detail = c.source = null;
  }
  const upgrade = (c, status, time, detail, source) => {
    if (RANK[status] > RANK[c.status] || (status === c.status && (time || 0) > (c.time || 0))) {
      Object.assign(c, { status, time, detail, source });
    }
  };

  for (const r of results) {
    if (!r.ok) continue;
    const stateChunks = byState.get(r.feed.state) || [];
    if (r.feed.kind === 'segments') {
      const grid = new Grid();
      const items = r.items.filter((it) => !it.time || it.time >= since);
      for (const it of items) for (const pt of samplePaths(it.paths, SAMPLE_M)) grid.add(pt, it);
      for (const c of stateChunks) {
        const pts = samplesOf(c);
        const hits = new Map();
        for (const pt of pts) {
          const seen = new Set();
          grid.near(pt, MATCH_M, (it) => seen.add(it));
          // credit each sample point to the best segment touching it, per status
          let best = null;
          for (const it of seen) if (!best || RANK[it.status] > RANK[best.status] || (it.status === best.status && (it.time || 0) > (best.time || 0))) best = it;
          if (best) hits.set(best, (hits.get(best) || 0) + 1);
        }
        const tally = { treated: 0, plowed: 0 };
        const newest = {};
        for (const [it, n] of hits) {
          tally[it.status] += n;
          if (!newest[it.status] || (it.time || 0) > (newest[it.status].time || 0)) newest[it.status] = it;
        }
        if (tally.treated / pts.length >= COVER) upgrade(c, 'treated', newest.treated.time, newest.treated.detail, r.feed.name);
        else if ((tally.treated + tally.plowed) / pts.length >= COVER) {
          const it = newest.plowed || newest.treated;
          upgrade(c, 'plowed', it.time, it.detail, r.feed.name);
        }
      }
    } else {
      const grid = new Grid();
      for (const c of stateChunks) for (const pt of samplesOf(c)) grid.add(pt, c);
      for (const t of r.items) {
        const fresh = t.time && Date.now() - t.time <= TRUCK_FRESH_MS;
        const status = t.applying ? 'treated' : 'plowed';
        if (fresh) {
          const near = new Set();
          grid.near([t.lon, t.lat], MATCH_M, (c) => near.add(c));
          for (const c of near) upgrade(c, status, t.time, `${t.label}: ${t.detail}`, r.feed.name);
        }
        const color = !fresh ? '#9aa3ad' : t.applying ? STATUS.treated.color : STATUS.plowed.color;
        L.circleMarker([t.lat, t.lon], { radius: 5, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 1, pane: 'markerPane' })
          .bindPopup(`<div class="pop"><strong>${esc(t.label)}</strong><br>${esc(t.detail)}<br><small>${ago(t.time)}${fresh ? '' : ' – stale position'}</small></div>`)
          .addTo(truckLayer);
      }
    }
  }
  for (const c of chunks) c.layer.setStyle(styleFor(c.status));
  renderPanel(results);
}

// ---------- panel ----------
function renderPanel(results) {
  const tot = { treated: 0, plowed: 0, none: 0, nodata: 0 };
  for (const c of chunks) tot[c.status] += c.len;
  const all = tot.treated + tot.plowed + tot.none + tot.nodata;
  $('legend').innerHTML = Object.entries(STATUS).map(([k, s]) =>
    `<li><span class="swatch" style="background:${s.color}"></span><span>${s.label}</span><span class="pct">${(100 * tot[k] / all).toFixed(tot[k] / all < 0.1 && tot[k] ? 1 : 0)}%</span></li>`).join('');

  const states = [...new Set(FEEDS.map((f) => f.state))];
  $('states').innerHTML = states.map((st) => {
    const cs = byState.get(st) || [];
    const len = cs.reduce((a, c) => a + c.len, 0) || 1;
    const share = (k) => cs.filter((c) => c.status === k).reduce((a, c) => a + c.len, 0) / len;
    const feeds = results.filter((r) => r.feed.state === st);
    const material = feeds.some((r) => r.ok && r.feed.material);
    const bar = ['treated', 'plowed', 'none', 'nodata'].map((k) => `<i style="width:${100 * share(k)}%;background:${STATUS[k].color}"></i>`).join('');
    const summary = material
      ? `${Math.round(100 * share('treated'))}% of interstate treated in the last ${windowHours} h`
      : feeds.some((r) => r.ok) ? 'Plow positions only – salting not reported' : 'Feed unavailable';
    return `<div class="state"><button data-state="${st}" title="Zoom to ${STATE_NAMES[st]}">${STATE_NAMES[st]}</button>
      <div class="bar">${bar}</div><div class="sum">${summary}</div>
      ${feeds.map((r) => `<div class="feed ${r.ok ? 'ok' : 'err'}"><a href="${r.feed.link}" target="_blank" rel="noopener">${esc(r.feed.name)}</a>
        <span>${r.ok ? `${r.items.length.toLocaleString()} ${r.feed.kind === 'trucks' ? 'active truck' : 'active segment'}${r.items.length === 1 ? '' : 's'}` : `failed: ${esc(r.error)}`}</span></div>`).join('')}</div>`;
  }).join('');
  $('states').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => zoomTo(b.dataset.state)));

  const quiet = results.every((r) => r.ok) && results.every((r) => r.items.every((t) => r.feed.kind === 'trucks' && !t.applying)) && tot.treated === 0;
  $('note').hidden = !quiet || DEMO;
  $('updated').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · refreshes every 2 min`;
}

function zoomTo(st) {
  const cs = byState.get(st);
  if (!cs) return;
  const b = L.latLngBounds([]);
  for (const c of cs) b.extend(c.layer.getBounds());
  map.fitBounds(b, { padding: [30, 30] });
}

// ---------- loading ----------
async function refresh() {
  const feeds = DEMO ? demoFeeds(chunks) : FEEDS;
  $('updated').textContent = 'Loading state feeds…';
  const results = await Promise.all(feeds.map(async (feed) => {
    try {
      return { feed, ok: true, items: await feed.load() };
    } catch (e) {
      console.warn(feed.id, e);
      return { feed, ok: false, items: [], error: e.message || String(e) };
    }
  }));
  applyResults(results);
}

async function init() {
  $('demo').hidden = !DEMO;
  if (window.innerWidth <= 640) document.body.classList.add('collapsed');
  $('window').addEventListener('change', (e) => { windowHours = +e.target.value; applyResults(lastResults); });
  $('toggle').addEventListener('click', () => document.body.classList.toggle('collapsed'));
  try {
    chunks = await (await fetch('data/interstates.json')).json();
  } catch (e) {
    $('updated').textContent = 'Could not load the interstate network. Serve this folder over HTTP (see README).';
    return;
  }
  drawRoads();
  await refresh();
  setInterval(refresh, REFRESH_MS);
  window.saltMap = { map, chunks: () => chunks, zoomTo };
}
init();
