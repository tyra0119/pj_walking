// 歩ける道の網（交差点で区切った区間）を作る。上津台の分は scripts/build-graph.mjs が前もって作り（data/graph.json）、
// ほかの場所はブラウザで集めたデータから web/area-loader.mjs がその場で作る（2026-10-15 利用者「スタート位置は自由に設定できること」）
//  - 道の形とつながり: OpenStreetMap
//  - 道幅の区分・庭園路: 国土地理院の道路中心線を、近くて向きが同じ線に合わせて写す
//  - 上り下り: 国土地理院の標高（elev(lon, lat) で渡す）
// 上津台のあたりの OSM には「歩道あり」（sidewalk）がほとんど書かれていない（2026-10-15 に数えて 0.03 km）ので、
// 道の種類（OSM）と道幅（地理院）から安全さの段階（cls）を見積もる。段階の決め方は classify() と vault/データソース.md

const RAD = Math.PI / 180, R = 6371008;

// 0 歩行者の道（歩道・遊歩道・公園の道） 1 広い道（幅 5.5 m 以上の幹線。歩道がある見込みが高い） 2 住宅地の道（車が少ない）
// 3 車に注意（歩道の無い狭い車道・抜け道・駐車場の中） 4 山道・階段
export const CLASSES = ['歩行者の道', '広い道', '住宅地の道', '車に注意', '山道・階段'];

const ROADS = new Set(['primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'trunk', 'trunk_link',
  'unclassified', 'residential', 'living_street', 'road', 'service', 'footway', 'pedestrian', 'path', 'steps', 'track', 'cycleway']);
const NO = new Set(['no', 'private']);
const PAVED = new Set(['asphalt', 'paved', 'concrete', 'concrete:plates', 'concrete:lanes', 'paving_stones', 'sett', 'metal', 'wood', 'compacted', 'fine_gravel']);
function walkable(t) {
  if (!ROADS.has(t.highway)) return false;
  if (NO.has(t.foot)) return false;
  if (NO.has(t.access) && !['yes', 'designated', 'permissive'].includes(t.foot)) return false;
  if (t.area === 'yes' || t.indoor === 'yes' || t.level && t.level !== '0') return false;
  return true;
}
const WIDTH_RANK = { '3m未満': 1, '3m-5.5m未満': 2, '5.5m-13m未満': 3, '13m-19.5m未満': 4, '19.5m以上': 5 };
// OSM の yh:WIDTH（Yahoo のデータを取り込んだときの道幅）。地理院で分からないときに使う
const YH_RANK = { '1.5m未満': 1, '1.5m〜3.0m': 1, '3.0m〜5.5m': 2, '5.5m〜13.0m': 3, '13.0m以上': 4 };
// 町の範囲の種類。舗装の書かれていない歩行者の小道が、公園の道か・住宅の中の小道か・山の中の小道かを見分ける
// （住宅の中を抜ける小道は防犯上よくないので住宅地の道にする。2026-10-15 利用者「住宅の中を歩くのは防犯上よろしくない」）
const AREA_KIND = {
  park: 'park', playground: 'park', pitch: 'park', garden: 'park', recreation_ground: 'park', cemetery: 'park',
  residential: 'home', commercial: 'town', retail: 'town', education: 'town',
};

// 段階ごとに classify() の重みへ掛ける倍率。住宅地の道より広い道を強く優先する（2026-10-15 利用者「住宅地の道より
// 広い道をもっと強く優先してほしい」「住宅の中を歩くのは防犯上よろしくない。安全で広い道優先にしてほしい」）。
// 上津台の 5 地点で比べた道順の広い道: 1 倍 30 分 53%・60 分 77% → 2 倍 80%・87% → 3 倍 82%・90% → 4 倍 82%・93%
// （中継点を広い道に寄せるのとあわせて。web/route.mjs の WAYPOINT）。3 倍で残る住宅地の道（30 分 9%・60 分 5%）は大半が
// 住宅地の中の出発地から広い道へ出るまでと戻るまで。4 倍は長さの目標からのずれ（60 分 7% → 9%）が増えるだけなので 3 倍
const CLASS_WEIGHT = [1, 1, 3, 3, 3];

