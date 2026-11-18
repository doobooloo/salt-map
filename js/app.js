import { FEEDS, LOCAL_FEEDS, STATE_NAMES, demoFeeds } from './feeds.js';
import { pathsLength, saltedChunks, chunkKey, seasonOf, seasonStart, TRUCK_FRESH_MS } from './geo.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const REFRESH_MS = 2 * 60e3;

const STATUS = {
  salted: { label: 'Salted this season', color: '#1f6fe5', weight: 4 },
  unsalted: { label: 'Not salted yet', color: '#d1495b', weight: 3 },
  nodata: { label: 'No public data from this state', color: '#9aa3ad', weight: 1.5 },
};
const SERVICED = { label: 'City street serviced by winter crew (salt not specified)', color: '#12a594' };

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
const pct = (f) => (f > 0 && f < 0.001 ? '<0.1%' : `${(100 * f).toFixed(f < 0.1 && f ? 1 : 0)}%`);
const count = (r) => r.items.filter((t) => !t.trail).length;
function renderPanel(results) {
  const tot = { salted: 0, unsalted: 0, nodata: 0 };
  for (const c of chunks) tot[c.status] += c.len;
  const all = tot.salted + tot.unsalted + tot.nodata;
  $('legend').innerHTML = Object.entries(STATUS).map(([k, s]) =>
    `<li><span class="swatch" style="background:${s.color}"></span><span>${s.label}</span><span class="pct">${pct(tot[k] / all)}</span></li>`).join('')
    + `<li><span class="swatch" style="background:${SERVICED.color}"></span><span>${SERVICED.label}</span></li>`;

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
      <details><summary>Sources</summary>${feeds.map((r) => `<div class="feed ${r.ok ? 'ok' : 'err'}"><a href="${r.feed.link}" target="_blank" rel="noopener">${esc(r.feed.name)}</a>
        <span>${r.ok ? `${count(r).toLocaleString()} ${r.feed.kind === 'trucks' ? 'truck' : 'treated segment'}${count(r) === 1 ? '' : 's'} now` : `failed: ${esc(r.error)}`}</span></div>`).join('')}</details></div>`;
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

// ---------- city streets ----------
// Each city feed is fetched the first time the map is zoomed in near it.
const CITY_ZOOM = 10;
const cityLayer = L.layerGroup();
const cityPins = L.layerGroup();
const cityState = new Map(); // feed.id -> { status: 'idle'|'loading'|'ok'|'err', counts }
const cityRenderer = L.canvas({ padding: 0.3, tolerance: 5 });

function cityPopup(feed, it) {
  const st = it.status === 'salted' ? STATUS.salted : it.status === 'serviced' ? { ...SERVICED, label: 'Serviced by winter crew (salt not specified)' } : STATUS.unsalted;
  return `<div class="pop"><strong>${esc(it.name)}</strong> · ${esc(feed.place)}<br><span class="dot" style="background:${st.color}"></span>${st.label}`
    + (it.time ? `<br><small>${it.status === 'salted' ? 'First recorded' : 'Last serviced'} ${day(it.time)}${it.detail ? ` · ${esc(it.detail)}` : ''}</small>` : '') + '</div>';
}

async function loadCity(feed) {
  const st = cityState.get(feed.id);
  if (st.status !== 'idle') return;
  st.status = 'loading';
  renderCities();
  try {
    const since = seasonStart(season.season || seasonOf());
    const items = await feed.load(since);
    if (feed.archive) {
      // Streets the recorder saw earlier this season that the city's feed has since dropped.
      try {
        const res = await fetch(`data/local/${feed.id}.json`, { cache: 'no-store' });
        const live = new Set(items.map((it) => it.id));
        if (res.ok) for (const it of await res.json()) if (!live.has(it.id) && it.time >= since) items.push(it);
      } catch (e) { console.warn(feed.id, 'archive unavailable', e); }
    }
    const recorded = (season.local && season.local[feed.id]) || {};
    st.counts = { salted: 0, serviced: 0, none: 0 };
    for (const it of items) {
      if (recorded[it.id] && it.status !== 'salted') Object.assign(it, { status: 'salted', time: Date.parse(recorded[it.id]), detail: '' });
      st.counts[it.status]++;
      const color = it.status === 'salted' ? STATUS.salted.color : it.status === 'serviced' ? SERVICED.color : STATUS.unsalted.color;
      L.polyline(it.paths.map((p) => p.map(([x, y]) => [y, x])), { renderer: cityRenderer, color, weight: it.status === 'none' ? 1.5 : 2.5, opacity: it.status === 'none' ? 0.55 : 0.9 })
        .bindPopup(() => cityPopup(feed, it)).addTo(cityLayer);
    }
    st.status = 'ok';
  } catch (e) {
    console.warn(feed.id, e);
    st.status = 'err';
    st.error = e.message || String(e);
  }
  renderCities();
}

function updateCities() {
  const zoomedIn = map.getZoom() >= CITY_ZOOM;
  if (zoomedIn) { map.removeLayer(cityPins); map.addLayer(cityLayer); } else { map.removeLayer(cityLayer); map.addLayer(cityPins); }
  if (!zoomedIn || DEMO) return;
  const b = map.getBounds().pad(0.3);
  for (const feed of LOCAL_FEEDS) if (b.contains(feed.center)) loadCity(feed);
}

function renderCities() {
  $('cities').innerHTML = LOCAL_FEEDS.map((feed) => {
    const st = cityState.get(feed.id);
    const c = st.counts;
    const txt = st.status === 'idle' ? (feed.material ? 'Reports salting' : 'Reports vehicle passes only')
      : st.status === 'loading' ? 'Loading…'
      : st.status === 'err' ? `Failed: ${esc(st.error)}`
      : feed.archive ? (c.salted + c.serviced ? `${(c.salted + c.serviced).toLocaleString()} ${feed.archive === 'tracks' ? 'truck routes' : 'streets'} ${feed.material ? 'salted' : 'serviced'} this season` : `Nothing ${feed.material ? 'salted' : 'serviced'} yet this season`)
      : feed.material ? `${c.salted.toLocaleString()} of ${(c.salted + c.none).toLocaleString()} streets salted this season`
      : c.serviced ? `${c.serviced.toLocaleString()} streets serviced this season` : 'No streets serviced yet this season';
    return `<div class="city"><button data-city="${feed.id}">${esc(feed.place)}</button><span class="${st.status === 'err' ? 'bad' : ''}">${txt}</span></div>`;
  }).join('');
  $('cities').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    map.setView(LOCAL_FEEDS.find((f) => f.id === b.dataset.city).center, 12);
  }));
}

function initCities() {
  for (const feed of LOCAL_FEEDS) {
    cityState.set(feed.id, { status: 'idle' });
    L.marker(feed.center, { icon: L.divIcon({ className: 'citypin', html: `<span>${esc(feed.place.split(',')[0])}</span>`, iconSize: null }) })
      .on('click', () => map.setView(feed.center, 12)).addTo(cityPins);
  }
  renderCities();
  map.on('zoomend moveend', updateCities);
  updateCities();
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
  initCities();
  setInterval(refresh, REFRESH_MS);
  window.saltMap = { map, chunks: () => chunks, zoomTo };
}
init();
