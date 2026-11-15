// Signal fields over the real terrain of one site.
//
// If a real NISAR GUNW raster was extracted (`public/data/<site>/gunw.*`, see scripts/fetch-gunw.py) it is used as is.
// Otherwise the signal is SYNTHETIC: a physically-motivated stand-in so the whole experience can be built and
// rehearsed. The interface labels which of the two is on screen.
import type { SiteDef } from './sites';
import { berlin } from './colormaps';

export interface TerrainMeta {
  width: number;
  height: number;
  metersPerPixel: number;
  min: number;
  max: number;
  aoi: { west: number; south: number; east: number; north: number };
  source: string;
}

// Real-data raster resampled to the terrain grid by scripts/fetch-gunw.py.
export interface RealSignal {
  los: Float32Array; // metres, positive = toward the satellite
  coh: Float32Array; // 0..1 coherence of the event pair
  dcoh?: Float32Array; // 0..1 coherence lost against a pre-event pair (flood sites)
}

export interface Fields {
  W: number;
  H: number;
  heights: Int16Array;
  los: Float32Array;
  coh: Float32Array;
  dcoh: Float32Array;
  packed: Uint16Array; // RGBA half floats: height, los, coherence, roughness
  packedChange: Uint16Array; // RG half floats: coherence lost, baked sun shadow (1 lit … 0 shadowed)
  losMin: number;
  losMax: number;
  sizeKm: [number, number];
  synthetic: boolean;
  range: number; // metres of line of sight mapped onto the colour scale
  lift: Float32Array; // the smoothed line of sight the relief rises by (see smoothLift)
  liftH: Uint16Array; // the same, as half floats for the GPU
  grid: Grid; // the slab's mesh, built here so a place switch never stalls the main thread
  thumb: { w: number; h: number; rgba: Uint8ClampedArray<ArrayBuffer> }; // the picker card's picture
}

// The picker card's picture: shaded relief lit from the north-west, with the real signal over it on the story's scale
// (coherence loss for the change sites, line of sight elsewhere). Built here: ten of these on the main thread would
// stutter the opening.
export function thumbOf(meta: TerrainMeta, heights: Int16Array, s: SiteDef, f: Pick<Fields, 'los' | 'coh' | 'dcoh' | 'range'>, real: boolean) {
  const w = 640, h = Math.round((640 * meta.height) / meta.width);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const step = meta.width / w;
  const at = (x: number, y: number) =>
    heights[Math.min(meta.height - 1, Math.max(0, Math.round(y * step))) * meta.width + Math.min(meta.width - 1, Math.max(0, Math.round(x * step)))];
  const mpp = meta.metersPerPixel * step;
  const change = s.kind === 'flood' || s.kind === 'volcano';
  const ve = change ? 2.2 : 3;
  const span = Math.max(1, meta.max);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const z = at(x, y);
      const dx = (at(x + 1, y) - at(x - 1, y)) / (2 * mpp), dy = (at(x, y + 1) - at(x, y - 1)) / (2 * mpp);
      const shade = Math.max(0, Math.min(1.4, 0.55 + (dx * 0.7 + dy * 0.7) * ve * 0.9));
      const o = (y * w + x) * 4;
      let r: number, gg: number, b: number;
      if (z <= 0) {
        const d = Math.min(1, -z / 1800);
        r = 6 - d * 4; gg = 16 - d * 8; b = 24 - d * 10;
      } else {
        const e = Math.min(1, z / span);
        r = (40 + 90 * e) * shade; gg = (34 + 78 * e) * shade; b = (28 + 64 * e) * shade;
      }
      if (real && z > 0) {
        const k = Math.min(meta.height - 1, Math.round(y * step)) * meta.width + Math.min(meta.width - 1, Math.round(x * step));
        if (change) {
          const a = Math.max(0, Math.min(1, (f.dcoh[k] - 0.15) / 0.4));
          r += (235 - r) * a * 0.9; gg += (105 - gg) * a * 0.9; b += (70 - b) * a * 0.9;
        } else if (f.coh[k] > 0.3) {
          const v = Math.max(-1, Math.min(1, f.los[k] / f.range));
          const a = Math.min(1, Math.abs(v) * 1.5) * 0.85;
          const m = Math.round(128 + v * 127) * 3;
          r += (berlin[m] - r) * a; gg += (berlin[m + 1] - gg) * a; b += (berlin[m + 2] - b) * a;
        }
      }
      rgba[o] = r; rgba[o + 1] = gg; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  return { w, h, rgba };
}

