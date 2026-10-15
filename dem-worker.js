// 国土地理院の標高 PNG → MapLibre の形式（Terrarium）への変換を、画面を描く処理とは別のスレッドで行う
// （スマホで地図のスクロールが重い。2026-10-15。画素ごとの変換と PNG の作り直しが、スクロール中に画面を止めていた）
// 受け取る: { id, url } または { cancel: id }。返す: { id, buf }（ArrayBuffer）か { id, status }（404 などのとき）か { id, error }
const TILE = 256;
const ctrls = new Map();

function gsiHeight(r, g, b) {
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return null;
  return (x > 8388608 ? x - 16777216 : x) * 0.01;
}

self.onmessage = async (ev) => {
  const { id, url, cancel } = ev.data;
  if (cancel !== undefined) { ctrls.get(cancel)?.abort(); ctrls.delete(cancel); return; }
  const ctrl = new AbortController();
  ctrls.set(id, ctrl);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) { self.postMessage({ id, status: res.status }); return; }
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = new OffscreenCanvas(TILE, TILE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const img = ctx.getImageData(0, 0, TILE, TILE);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const h = gsiHeight(d[i], d[i + 1], d[i + 2]) ?? 0;
      const v = h + 32768, whole = Math.floor(v);
      d[i] = whole >> 8; d[i + 1] = whole & 255; d[i + 2] = Math.floor((v - whole) * 256); d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const buf = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
    self.postMessage({ id, buf }, [buf]);
  } catch (e) {
    if (!ctrl.signal.aborted) self.postMessage({ id, error: String(e?.message ?? e) });
  } finally {
    ctrls.delete(id);
  }
};
