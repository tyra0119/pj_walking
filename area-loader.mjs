// スタート地点のまわりの道のデータを、ブラウザでその場で集めて道の網を作る（上津台の外でもスタートできるように。2026-10-15）
//  - OpenStreetMap の道と、町・森の範囲: Overpass API（1 回の問い合わせで両方）
//  - 国土地理院の道路中心線（ズーム 16 の GeoJSON）と標高（ズーム 14 の PNG）
// 作り方は上津台の分と同じ（web/graph-build.mjs）
import { buildGraph, elevFromTiles, tilesOf } from './graph-build.mjs?v=5ee49af-10152253';

const RAD = Math.PI / 180;
// 公開の Overpass は混んでいると断る・止まることが多い（2026-10-15 に試すと overpass-api.de 406、kumi・private.coffee 500、
// maps.mail.ru は小さい範囲だけ返った）。順に頼み、どれもだめなら国土地理院の道路中心線だけで道の網を作る（gsiRoads）
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const OVERPASS_WAIT = 30e3;  // 1 か所あたり待つ長さ
const OVERPASS_TOTAL = 45e3; // ぜんぶで待つ長さ（過ぎたら国土地理院だけで作る）

// 取りやめ（signal）か時間切れ（ms）で止まる signal
function withTimeout(signal, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(new DOMException('timeout', 'TimeoutError')), ms);
  signal?.addEventListener('abort', () => ctrl.abort(signal.reason), { once: true });
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

/** 中心 center から radius m の四角 */
export function bboxAround(center, radius) {
  const dLat = radius / 111320, dLon = radius / (111320 * Math.cos(center[1] * RAD));
  return { s: center[1] - dLat, w: center[0] - dLon, n: center[1] + dLat, e: center[0] + dLon };
}

async function overpass(bbox, signal) {
  const b = `${bbox.s.toFixed(5)},${bbox.w.toFixed(5)},${bbox.n.toFixed(5)},${bbox.e.toFixed(5)}`;
  const q = `[out:json][timeout:90];way["highway"](${b})->.r;(.r;.r>;);out body qt;`
    + `(way["landuse"~"^(residential|retail|commercial|recreation_ground|cemetery|education|forest)$"](${b});way["leisure"~"^(park|playground|pitch|garden)$"](${b});way["natural"="wood"](${b}););out tags geom qt;`;
  let lastErr;
  const until = Date.now() + OVERPASS_TOTAL;
  for (const url of OVERPASS) {
    const left = until - Date.now();
    if (left < 5e3) break;
    const t = withTimeout(signal, Math.min(OVERPASS_WAIT, left));
    try {
      const r = await fetch(url, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: t.signal });
      if (!r.ok) throw new Error(`Overpass ${r.status}`);
      const j = await r.json();
      if (j.remark && /error|timed out/i.test(j.remark)) throw new Error(j.remark); // 途中で打ち切られた答え
      return j;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    } finally {
      t.done();
    }
  }
  throw lastErr ?? new Error('Overpass の待ち時間切れ');
}

// 国土地理院の道路中心線だけで道を作る（Overpass が使えないとき）。線は交差点で切れていて端の点を共有するので、
// 同じ座標（1e-6 度に丸める）を同じ交差点とみなす。高速道路・有料道路は歩けないので除く。
// 種類: 通常部 → 道路の種類（国道 → primary、都道府県道 → secondary、ほか → residential）、庭園路（公園の道）→ footway、
// 徒歩道（地形図の山道・田畑の小道）→ path（山道・階段の段階になる）、石段 → steps
export function gsiRoads(features) {
  const ids = new Map(), elements = [];
  let nid = -1, wid = -1;
  const nodeOf = ([lon, lat]) => {
    const x = Math.round(lon * 1e6), y = Math.round(lat * 1e6), k = `${x},${y}`;
    let id = ids.get(k);
    if (!id) { id = nid--; ids.set(k, id); elements.push({ type: 'node', id, lon: x / 1e6, lat: y / 1e6 }); }
    return id;
  };
  for (const ft of features) {
    const p = ft.properties ?? {}, g = ft.geometry;
    if (!g || p.rdCtg === '高速自動車国道等' || p.tollSect === '有料') continue;
    const hw = p.type === '庭園路' ? 'footway' : p.type === '徒歩道' ? 'path' : p.type === '石段' ? 'steps'
      : p.type !== '通常部' ? null : p.rdCtg === '国道' ? 'primary' : p.rdCtg === '都道府県道' ? 'secondary' : 'residential';
    if (!hw) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    for (const l of lines) {
      const nodes = l.map(nodeOf).filter((n, i, a) => i === 0 || n !== a[i - 1]);
      if (nodes.length >= 2) elements.push({ type: 'way', id: wid--, nodes, tags: { highway: hw, ...(p.name ? { name: p.name } : {}) } });
    }
  }
  return elements;
}

