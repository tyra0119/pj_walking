// 地形の立体: 国土地理院の標高タイル（DEM10B、10 m 間隔）を MapLibre の地形にする（BusTracker の web/terrain.mjs から）。
// 地理院の標高 PNG は MapLibre の形式（Terrarium）と違うので、読み込むときに変換する（wkdem://）。
// 道順の線は MapLibre の層なので、地形の上に自動で乗る

const TILE = 256;
const GSI_DEM = 'cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png';
export const DEM_MAX_ZOOM = 14;
export const DEM_CREDIT = '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noopener">地理院タイル（標高）</a>';

// 地理院の値 → 標高 m（海などの「値なし」は null）
function gsiHeight(r, g, b) {
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return null;
  return (x > 8388608 ? x - 16777216 : x) * 0.01;
}
function makeCanvas() {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(TILE, TILE);
  const c = document.createElement('canvas');
  c.width = c.height = TILE;
  return c;
}
async function canvasToPng(canvas) {
  const blob = canvas.convertToBlob ? await canvas.convertToBlob({ type: 'image/png' }) : await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return blob.arrayBuffer();
}

let flatTile = null;
function getFlatTile() {
  if (!flatTile) {
    const canvas = makeCanvas();
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'rgb(128,0,0)'; // Terrarium で 0 m
    ctx.fillRect(0, 0, TILE, TILE);
    flatTile = canvasToPng(canvas);
  }
  return flatTile;
}

// 地形用と陰影用の 2 つの source が同じタイルを読むので、取得と変換は 1 回にして使い回す
const MAX_TILES = 200;
const done = new Map();    // url → 変換した PNG
const pending = new Map(); // url → { promise, ctrl, refs }

// 変換は別のスレッド（web/dem-worker.js）で行う（スマホで地図のスクロールが重かった。2026-10-15）。
// OffscreenCanvas が使えないブラウザや、別のスレッドでうまくいかなかったときは、ここで変換する
let worker = null, workerOk = typeof OffscreenCanvas !== 'undefined' && 'convertToBlob' in OffscreenCanvas.prototype && typeof Worker !== 'undefined';
let seq = 0;
const waiting = new Map(); // id → { resolve, reject }
function getWorker() {
  if (!workerOk) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./dem-worker.js?v=e14aad4-10152305', import.meta.url));
      worker.onmessage = (ev) => { const w = waiting.get(ev.data.id); if (!w) return; waiting.delete(ev.data.id); w.resolve(ev.data); };
      worker.onerror = () => { workerOk = false; for (const w of waiting.values()) w.resolve({ error: 'worker' }); waiting.clear(); };
    } catch { workerOk = false; return null; }
  }
  return worker;
}
async function loadTile(url, signal) {
  const w = getWorker();
  if (w) {
    const id = ++seq;
    const r = await new Promise((resolve, reject) => {
      waiting.set(id, { resolve });
      signal.addEventListener('abort', () => { waiting.delete(id); w.postMessage({ cancel: id }); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
      w.postMessage({ id, url });
    });
    if (r.buf) return r.buf;
    if (r.status === 404) return getFlatTile();
    if (r.status) throw new Error(`標高タイル ${r.status} ${url}`);
    workerOk = false; // 別のスレッドで変換できなかった: 以後はここで
  }
  return loadTileHere(url, signal);
}
async function loadTileHere(url, signal) {
  const res = await fetch(url, { signal });
  // 平らなタイルにするのは「タイルが無い」（404）ときだけ。一時的な失敗は失敗のまま返す（MapLibre が取り直す）
  if (res.status === 404) return getFlatTile();
  if (!res.ok) throw new Error(`標高タイル ${res.status} ${url}`);
  const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = makeCanvas();
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const img = ctx.getImageData(0, 0, TILE, TILE);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const h = gsiHeight(d[i], d[i + 1], d[i + 2]) ?? 0;
    const v = h + 32768, whole = Math.floor(v);
    d[i] = whole >> 8; d[i + 1] = whole & 255; d[i + 2] = Math.floor((v - whole) * 256); d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasToPng(canvas);
}

maplibregl.addProtocol('wkdem', async (params, abort) => {
  const url = params.url.replace('wkdem://', 'https://');
  // MapLibre は受け取った ArrayBuffer を処理用のスレッドへ渡して使えなくするので、写しを返す
  if (done.has(url)) { const buf = done.get(url); done.delete(url); done.set(url, buf); return { data: buf.slice(0) }; }
  let e = pending.get(url);
  if (!e) {
    const ctrl = new AbortController();
    e = { ctrl, refs: 0, promise: null };
    e.promise = loadTile(url, ctrl.signal).then((buf) => {
      done.set(url, buf);
      if (done.size > MAX_TILES) done.delete(done.keys().next().value);
      return buf;
    }).finally(() => { if (pending.get(url) === e) pending.delete(url); });
    pending.set(url, e);
  }
  e.refs++;
  const onAbort = () => { if (--e.refs <= 0) { if (pending.get(url) === e) pending.delete(url); e.ctrl.abort(); } };
  abort.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return { data: (await e.promise).slice(0) };
  } finally {
    abort.signal.removeEventListener('abort', onAbort);
  }
});

/** 地形の元（MapLibre の source）。地形用と陰影用は別にする（同じだと MapLibre が警告し、陰影が粗くなる） */
// maxzoom を下げると標高は粗くなるが、読むタイルは 1/4 ずつ減る（スマホは 13）
export const demSource = (maxzoom = DEM_MAX_ZOOM) => ({
  type: 'raster-dem', tiles: [`wkdem://${GSI_DEM}`], tileSize: TILE, minzoom: 1, maxzoom, encoding: 'terrarium', attribution: DEM_CREDIT,
});

// 引いて見るほど山は平たく見えるので、縮尺が小さいときは高さを強める（縮尺 13 以上は 1.3 倍）
export const exaggerationFor = (z) => 1.3 * Math.min(4, Math.max(1, 2 ** ((13 - z) / 1.5)));