export interface Grid {
  pos: Float32Array;
  uv: Float32Array;
  index: Uint32Array;
}

// The slab mesh: a plane of segX × segZ cells on x/z (north at −z), with uv (0,0) at the north-west corner's top.
// It matches THREE.PlaneGeometry(SX, SZ, segX, segZ).rotateX(−π/2), without its normals (the shader makes its own).
export function gridOf(SX: number, SZ: number, segX: number, segZ: number): Grid {
  const nx = segX + 1, nz = segZ + 1;
  const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
  for (let iz = 0; iz < nz; iz++) {
    const z = -SZ / 2 + (iz / segZ) * SZ;
    for (let ix = 0; ix < nx; ix++) {
      const k = iz * nx + ix;
      pos[k * 3] = -SX / 2 + (ix / segX) * SX;
      pos[k * 3 + 2] = z;
      uv[k * 2] = ix / segX;
      uv[k * 2 + 1] = 1 - iz / segZ;
    }
  }
  const index = new Uint32Array(segX * segZ * 6);
  let o = 0;
  for (let iz = 0; iz < segZ; iz++)
    for (let ix = 0; ix < segX; ix++) {
      const a = iz * nx + ix, b = (iz + 1) * nx + ix, c = b + 1, d = a + 1;
      index[o++] = a; index[o++] = b; index[o++] = d;
      index[o++] = b; index[o++] = c; index[o++] = d;
    }
  return { pos, uv, index };
}

// The colour scale of a place: with a real signal it follows the data (never tighter than the site's own).
export const rangeOf = (site: SiteDef, synthetic: boolean, losMin: number, losMax: number) =>
  synthetic ? site.range : Math.max(site.range, 1.1 * Math.max(Math.abs(losMin), Math.abs(losMax)));

// The line of sight the ground rises by: clamped to the colour scale, weighted by coherence (untrustworthy pixels count
// for nothing) and smoothed by two box passes of (2r+1)² pixels with running sums (close to a gaussian). A four-times
// wider pass fills the gaps where too little nearby is coherent: an incoherent patch inside a sinking basin takes the
// basin's value instead of sticking up at zero. Runs in the field worker: on a large place it takes a few hundred ms.
export function smoothLift(los: Float32Array, coh: ArrayLike<number>, cohScale: number, W: number, H: number, range: number) {
  const n = W * H, lim = 1.4 * range;
  const r = Math.max(4, Math.round(Math.max(W, H) / 130));
  const num = new Float32Array(n), den = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const c = Math.min(1, Math.max(0, (coh[k] * cohScale - 0.22) / 0.23)), w = c * c * (3 - 2 * c);
    num[k] = Math.min(lim, Math.max(-lim, los[k])) * w;
    den[k] = w;
  }
  const t = new Float32Array(n);
  const blur = (a: Float32Array, R: number) => {
    for (let j = 0; j < H; j++) {
      let s = 0;
      const o = j * W;
      for (let i = -R; i <= R; i++) s += a[o + Math.min(W - 1, Math.max(0, i))];
      for (let i = 0; i < W; i++) {
        t[o + i] = s;
        s += a[o + Math.min(W - 1, i + R + 1)] - a[o + Math.max(0, i - R)];
      }
    }
    for (let i = 0; i < W; i++) {
      let s = 0;
      for (let j = -R; j <= R; j++) s += t[Math.min(H - 1, Math.max(0, j)) * W + i];
      for (let j = 0; j < H; j++) {
        a[j * W + i] = s;
        s += t[Math.min(H - 1, j + R + 1) * W + i] - t[Math.max(0, j - R) * W + i];
      }
    }
  };
  const numC = num.slice(), denC = den.slice();
  for (const a of [num, num, den, den]) blur(a, r);
  for (const a of [numC, numC, denC, denC]) blur(a, r * 4);
  const floor = (2 * r + 1) ** 4 * 0.3, floorC = (8 * r + 1) ** 4 * 0.05;
  const lift = new Float32Array(n), liftH = new Uint16Array(n);
  for (let k = 0; k < n; k++) {
    const broad = numC[k] / Math.max(denC[k], floorC); // where almost nothing is coherent even broadly, no lift
    const a = Math.min(1, den[k] / floor);
    const v = den[k] > 1e-6 ? broad + (num[k] / den[k] - broad) * a : broad;
    lift[k] = v;
    liftH[k] = toHalf(v);
  }
  return { lift, liftH };
}