// cost はその段階の道を 1 m 歩く重み（小さいほど選ばれやすい。ここに CLASS_WEIGHT を掛ける）
// area: 道のある所の種類（'park' 公園など・'home' 住宅地・'town' 店や学校・null 町の外か森）
function classify(t, w, area) {
  const hw = t.highway, paved = PAVED.has(t.surface);
  const rank = w.rank || YH_RANK[t['yh:WIDTH']] || 0;
  if (hw === 'steps') return [4, 3.0];
  if (hw === 'footway' || hw === 'pedestrian' || hw === 'cycleway') {
    // 歩道・横断歩道・歩行者の広場・公園の道は歩行者の道。住宅地の中の小道（家と家の間を抜ける道）は住宅地の道。
    // ほかは舗装・地理院の地図にも載っている・照明があれば歩行者の道、どれでもないものは山の中の小道が多い
    if (['sidewalk', 'crossing'].includes(t.footway) || hw === 'pedestrian' || w.park || area === 'park') return [0, 1.0];
    if (area === 'home') return [2, 1.6];
    if (paved || w.matched || t.lit === 'yes') return [0, 1.0];
    if (area) return [0, 1.1];
    return [4, 3.5];
  }
  if (hw === 'path') {
    if (w.park || area === 'park') return [0, 1.1];
    if (area === 'home') return [2, 1.6];
    return paved || area ? [0, 1.1] : [4, 4.0];
  }
  if (hw === 'track') return paved ? [3, 2.4] : [4, 4.0];
  if (hw === 'service') return rank >= 3 ? [2, 1.5] : [3, 2.2];
  if (['residential', 'living_street', 'road', 'unclassified'].includes(hw)) {
    if (rank >= 4) return [1, 1.1];
    if (rank === 3) return [2, 1.35];
    // 町の外の生活道路（抜け道。歩道が無いことが多い）。住宅地の中の unclassified は住宅地の道と同じに見る
    // （上津台では住宅地の道の約半分が unclassified で書かれていて、「車に注意」になっていた。2026-10-15）
    if (hw === 'unclassified' && !area) return [3, rank === 2 ? 2.2 : 2.6];
    if (rank === 1) return [3, 2.2];
    return [2, 1.6];
  }
  // 県道・市道の幹線（tertiary 以上）
  if (rank && rank <= 2) return [3, 2.6]; // 幹線なのに狭い: 車が多く歩道が無い
  return [1, hw.startsWith('primary') || hw.startsWith('trunk') ? 1.15 : 1.1];
}

/**
 * @param osm   OSM の要素（Overpass の elements。道の way と、その node）
 * @param areas 町と森の範囲（Overpass の out geom の way・relation）
 * @param rdcl  国土地理院の道路中心線の GeoJSON の feature の並び
 * @param elev  (lon, lat) → 標高 m
 * @returns { graph, stat }（graph は data/graph.json と同じ形）
 */
