// Registry of public state DOT feeds that say something about winter road treatment.
//
// Each feed turns a state's own data into one of two normalized shapes:
//   segments: [{ paths: [[[lon,lat],...],...], status: 'treated'|'plowed', time: ms, detail: string }]
//   trucks:   [{ lon, lat, time: ms, applying: true|false|null, label, detail, route?, trail? }]
// `route` (e.g. "I-70") restricts matching to that road; `trail: true` marks an older breadcrumb.
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

// Castle Rock "CARS" 511 platform: per-truck breadcrumb trails, shared by several states.
// The material being spread is only encoded in the icon name (None_ / Solid_ / Liquid_ ...).
function carsFeed({ state, agency, host, site, material = true }) {
  return {
    id: `${state.toLowerCase()}-cars`,
    state,
    kind: 'trucks',
    material,
    name: `${agency} – 511 plow locations (live)`,
    about: material ? 'Plow trails with the material each truck is spreading.' : 'Plow positions only; material is not reported.',
    link: site,
    async load() {
      const res = await fetch(`https://${host}/avl_v2/api/plows`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const trucks = await res.json();
      const out = [];
      for (const t of trucks) {
        if (String(t.id).endsWith('-i') && material) continue; // plow-camera duplicate of a truck
        (t.statuses || []).forEach((st, i) => {
          if (st.latitude == null || st.longitude == null) return;
          const mat = st.plowIconName ? st.plowIconName.replace(/^\//, '').split('_')[0] : null;
          const applying = !material || mat == null ? null : mat.toLowerCase() !== 'none';
          out.push({
            lon: st.longitude,
            lat: st.latitude,
            time: st.timestamp || null,
            applying,
            route: st.routeDesignator || null,
            trail: i > 0,
            label: `${agency} plow ${st.vehicleName || t.id}`.replace(/-i$/, ''),
            detail: (applying == null ? 'Material not reported' : applying ? `Applying ${mat.toLowerCase()} material` : 'Not applying material')
              + (st.routeDesignator ? ` on ${st.routeDesignator}` : ''),
          });
        });
      }
      return out;
    },
  };
}

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
  carsFeed({ state: 'IN', agency: 'INDOT', host: 'intg.carsprogram.org', site: 'https://511in.org' }),
  carsFeed({ state: 'KS', agency: 'KDOT', host: 'kstg.carsprogram.org', site: 'https://www.kandrive.gov' }),
  carsFeed({ state: 'NE', agency: 'Nebraska DOT', host: 'netg.carsprogram.org', site: 'https://new.511.nebraska.gov' }),
  carsFeed({ state: 'MN', agency: 'MnDOT', host: 'mntg.carsprogram.org', site: 'https://511mn.org', material: false }),
  {
    id: 'ky-segments',
    state: 'KY',
    kind: 'segments',
    material: true,
    name: 'Kentucky KYTC – Snow and ice treated roads',
    about: 'Road segments with the last time they were treated or pre-treated.',
    link: 'https://www.arcgis.com/home/search.html?q=SNICTreatedRoads_2020',
    async load() {
      const feats = await arcgisQuery('https://services2.arcgis.com/CcI36Pduqd0OR4W9/arcgis/rest/services/SNICTreatedRoads_2020/FeatureServer/0', {
        where: "kytcRtPrefix='I' AND (TreatmentLastDate IS NOT NULL OR PreTreatmentLastDate IS NOT NULL)",
        outFields: 'kytcRoute,TreatmentLastDate,PreTreatmentLastDate',
        maxAllowableOffset: '0.0005',
        geometryPrecision: '4',
      }, 10);
      return feats.filter((f) => f.geometry && f.geometry.paths).map((f) => {
        const a = f.attributes;
        const pre = (a.PreTreatmentLastDate || 0) > (a.TreatmentLastDate || 0);
        return { paths: f.geometry.paths, status: 'treated', time: Math.max(a.TreatmentLastDate || 0, a.PreTreatmentLastDate || 0) || null,
          detail: `${a.kytcRoute || ''} ${pre ? 'pre-treated' : 'treated'}`.trim() };
      });
    },
  },
  {
    id: 'ky-trucks',
    state: 'KY',
    kind: 'trucks',
    material: false, // the rate fields read non-zero on parked trucks, so they are not trusted here
    name: 'Kentucky KYTC – Truck locations (live)',
    about: 'Live truck positions.',
    link: 'https://www.arcgis.com/home/search.html?q=avl_2020%20KYTC',
    async load() {
      const feats = await arcgisQuery('https://services2.arcgis.com/CcI36Pduqd0OR4W9/arcgis/rest/services/avl_2020/FeatureServer/0', {
        where: 'avlSpeed > 5',
        outFields: 'avlVehicleName,avlDatestamp,avlSpeed,kytcRouteLbl',
        orderByFields: 'avlDatestamp DESC',
        resultRecordCount: '300',
      }, 1);
      const cutoff = Date.now() - HOUR;
      return feats.filter((f) => f.geometry && f.attributes.avlDatestamp > cutoff).map((f) => ({
        lon: f.geometry.x, lat: f.geometry.y, time: f.attributes.avlDatestamp, applying: null,
        label: `KYTC truck ${f.attributes.avlVehicleName || ''}`.trim(),
        detail: `Moving at ${Math.round(f.attributes.avlSpeed)} mph${f.attributes.kytcRouteLbl ? ` on ${f.attributes.kytcRouteLbl}` : ''} – material not reported`,
      }));
    },
  },
  {
    id: 'md-trucks',
    state: 'MD',
    kind: 'trucks',
    material: false,
    name: 'Maryland MDOT SHA – STORM plow locations (live)',
    about: 'Live plow positions (5 minute delay). Material is not reported.',
    link: 'https://storm.sha.maryland.gov',
    async load() {
      const feats = await arcgisQuery('https://app-storm-sha-prod.azurewebsites.net/koop/avllocation/rest/services/0/FeatureServer/0', { outFields: '*' }, 1);
      return feats.filter((f) => f.attributes.lat && f.attributes.lon).map((f) => ({
        lon: f.attributes.lon, lat: f.attributes.lat, time: f.attributes.dateStamp || null, applying: null,
        label: 'MDOT SHA plow', detail: 'Material not reported',
      }));
    },
  },
  carsFeed({ state: 'CO', agency: 'CDOT', host: 'cotg.carsprogram.org', site: 'https://www.cotrip.org' }),
  {
    id: 'ar-segments',
    state: 'AR',
    kind: 'segments',
    material: true,
    name: 'Arkansas ARDOT – Pretreatment routes',
    about: 'Highway segments with the pretreatment solution applied.',
    link: 'https://www.idrivearkansas.com',
    async load() {
      const res = await fetch('https://layers.idrivearkansas.com/pretreat_routes.geojson');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data.features || [])
        .filter((f) => f.geometry && f.properties.route_type === 'Interstate')
        .filter((f) => f.properties.completed || (f.properties.solution && f.properties.solution !== 'None'))
        .map((f) => {
          const p = f.properties;
          return { paths: f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates], status: 'treated',
            time: Date.parse(p.completed_date || p.last_update) || null,
            detail: `Pretreatment${p.solution && p.solution !== 'None' ? `: ${p.solution}` : ' completed'}` };
        });
    },
  },
];

