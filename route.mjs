// 道の網（data/graph.json）と、出発地に戻る輪の道順づくり
//  - 区間の重み = 長さ × 安全さの重み（build-graph.mjs の cost）。同じ区間をもう一度通るときは重くする（行って戻るだけの道順を避ける）
//  - 輪の作り方: 出発地を通る円を考え、円の上に中継点を 2〜3 個置いて「出発地 → 中継点 → … → 出発地」を順に探す。
//    円の向きを 8 方向に変え、長さが目標に合うまで円の大きさを直す。安全さ・長さの合い方・同じ道の重なりで点を付けて並べる

const RAD = Math.PI / 180, R = 6371008;

export class Graph {
  constructor(j) {
    this.j = j;
    this.center = j.center;
    this.bbox = j.bbox;
    this.classes = j.classes;
    this.kx = Math.cos(j.center[1] * RAD) * RAD * R;
    this.ky = RAD * R;
    const n = j.nodes.length / 2;
    this.n = n;
    this.lon = new Float64Array(n); this.lat = new Float64Array(n);
    this.x = new Float64Array(n); this.y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.lon[i] = j.nodes[i * 2] / 1e6; this.lat[i] = j.nodes[i * 2 + 1] / 1e6;
      this.x[i] = (this.lon[i] - j.center[0]) * this.kx; this.y[i] = (this.lat[i] - j.center[1]) * this.ky;
    }
    const E = j.edges;
    this.m = E.a.length;
    this.ea = Int32Array.from(E.a); this.eb = Int32Array.from(E.b);
    this.len = Float64Array.from(E.len); this.cls = Uint8Array.from(E.cls); this.cost = Float64Array.from(E.cost);
    this.up = Float64Array.from(E.up); this.down = Float64Array.from(E.down);
    this.name = E.name; this.names = j.names; this.geom = E.g;
    // つながり（CSR）
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < this.m; e++) { deg[this.ea[e] + 1]++; deg[this.eb[e] + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    this.adjStart = deg;
    this.adjEdge = new Int32Array(this.m * 2);
    const fill = deg.slice(0, n);
    for (let e = 0; e < this.m; e++) { this.adjEdge[fill[this.ea[e]]++] = e; this.adjEdge[fill[this.eb[e]]++] = e; }
    // 交差点ごとの「いちばん安全な区間の段階」（中継点はよい道の上に置く）
    this.bestCls = new Uint8Array(n).fill(9);
    for (let e = 0; e < this.m; e++) for (const v of [this.ea[e], this.eb[e]]) this.bestCls[v] = Math.min(this.bestCls[v], this.cls[e]);
  }

  inside(lon, lat) { const b = this.bbox; return lon > b.w && lon < b.e && lat > b.s && lat < b.n; }
  /** 範囲 box がこの道の網の範囲に収まるか */
  covers(box) { const b = this.bbox; return box.w >= b.w && box.e <= b.e && box.s >= b.s && box.n <= b.n; }
  toXY(lon, lat) { return [(lon - this.center[0]) * this.kx, (lat - this.center[1]) * this.ky]; }
  toLonLat(x, y) { return [x / this.kx + this.center[0], y / this.ky + this.center[1]]; }

  /** いちばん近い交差点（maxCls 以下の段階の道に面したものだけ）。距離 m も返す */
  nearestNode(lon, lat, maxCls = 9) {
    const [px, py] = this.toXY(lon, lat);
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.bestCls[i] > maxCls) continue;
      const d = (this.x[i] - px) ** 2 + (this.y[i] - py) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return { node: best, dist: Math.sqrt(bd) };
  }

  /** 区間の形 [[lon, lat], ...]（fwd = a → b の向き） */
  coordsOf(e, fwd = true) {
    const a = this.ea[e], b = this.eb[e], g = this.geom[e];
    const out = [[this.lon[a], this.lat[a]]];
    let x = Math.round(this.lon[a] * 1e6), y = Math.round(this.lat[a] * 1e6);
    for (let i = 0; i < g.length; i += 2) { x += g[i]; y += g[i + 1]; out.push([x / 1e6, y / 1e6]); }
    out.push([this.lon[b], this.lat[b]]);
    return fwd ? out : out.reverse();
  }

  /** 最も重みの小さい道（A*）。weight(e) は 1 m あたりの重み × 長さ。返り値: [{ e, fwd }] */
  shortest(src, dst, weight) {
    if (src === dst) return [];
    const n = this.n;
    const g = new Float64Array(n).fill(Infinity), via = new Int32Array(n).fill(-1);
    const closed = new Uint8Array(n);
    const heap = new MinHeap();
    const h = (v) => Math.hypot(this.x[v] - this.x[dst], this.y[v] - this.y[dst]); // 重みは 1 m あたり 1 以上なので距離は下回る
    g[src] = 0; heap.push(src, h(src));
    while (heap.size) {
      const v = heap.pop();
      if (closed[v]) continue;
      if (v === dst) break;
      closed[v] = 1;
      for (let k = this.adjStart[v]; k < this.adjStart[v + 1]; k++) {
        const e = this.adjEdge[k];
        const u = this.ea[e] === v ? this.eb[e] : this.ea[e];
        if (closed[u]) continue;
        const nd = g[v] + weight(e);
        if (nd < g[u]) { g[u] = nd; via[u] = e; heap.push(u, nd + h(u)); }
      }
    }
    if (via[dst] < 0) return null;
    const path = [];
    for (let v = dst; v !== src;) { const e = via[v]; const fwd = this.eb[e] === v; path.push({ e, fwd }); v = fwd ? this.ea[e] : this.eb[e]; }
    return path.reverse();
  }
}

