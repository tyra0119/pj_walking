// あんしん散歩道: スタート地点と歩く時間を決めると、なるべく安全な道を通ってスタートに戻る道順を作る
import { Graph, makeLoops, routeGeometry, Progress } from './route.mjs?v=1412f2f-10152140';
import { demSource, exaggerationFor } from './terrain.mjs?v=1412f2f-10152140';
import { loadArea, bboxAround } from './area-loader.mjs?v=1412f2f-10152140';

const $ = (id) => document.getElementById(id);
const COLORS = ['#16a34a', '#2563eb', '#ca8a04', '#ea580c', '#dc2626'];
const CLASS_NOTE = ['歩道・遊歩道・公園の道', '幅 5.5 m 以上の道。歩道がある見込みが高い', '車の少ない住宅地の道', '歩道の無い狭い車道・抜け道', '舗装されていない山道・階段'];
const MINUTES = [15, 20, 30, 45, 60, 90];
const CENTER = [135.195, 34.865];
const narrow = () => innerWidth <= 720;
const load = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const save = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 使えなくてもよい */ } };

let G = null;              // いま使っている道の網
const graphs = [];         // 読み込んだ道の網（最初は上津台。ほかの場所はスタートのまわりをその場で読む）
let minutes = +load('wk.min', 30);
let speed = +load('wk.speed', 4.5);
let start = null;          // { lon, lat }（道の網の中なら近くの交差点に寄せた位置）
let routes = [], idx = 0;  // 作った道順の候補と、いま出している番号
let geom = null;           // いまの道順の形
let walking = false, progress = null, arrived = false;
let me = null;             // 現在地 { lon, lat, acc }
let watchId = null;

// ---------- 地図 ----------
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  center: CENTER, zoom: 15.2, pitch: 50, bearing: -15,
  minZoom: 11, maxZoom: 19, maxPitch: 70,
  pitchWithRotate: true, // 右ドラッグで回転と傾き
  attributionControl: { compact: true, customAttribution: '道: © OpenStreetMap contributors、国土地理院' },
});
window.wkMap = map; // 確かめる用（開発者ツールから）
// 開いたときに画面が隠れていて大きさ 0 だと、描画域が 400×300 のまま残ることがあった（2026-10-15）。大きさが変わったら合わせ直す
new ResizeObserver(() => map.resize()).observe($('map'));
// 指 2 本の拡大・縮小と回転は、指のあいだを中心に（MapLibre の標準）。2 本そろえて上下で傾き（touchPitch、標準）

// 地名は日本語で（CARTO の地図は英語名を出すことがある）
function japaneseLabels() {
  for (const l of map.getStyle().layers) {
    if (l.type !== 'symbol') continue;
    const tf = map.getLayoutProperty(l.id, 'text-field');
    if (tf && /name/.test(JSON.stringify(tf))) map.setLayoutProperty(l.id, 'text-field', ['coalesce', ['get', 'name:ja'], ['get', 'name'], ['get', 'name_en']]);
  }
}

function arrowImage() {
  const s = 48, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath(); g.moveTo(16, 12); g.lineTo(32, 24); g.lineTo(16, 36);
  g.strokeStyle = 'rgba(17,24,39,0.55)'; g.lineWidth = 11; g.stroke();
  g.strokeStyle = '#ffffff'; g.lineWidth = 6; g.stroke();
  return g.getImageData(0, 0, s, s);
}