export function buildGraph({ osm, areas = [], rdcl = [], elev = () => 0, bbox, center, osmBase = '' }) {
  const KX = Math.cos(center[1] * RAD) * RAD * R, KY = RAD * R; // 度 → m（狭い範囲なので平面とみなす）
  const dist = (a, b) => Math.hypot((b[0] - a[0]) * KX, (b[1] - a[1]) * KY);

  // ---------- OSM ----------
  const nodeById = new Map();
  for (const e of osm) if (e.type === 'node') nodeById.set(e.id, [e.lon, e.lat]);
  const ways = osm.filter((e) => e.type === 'way' && e.tags && e.nodes && walkable(e.tags) && e.nodes.every((n) => nodeById.has(n)));

  // ---------- 地理院の道路中心線 ----------
  const gsiSegs = []; // [ax, ay, bx, by, rank, park]
  for (const ft of rdcl) {
    const p = ft.properties ?? {}, g = ft.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
    const rank = WIDTH_RANK[p.rnkWidth] ?? 0, park = p.type === '庭園路' ? 1 : 0;
    for (const l of lines) for (let i = 1; i < l.length; i++) gsiSegs.push([l[i - 1][0], l[i - 1][1], l[i][0], l[i][1], rank, park]);
  }
  // 近くの線を探す格子（約 30 m 角）
  const CELL = 30;
  const cellOf = (x, y) => `${Math.floor((x - center[0]) * KX / CELL)},${Math.floor((y - center[1]) * KY / CELL)}`;
  const grid = new Map();
  gsiSegs.forEach((s, i) => {
    const n = Math.max(1, Math.ceil(Math.hypot((s[2] - s[0]) * KX, (s[3] - s[1]) * KY) / (CELL / 2)));
    const cells = new Set();
    for (let k = 0; k <= n; k++) cells.add(cellOf(s[0] + (s[2] - s[0]) * k / n, s[1] + (s[3] - s[1]) * k / n));
    for (const c of cells) { if (!grid.has(c)) grid.set(c, []); grid.get(c).push(i); }
  });
  // 点 p（向き dir、単位ベクトル m 系）にいちばん近い、向きの近い地理院の線（12 m 以内・向きの差 35° 以内）
  const COS35 = Math.cos(35 * RAD);
  function nearestGsi(p, dir) {
    const cx = Math.floor((p[0] - center[0]) * KX / CELL), cy = Math.floor((p[1] - center[1]) * KY / CELL);
    let best = null, bd = 12;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        const s = gsiSegs[i];
        const ax = (s[0] - p[0]) * KX, ay = (s[1] - p[1]) * KY, bx = (s[2] - p[0]) * KX, by = (s[3] - p[1]) * KY;
        const vx = bx - ax, vy = by - ay, L = Math.hypot(vx, vy);
        if (L < 0.01) continue;
        if (Math.abs((vx * dir[0] + vy * dir[1]) / L) < COS35) continue;
        const t = Math.max(0, Math.min(1, -(ax * vx + ay * vy) / (L * L)));
        const d = Math.hypot(ax + vx * t, ay + vy * t);
        if (d < bd) { bd = d; best = s; }
      }
    }
    return best;
  }
  // 道（OSM の形）の 10 m ごとに地理院の線を探し、半分以上で見つかれば、いちばん多い道幅の区分を返す
  function matchWidth(coords) {
    const counts = {}; let samples = 0, hits = 0, park = 0;
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i], L = dist(a, b);
      if (L < 0.5) continue;
      const dir = [(b[0] - a[0]) * KX / L, (b[1] - a[1]) * KY / L];
      for (let d = Math.min(5, L / 2); d < L; d += 10) {
        const p = [a[0] + (b[0] - a[0]) * d / L, a[1] + (b[1] - a[1]) * d / L];
        samples++;
        const s = nearestGsi(p, dir);
        if (!s) continue;
        hits++; park += s[5];
        if (s[4]) counts[s[4]] = (counts[s[4]] ?? 0) + 1;
      }
    }
    if (!samples || hits / samples < 0.5) return { rank: 0, matched: false, park: false };
    const rank = +(Object.entries(counts).sort((x, y) => y[1] - x[1])[0]?.[0] ?? 0);
    return { rank, matched: true, park: park / hits >= 0.5 };
  }

  // ---------- 町と森の範囲 ----------
  const areaPolys = [], woodPolys = []; // areaPolys: { ...poly, kind }
  for (const e of areas) {
    const t = e.tags ?? {}, kind = t.landuse ?? t.leisure ?? t.natural;
    const rings = e.type === 'way' ? [e.geometry] : (e.members ?? []).filter((m) => m.role === 'outer' && m.geometry).map((m) => m.geometry);
    for (const g of rings) {
      if (!g || g.length < 4 || g[0].lat !== g[g.length - 1].lat || g[0].lon !== g[g.length - 1].lon) continue;
      const ring = g.map((p) => [p.lon, p.lat]);
      let w = Infinity, s = Infinity, ea = -Infinity, n = -Infinity;
      for (const [x, y] of ring) { if (x < w) w = x; if (x > ea) ea = x; if (y < s) s = y; if (y > n) n = y; }
      const poly = { ring, w, e: ea, s, n };
      if (kind === 'wood' || kind === 'forest') woodPolys.push(poly); else if (AREA_KIND[kind]) areaPolys.push({ ...poly, kind: AREA_KIND[kind] });
    }
  }
  function inPoly(p, poly) {
    if (p[0] < poly.w || p[0] > poly.e || p[1] < poly.s || p[1] > poly.n) return false;
    let inside = false;
    const r = poly.ring;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > p[1]) !== (r[j][1] > p[1]) && p[0] < (r[j][0] - r[i][0]) * (p[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
    }
    return inside;
  }
  // 道の真ん中あたりの点がある所の種類（公園 > 住宅地 > 店や学校の順に見る）。森の中・町の外は null
  const RANK = { park: 0, home: 1, town: 2 };
  const areaOf = (coords) => {
    const p = coords[Math.floor(coords.length / 2)];
    if (woodPolys.some((q) => inPoly(p, q))) return null;
    let best = null;
    for (const q of areaPolys) if ((best === null || RANK[q.kind] < RANK[best]) && inPoly(p, q)) best = q.kind;
    return best;
  };

  // ---------- 交差点で区切る ----------
  const useCount = new Map();
  for (const w of ways) w.nodes.forEach((n, i) => useCount.set(n, (useCount.get(n) ?? 0) + (i === 0 || i === w.nodes.length - 1 ? 2 : 1)));
  const nodeIdx = new Map(), nodes = [];
  const idxOf = (id) => { if (!nodeIdx.has(id)) { nodeIdx.set(id, nodes.length); nodes.push(nodeById.get(id)); } return nodeIdx.get(id); };
  const edges = [];
  const stat = { classes: [0, 0, 0, 0, 0], matched: 0, total: 0 };
  for (const w of ways) {
    const t = w.tags;
    const coordsAll = w.nodes.map((n) => nodeById.get(n));
    const wm = matchWidth(coordsAll);
    const [cls, cost0] = classify(t, wm, areaOf(coordsAll));
    const cost = cost0 * CLASS_WEIGHT[cls] * (t.lit === 'yes' && cls > 0 ? 0.95 : 1);
    let start = 0;
    for (let i = 1; i < w.nodes.length; i++) {
      if (i < w.nodes.length - 1 && (useCount.get(w.nodes[i]) ?? 0) < 2) continue;
      const ids = w.nodes.slice(start, i + 1);
      const coords = ids.map((n) => nodeById.get(n));
      let len = 0, up = 0, down = 0, prevH = elev(...coords[0]);
      for (let k = 1; k < coords.length; k++) {
        const L = dist(coords[k - 1], coords[k]);
        len += L;
        // 10 m ごとに標高を見て上り・下りを足す
        const steps = Math.max(1, Math.round(L / 10));
        for (let s = 1; s <= steps; s++) {
          const h = elev(coords[k - 1][0] + (coords[k][0] - coords[k - 1][0]) * s / steps, coords[k - 1][1] + (coords[k][1] - coords[k - 1][1]) * s / steps);
          if (h > prevH) up += h - prevH; else down += prevH - h;
          prevH = h;
        }
      }
      if (len > 0.2 && ids[0] !== ids[ids.length - 1]) {
        edges.push({ a: idxOf(ids[0]), b: idxOf(ids[ids.length - 1]), len, cls, cost, up, down, coords: coords.slice(1, -1), name: t.name ?? '' });
        stat.classes[cls] += len; stat.total += len; if (wm.matched) stat.matched += len;
      }
      start = i;
    }
  }

  // ---------- いちばん大きなつながりだけ残す（島のように切れた道は道順に使えない） ----------
  const adj = nodes.map(() => []);
  edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
  const comp = new Int32Array(nodes.length).fill(-1);
  let bestComp = -1, bestSize = 0;
  for (let s = 0, c = 0; s < nodes.length; s++) {
    if (comp[s] >= 0) continue;
    const stack = [s]; comp[s] = c; let size = 0;
    while (stack.length) { const v = stack.pop(); size++; for (const ei of adj[v]) { const e = edges[ei]; const u = e.a === v ? e.b : e.a; if (comp[u] < 0) { comp[u] = c; stack.push(u); } } }
    if (size > bestSize) { bestSize = size; bestComp = c; }
    c++;
  }
  const keepNode = new Int32Array(nodes.length).fill(-1);
  const outNodes = [];
  nodes.forEach((p, i) => { if (comp[i] === bestComp) { keepNode[i] = outNodes.length; outNodes.push(p); } });
  const outEdges = edges.filter((e) => comp[e.a] === bestComp);
  stat.dropped = edges.length - outEdges.length;

  // ---------- 書き出し（座標は 1e-6 度の整数。区間の途中の点は前の点からの差） ----------
  const q = (v) => Math.round(v * 1e6);
  const names = [''], nameIdx = new Map([['', 0]]);
  const E = { a: [], b: [], len: [], cls: [], cost: [], up: [], down: [], name: [], g: [] };
  for (const e of outEdges) {
    E.a.push(keepNode[e.a]); E.b.push(keepNode[e.b]);
    E.len.push(Math.round(e.len * 10) / 10); E.cls.push(e.cls); E.cost.push(Math.round(e.cost * 100) / 100);
    E.up.push(Math.round(e.up * 10) / 10); E.down.push(Math.round(e.down * 10) / 10);
    if (!nameIdx.has(e.name)) { nameIdx.set(e.name, names.length); names.push(e.name); }
    E.name.push(nameIdx.get(e.name));
    let px = q(outNodes[keepNode[e.a]][0]), py = q(outNodes[keepNode[e.a]][1]);
    const g = [];
    for (const c of e.coords) { const x = q(c[0]), y = q(c[1]); g.push(x - px, y - py); px = x; py = y; }
    E.g.push(g);
  }
  const graph = {
    generated: new Date().toISOString(), osmBase,
    bbox, center, classes: CLASSES,
    nodes: outNodes.flatMap((p) => [q(p[0]), q(p[1])]),
    edges: E, names,
  };
  return { graph, stat };
}