class MinHeap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    const k = this.k, p = this.p; let i = k.length; k.push(key); p.push(pri);
    while (i > 0) { const j = (i - 1) >> 1; if (p[j] <= pri) break; k[i] = k[j]; p[i] = p[j]; i = j; }
    k[i] = key; p[i] = pri;
  }
  pop() {
    const k = this.k, p = this.p, top = k[0], lk = k.pop(), lp = p.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && p[c + 1] < p[c]) c++; if (p[c] >= lp) break; k[i] = k[c]; p[i] = p[c]; i = c; }
      k[i] = lk; p[i] = lp;
    }
    return top;
  }
}

const REUSE = 4; // もう一度通る区間の重みの倍率

// 円の向き heading（ラジアン）・半径 r m で 1 つ輪を作る
function tryLoop(G, start, heading, r, nWay) {
  const cx = G.x[start] + r * Math.cos(heading), cy = G.y[start] + r * Math.sin(heading);
  const pts = [start];
  for (let k = 1; k <= nWay; k++) {
    const a = heading + Math.PI + k * 2 * Math.PI / (nWay + 1);
    const [lon, lat] = G.toLonLat(cx + r * Math.cos(a), cy + r * Math.sin(a));
    let { node, dist } = G.nearestNode(lon, lat, 2);
    if (dist > Math.max(250, r * 0.6)) node = G.nearestNode(lon, lat).node;
    if (node !== pts[pts.length - 1]) pts.push(node);
  }
  pts.push(start);
  const used = new Map(); // 区間 → 通った回数
  const weight = (e) => G.len[e] * G.cost[e] * (used.has(e) ? REUSE : 1);
  const path = [];
  for (let i = 1; i < pts.length; i++) {
    const leg = G.shortest(pts[i - 1], pts[i], weight);
    if (!leg) return null;
    for (const s of leg) { used.set(s.e, (used.get(s.e) ?? 0) + 1); path.push(s); }
  }
  return summarize(G, trimSpurs(G, path));
}

// 中継点で行き止まりに入って同じ道を引き返す「ひげ」を取る（…→ X → Y → X →… の Y を除く）
function trimSpurs(G, path) {
  const out = [];
  for (const s of path) {
    const last = out[out.length - 1];
    if (last && last.e === s.e && last.fwd !== s.fwd) { out.pop(); continue; }
    out.push(s);
  }
  return out;
}

function summarize(G, path) {
  let len = 0, up = 0, down = 0, wcost = 0, dup = 0;
  const byClass = [0, 0, 0, 0, 0];
  const seen = new Set();
  for (const { e, fwd } of path) {
    const L = G.len[e];
    len += L; wcost += L * G.cost[e];
    byClass[G.cls[e]] += L;
    up += fwd ? G.up[e] : G.down[e]; down += fwd ? G.down[e] : G.up[e];
    if (seen.has(e)) dup += L; else seen.add(e);
  }
  return { path, len, up, down, byClass, avgCost: len ? wcost / len : 9, overlap: len ? dup / len : 1, edges: seen };
}