const EMPTY = { type: 'FeatureCollection', features: [] };
map.on('load', () => {
  japaneseLabels();
  // 出典は「i」にたたんでおく（狭い画面で地図の下を大きく覆っていた）
  document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
  const layers = map.getStyle().layers;
  // CARTO の地図は、海の名前（symbol）が道路（line）より前にあるので、「最後の道路より後の、最初の名前」の下に描く
  // （最初の symbol の下に描くと、道路の白い線に隠れていた）
  const lastLine = layers.findLastIndex((l) => l.type === 'line');
  const firstSymbol = layers.find((l, i) => i > lastLine && l.type === 'symbol')?.id;
  const firstLine = layers.find((l) => l.type === 'line' || l.type === 'symbol')?.id;
  // 地形の立体と陰影（国土地理院の標高）
  map.addSource('dem', demSource());
  map.addSource('dem-shade', demSource());
  map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem-shade', paint: {
    'hillshade-exaggeration': 0.35, 'hillshade-shadow-color': '#5b6670', 'hillshade-highlight-color': '#ffffff', 'hillshade-accent-color': '#5b6670', 'hillshade-illumination-anchor': 'map',
  } }, firstLine);
  map.setTerrain({ source: 'dem', exaggeration: exaggerationFor(map.getZoom()) });
  // 3D の建物（CARTO の建物の高さ）
  if (map.getSource('carto')) {
    map.addLayer({
      id: 'bldg-3d', type: 'fill-extrusion', source: 'carto', 'source-layer': 'building', minzoom: 14,
      filter: ['!=', ['get', 'hide_3d'], true],
      paint: {
        'fill-extrusion-color': '#d6dbe2',
        'fill-extrusion-height': ['interpolate', ['linear'], ['zoom'], 14, 0, 15, ['coalesce', ['get', 'render_height'], 6]],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
        'fill-extrusion-opacity': 0.85,
      },
    }, firstSymbol);
  }
  const colorExpr = ['match', ['get', 'cls'], 0, COLORS[0], 1, COLORS[1], 2, COLORS[2], 3, COLORS[3], COLORS[4]];
  // まわりの道の色分け（確かめる用）
  map.addSource('net', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'net', type: 'line', source: 'net', layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' }, paint: {
    'line-color': colorExpr, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 1.5, 17, 5], 'line-opacity': 0.75,
  } }, firstSymbol);
  // 道順
  map.addSource('route', { type: 'geojson', data: EMPTY });
  map.addSource('route-all', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'route-casing', type: 'line', source: 'route-all', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
    'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 7, 17, 16],
  } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: {
    'line-color': colorExpr, 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 4, 17, 10],
  } });
  map.addImage('arrow', arrowImage(), { pixelRatio: 2 });
  map.addLayer({ id: 'route-arrows', type: 'symbol', source: 'route-all', minzoom: 14, layout: {
    'symbol-placement': 'line', 'symbol-spacing': ['interpolate', ['linear'], ['zoom'], 14, 70, 18, 140], 'icon-image': 'arrow',
    'icon-size': ['interpolate', ['linear'], ['zoom'], 14, 0.7, 18, 1.2], 'icon-allow-overlap': true, 'icon-ignore-placement': true, 'icon-rotation-alignment': 'map',
  } });
  updateNet();
});
map.on('zoom', () => { if (map.getTerrain()) map.terrain.exaggeration = exaggerationFor(map.getZoom()); });

// ---------- 地図のボタン（右下に縦に。上から 方角・現在地・拡大・縮小） ----------
const ICON = {
  compass: '<svg viewBox="0 0 24 24"><path d="M12 2.5l4 9.5h-8z" fill="#dc2626"/><path d="M12 21.5l-4-9.5h8z" fill="#9ca3af"/></svg>',
  locate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/><circle cx="12" cy="12" r="8"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  minus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg>',
};
class MapButtons {
  onAdd() {
    const div = document.createElement('div');
    div.className = 'maplibregl-ctrl wk-ctrl';
    div.innerHTML = `<button type="button" class="one compass" title="北を上に（真上から）" aria-label="北を上に">${ICON.compass}</button>
      <button type="button" class="one locate" title="現在地" aria-label="現在地">${ICON.locate}</button>
      <div class="pair"><button type="button" class="zin" title="拡大" aria-label="拡大">${ICON.plus}</button><button type="button" class="zout" title="縮小" aria-label="縮小">${ICON.minus}</button></div>`;
    const needle = div.querySelector('.compass svg');
    const turn = () => { needle.style.transform = `rotateX(${map.getPitch()}deg) rotate(${-map.getBearing()}deg)`; };
    map.on('rotate', turn); map.on('pitch', turn); turn();
    div.querySelector('.compass').onclick = () => map.easeTo({ bearing: 0, pitch: 0, duration: 600 });
    div.querySelector('.locate').onclick = () => locateMe();
    div.querySelector('.zin').onclick = () => map.zoomIn();
    div.querySelector('.zout').onclick = () => map.zoomOut();
    this.locateBtn = div.querySelector('.locate');
    return div;
  }
  onRemove() {}
}
const buttons = new MapButtons();
map.addControl(buttons, 'bottom-right');

