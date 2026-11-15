// Builds the opening globe's picture: an equirectangular relief map of the whole Earth.
// Source: Mapzen/AWS Terrarium tiles (public AWS Open Data; land relief and ocean depth).
//
//   node scripts/build-globe.mjs [--fetch]              public/data/globe.png, 2048×1024 from zoom 3 (64 tiles, ~3 MB)
//   node scripts/build-globe.mjs --hd [--fetch]         public/data/globe-hd.webp, 4096×2048 from zoom 4 (256 tiles, ~12 MB)
//
// Without --fetch nothing is downloaded: the script reports the missing tiles and stops. --hd needs ffmpeg (WebP encoding).
//
// The picture is baked in the app's palette: deep navy sea that lightens toward the shelves, warm grey land, hill-shaded.
// Alpha carries the sea mask (255 sea, 224 land) so the globe shader can add a glint on water only.
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

import { execFileSync } from 'node:child_process';

const fetchMissing = process.argv.includes('--fetch');
const HD = process.argv.includes('--hd');
const Z = HD ? 4 : 3;
const N = 2 ** Z;
const cacheDir = path.resolve('.cache/tiles');
fs.mkdirSync(cacheDir, { recursive: true });
const file = (x, y) => path.join(cacheDir, `${Z}_${x}_${y}.png`);
const URL_OF = (x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${x}/${y}.png`;

const missing = [];
for (let x = 0; x < N; x++) for (let y = 0; y < N; y++) if (!fs.existsSync(file(x, y))) missing.push([x, y]);
console.log(`globe: ${N * N} tiles at zoom ${Z} (${missing.length} missing)`);
if (missing.length && !fetchMissing) {
  console.log(`  not downloading; re-run with --fetch to get ${missing.length} tiles from AWS Open Data`);
  process.exit(0);
}
for (const [x, y] of missing) {
  const res = await fetch(URL_OF(x, y));
  if (!res.ok) throw new Error(`${res.status} for tile ${Z}/${x}/${y}`);
  fs.writeFileSync(file(x, y), Buffer.from(await res.arrayBuffer()));
}

// Stitch the Web-Mercator tiles into one height grid.
const M = N * 256;
const merc = new Float32Array(M * M);
for (let tx = 0; tx < N; tx++) {
  for (let ty = 0; ty < N; ty++) {
    const png = PNG.sync.read(fs.readFileSync(file(tx, ty)));
    for (let j = 0; j < 256; j++) {
      for (let i = 0; i < 256; i++) {
        const k = (j * 256 + i) * 4;
        merc[(ty * 256 + j) * M + tx * 256 + i] = png.data[k] * 256 + png.data[k + 1] + png.data[k + 2] / 256 - 32768;
      }
    }
  }
}
const mercAt = (fx, fy) => {
  const x = Math.min(M - 1.001, Math.max(0, fx)), y = Math.min(M - 1.001, Math.max(0, fy));
  const x0 = Math.floor(x), y0 = Math.floor(y), ax = x - x0, ay = y - y0;
  const a = merc[y0 * M + x0], b = merc[y0 * M + x0 + 1], c = merc[(y0 + 1) * M + x0], d = merc[(y0 + 1) * M + x0 + 1];
  return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
};

// Resample to equirectangular (Mercator stops at ±85.05°; the caps repeat the last row).
const W = HD ? 4096 : 2048, H = W / 2;
const height = new Float32Array(W * H);
for (let j = 0; j < H; j++) {
  const lat = 90 - ((j + 0.5) / H) * 180;
  const r = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * M;
  for (let i = 0; i < W; i++) height[j * W + i] = mercAt(((i + 0.5) / W) * M, fy);
}

const lerp = (a, b, t) => a + (b - a) * t;
const mix3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const smooth = (a, b, x) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const out = new PNG({ width: W, height: H });
const kmPerPx = (40075 / W) * 1000; // metres per pixel along the equator
for (let j = 0; j < H; j++) {
  const lat = 90 - ((j + 0.5) / H) * 180;
  const cosLat = Math.max(0.12, Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < W; i++) {
    const k = j * W + i;
    const h = height[k];
    const at = (di, dj) => height[Math.min(H - 1, Math.max(0, j + dj)) * W + ((i + di + W) % W)];
    // Light from the north-west, relief exaggerated so the ranges read at globe scale.
    const gx = (at(1, 0) - at(-1, 0)) / (2 * kmPerPx * cosLat);
    const gy = (at(0, 1) - at(0, -1)) / (2 * kmPerPx);
    // Finer pixels see steeper local slopes: soften the shading as the resolution rises, so both read alike.
    const shade = Math.max(-1, Math.min(1, (-gx * 0.7 - gy * 0.7) * 26 * Math.sqrt(2048 / W)));
    let c;
    let sea = h < 0;
    if (sea) {
      const d = smooth(0, 4200, -h);
      c = mix3([22, 62, 82], [4, 10, 18], Math.pow(d, 0.55));
      c = c.map((v) => v * (1 + shade * 0.12));
    } else {
      const lo = smooth(0, 900, h), hi = smooth(900, 5200, h);
      c = mix3(mix3([58, 60, 52], [96, 88, 72], lo), [150, 142, 128], hi);
      const lit = 1 + shade * 0.55;
      c = c.map((v) => v * lit);
    }
    const o = k * 4;
    out.data[o] = Math.max(0, Math.min(255, Math.round(c[0])));
    out.data[o + 1] = Math.max(0, Math.min(255, Math.round(c[1])));
    out.data[o + 2] = Math.max(0, Math.min(255, Math.round(c[2])));
    out.data[o + 3] = sea ? 255 : 224;
  }
}
if (!HD) {
  const target = path.resolve('public/data/globe.png');
  fs.writeFileSync(target, PNG.sync.write(out, { colorType: 6, deflateLevel: 9 }));
  console.log(`wrote ${target} (${(fs.statSync(target).size / 1048576).toFixed(2)} MB)`);
} else {
  // The large picture ships as lossy WebP with alpha (the sea mask): a PNG this size would weigh several megabytes.
  const tmp = path.resolve('.cache/globe-hd.png');
  fs.writeFileSync(tmp, PNG.sync.write(out, { colorType: 6, deflateLevel: 3 }));
  const target = path.resolve('public/data/globe-hd.webp');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', tmp, '-c:v', 'libwebp', '-pix_fmt', 'yuva420p', '-quality', '84', '-compression_level', '6', target]);
  console.log(`wrote ${target} (${(fs.statSync(target).size / 1048576).toFixed(2)} MB)`);
}