// ---------- city / local street feeds ----------
// These carry their own street geometry and are drawn only when the map is zoomed to the city.
// load(sinceMs) -> [{ id, name, paths, status: 'salted'|'serviced'|'none', time, detail }]
//   salted:   the agency says salt/brine/pre-treatment went down
//   serviced: a winter operations vehicle pass was logged, salt vs plow not specified
// `record: true` means the layer is reset between storms, so the season recorder must remember it.

const sqlDate = (ms) => new Date(ms).toISOString().slice(0, 10) + ' 00:00:00';
const TEST_EVENT = /test|dry.?run|training|drill|demo/i;

// Esri "Winter Weather Operations" solution: streets with the last time a vehicle serviced them.
function wwoFeed({ id, place, state, center, url, link }) {
  return {
    id, place, state, center, link, material: false, record: false,
    name: `${place} – streets last serviced`,
    async load(since) {
      // Segments keep the id of the event that last serviced them; drop tests and dry runs.
      const testEvents = new Set();
      try {
        const events = await arcgisQuery(url.replace(/\/0$/, '/3'), { outFields: 'eventid,eventname', returnGeometry: 'false' }, 3);
        for (const e of events) if (TEST_EVENT.test(e.attributes.eventname || '')) testEvents.add(e.attributes.eventid);
      } catch (e) { /* this city publishes no event table */ }
      const feats = await arcgisQuery(url, {
        where: `lastserviced >= TIMESTAMP '${sqlDate(since)}'`,
        outFields: '*',
        maxAllowableOffset: '0.00005',
        geometryPrecision: '5',
      }, 15);
      return feats
        .filter((f) => f.geometry && f.geometry.paths)
        .filter((f) => !TEST_EVENT.test(f.attributes.eventname || f.attributes.eventname_Any || '') && !testEvents.has(f.attributes.eventid))
        .map((f) => {
          const a = f.attributes;
          const what = a.servicestatus && !/not serviced|reset/i.test(a.servicestatus) ? a.servicestatus : '';
          const salted = /de-?ic|anti-?ic|salt|brin/i.test(what);
          const passes = a.passes ? `${a.passes} vehicle pass${a.passes === 1 ? '' : 'es'}` : '';
          return { id: String(a.snowroutesegmentid || a.OBJECTID || a.objectid), name: a.roadname || 'Street', paths: f.geometry.paths,
            status: salted ? 'salted' : 'serviced', time: a.lastserviced, detail: [what, passes].filter(Boolean).join(', ') };
        });
    },
  };
}