/**
 * 出発地 start（交差点の番号）から targetM m 歩いて戻る輪の候補を、よい順に返す
 * onProgress(0..1) で進み具合を知らせる（重くないが、画面が止まらないように合間を空ける）
 */
export async function makeLoops(G, start, targetM, { onProgress, seed = Math.random() } = {}) {
  const nWay = targetM < 1800 ? 2 : 3;
  const H = 8;
  const found = [];
  for (let h = 0; h < H; h++) {
    const heading = (seed + h / H) * 2 * Math.PI;
    let r = targetM / (2 * Math.PI * 1.25);
    let best = null;
    for (let it = 0; it < 4; it++) {
      const res = tryLoop(G, start, heading, r, nWay);
      if (!res || res.len < 50) { r *= 1.3; continue; }
      const ratio = res.len / targetM;
      res.lenErr = Math.abs(ratio - 1);
      if (!best || res.lenErr < best.lenErr) best = res;
      if (res.lenErr < 0.06) break;
      r *= Math.pow(1 / ratio, 0.9);
    }
    if (best) {
      // 点（小さいほどよい）: 安全さの重み（1 m あたり）＋ 長さのずれ ＋ 同じ道の重なり
      best.score = best.avgCost + 3 * Math.max(0, best.lenErr - 0.04) + 1.5 * best.overlap;
      found.push(best);
    }
    onProgress?.((h + 1) / H);
    await new Promise((r) => setTimeout(r, 0));
  }
  found.sort((a, b) => a.score - b.score);
  // ほとんど同じ道順は 1 つにまとめる
  const out = [];
  for (const c of found) {
    if (out.some((o) => { let s = 0; for (const e of c.edges) if (o.edges.has(e)) s += G.len[e]; return s / c.len > 0.7; })) continue;
    out.push(c);
  }
  return out;
}

/** 道順の形（[lon, lat] の並び）と、段階が同じ続きごとの線 */
export function routeGeometry(G, route) {
  const coords = [], runs = [];
  let cur = null;
  for (const { e, fwd } of route.path) {
    const c = G.coordsOf(e, fwd), cls = G.cls[e];
    coords.push(...(coords.length ? c.slice(1) : c));
    if (!cur || cur.cls !== cls) { cur = { cls, coords: [c[0]] }; runs.push(cur); }
    cur.coords.push(...c.slice(1));
  }
  return { coords, runs };
}

/** 道順の上で、いまいる所に近い点までの距離（m）。道順から離れているときは off に離れた距離 */
export class Progress {
  constructor(G, coords) {
    this.G = G;
    this.xy = coords.map(([lon, lat]) => G.toXY(lon, lat));
    this.cum = [0];
    for (let i = 1; i < this.xy.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(this.xy[i][0] - this.xy[i - 1][0], this.xy[i][1] - this.xy[i - 1][1]));
    this.total = this.cum[this.cum.length - 1];
    this.last = 0;
  }
  locate(lon, lat) {
    const [px, py] = this.G.toXY(lon, lat);
    // 前の位置より先（少しだけ戻りも見る）を優先する。輪なので出発地の近くでは始めと終わりが重なるため
    const near = this.#search(px, py, Math.max(0, this.last - 30), this.xy.length - 1);
    const best = near.d < 40 ? near : this.#search(px, py, 0, this.xy.length - 1);
    if (best.d < 60) this.last = best.i;
    return { along: best.along, remain: Math.max(0, this.total - best.along), off: best.d };
  }
  #search(px, py, i0, i1) {
    let best = { d: Infinity, along: 0, i: i0 };
    for (let i = i0; i < i1; i++) {
      const [ax, ay] = this.xy[i], [bx, by] = this.xy[i + 1];
      const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
      const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / L2)) : 0;
      const d = Math.hypot(ax + vx * t - px, ay + vy * t - py);
      if (d < best.d - 0.5) best = { d, along: this.cum[i] + Math.sqrt(L2) * t, i };
    }
    return best;
  }
}