// ---------- 現在地 ----------
const meEl = document.createElement('div');
meEl.className = 'me';
const meMarker = new maplibregl.Marker({ element: meEl });
const waiters = [];
function startWatch() {
  if (watchId !== null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition((p) => {
    me = { lon: p.coords.longitude, lat: p.coords.latitude, acc: p.coords.accuracy };
    meMarker.setLngLat([me.lon, me.lat]).addTo(map);
    buttons.locateBtn?.classList.add('on');
    while (waiters.length) waiters.shift()(me);
    onPosition();
  }, (err) => {
    while (waiters.length) waiters.shift()(null);
    if (err.code === err.PERMISSION_DENIED) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
function getPosition(timeout = 8000) {
  if (me) return Promise.resolve(me);
  if (!navigator.geolocation) return Promise.resolve(null);
  startWatch();
  return new Promise((res) => { waiters.push(res); setTimeout(() => res(me), timeout); });
}
// 現在地を画面の中ほどに。取れないとき（屋内・許可なし）は、歩いている道順の位置かスタート地点
async function locateMe() {
  const p = await getPosition();
  if (p) { map.easeTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 16), duration: 700, offset: centerOffset() }); return; }
  if (start) {
    map.easeTo({ center: [start.lon, start.lat], duration: 700, offset: centerOffset() });
    toast('現在地が分からないので、スタート地点を出しました');
  }
}

// ---------- スタート地点 ----------
const pinEl = document.createElement('div');
pinEl.className = 'pin';
pinEl.title = 'スタート地点（動かせます）';
pinEl.innerHTML = '<svg viewBox="0 0 34 44"><path d="M17 1C8.2 1 1 8 1 16.6 1 28 17 43 17 43s16-15 16-26.4C33 8 25.8 1 17 1z" fill="#15803d" stroke="#fff" stroke-width="2"/><text x="17" y="21" text-anchor="middle" font-size="11" font-weight="700" fill="#fff" font-family="sans-serif">S</text></svg>';
const pin = new maplibregl.Marker({ element: pinEl, anchor: 'bottom', draggable: true });
pin.on('dragend', () => { const p = pin.getLngLat(); setStart(p.lng, p.lat); });

// スタートはどこにでも置ける（利用者の指定。2026-10-15）。読み込んだ道の網の中なら近くの交差点に寄せ、
// 外なら置いた所のまま。道順を作るときに、まわりの道を読み込む（ensureGraph）
let labelSeq = 0;
async function setStart(lon, lat, { quiet = false } = {}) {
  if (walking) stopWalking();
  const g = graphs.find((x) => x.inside(lon, lat));
  if (g) {
    const { node, dist } = g.nearestNode(lon, lat, 3);
    if (dist <= 150) { lon = g.lon[node]; lat = g.lat[node]; }
  }
  start = { lon, lat };
  pin.setLngLat([lon, lat]).addTo(map);
  clearRoute();
  $('startLabel').textContent = '選んだ地点';
  const seq = ++labelSeq;
  const name = await placeName(lon, lat);
  if (seq === labelSeq) $('startLabel').textContent = name ? `${name} 付近` : '選んだ地点';
  if (!quiet && !narrow()) map.easeTo({ center: [lon, lat], duration: 500, offset: centerOffset() });
}
// 道順に要る広さ（m）: 輪の円は半径 D ÷ 2π ÷ 1.25 ほど。中継点は出発地から円の直径まで離れ、長さの調整で円が大きくなることもある
const needRadius = (D) => 2.3 * D / (2 * Math.PI * 1.25) + 350;
let loading = null;
// スタートのまわり radius m を覆う道の網を使う。無ければ読み込む
async function ensureGraph(radius, onProgress) {
  const box = bboxAround([start.lon, start.lat], radius);
  const g = graphs.find((x) => x.covers(box));
  if (g) { useGraph(g); return g; }
  loading?.abort();
  loading = new AbortController();
  const j = await loadArea([start.lon, start.lat], radius * 1.15, { onProgress, signal: loading.signal });
  const ng = new Graph(j);
  if (j.source === 'gsi') toast('OpenStreetMap が混んでいて読めなかったので、国土地理院の道だけで作りました（歩道や小道は少なめです）');
  graphs.push(ng);
  if (graphs.length > 4) graphs.splice(1, 1); // 上津台（最初の 1 つ）は残し、古いものから捨てる
  useGraph(ng);
  return ng;
}
function useGraph(g) {
  if (G === g) return;
  G = g;
  netData = null;
  updateNet();
}
// 町名（国土地理院の逆ジオコーダ）
async function placeName(lon, lat) {
  try {
    const r = await fetch(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat.toFixed(6)}&lon=${lon.toFixed(6)}`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    return j?.results?.lv01Nm?.trim() || '';
  } catch { return ''; }
}
// 地図をタップするとスタートをそこへ（道順を出していても。案内の途中だけは動かさない）
map.on('click', (e) => {
  if (walking) { toast('案内の途中です。スタートを変えるときは「案内をやめる」を押してください'); return; }
  setStart(e.lngLat.lng, e.lngLat.lat);
});
$('btnHere').onclick = async () => {
  $('btnHere').disabled = true;
  const p = await getPosition();
  $('btnHere').disabled = false;
  if (!p) { toast('現在地が分かりませんでした（位置情報の許可を確かめてください）'); return; }
  setStart(p.lon, p.lat);
  map.easeTo({ center: [p.lon, p.lat], duration: 600, offset: centerOffset() });
};

// ---------- 時間・速さ ----------
for (const m of MINUTES) {
  const b = document.createElement('button');
  b.type = 'button'; b.role = 'radio'; b.textContent = `${m}分`; b.dataset.m = m;
  b.onclick = () => { minutes = m; save('wk.min', m); syncMinutes(); clearRoute(); };
  $('minutes').append(b);
}
function syncMinutes() { for (const b of $('minutes').children) b.setAttribute('aria-checked', String(+b.dataset.m === minutes)); }
if (!MINUTES.includes(minutes)) minutes = 30;
syncMinutes();
$('speed').value = String(speed);
if (!$('speed').value) { speed = 4.5; $('speed').value = '4.5'; }
$('speed').onchange = (e) => { speed = +e.target.value; save('wk.speed', speed); if (routes.length) showRoute(); };
const metersPerMin = () => speed * 1000 / 60;

// ---------- 道順を作る ----------
$('btnMake').onclick = async () => {
  if (!start) return;
  const btn = $('btnMake');
  const D = minutes * metersPerMin();
  btn.disabled = true;
  btn.textContent = '道順を作っています…';
  let found = [];
  try {
    const g = await ensureGraph(needRadius(D), (f) => { btn.textContent = `まわりの道を読み込んでいます… ${Math.round(f * 100)}%`; });
    const { node, dist } = g.nearestNode(start.lon, start.lat, 3);
    if (node < 0 || dist > 300) { toast('スタートの近くに歩ける道がありません。道の上に置いてください'); return; }
    // 道の上に寄せる（ピンも動かす）
    start = { lon: g.lon[node], lat: g.lat[node], node };
    pin.setLngLat([start.lon, start.lat]);
    btn.textContent = '道順を作っています…';
    found = await makeLoops(g, node, D, { onProgress: (f) => { btn.textContent = `道順を作っています… ${Math.round(f * 100)}%`; } });
  } catch (e) {
    if (e?.name !== 'AbortError') { console.error(e); toast('まわりの道を読み込めませんでした。少し待ってからもう一度押してください'); }
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = found.length ? '道順を作り直す' : '道順を作る';
  }
  if (!found.length) { toast('道順を作れませんでした。スタート地点を変えてみてください'); return; }
  routes = found;
  fixedZoom = null;
  idx = 0;
  showRoute(true);
};
// 別の道順: 縮尺は変えず、道順の真ん中へ動かすだけ
// （前は押すたびにその道順の広さに合わせ直していて、押すたびに引いていくように見えた。2026-10-15 利用者の指摘）
$('btnNext').onclick = () => {
  if (!routes.length) return;
  idx = (idx + 1) % routes.length;
  if (walking) stopWalking();
  showRoute(false);
  fitRoute();
};

function showRoute(fit = false) {
  const r = routes[idx];
  geom = routeGeometry(G, r);
  map.getSource('route')?.setData({ type: 'FeatureCollection', features: geom.runs.map((run) => ({ type: 'Feature', properties: { cls: run.cls }, geometry: { type: 'LineString', coordinates: run.coords } })) });
  map.getSource('route-all')?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: geom.coords } });
  $('result').hidden = false;
  $('rDist').textContent = (r.len / 1000).toFixed(1);
  $('rTime').textContent = Math.round(r.len / metersPerMin());
  $('rUp').textContent = Math.round(r.up);
  $('rIdx').textContent = routes.length > 1 ? `${idx + 1}/${routes.length}` : '';
  $('btnNext').disabled = routes.length < 2;
  const pct = r.byClass.map((v) => v / r.len * 100);
  $('rBar').innerHTML = pct.map((p, i) => (p > 0 ? `<i style="width:${p}%;background:${COLORS[i]}" title="${G.classes[i]} ${Math.round(p)}%"></i>` : '')).join('');
  $('rLegend').innerHTML = pct.map((p, i) => (p >= 0.5 ? `<li style="--c:${COLORS[i]}">${G.classes[i]} <span>${Math.round(p)}%</span></li>` : '')).join('');
  progress = new Progress(G, geom.coords);
  arrived = false;
  $('startHint').textContent = '地図をタップするか、ピンを動かすとスタートが変わります';
  // 狭い画面: 欄をたたんで結果だけにし、高さが決まってから道順に合わせる
  if (fit && narrow()) { $('panel').classList.add('folded'); syncFold(); measureSheet(); }
  if (fit) requestAnimationFrame(fitRoute);
  updateNet();
}
function clearRoute() {
  routes = []; idx = 0; geom = null; progress = null;
  map.getSource('route')?.setData(EMPTY);
  map.getSource('route-all')?.setData(EMPTY);
  $('result').hidden = true;
  $('btnMake').textContent = '道順を作る';
  $('startHint').textContent = '地図のどこでもタップするか、ピンを動かして決めます';
  updateNet();
  measureSheet();
}
// 道順に合わせる。縮尺は「候補のうちいちばん広いものが収まる大きさ」にそろえ、位置だけをいまの道順の真ん中にする
// （候補をまとめた範囲に合わせると、四方に広がるので引きすぎた）
let fixedZoom = null;
function routeBounds(r) {
  const b = new maplibregl.LngLatBounds();
  for (const { e } of r.path) for (const c of G.coordsOf(e)) b.extend(c);
  return b;
}
function fitRoute() {
  if (!routes.length) return;
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
  const opt = { padding: mapPadding(), bearing: map.getBearing() };
  if (fixedZoom === null) fixedZoom = Math.min(17, ...routes.map((r) => map.cameraForBounds(routeBounds(r), opt)?.zoom ?? 17));
  const cam = map.cameraForBounds(routeBounds(routes[idx]), opt);
  if (!cam) return;
  map.easeTo({ center: cam.center, zoom: fixedZoom, bearing: map.getBearing(), pitch: map.getPitch(), duration: 800 });
}
// 操作の欄に隠れない範囲（fitBounds の余白）
function mapPadding() {
  const sheet = $('panel').getBoundingClientRect();
  if (narrow()) return { top: 50, bottom: sheet.height + 30, left: 30, right: 70 };
  return { top: 50, bottom: 50, left: sheet.right + 40, right: 80 };
}
// 地点を「操作の欄に隠れない部分の真ん中」に出すための、中心からのずれ（easeTo の offset）。
// padding を使うと地図に余白が残り、あとの fitBounds の余白に足されるので使わない
function centerOffset() {
  const sheet = $('panel').getBoundingClientRect();
  return narrow() ? [0, -sheet.height / 2] : [sheet.right / 2, 0];
}

// ---------- 歩く ----------
$('btnWalk').onclick = () => { if (walking) stopWalking(); else startWalking(); };
async function startWalking() {
  if (!progress) return;
  walking = true;
  $('btnWalk').setAttribute('aria-pressed', 'true');
  $('btnWalk').textContent = '案内をやめる';
  $('walkInfo').hidden = false;
  $('walkInfo').textContent = '現在地を探しています…';
  if (narrow()) { $('panel').classList.add('folded'); syncFold(); }
  const p = await getPosition(15000);
  if (!walking) return;
  if (!p) { $('walkInfo').textContent = '現在地が分かりません。位置情報の許可を確かめてください'; return; }
  map.easeTo({ center: [p.lon, p.lat], zoom: 17, pitch: 55, duration: 900, offset: centerOffset() });
  onPosition();
}
function stopWalking() {
  walking = false;
  $('btnWalk').removeAttribute('aria-pressed');
  $('btnWalk').textContent = '歩きはじめる';
  $('walkInfo').hidden = true;
}
let lastFollow = 0, userMovedAt = 0;
map.on('dragstart', () => { userMovedAt = Date.now(); });
function onPosition() {
  if (!walking || !progress || !me) return;
  const s = progress.locate(me.lon, me.lat);
  const mins = Math.round(s.remain / metersPerMin());
  if (!arrived && s.along > progress.total * 0.7 && s.remain < 40) arrived = true;
  let html;
  if (arrived) html = '<b>おかえりなさい</b><br>スタート地点に戻りました';
  else if (s.off > 60) html = `道順から <b>${Math.round(s.off)}</b> m 離れています。色の付いた道に戻ってください`;
  else html = `あと <b>${(s.remain / 1000).toFixed(1)}</b> km（約 ${mins} 分）<br><small>ここまで ${(s.along / 1000).toFixed(1)} km</small>`;
  $('walkInfo').innerHTML = html;
  // 地図を動かした直後（20 秒）は追いかけない
  if (Date.now() - userMovedAt > 20000 && Date.now() - lastFollow > 3000 && !map.isMoving()) {
    lastFollow = Date.now();
    map.easeTo({ center: [me.lon, me.lat], duration: 800, offset: centerOffset() });
  }
}

// ---------- まわりの道の色分け ----------
let netData = null;
$('showNet').checked = load('wk.net', '0') === '1';
$('showNet').onchange = (e) => { save('wk.net', e.target.checked ? '1' : '0'); updateNet(); };
function updateNet() {
  if (!map.getLayer('net') || !G) return;
  const on = $('showNet').checked;
  if (on && !netData) {
    const features = [];
    for (let e = 0; e < G.m; e++) features.push({ type: 'Feature', properties: { cls: G.cls[e] }, geometry: { type: 'LineString', coordinates: G.coordsOf(e) } });
    netData = { type: 'FeatureCollection', features };
    map.getSource('net').setData(netData);
  }
  map.setLayoutProperty('net', 'visibility', on ? 'visible' : 'none');
  map.setPaintProperty('net', 'line-opacity', routes.length ? 0.35 : 0.75);
}

// ---------- 画面の部品 ----------
let toastTimer = 0;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, Math.max(3500, msg.length * 120));
}
function legendHtml(big) {
  return COLORS.map((c, i) => `<li style="--c:${c}"><b>${G ? G.classes[i] : ''}</b>${big ? `：${CLASS_NOTE[i]}` : ''}</li>`).join('');
}
$('btnHelp').onclick = () => { $('helpLegend').innerHTML = legendHtml(true); $('dlgHelp').showModal(); };
$('btnSources').onclick = () => $('dlgSources').showModal();
// 狭い画面: 下の欄の高さだけ、地図のボタンを上げる。たためる
function measureSheet() {
  document.documentElement.style.setProperty('--sheet-h', narrow() ? `${$('panel').getBoundingClientRect().height}px` : '0px');
}
new ResizeObserver(measureSheet).observe($('panel'));
addEventListener('resize', measureSheet);
function syncFold() {
  const f = $('panel').classList.contains('folded');
  $('btnFold').textContent = f ? '▴' : '▾';
  $('btnFold').setAttribute('aria-expanded', String(!f));
  $('btnFold').setAttribute('aria-label', f ? 'ひらく' : 'たたむ');
}
$('btnFold').onclick = () => { $('panel').classList.toggle('folded'); syncFold(); };

// ---------- 上津台の道の網を読む（前もって作ったもの。ほかの場所はスタートを置いて道順を作るときに読み込む） ----------
(async () => {
  try {
    const r = await fetch('./data/graph.json?v=1412f2f-10152140');
    const g = new Graph(await r.json());
    graphs.unshift(g);
    useGraph(g);
    if (g.j.osmBase) $('osmDate').textContent = `（上津台は ${g.j.osmBase.slice(0, 10)} 時点、ほかの場所は開いた時点）`;
  } catch (e) {
    console.error(e); // 無くても、まわりの道をその場で読み込めば使える
  }
  if (!start) setStart(CENTER[0], CENTER[1], { quiet: true });
})();