// ---------- geometry ----------
// The terrain grid is Web-Mercator in y, so rows are not linear in latitude.
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latOfMercY = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * (180 / Math.PI);

export function makeMapper(aoi: TerrainMeta['aoi']) {
  const y0 = mercY(aoi.north), y1 = mercY(aoi.south);
  return {
    u: (lon: number) => (lon - aoi.west) / (aoi.east - aoi.west),
    v: (lat: number) => (y0 - mercY(lat)) / (y0 - y1),
    lonAt: (u: number) => aoi.west + u * (aoi.east - aoi.west),
    latAt: (v: number) => latOfMercY(y0 + v * (y1 - y0)),
  };
}

export function sizeKmOf(aoi: TerrainMeta['aoi']): [number, number] {
  const lat0 = (aoi.north + aoi.south) / 2;
  return [(aoi.east - aoi.west) * 111.32 * Math.cos((lat0 * Math.PI) / 180), (aoi.north - aoi.south) * 110.57];
}

// ---------- noise ----------
function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, oct = 4) {
  let s = 0, a = 0.5;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise(x, y);
    x = x * 2.03 + 17.1;
    y = y * 2.03 + 3.7;
    a *= 0.5;
  }
  return s;
}
const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// float32 → float16 bits (avoids pulling three.js into the worker).
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toHalf(v: number) {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  const m = x & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return sign;
    return sign | ((m | 0x800000) >> (1 - e + 13));
  }
  if (e >= 31) return sign | 0x7c00;
  return sign | (e << 10) | (m >> 13);
}

// ---------- flood corridor ----------
interface Corridor {
  x: Float32Array; // km east of the AOI's south-west corner
  y: Float32Array; // km north of it
  w: Float32Array; // half width, km
  vh: Float32Array; // valley-floor elevation, m
}

// Densify the reported waypoints, then pull every point down to the valley floor so the corridor follows the terrain.
function traceCorridor(site: SiteDef, W: number, H: number, heights: Int16Array, sizeKm: [number, number]): Corridor {
  const map = makeMapper(site.aoi);
  const flood = site.flood!;
  const pts = flood.waypoints.map(([lon, lat]) => [map.u(lon) * sizeKm[0], (1 - map.v(lat)) * sizeKm[1]]);
  const step = 0.5;
  const dense: number[][] = [];
  const segLen: number[] = [];
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    segLen.push(l);
    total += l;
  }
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const n = Math.max(1, Math.round(segLen[i] / step));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      dense.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, (acc + segLen[i] * t) / total]);
    }
    acc += segLen[i];
  }
  dense.push([...pts[pts.length - 1], 1]);

  const R = Math.round(2.2 / (sizeKm[0] / W));
  const px = (x: number) => Math.min(W - 1, Math.max(0, Math.round((x / sizeKm[0]) * W)));
  const py = (y: number) => Math.min(H - 1, Math.max(0, Math.round((1 - y / sizeKm[1]) * H)));
  const snapped = dense.map(([x, y, t]) => {
    let bx = x, by = y, bh = Infinity;
    const cx = px(x), cy = py(y);
    for (let dj = -R; dj <= R; dj += 2) {
      for (let di = -R; di <= R; di += 2) {
        if (di * di + dj * dj > R * R) continue;
        const i = cx + di, j = cy + dj;
        if (i < 0 || j < 0 || i >= W || j >= H) continue;
        const h = heights[j * W + i];
        if (h < bh) {
          bh = h;
          bx = (i / W) * sizeKm[0];
          by = (1 - j / H) * sizeKm[1];
        }
      }
    }
    return [bx, by, t];
  });
  const n = snapped.length;
  const x = new Float32Array(n), y = new Float32Array(n), w = new Float32Array(n), vh = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, c = 0;
    for (let k = -4; k <= 4; k++) {
      const p = snapped[Math.min(n - 1, Math.max(0, i + k))];
      sx += p[0];
      sy += p[1];
      c++;
    }
    x[i] = sx / c;
    y[i] = sy / c;
    w[i] = flood.widthKm[0] + (flood.widthKm[1] - flood.widthKm[0]) * snapped[i][2];
    vh[i] = heights[py(y[i]) * W + px(x[i])];
  }
  return { x, y, w, vh };
}

