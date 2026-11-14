// Builds public/data/<site>/terrain.{bin,json}: Mapzen/AWS Terrarium tiles stitched into one Int16 height grid
// cropped to the site's AOI (see src/sites.ts).
//
//   node scripts/build-terrain.mjs <site|all>            report which tiles are missing, download nothing
//   node scripts/build-terrain.mjs <site|all> --fetch    download the missing tiles first (public AWS Open Data)
//
// Tiles are cached in .cache/tiles/. Source: https://registry.opendata.aws/terrain-tiles/
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { SITES } from './terrain-sites.mjs';

const args = process.argv.slice(2);
const fetchMissing = args.includes('--fetch');
const which = args.find((a) => !a.startsWith('--'));
if (!which) throw new Error('usage: node scripts/build-terrain.mjs <site|all> [--fetch]');
const targets = which === 'all' ? SITES : SITES.filter((s) => s.id === which);
if (!targets.length) throw new Error(`unknown site "${which}" (${SITES.map((s) => s.id).join(', ')})`);

const cacheDir = path.resolve('.cache/tiles');
fs.mkdirSync(cacheDir, { recursive: true });
const URL_OF = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

for (const site of targets) {
  const { aoi, zoom: Z } = site;
  const n = 2 ** Z;
  const tx = (lon) => ((lon + 180) / 360) * n;
  const ty = (lat) => {
    const r = (lat * Math.PI) / 180;
    return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
  };
  const x0 = tx(aoi.west), x1 = tx(aoi.east), y0 = ty(aoi.north), y1 = ty(aoi.south);
  const W = Math.round((x1 - x0) * 256), H = Math.round((y1 - y0) * 256);

  const need = [];
  for (let x = Math.floor(x0); x <= Math.floor(x1); x++) for (let y = Math.floor(y0); y <= Math.floor(y1); y++) need.push([x, y]);
  const file = (x, y) => path.join(cacheDir, `${Z}_${x}_${y}.png`);
  const missing = need.filter(([x, y]) => !fs.existsSync(file(x, y)));
  console.log(`${site.id}: ${W}×${H} px, ${need.length} tiles (${missing.length} missing)`);

  if (missing.length && !fetchMissing) {
    console.log(`  not downloading; re-run with --fetch to get ${missing.length} tiles from AWS Open Data`);
    continue;
  }
  for (const [x, y] of missing) {
    const res = await fetch(URL_OF(Z, x, y));
    if (!res.ok) throw new Error(`${res.status} for tile ${Z}/${x}/${y}`);
    fs.writeFileSync(file(x, y), Buffer.from(await res.arrayBuffer()));
  }

  const cache = new Map();
  const tile = (x, y) => {
    const key = `${x}_${y}`;
    if (!cache.has(key)) cache.set(key, PNG.sync.read(fs.readFileSync(file(x, y))));
    return cache.get(key);
  };
  const sample = (gx, gy) => {
    const x = Math.floor(gx), y = Math.floor(gy);
    const png = tile(x, y);
    const px = Math.min(255, Math.floor((gx - x) * 256));
    const py = Math.min(255, Math.floor((gy - y) * 256));
    const i = (py * 256 + px) * 4;
    return png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
  };

  const heights = new Int16Array(W * H);
  let min = Infinity, max = -Infinity;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const h = Math.round(sample(x0 + (i + 0.5) / 256, y0 + (j + 0.5) / 256));
      heights[j * W + i] = h;
      if (h < min) min = h;
      if (h > max) max = h;
    }
  }
  // Remove isolated DEM spikes/pits: a cell far outside the range of its 8 neighbours is replaced by their median.
  let despiked = 0;
  const src = heights.slice();
  for (let j = 2; j < H - 2; j++) {
    for (let i = 2; i < W - 2; i++) {
      const k = j * W + i;
      const nb = [];
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) if (di || dj) nb.push(src[k + dj * W + di]);
      nb.sort((a, b) => a - b);
      const med = Math.round((nb[11] + nb[12]) / 2);
      if (Math.abs(src[k] - med) > 700) {
        heights[k] = med;
        despiked++;
      }
    }
  }
  min = Infinity;
  max = -Infinity;
  for (let k = 0; k < heights.length; k++) {
    if (heights[k] < min) min = heights[k];
    if (heights[k] > max) max = heights[k];
  }
  if (despiked) console.log(`  despiked ${despiked} cells`);

  const midLat = ((aoi.north + aoi.south) / 2) * (Math.PI / 180);
  const metersPerPixel = (40075016.686 * Math.cos(midLat)) / (n * 256);

  const out = path.resolve('public/data', site.id);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'terrain.bin'), Buffer.from(heights.buffer));
  fs.writeFileSync(
    path.join(out, 'terrain.json'),
    JSON.stringify(
      {
        width: W, height: H, metersPerPixel, min, max, aoi,
        source: `Mapzen/AWS Terrarium tiles z${Z} (AWS Open Data terrain-tiles)`,
      },
      null,
      2,
    ),
  );
  console.log(`  wrote public/data/${site.id}/terrain.bin (${(heights.byteLength / 1e6).toFixed(1)} MB) · ${min}…${max} m · ${metersPerPixel.toFixed(0)} m/px`);
}
