#!/usr/bin/env node
// Records which interstate chunks have been salted at least once this season.
// Run on a schedule (see .github/workflows/season.yml). Once a chunk is in
// data/season.json it stays there until the next season starts on 1 October.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { FEEDS, LOCAL_FEEDS } from '../js/feeds.js';
import { saltedChunks, chunkKey, seasonOf, seasonStart, samplePaths } from '../js/geo.js';

const root = new URL('..', import.meta.url);
const file = new URL('data/season.json', root);
const chunks = JSON.parse(readFileSync(new URL('data/interstates.json', root)));

const now = new Date();
let season = existsSync(file) ? JSON.parse(readFileSync(file)) : null;
if (!season || season.season !== seasonOf(now)) {
  season = { season: seasonOf(now), recordingSince: now.toISOString(), updated: null, salted: {} };
}

const results = await Promise.all(FEEDS.map(async (feed) => {
  try {
    return { feed, ok: true, items: await feed.load() };
  } catch (e) {
    console.error(`${feed.id} failed: ${e.message}`);
    return { feed, ok: false, items: [] };
  }
}));

let added = 0;
for (const [c, info] of saltedChunks(chunks, results, now.getTime())) {
  const k = chunkKey(c);
  if (!season.salted[k]) {
    season.salted[k] = new Date(info.time || now).toISOString();
    added++;
  }
}
// City layers that are reset between storms: remember every street seen as salted.
season.local ||= {};
for (const feed of LOCAL_FEEDS.filter((f) => f.record)) {
  try {
    const seen = (season.local[feed.id] ||= {});
    for (const it of await feed.load(seasonStart(season.season))) {
      if (it.status === 'salted' && !seen[it.id]) {
        seen[it.id] = new Date(it.time || now).toISOString();
        added++;
      }
    }
  } catch (e) {
    console.error(`${feed.id} failed: ${e.message}`);
  }
}
// City feeds that list only recently treated streets: keep the geometry too.
const CELL = 0.0003; // ~30 m
const cellsOf = (paths) => samplePaths(paths, 25).map(([x, y]) => `${Math.round(x / CELL)},${Math.round(y / CELL)}`);
for (const feed of LOCAL_FEEDS.filter((f) => f.archive)) {
  try {
    const dir = new URL('data/local/', root);
    const f = new URL(`${feed.id}.json`, dir);
    const since = seasonStart(season.season);
    const kept = existsSync(f) ? JSON.parse(readFileSync(f)).filter((it) => it.time >= since) : [];
    const ids = new Set(kept.map((it) => it.id));
    const covered = new Set(feed.archive === 'tracks' ? kept.flatMap((it) => cellsOf(it.paths)) : []);
    let n = 0;
    for (const it of await feed.load(since)) {
      if (it.status === 'none' || ids.has(it.id)) continue;
      if (feed.archive === 'tracks') {
        // Skip a track that only repeats streets already archived.
        const cells = cellsOf(it.paths);
        if (cells.filter((c) => covered.has(c)).length >= 0.9 * cells.length) continue;
        for (const c of cells) covered.add(c);
      }
      ids.add(it.id);
      kept.push({ ...it, paths: it.paths.map((p) => p.map(([x, y]) => [+x.toFixed(5), +y.toFixed(5)])) });
      n++;
    }
    if (n) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(f, JSON.stringify(kept) + '\n');
      added += n;
    }
  } catch (e) {
    console.error(`${feed.id} failed: ${e.message}`);
  }
}
console.log(`${added} newly salted stretches, ${Object.keys(season.salted).length} interstate stretches total this season`);
if (added || !season.updated) {
  season.updated = now.toISOString();
  writeFileSync(file, JSON.stringify(season, null, 1) + '\n');
}
if (results.every((r) => !r.ok)) process.exit(1);