// ---------- baked sun shadow ----------
// Same soft-shadow march the terrain shader used to run per pixel per frame, done once here on the un-lifted terrain.
const SUN = (() => {
  const v = [-0.5, 0.24, -0.58];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();

function bakeShadows(heights: Int16Array, W: number, H: number, sizeKm: [number, number], vex: number, out: Uint16Array) {
  const dl = Math.hypot(SUN[0], SUN[2]);
  const dx = SUN[0] / dl, dz = SUN[2] / dl;
  const rise = SUN[1] / dl;
  const stepsX: number[] = [], stepsY: number[] = [], ts: number[] = [];
  let t = 0.35;
  for (let i = 0; i < 22; i++) {
    ts.push(t);
    stepsX.push((dx * t / sizeKm[0]) * W);
    stepsY.push((dz * t / sizeKm[1]) * H);
    t *= 1.24;
  }
  const k = 0.001 * vex;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const h0 = Math.max(heights[j * W + i], 0) * k;
      let s = 1;
      for (let n = 0; n < 22; n++) {
        const x = Math.round(i + stepsX[n]), y = Math.round(j + stepsY[n]);
        if (x < 0 || y < 0 || x >= W || y >= H) break;
        const dh = h0 + rise * ts[n] - Math.max(heights[y * W + x], 0) * k;
        const v = Math.min(1, Math.max(0, (6 * dh) / ts[n] + 0.25));
        if (v < s) s = v;
        if (s <= 0) break;
      }
      out[(j * W + i) * 2 + 1] = toHalf(s);
    }
  }
}