// ---------- 標高の引き方（地理院 dem、ズーム 14。tiles: "x,y" → Float32Array(256*256)、値なしは NaN） ----------
export function elevFromTiles(tiles, z = 14) {
  return (lon, lat) => {
    const n = 2 ** z, s = Math.sin(lat * RAD);
    const fx = (lon + 180) / 360 * n * 256 - 0.5, fy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * 256 - 0.5;
    const at = (px, py) => { const a = tiles.get(`${Math.floor(px / 256)},${Math.floor(py / 256)}`); return a ? a[(py % 256) * 256 + (px % 256)] : NaN; };
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const v = [at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)];
    if (v.some(Number.isNaN)) return v.find((q) => !Number.isNaN(q)) ?? 0;
    return (v[0] * (1 - tx) + v[1] * tx) * (1 - ty) + (v[2] * (1 - tx) + v[3] * tx) * ty;
  };
}

/** 範囲 bbox を覆うタイルの番号 [[x, y], ...] */
export function tilesOf(bbox, z) {
  const tx = (lon) => Math.floor((lon + 180) / 360 * 2 ** z);
  const ty = (lat) => { const s = Math.sin(lat * RAD); return Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z); };
  const out = [];
  for (let x = tx(bbox.w); x <= tx(bbox.e); x++) for (let y = ty(bbox.n); y <= ty(bbox.s); y++) out.push([x, y]);
  return out;
}