// 地理院のタイルを 6 本ずつ並べて取る。無いタイル（海・国外）は null
async function fetchTiles(list, url, parse, onOne, signal) {
  const out = new Map();
  const todo = list.slice();
  const worker = async () => {
    for (let t; (t = todo.shift());) {
      try {
        const r = await fetch(url(...t), { signal });
        out.set(`${t[0]},${t[1]}`, r.ok ? await parse(r) : null);
      } catch (e) {
        if (signal?.aborted) throw e;
        out.set(`${t[0]},${t[1]}`, null); // 道幅・標高が無くても道順は作れる
      }
      onOne();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

// 地理院の標高 PNG → Float32Array（m、値なしは NaN）
async function demPng(r) {
  const bmp = await createImageBitmap(await r.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(256, 256) : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  const d = g.getImageData(0, 0, 256, 256).data;
  const a = new Float32Array(256 * 256);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const x = d[i] * 65536 + d[i + 1] * 256 + d[i + 2];
    a[p] = x === 8388608 ? NaN : (x > 8388608 ? x - 16777216 : x) * 0.01;
  }
  return a;
}

/**
 * center のまわり radius m の道の網を作る。onProgress(0..1, 何をしているか)
 * 返り値は data/graph.json と同じ形
 */
export async function loadArea(center, radius, { onProgress, signal } = {}) {
  const bbox = bboxAround(center, radius);
  const rdTiles = tilesOf(bbox, 16), demTiles = tilesOf(bbox, 14);
  const total = 1 + rdTiles.length + demTiles.length;
  let done = 0;
  const tick = (what) => onProgress?.(Math.min(0.99, ++done / total), what);
  onProgress?.(0, '道を読み込んでいます');
  // 3 つを同時に取る（Overpass がいちばん時間がかかる。使えなければ null）
  const [osm, rd, dem] = await Promise.all([
    overpass(bbox, signal).catch((e) => { if (signal?.aborted) throw e; console.warn('Overpass が使えない', e); return null; }).then((j) => { tick('道を読み込みました'); return j; }),
    fetchTiles(rdTiles, (x, y) => `https://cyberjapandata.gsi.go.jp/xyz/experimental_rdcl/16/${x}/${y}.geojson`, (r) => r.json(), () => tick('道幅を読み込んでいます'), signal),
    fetchTiles(demTiles, (x, y) => `https://cyberjapandata.gsi.go.jp/xyz/dem_png/14/${x}/${y}.png`, demPng, () => tick('高さを読み込んでいます'), signal),
  ]);
  onProgress?.(0.99, '道の網を作っています');
  await new Promise((r) => setTimeout(r, 0));
  const rdcl = [];
  for (const j of rd.values()) if (j?.features) rdcl.push(...j.features);
  let roads = [];
  const areas = [];
  if (osm) for (const e of osm.elements) (e.type === 'way' && e.geometry ? areas : roads).push(e);
  const source = osm ? 'osm' : 'gsi';
  if (!osm) roads = gsiRoads(rdcl);
  if (!roads.length) throw new Error('この場所の道のデータがありません');
  const demMap = new Map([...dem].filter(([, a]) => a));
  const { graph } = buildGraph({ osm: roads, areas, rdcl, elev: elevFromTiles(demMap), bbox, center, osmBase: osm?.osm3s?.timestamp_osm_base ?? '' });
  graph.source = source;
  onProgress?.(1, '');
  return graph;
}