// ---------- build ----------
export function buildFields(meta: TerrainMeta, heights: Int16Array, site: SiteDef, real?: RealSignal): Fields {
  const { width: W, height: H, aoi } = meta;
  const map = makeMapper(aoi);
  const sizeKm = sizeKmOf(aoi);
  const lon0 = (aoi.west + aoi.east) / 2, lat0 = (aoi.north + aoi.south) / 2;
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57;
  const look = site.look;

  const F = site.fault;
  const s = ((F?.strikeDeg ?? 0) * Math.PI) / 180;
  const aE = Math.sin(s), aN = Math.cos(s);
  const nE = -aN, nN = aE;
  const fx = F ? (F.lon - lon0) * kx : 0, fy = F ? (F.lat - lat0) * ky : 0;
  const aps = site.kind === 'quake' ? 0.018 : 0.01;

  const corridor = site.kind === 'flood' && !real ? traceCorridor(site, W, H, heights, sizeKm) : null;
  const src = site.flood
    ? [map.u(site.flood.source[0]) * sizeKm[0], (1 - map.v(site.flood.source[1])) * sizeKm[1]]
    : [0, 0];

  const los = new Float32Array(W * H), coh = new Float32Array(W * H), dcoh = new Float32Array(W * H);
  const packed = new Uint16Array(W * H * 4), packedChange = new Uint16Array(W * H * 2);
  const samples: number[] = []; // coherent land, for a robust range
  const mpp = meta.metersPerPixel;

  // km from the AOI centre for every column / row.
  const PX = new Float64Array(W), PY = new Float64Array(H);
  for (let i = 0; i < W; i++) PX[i] = (map.lonAt((i + 0.5) / W) - lon0) * kx;
  for (let j = 0; j < H; j++) PY[j] = (map.latAt((j + 0.5) / H) - lat0) * ky;

  // The synthetic noise varies over kilometres while a pixel is ~150 m, so evaluate it on a coarse grid and interpolate.
  const coarse = (cell: number, f: (x: number, y: number) => number) => {
    const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2;
    const g = new Float32Array(gw * gh);
    for (let gj = 0; gj < gh; gj++) {
      const j = Math.min(H - 1, gj * cell);
      for (let gi = 0; gi < gw; gi++) g[gj * gw + gi] = f(PX[Math.min(W - 1, gi * cell)], PY[j]);
    }
    return (i: number, j: number) => {
      const x = i / cell, y = j / cell;
      const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
      const a = g[yi * gw + xi], b = g[yi * gw + xi + 1], c = g[(yi + 1) * gw + xi], d = g[(yi + 1) * gw + xi + 1];
      return a + (b - a) * xf + (c - a) * yf + (a - b - c + d) * xf * yf;
    };
  };
  const nCoh = coarse(4, (x, y) => fbm(x / 9, y / 9, 3));
  const nAps = coarse(4, (x, y) => fbm(x / 28 + 5.2, y / 28 - 1.3));
  const nRough = coarse(3, (x, y) => fbm(x / 3 + 40, y / 3 - 11, 3));
  const nCorr = corridor ? coarse(2, (x, y) => fbm(x / 1.2 + 9, y / 1.2 - 4, 3)) : null;

  // Bucket the corridor points so each pixel only tests the ones nearby.
  const CELL = 3;
  const bw = Math.ceil(sizeKm[0] / CELL) + 2, bh = Math.ceil(sizeKm[1] / CELL) + 2;
  const buckets: number[][] = corridor ? Array.from({ length: bw * bh }, () => []) : [];
  if (corridor) {
    for (let m = 0; m < corridor.x.length; m++) buckets[Math.floor(corridor.y[m] / CELL) * bw + Math.floor(corridor.x[m] / CELL)].push(m);
  }

  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const h = heights[k];
      const px = PX[i], py = PY[j]; // km from the AOI centre
      const gx = px + sizeKm[0] / 2, gy = py + sizeKm[1] / 2; // km from the south-west corner

      // Terrain-driven baseline coherence (sea decorrelates; forest, snow and steep slopes lose it).
      let c: number;
      if (h <= 0) {
        c = 0.04 + 0.1 * hash(i * 0.37, j * 0.91);
      } else {
        const hL = heights[j * W + Math.max(0, i - 1)], hR = heights[j * W + Math.min(W - 1, i + 1)];
        const hU = heights[Math.max(0, j - 1) * W + i], hD = heights[Math.min(H - 1, j + 1) * W + i];
        const slope = Math.hypot(hR - hL, hD - hU) / (2 * mpp);
        const veg = smooth(250, 1100, h) * (1 - smooth(2000, 2500, h));
        const n = nCoh(i, j);
        c = 0.95 - 0.62 * veg * smooth(0.3, 0.62, n) - 0.35 * smooth(0.2, 0.5, slope) - 0.12 * (n - 0.5);
        c -= 0.55 * smooth(4600, 5600, h); // snow and ice
      }
      c = Math.min(0.98, Math.max(0.02, c));

      let d = 0, loss = 0;
      if (real) {
        d = real.los[k];
        c = real.coh[k];
        loss = real.dcoh ? real.dcoh[k] : 0;
      } else if (F && site.kind === 'quake') {
        // Vertical strike-slip rupture: arctangent profile, tapered along strike, decaying away from the trace.
        const x = px - fx, y = py - fy;
        const along = x * aE + y * aN, perp = x * nE + y * nN;
        const L = F.lengthKm, D = F.depthKm;
        const taper = 0.5 * (Math.tanh((along + L / 2) / 14) - Math.tanh((along - L / 2) / 14));
        const far = Math.exp(-Math.abs(perp) / 75);
        const par = (F.slipM / Math.PI) * ((Math.PI / 2) * Math.sign(perp || 1e-6) - Math.atan(perp / D)) * taper * far;
        const uU = 0.05 * F.slipM * Math.exp(-(along * along) / 3000) * Math.tanh(perp / 10) * Math.sin(along / 25);
        d = par * aE * look[0] + par * aN * look[1] + uU * look[2];
        c *= 1 - 0.8 * Math.exp(-((perp / 1.4) ** 2)) * taper;
      } else if (F && site.kind === 'quake-normal') {
        // Shallow normal fault: mostly vertical. The hanging wall (perp > 0) sinks, the footwall rises a little.
        const x = px - fx, y = py - fy;
        const along = x * aE + y * aN, perp = x * nE + y * nN;
        const sP = 2.4, sA = F.lengthKm * 0.55;
        const g = (p: number) => Math.exp(-(p * p) / (2 * sP * sP));
        const alongF = Math.exp(-(along * along) / (2 * sA * sA));
        const uU = F.slipM * 0.125 * alongF * (-g(perp - 2.2) + 0.5 * g(perp + 3.6));
        const uH = -Math.sign(uU) * Math.abs(uU) * 0.45; // horizontal motion towards/away from the trace
        d = uU * look[2] + uH * (nE * look[0] + nN * look[1]);
        c *= 1 - 0.45 * Math.exp(-((perp / 1.2) ** 2)) * alongF;
      } else if (corridor) {
        // Debris flood: no ground motion, but the scoured valley loses coherence.
        let best = Infinity, bi = -1;
        const cx = Math.floor(gx / CELL), cy = Math.floor(gy / CELL);
        for (let by = Math.max(0, cy - 1); by <= Math.min(bh - 1, cy + 1); by++) {
          for (let bx = Math.max(0, cx - 1); bx <= Math.min(bw - 1, cx + 1); bx++) {
            for (const m of buckets[by * bw + bx]) {
              const dx = gx - corridor.x[m], dy = gy - corridor.y[m];
              const dd = dx * dx + dy * dy;
              if (dd < best) {
                best = dd;
                bi = m;
              }
            }
          }
        }
        const rough = 0.6 + 0.4 * nCorr!(i, j);
        if (bi >= 0) {
          const onFloor = 1 - smooth(120, 420, h - corridor.vh[bi]); // only ground near the valley floor is scoured
          loss = Math.exp(-((Math.sqrt(best) / corridor.w[bi]) ** 2)) * onFloor * rough;
        }
        const ds = Math.hypot(gx - src[0], gy - src[1]);
        loss = Math.max(loss, Math.exp(-((ds / site.flood!.sourceKm) ** 2)) * 0.9 * rough);
        loss = Math.min(1, loss * 1.15) * smooth(0.05, 0.25, c);
        c = Math.max(0.02, c * (1 - loss * 0.92));
      }
      if (!real) {
        // Atmospheric phase screen + gentle orbital ramp, both in metres.
        d += aps * (nAps(i, j) - 0.5) - 0.004 * (Math.max(h, 0) / 1000) + 0.012 * (px / sizeKm[0]);
      } else if (!Number.isFinite(d)) d = 0;

      los[k] = d;
      coh[k] = c;
      dcoh[k] = loss;
      if (h > 0 && c > 0.3 && (i + j) % 3 === 0) samples.push(d);

      const rough = 0.35 + 0.5 * nRough(i, j);
      packed[k * 4] = toHalf(h);
      packed[k * 4 + 1] = toHalf(d);
      packed[k * 4 + 2] = toHalf(c);
      packed[k * 4 + 3] = toHalf(rough);
      packedChange[k * 2] = toHalf(loss);
    }
  }
  bakeShadows(heights, W, H, sizeKm, site.vex, packedChange);
  // Range of the signal: 0.5–99.5 percentile of coherent land, so a handful of unwrapping errors cannot inflate it.
  samples.sort((a, b) => a - b);
  const pick = (q: number) => samples[Math.min(samples.length - 1, Math.max(0, Math.floor(q * samples.length)))] ?? 0;
  const losMin = pick(0.005), losMax = pick(0.995);
  const range = rangeOf(site, !real, losMin, losMax);
  const { lift, liftH } = smoothLift(los, coh, 1, W, H, range);
  const segX = Math.min(1000, Math.round(W / 2)), segZ = Math.round((segX * sizeKm[1]) / sizeKm[0]);
  const grid = gridOf(sizeKm[0], sizeKm[1], segX, segZ);
  const thumb = thumbOf(meta, heights, site, { los, coh, dcoh, range }, !!real);
  return { W, H, heights, los, coh, dcoh, packed, packedChange, losMin, losMax, sizeKm, synthetic: !real, range, lift, liftH, grid, thumb };
}
