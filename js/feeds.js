// Registry of public state DOT feeds that say something about winter road treatment.
//
// Each feed turns a state's own data into one of two normalized shapes:
//   segments: [{ paths: [[[lon,lat],...],...], status: 'treated'|'plowed', time: ms, detail: string }]
//   trucks:   [{ lon, lat, time: ms, applying: true|false|null, label, detail }]
// `applying: null` means the feed does not say whether material is going down.
//
// To add a state: append an entry here. `material: true` means the feed reports
// salt/brine application, so roads with no report can honestly be shown as
// "no treatment reported". With `material: false` the state only ever shows
// plow activity, never a salted / not-salted verdict.

const HOUR = 3600e3;

async function arcgisQuery(layerUrl, params, maxPages = 10) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({ where: '1=1', outSR: '4326', f: 'json', ...params, resultOffset: offset });
    const res = await fetch(`${layerUrl}/query?${qs}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message || 'ArcGIS error');
    const feats = data.features || [];
    out.push(...feats);
    offset += feats.length;
    if (!feats.length || !data.exceededTransferLimit) break;
  }
  return out;
}

const fmt = (n, unit) => (n > 0 ? `${Math.round(n).toLocaleString()} ${unit}` : null);

const IOWA = 'https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services';
const UTAH = 'https://services.arcgis.com/pA2nEVnB6tquxgOW/arcgis/rest/services';

export const FEEDS = [
  {
    id: 'ia-segments',
    state: 'IA',
    kind: 'segments',
    material: true,
    name: 'Iowa DOT – Winter Storm Analysis (past 48 h)',
    about: 'Road segments with plow passes and salt/brine quantities over the last 48 hours.',
    link: 'https://www.arcgis.com/home/search.html?q=Winter%20Storm%20Analysis%20owner%3AIowaDOT_SODA',
    async load() {
      const feats = await arcgisQuery(`${IOWA}/Winter_Storm_Analysis_48HR_View/FeatureServer/0`, {
        outFields: 'TOTAL_PASSES_WITH_MATERIAL,NUMBER_PASSES,LAST_PASS,QUANTITY_SOLID,QUANTITY_LIQUID,QUANTITY_PREWET,COMMON_ROUTE_NAME',
        maxAllowableOffset: '0.0005',
        geometryPrecision: '4',
      }, 25);
      return feats
        .filter((f) => f.geometry && f.geometry.paths && (f.attributes.NUMBER_PASSES > 0 || f.attributes.TOTAL_PASSES_WITH_MATERIAL > 0))
        .map((f) => {
          const a = f.attributes;
          const withMat = a.TOTAL_PASSES_WITH_MATERIAL || 0;
          const mats = [fmt(a.QUANTITY_SOLID, 'lb solid'), fmt(a.QUANTITY_LIQUID, 'gal liquid'), fmt(a.QUANTITY_PREWET, 'gal prewet')].filter(Boolean);
          return {
            paths: f.geometry.paths,
            status: withMat > 0 ? 'treated' : 'plowed',
            time: a.LAST_PASS || null,
            detail: `${a.NUMBER_PASSES || 0} pass${a.NUMBER_PASSES === 1 ? '' : 'es'}, ${withMat} with material` + (mats.length ? ` (${mats.join(', ')})` : ''),
          };
        });
    },
  },
  {
    id: 'ia-trucks',
    state: 'IA',
    kind: 'trucks',
    material: true,
    name: 'Iowa DOT – Snow plow truck locations (live)',
    about: 'Live plow positions with the material each truck is spreading right now.',
    link: 'https://www.arcgis.com/home/search.html?q=Snow%20Plow%20Truck%20Location%20AVL%20owner%3AIowaDOT_SODA',
    async load() {
      const feats = await arcgisQuery(`${IOWA}/AVL_Direct_View/FeatureServer/0`, {
        outFields: 'LABEL,VELOCITY,ACTIVE_MATERIAL,SOLIDRATE,LIQUIDRATE,PREWETRATE,SOLIDMATERIAL,LIQUIDMATERIAL,ROUTE_NAME,MODIFIEDDT',
      });
      return feats.filter((f) => f.geometry).map((f) => {
        const a = f.attributes;
        const active = a.ACTIVE_MATERIAL && a.ACTIVE_MATERIAL.toUpperCase() !== 'NONE';
        const applying = !!(active || a.SOLIDRATE > 0 || a.LIQUIDRATE > 0 || a.PREWETRATE > 0);
        const rates = [fmt(a.SOLIDRATE, 'lb/mi solid'), fmt(a.LIQUIDRATE, 'gal/mi liquid'), fmt(a.PREWETRATE, 'gal/ton prewet')].filter(Boolean);
        return {
          lon: f.geometry.x,
          lat: f.geometry.y,
          time: a.MODIFIEDDT || null,
          applying,
          label: `Iowa DOT truck ${a.LABEL || ''}`.trim(),
          detail: applying
            ? `Applying ${active ? a.ACTIVE_MATERIAL.toLowerCase() : 'material'}${rates.length ? ` – ${rates.join(', ')}` : ''}`
            : 'Not applying material',
        };
      });
    },
  },
  {
    id: 'ut-trucks',
    state: 'UT',
    kind: 'trucks',
    material: false,
    name: 'Utah DOT – Snow plow locations (live)',
    about: 'Live plow positions. Utah does not publish what material, if any, is being spread.',
    link: 'https://www.arcgis.com/home/search.html?q=SnowPlow_AVL_Public',
    async load() {
      const feats = await arcgisQuery(`${UTAH}/SnowPlow_AVL_Public/FeatureServer/0`, {
        outFields: 'vehicleid,servicetype,speedmph,location_timestamp',
        orderByFields: 'location_timestamp DESC',
        resultRecordCount: '1000',
      }, 1);
      const cutoff = Date.now() - 2 * HOUR;
      return feats
        .filter((f) => f.geometry && f.attributes.servicetype === 'Moving' && f.attributes.location_timestamp > cutoff)
        .map((f) => ({
          lon: f.geometry.x,
          lat: f.geometry.y,
          time: f.attributes.location_timestamp,
          applying: null,
          label: `UDOT plow ${f.attributes.vehicleid || ''}`.trim(),
          detail: `Moving at ${Math.round(f.attributes.speedmph || 0)} mph – material not reported`,
        }));
    },
  },
];

export const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York',
  NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', PR: 'Puerto Rico',
};

// Simulated storm used by ?demo=1 so the map can be exercised when no plows are out.
// It fabricates feed output from the real interstate geometry; it is never mixed with live data.
export function demoFeeds(chunks) {
  const now = Date.now();
  const pick = (state, routes) => chunks.filter((c) => c.s === state && routes.includes(c.r));
  const rand = (i) => { const x = Math.sin(i * 12.9898) * 43758.5453; return x - Math.floor(x); };
  const mid = (c) => c.c[0][Math.floor(c.c[0].length / 2)];
  return [
    { ...FEEDS[0], load: async () => pick('IA', ['80', '35', '380', '235']).map((c, i) => {
      const r = rand(i);
      if (r < 0.12) return null;
      const treated = r > 0.3;
      return { paths: c.c, status: treated ? 'treated' : 'plowed', time: now - r * 40 * HOUR,
        detail: treated ? `3 passes, 2 with material (${Math.round(200 + r * 900)} lb solid)` : '1 pass, 0 with material' };
    }).filter(Boolean) },
    { ...FEEDS[1], load: async () => pick('IA', ['29', '680', '80']).filter((_, i) => i % 9 === 0).map((c, i) => {
      const [lon, lat] = mid(c);
      const applying = i % 3 !== 0;
      return { lon, lat, time: now - i * 60e3, applying, label: `Iowa DOT truck A3${1000 + i}`,
        detail: applying ? 'Applying salt – 200 lb/mi solid' : 'Not applying material' };
    }) },
    { ...FEEDS[2], load: async () => pick('UT', ['15', '80', '84']).filter((_, i) => i % 6 === 0).map((c, i) => {
      const [lon, lat] = mid(c);
      return { lon, lat, time: now - i * 90e3, applying: null, label: `UDOT plow 01${1200 + i}`, detail: 'Moving at 31 mph – material not reported' };
    }) },
  ];
}
