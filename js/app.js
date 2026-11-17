import { FEEDS, STATE_NAMES, demoFeeds } from './feeds.js';
import { pathsLength, saltedChunks, chunkKey, TRUCK_FRESH_MS } from './geo.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const REFRESH_MS = 2 * 60e3;

const STATUS = {
  salted: { label: 'Salted this season', color: '#1f6fe5', weight: 4 },
  unsalted: { label: 'Not salted yet', color: '#d1495b', weight: 3 },
  nodata: { label: 'No public data from this state', color: '#9aa3ad', weight: 1.5 },
};

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
let season = { season: '', recordingSince: null, salted: {} };
const byState = new Map();

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const day = (t) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
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
  } else if (c.status === 'unsalted') {
    h += `<br><small>No salt or brine reported here since recording began${season.recordingSince ? ` on ${day(season.recordingSince)}` : ''}.</small>`;
  } else {
    h += `<br><small>First recorded ${day(c.first)}${c.detail ? `<br>${esc(c.detail)}` : ''}</small>`;
  }
  return h + '</div>';
}

const styleFor = (st) => ({ color: STATUS[st].color, weight: STATUS[st].weight, opacity: st === 'nodata' ? 0.7 : 0.95 });

function drawRoads() {
  for (const c of chunks) {
    c.len = pathsLength(c.c);
    c.key = chunkKey(c);
    c.status = 'nodata';
    c.layer = L.polyline(c.c.map((p) => p.map(([x, y]) => [y, x])), { renderer: roadRenderer, ...styleFor('nodata') })
      .bindPopup(() => popupHtml(c))
      .addTo(map);
    if (!byState.has(c.s)) byState.set(c.s, []);
    byState.get(c.s).push(c);
  }
}

// ---------- status ----------
// A chunk is salted for the season once it appears in data/season.json (kept by
// the scheduled recorder) or a feed reports material on it right now.
function applyResults(results) {
  const materialStates = new Set(), okStates = new Set(), failed = new Set();
  for (const r of results) {
    if (!r.ok) { failed.add(r.feed.state); continue; }
    okStates.add(r.feed.state);
    if (r.feed.material) materialStates.add(r.feed.state);
  }
  // A state stays "reporting" on the strength of the season record even if its feed is down.
  const recorded = new Set(Object.keys(season.salted).map((k) => k.split('|')[0]));
  const live = saltedChunks(chunks, results);
  for (const c of chunks) {
    const first = DEMO ? null : season.salted[c.key];
    const now = live.get(c);
    c.partial = okStates.has(c.s) && !materialStates.has(c.s);
    c.feedError = !okStates.has(c.s) && failed.has(c.s);
    c.detail = now ? now.detail : null;
    if (first || now) {
      c.status = 'salted';
      c.first = first || now.time || Date.now();
    } else {
      c.status = materialStates.has(c.s) || recorded.has(c.s) ? 'unsalted' : 'nodata';
    }
    c.layer.setStyle(styleFor(c.status));
  }

  truckLayer.clearLayers();
  for (const r of results) {
    if (!r.ok || r.feed.kind !== 'trucks') continue;
    for (const t of r.items) {
      if (t.trail) continue;
      const fresh = t.time && Date.now() - t.time <= TRUCK_FRESH_MS;
      const color = !fresh ? '#9aa3ad' : t.applying ? STATUS.salted.color : '#e0a100';
      L.circleMarker([t.lat, t.lon], { radius: 5, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 1, pane: 'markerPane' })
        .bindPopup(`<div class="pop"><strong>${esc(t.label)}</strong><br>${esc(t.detail)}<br><small>${ago(t.time)}${fresh ? '' : ' – stale position'}</small></div>`)
        .addTo(truckLayer);
    }
  }
  renderPanel(results);
}

// ---------- panel ----------
const count = (r) => r.items.filter((t) => !t.trail).length;
function renderPanel(results) {
  const tot = { salted: 0, unsalted: 0, nodata: 0 };
  for (const c of chunks) tot[c.status] += c.len;
  const all = tot.salted + tot.unsalted + tot.nodata;
  $('legend').innerHTML = Object.entries(STATUS).map(([k, s]) =>
    `<li><span class="swatch" style="background:${s.color}"></span><span>${s.label}</span><span class="pct">${(100 * tot[k] / all).toFixed(tot[k] / all < 0.1 && tot[k] ? 1 : 0)}%</span></li>`).join('');

  const states = [...new Set(FEEDS.map((f) => f.state))];
  $('states').innerHTML = states.map((st) => {
    const cs = byState.get(st) || [];
    const len = cs.reduce((a, c) => a + c.len, 0) || 1;
    const share = (k) => cs.filter((c) => c.status === k).reduce((a, c) => a + c.len, 0) / len;
    const feeds = results.filter((r) => r.feed.state === st);
    const bar = Object.keys(STATUS).map((k) => `<i style="width:${100 * share(k)}%;background:${STATUS[k].color}"></i>`).join('');
    const summary = share('nodata') < 1
      ? `${Math.round(100 * share('salted'))}% of interstate salted this season`
      : feeds.some((r) => r.ok) ? 'Plow positions only – salting not reported' : 'Feed unavailable';
    return `<div class="state"><button data-state="${st}" title="Zoom to ${STATE_NAMES[st]}">${STATE_NAMES[st]}</button>
      <div class="bar">${bar}</div><div class="sum">${summary}</div>
      ${feeds.map((r) => `<div class="feed ${r.ok ? 'ok' : 'err'}"><a href="${r.feed.link}" target="_blank" rel="noopener">${esc(r.feed.name)}</a>
        <span>${r.ok ? `${count(r).toLocaleString()} ${r.feed.kind === 'trucks' ? 'truck' : 'treated segment'}${count(r) === 1 ? '' : 's'} now` : `failed: ${esc(r.error)}`}</span></div>`).join('')}</div>`;
  }).join('');
  $('states').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => zoomTo(b.dataset.state)));

  $('since').textContent = season.recordingSince && !DEMO
    ? `Season ${season.season}. Recording began ${day(season.recordingSince)}; salting before then is not counted.`
    : '';
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
  if (!DEMO) {
    try { season = await (await fetch('data/season.json', { cache: 'no-store' })).json(); } catch (e) { console.warn('season record unavailable', e); }
  }
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