export const LOCAL_FEEDS = [
  {
    id: 'cincinnati', place: 'Cincinnati, OH', state: 'OH', center: [39.14, -84.51], material: true, record: true,
    name: 'Cincinnati – street treatment status',
    link: 'https://cagisonline.hamilton-co.org/arcgis/rest/services/Cincinnati/PS_Snowplow_Routes/FeatureServer',
    async load(since) {
      const feats = await arcgisQuery('https://cagisonline.hamilton-co.org/arcgis/rest/services/Cincinnati/PS_Snowplow_Routes/FeatureServer/1', {
        outFields: 'SNOWSTREETID,MAPLABEL,STREETSTATUS,STREETDATE',
        maxAllowableOffset: '0.00005',
        geometryPrecision: '5',
      }, 5);
      return feats.filter((f) => f.geometry && f.geometry.paths).map((f) => {
        const a = f.attributes;
        const salted = /salt|pretreat/i.test(a.STREETSTATUS || '') && (a.STREETDATE || 0) >= since;
        return { id: a.SNOWSTREETID, name: a.MAPLABEL || 'Street', paths: f.geometry.paths,
          status: salted ? 'salted' : 'none', time: salted ? a.STREETDATE : null, detail: salted ? a.STREETSTATUS : '' };
      });
    },
  },
  wwoFeed({ id: 'kansas-city', place: 'Kansas City, MO', state: 'MO', center: [39.1, -94.58],
    url: 'https://services.arcgis.com/4o5uMWTHuOhUVJPd/arcgis/rest/services/Winter_Operations_public_74e8930bc7fb4f2aa30a81bec12d50bc/FeatureServer/0' }),
  wwoFeed({ id: 'akron', place: 'Akron, OH', state: 'OH', center: [41.08, -81.52],
    url: 'https://services1.arcgis.com/8roChjXOF0iBhNoB/arcgis/rest/services/Winter_Operations_public_05170e26916845e88589beb76f4c667f/FeatureServer/0' }),
  wwoFeed({ id: 'portage', place: 'Portage, MI', state: 'MI', center: [42.2, -85.59],
    url: 'https://services7.arcgis.com/AujU6g0cAkL5JYsn/arcgis/rest/services/Winter_Operations_public_8364b3cb987c4a85bfc6265073e2a647/FeatureServer/0' }),
  wwoFeed({ id: 'bowling-green', place: 'Bowling Green, OH', state: 'OH', center: [41.375, -83.65],
    url: 'https://services1.arcgis.com/2guSauYVDQrap3kI/arcgis/rest/services/Winter_Operations_public_e6027c15269544358b4a937dbb4d8879/FeatureServer/0' }),
  wwoFeed({ id: 'syracuse', place: 'Syracuse, NY', state: 'NY', center: [43.05, -76.15],
    url: 'https://services6.arcgis.com/bdPqSfflsdgFRVVM/arcgis/rest/services/EventSnowRoutes_dashboard_0eaac62ac5fc4865b58d5ce127f5841f/FeatureServer/0' }),
  wwoFeed({ id: 'washington-dc', place: 'Washington, DC', state: 'DC', center: [38.9, -77.03],
    url: 'https://services.arcgis.com/neT9SoYxizqTHZPH/arcgis/rest/services/EventSnowRoutes_dashboard_f01daf9a8523494aaa87a041ce02028f/FeatureServer/0' }),
  wwoFeed({ id: 'milwaukee', place: 'Milwaukee, WI', state: 'WI', center: [43.04, -87.91],
    url: 'https://services1.arcgis.com/5ly0cVV70qsN8Soc/arcgis/rest/services/SnowRoutes_PublicView/FeatureServer/0' }),
  wwoFeed({ id: 'sarpy-county', place: 'Sarpy County, NE', state: 'NE', center: [41.15, -96.04],
    url: 'https://services.arcgis.com/OiG7dbwhQEWoy77N/arcgis/rest/services/SnowRoutes_public_eb37385e0842450a93a46aae44a69298/FeatureServer/0' }),
  wwoFeed({ id: 'bozeman', place: 'Bozeman, MT', state: 'MT', center: [45.68, -111.04],
    url: 'https://services3.arcgis.com/f4hk1qcfxRJ0L2BU/arcgis/rest/services/Winter_Operations_public_0e474e29fe084c908647ee65df2bee92/FeatureServer/0' }),
  wwoFeed({ id: 'anchorage', place: 'Anchorage, AK', state: 'AK', center: [61.19, -149.87],
    url: 'https://services2.arcgis.com/Ce3DhLRthdwbHlfF/arcgis/rest/services/SnowRoutes_20241120_ReadOnly_View/FeatureServer/0' }),
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
