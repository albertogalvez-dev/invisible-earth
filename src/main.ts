import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import './style.css';
import './sites.css';

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { romaO, berlin, grayC } from './colormaps';
import { makeMapper, toHalf, type Fields, type RealSignal, type TerrainMeta } from './field';
import {
  beatsFor, eventDate, shortDate, siteById, SITES,
  type Beat, type SiteDef,
} from './sites';
import { beamFrag, beamVert, cloudFrag, cloudVert, ghostFrag, ghostVert, gradeFrag, skirtFrag, skirtVert, stemFrag, stemVert, terrainFrag, terrainVert } from './shaders';
import { easeInOut, linear, Tweens } from './tween';
import { createGlobe, dirOf, faceQuat, topQuat, GLOBE_R, type Globe } from './globe';
import { Sound } from './sound';

const LIFT_REF = 5;
const HALF_LAMBDA = 0.121; // L-band 1239 MHz: wavelength 24.2 cm, so 12.1 cm of line-of-sight motion per colour cycle
const BASE_KM = 14;
const REF_WIDTH_KM = 273; // slab width the camera moves and constants were authored at
const ORBIT: [number[], number[]] = [[0, 900, 150], [0, 0, 0]];
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches; // no long fly-ins or seismic wave
const INTRO_S = REDUCED ? 0.9 : 5.2;
const RISE_S = REDUCED ? 0.9 : 3.4; // back up to the globe

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sound = new Sound();
// The styles are in: the page may show more than its loading screen (see the guard in index.html).
$('app').classList.add('styled');
const params = new URLSearchParams(location.search);
const fmtDate = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });

// Recorded English narration avoids selecting a voice in the device's language.
const narrationAvailable = !params.has('silent') && typeof Audio !== 'undefined';
const narration = narrationAvailable ? new Audio() : null;
if (narration) {
  narration.preload = 'auto';
  narration.addEventListener('ended', () => sound.setNarrating(false));
  narration.addEventListener('error', () => sound.setNarrating(false));
}
let narrationTimer = 0;
let narrationEpoch = 0;
let narrationUnlocked = false;
function unlockNarration() {
  if (!narration || !sound.on || narrationUnlocked) return;
  narrationUnlocked = true;
  const epoch = narrationEpoch;
  narration.src = 'narration/quality.mp3';
  narration.volume = 0;
  void narration.play().then(() => {
    if (narrationEpoch === epoch) { narration.pause(); narration.currentTime = 0; }
    narration.volume = 1;
  }).catch(() => { narration.volume = 1; narrationUnlocked = false; });
}
function stopNarration() {
  clearTimeout(narrationTimer);
  narrationEpoch++;
  narration?.pause();
  sound.setNarrating(false);
}
function narrateChapter(_b: Beat, index: number, first: boolean) {
  stopNarration();
  if (!narration || !sound.on) return;
  // Do not describe synthetic fallback data as satellite observations.
  if (F.synthetic && index !== 0) return;
  const clip = F.synthetic ? 'simulated' : index === 4 ? 'quality' : index === 5 ? 'explore' : `${site.id}-${index}`;
  narrationTimer = window.setTimeout(() => {
    if (!sound.on || mode !== 'story' || beat !== index || document.hidden) return;
    narration.src = `narration/${clip}.mp3`;
    sound.setNarrating(true);
    void narration.play().catch(() => sound.setNarrating(false));
  }, first ? INTRO_S * 550 : 500);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopNarration(); });

// ---------- failure screen ----------
function fatal(message: string) {
  const l = document.getElementById('loader')!;
  l.classList.remove('done');
  l.classList.add('error');
  document.getElementById('loaderText')!.textContent = message;
  const b = document.getElementById('retry') as HTMLButtonElement;
  b.hidden = false;
  b.onclick = () => location.reload();
}
if (!document.createElement('canvas').getContext('webgl2')) {
  fatal('This browser cannot run WebGL 2, which the 3D view needs.');
  throw new Error('WebGL 2 unavailable');
}
addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  fatal('Something did not load. Check the connection and reload.');
});

// ---------- data loading ----------
interface Terrain { meta: TerrainMeta; heights: Int16Array }
const terrainCache = new Map<string, Promise<Terrain>>();
function loadTerrain(site: SiteDef): Promise<Terrain> {
  if (!terrainCache.has(site.id)) {
    terrainCache.set(
      site.id,
      Promise.all([
        fetch(`data/${site.id}/terrain.json`).then((r) => (r.ok ? (r.json() as Promise<TerrainMeta>) : Promise.reject(new Error(`terrain.json ${r.status}`)))),
        fetch(`data/${site.id}/terrain.bin`).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`terrain.bin ${r.status}`)))),
      ]).then(([meta, bin]) => ({ meta, heights: new Int16Array(bin) })),
    );
  }
  return terrainCache.get(site.id)!;
}

// A real GUNW raster (scripts/fetch-gunw.py) replaces the synthetic signal when present.
const realMeta = new Map<string, Record<string, any>>();
async function loadReal(site: SiteDef, W: number, H: number): Promise<RealSignal | undefined> {
  try {
    const r = await fetch(`data/${site.id}/gunw.json`);
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return;
    const j = await r.json();
    if (j.width !== W || j.height !== H) {
      console.warn(`gunw.json for ${site.id} does not match the terrain grid`);
      return;
    }
    realMeta.set(site.id, j);
    const b = await (await fetch(`data/${site.id}/gunw.bin`)).arrayBuffer();
    const n = W * H;
    const los = new Float32Array(b, 0, n).slice();
    const c8 = new Uint8Array(b, n * 4, n);
    const coh = new Float32Array(n);
    for (let k = 0; k < n; k++) coh[k] = c8[k] / 255;
    let dcoh: Float32Array | undefined;
    if (j.hasDcoh) {
      const d8 = new Uint8Array(b, n * 5, n);
      dcoh = new Float32Array(n);
      for (let k = 0; k < n; k++) dcoh[k] = d8[k] / 255;
    }
    return { los, coh, dcoh };
  } catch {
    return;
  }
}

// A few workers build the sites' fields in parallel; each keeps its own queue so a site never waits behind another one's job.
const POOL = Math.min(SITES.length, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
const workers = Array.from({ length: POOL }, () => ({
  w: new Worker(new URL('./field.worker.ts', import.meta.url), { type: 'module' }),
  chain: Promise.resolve() as Promise<unknown>,
}));
let jobId = 0;
// A pair of a series is prepared in a worker too (half floats and the smoothed lift): Explore then only copies it.
let pairSlot = 0;
function pairJob(buf: ArrayBuffer, W: number, H: number, range: number, hasDcoh: boolean) {
  const slot = workers[pairSlot++ % POOL];
  const id = ++jobId;
  const job = slot.chain.then(
    () =>
      new Promise<{ buf: ArrayBuffer; losH: Uint16Array; lift: Float32Array; liftH: Uint16Array }>((resolve) => {
        const on = (e: MessageEvent) => {
          if (e.data.id !== id) return;
          slot.w.removeEventListener('message', on);
          resolve(e.data);
        };
        slot.w.addEventListener('message', on);
        slot.w.postMessage({ kind: 'pair', id, buf, W, H, range, hasDcoh }, [buf]);
      }),
  );
  slot.chain = job;
  return job;
}
const fieldCache = new Map<string, Promise<Fields>>();
function loadFields(site: SiteDef): Promise<Fields> {
  if (!fieldCache.has(site.id)) {
    const slot = workers[SITES.findIndex((s) => s.id === site.id) % POOL];
    const job = slot.chain.then(async () => {
      const { meta, heights } = await loadTerrain(site);
      const real = await loadReal(site, meta.width, meta.height);
      const id = ++jobId;
      const t0 = performance.now();
      return new Promise<Fields>((resolve, reject) => {
        slot.w.addEventListener('error', (e) => reject(e.error ?? new Error('field worker failed')), { once: true });
        const on = (e: MessageEvent) => {
          if (e.data.id !== id) return;
          slot.w.removeEventListener('message', on);
          if (params.has('debug')) console.info(`[fields] ${site.id}: ${Math.round(performance.now() - t0)} ms (${meta.width}×${meta.height})`);
          resolve(e.data.fields as Fields);
        };
        slot.w.addEventListener('message', on);
        slot.w.postMessage({ id, siteId: site.id, meta, heights: heights.slice(), real });
      });
    });
    slot.chain = job;
    fieldCache.set(site.id, job);
  }
  return fieldCache.get(site.id)!;
}

// ---------- renderer ----------
const canvas = $<HTMLCanvasElement>('gl');
// preserveDrawingBuffer: when a heavy task (a place being set up) delays a frame, the last picture stays on screen
// instead of an empty canvas flashing black.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
const DPR_CAP = Math.min(devicePixelRatio, 1.75);
const DPR_MIN = 0.75;
let dpr = DPR_CAP; // adapts to the frame time, see adaptQuality()
renderer.setPixelRatio(dpr);
renderer.setClearColor(0x010203, 1);
renderer.info.autoReset = false; // count every pass of the composer, not just the last one

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(34, 1, 0.5, 6000);

const lut = new Uint8Array(256 * 3 * 4);
[romaO, berlin, grayC].forEach((m, row) => {
  for (let i = 0; i < 256; i++) {
    const o = (row * 256 + i) * 4;
    lut[o] = m[i * 3];
    lut[o + 1] = m[i * 3 + 1];
    lut[o + 2] = m[i * 3 + 2];
    lut[o + 3] = 255;
  }
});
const cmapTex = new THREE.DataTexture(lut, 256, 3, THREE.RGBAFormat);
cmapTex.colorSpace = THREE.SRGBColorSpace;
cmapTex.minFilter = cmapTex.magFilter = THREE.LinearFilter;
cmapTex.needsUpdate = true;

const emptyTex = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
emptyTex.needsUpdate = true;
const emptyChange = new THREE.DataTexture(new Uint16Array(2), 1, 1, THREE.RGFormat, THREE.HalfFloatType);
emptyChange.needsUpdate = true;
const emptyLift = new THREE.DataTexture(new Uint16Array(1), 1, 1, THREE.RedFormat, THREE.HalfFloatType);
emptyLift.needsUpdate = true;

const sun = new THREE.Vector3(-0.5, 0.24, -0.58).normalize();
const U = {
  uData: { value: emptyTex as THREE.Texture },
  uData2: { value: emptyTex as THREE.Texture },
  uLiftTex: { value: emptyLift as THREE.Texture },
  uLiftTex2: { value: emptyLift as THREE.Texture },
  uXf: { value: 0 },
  uReveal: { value: 0 },
  uLossK: { value: 1 },
  uNight: { value: 0 },
  uChange2: { value: emptyChange as THREE.Texture },
  uChangeTex: { value: emptyChange as THREE.Texture },
  uCmap: { value: cmapTex },
  uTexel: { value: new THREE.Vector2(1, 1) },
  uSize: { value: new THREE.Vector2(273, 143) },
  uVex: { value: 4 },
  uLiftKm: { value: LIFT_REF },
  uLift: { value: 0 },
  uDisp: { value: 1 },
  uSun: { value: sun },
  uLook: { value: new THREE.Vector3(0, 1, 0) },
  uHalfLambda: { value: HALF_LAMBDA },
  uRange: { value: 0.35 },
  uIso: { value: 0.05 },
  uS: { value: 1 },
  uPass1: { value: 0 },
  uPass2: { value: 0 },
  uAmp: { value: 0 },
  uFringe: { value: 0 },
  uUnwrap: { value: 0 },
  uChange: { value: 0 },
  uCoh: { value: 0 },
  uRoll: { value: 0 },
  uTime: { value: 0 },
  uProbe: { value: new THREE.Vector3(0, 0, 0) },
  uEpi: { value: [new THREE.Vector4(0, 0, 0, 1), new THREE.Vector4(0, 0, 0, 1)] },
  uFront: { value: -1 },
  uSplit: { value: -1 },
  uLava: { value: 0 },
  uFlow: { value: 0 },
  uScreen: { value: new THREE.Vector2(1, 1) },
  uFrontW: { value: 6 },
  uFrontLit: { value: 0 },
  uSweepLit: { value: 0 },
  uCohWipe: { value: -1 },
  uWave: { value: 0 },
  uWaveR: { value: 150 },
  uBase: { value: BASE_KM },
};

const terrain = new THREE.Mesh(
  new THREE.BufferGeometry(),
  // The slab is drawn as a blended layer: while it surfaces out of the globe it fades in over it instead of dimming to black.
  new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: U, vertexShader: terrainVert, fragmentShader: terrainFrag, transparent: true }),
);

// The ground as it was: a ghost grid at the terrain's old height and stems from each old point to where it went. They
// ride on the slab (children of it) and show only while the relief is lifted by the motion.
const ghostU = { uGhost: { value: 0 }, uGrid: { value: 4 }, uGapMin: { value: 0.05 }, uStemW: { value: 0.3 } };
const ghost = new THREE.Mesh(
  terrain.geometry,
  new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { ...U, ...ghostU }, vertexShader: ghostVert, fragmentShader: ghostFrag, transparent: true, depthWrite: false }),
);
ghost.frustumCulled = false;
ghost.renderOrder = 2;
const stemGeo = new THREE.InstancedBufferGeometry();
{
  const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  stemGeo.index = box.index;
  stemGeo.setAttribute('position', box.getAttribute('position'));
}
const stems = new THREE.Mesh(
  stemGeo,
  new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, uniforms: { ...U, ...ghostU }, vertexShader: stemVert, fragmentShader: stemFrag, transparent: true, depthWrite: false }),
);
stems.frustumCulled = false;
stems.renderOrder = 3;
terrain.add(ghost, stems);
terrain.renderOrder = -3;
terrain.matrixAutoUpdate = false; // placed by placeSlab()
terrain.frustumCulled = false;
terrain.visible = false;
scene.add(terrain);

// Cut walls around the slab.
function skirtGeometry(n: number, SX: number, SZ: number) {
  const pos: number[] = [], uv: number[] = [], nor: number[] = [], bottom: number[] = [], idx: number[] = [];
  const edges: [(t: number) => [number, number], [number, number, number]][] = [
    [(t) => [t, 1], [0, 0, -1]],
    [(t) => [t, 0], [0, 0, 1]],
    [(t) => [0, t], [-1, 0, 0]],
    [(t) => [1, t], [1, 0, 0]],
  ];
  for (const [f, nrm] of edges) {
    const start = pos.length / 3;
    for (let i = 0; i <= n; i++) {
      const [u, v] = f(i / n);
      for (const b of [0, 1]) {
        pos.push(-SX / 2 + u * SX, 0, (0.5 - v) * SZ);
        uv.push(u, v);
        nor.push(...nrm);
        bottom.push(b);
      }
      if (i < n) {
        const a = start + i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aBottom', new THREE.Float32BufferAttribute(bottom, 1));
  g.setIndex(idx);
  return g;
}
const skirt = new THREE.Mesh(
  new THREE.BufferGeometry(),
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: U,
    vertexShader: skirtVert,
    fragmentShader: skirtFrag,
    side: THREE.DoubleSide,
    transparent: true,
  }),
);
skirt.renderOrder = -3;
skirt.matrixAutoUpdate = false;
skirt.frustumCulled = false;
skirt.visible = false;
scene.add(skirt);

// Satellite + radar beam fan.
const beamU = { uOpacity: { value: 0 } };
const beamGeo = new THREE.BufferGeometry();
beamGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
beamGeo.setAttribute('aGround', new THREE.Float32BufferAttribute([0, 1, 1], 1));
const beam = new THREE.Mesh(
  beamGeo,
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: beamU,
    vertexShader: beamVert,
    fragmentShader: beamFrag,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  }),
);
beam.frustumCulled = false;
scene.add(beam);

function glowTexture() {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.06, 'rgba(255,255,255,0.85)');
  r.addColorStop(0.18, 'rgba(255,255,255,0.3)');
  r.addColorStop(0.45, 'rgba(255,255,255,0.07)');
  r.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(c);
}
const glowTex = glowTexture();
const glowSprite = (color: THREE.Color) =>
  new THREE.Sprite(
    new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
const satHalo = glowSprite(new THREE.Color(0.7, 1.25, 2.0));
const satCore = glowSprite(new THREE.Color(4.2, 4.8, 5.4));

// A stylised NISAR: gold bus, the 12 m mesh reflector on its boom, and solar wings. It looks LEFT: on an ascending pass
// (flying north) that is west, so the satellite sits east of the ground it images and the reflector opens towards the west.
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
function buildNisar() {
  const g = new THREE.Group();
  // Multi-layer insulation: gold foil, crinkled, with a few seams.
  const foil = canvasTex(256, 256, (x) => {
    x.fillStyle = '#c99442';
    x.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 900; i++) {
      const v = 150 + Math.random() * 105;
      x.fillStyle = `rgba(${v},${v * 0.72},${v * 0.3},${0.18 + Math.random() * 0.3})`;
      x.beginPath();
      x.ellipse(Math.random() * 256, Math.random() * 256, 4 + Math.random() * 18, 2 + Math.random() * 6, Math.random() * 3, 0, 7);
      x.fill();
    }
    x.strokeStyle = 'rgba(90,60,20,0.55)';
    x.lineWidth = 2;
    for (const p of [64, 150, 210]) (x.beginPath(), x.moveTo(p, 0), x.lineTo(p + 12, 256), x.stroke());
  });
  // Solar wings: dark cells in a silver frame.
  const cells = canvasTex(512, 256, (x) => {
    x.fillStyle = '#c8ccd4';
    x.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 16; i++)
      for (let j = 0; j < 8; j++) {
        const gr = x.createLinearGradient(0, j * 32, 0, j * 32 + 30);
        gr.addColorStop(0, '#1d2f66');
        gr.addColorStop(1, '#0c1532');
        x.fillStyle = gr;
        x.fillRect(i * 32 + 2, j * 32 + 2, 28, 28);
      }
  });
  const gold = new THREE.MeshStandardMaterial({ map: foil, color: 0xffffff, metalness: 0.85, roughness: 0.38, emissive: 0x1e1003 });
  const panel = new THREE.MeshStandardMaterial({ map: cells, color: 0xffffff, metalness: 0.5, roughness: 0.35, emissive: 0x050814 });
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 2.6), gold));
  for (const z of [-1.5, 1.5]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.06, 1.9), panel);
    w.position.set(3.4, 0.25, z);
    w.rotation.z = 0.1;
    g.add(w);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.5, 6), gold);
    arm.rotation.z = Math.PI / 2;
    arm.position.set(1.6, 0.2, z * 0.62);
    g.add(arm);
  }
  // A strut between two points.
  const rod = (a: THREE.Vector3, b: THREE.Vector3, r: number, m: THREE.Material) => {
    const d = b.clone().sub(a);
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, d.length(), 6), m);
    c.position.copy(a).addScaledVector(d, 0.5);
    c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
    return c;
  };
  const rib = new THREE.MeshStandardMaterial({ color: 0xe7c17a, metalness: 0.9, roughness: 0.3, emissive: 0x2a1a06 });
  // Radar electronics: the feed array under the bus, facing the reflector.
  const feed = new THREE.Mesh(new THREE.BoxGeometry(0.35, 1.1, 2.3), new THREE.MeshStandardMaterial({ map: cells, color: 0x9aa4b8, metalness: 0.6, roughness: 0.45 }));
  feed.position.set(-1.05, 0.15, 0);
  g.add(feed);
  // Reflector: 12 m of gold mesh held by radial ribs and a rim, opening towards the ground to the west (left-looking).
  const R = 8, th = Math.asin(4.4 / R);
  const dish = new THREE.Group();
  const cap = new THREE.SphereGeometry(R, 48, 12, 0, Math.PI * 2, 0, th);
  dish.add(new THREE.Mesh(cap, new THREE.MeshStandardMaterial({ color: 0xf2d08a, metalness: 0.7, roughness: 0.5, transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false, emissive: 0x3a2508 })));
  const rimY = R * Math.cos(th);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(4.4, 0.07, 6, 72), rib);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = rimY;
  dish.add(rim);
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= 10; k++) {
      const t = (k / 10) * th;
      pts.push(new THREE.Vector3(Math.sin(t) * Math.cos(a) * R, Math.cos(t) * R, Math.sin(t) * Math.sin(a) * R));
    }
    dish.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.035, 4), rib));
  }
  dish.position.set(-3.7, 3.6, 0);
  dish.rotation.z = -0.585;
  g.add(dish);
  // The boom: a triangular truss from the bus to the reflector.
  const A = new THREE.Vector3(-0.9, 0.7, 0), B = new THREE.Vector3(-3.5, 3.3, 0);
  const ax = B.clone().sub(A).normalize();
  const u = new THREE.Vector3(0, 0, 1), v = new THREE.Vector3().crossVectors(ax, u).normalize();
  const corner = (p: THREE.Vector3, k: number) => p.clone().addScaledVector(u, Math.cos(k * 2.094) * 0.16).addScaledVector(v, Math.sin(k * 2.094) * 0.16);
  const steps = 6;
  for (let k = 0; k < 3; k++) g.add(rod(corner(A, k), corner(B, k), 0.022, rib));
  for (let j = 0; j < steps; j++) {
    const p0 = A.clone().lerp(B, j / steps), p1 = A.clone().lerp(B, (j + 1) / steps);
    for (let k = 0; k < 3; k++) g.add(rod(corner(p0, k), corner(p1, k + 1), 0.012, rib));
  }
  g.rotation.set(0.12, 0, 0);
  return g;
}
const nisar = buildNisar();
const keyLight = new THREE.DirectionalLight(0xffe2b8, 3.2);
keyLight.position.set(-3, 4, -2);
scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x1a1208, 1.1), keyLight);
const sat = new THREE.Group();
sat.add(satHalo, satCore, nisar);
scene.add(sat);
// A deck of cloud over the slab in Acquire: the optical view is lost under it, the radar picture shows through it.
const cloudU = { uCloud: { value: 0 }, uPass: { value: 0 }, uTime: { value: 0 }, uS: U.uS, uSize: U.uSize };
const clouds = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1, 1, 1).rotateX(-Math.PI / 2),
  new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: cloudU,
    vertexShader: cloudVert,
    fragmentShader: cloudFrag,
    transparent: true,
    depthWrite: false,
  }),
);
clouds.frustumCulled = false;
clouds.visible = false;
clouds.renderOrder = 2;
scene.add(clouds);

const trackMat = new THREE.LineDashedMaterial({ color: 0x9fc4dd, dashSize: 2, gapSize: 3, transparent: true, opacity: 0 });
const track = new THREE.Line(new THREE.BufferGeometry(), trackMat);
scene.add(track);

// ---------- post ----------
const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
const composer = new EffectComposer(renderer, target);
composer.addPass(new RenderPass(scene, camera));
// A safety net before the bloom: one NaN or infinite pixel from any shader would be blurred over the whole frame (a
// white blob, or the screen gone black for a frame). Replace them with black here, whatever made them.
composer.addPass(
  new ShaderPass({
    uniforms: { tDiffuse: { value: null } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: 'uniform sampler2D tDiffuse; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); bool bad = any(isnan(c)) || any(isinf(c)) || any(notEqual(c, c)); gl_FragColor = bad ? vec4(0., 0., 0., 1.) : min(c, vec4(64.)); }',
  }),
);
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.75, 0.55, 0.92);
composer.addPass(bloom);
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uRes: { value: new THREE.Vector2() }, uTime: { value: 0 }, uMist: { value: 0 }, uMistZ: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
  fragmentShader: gradeFrag,
});
composer.addPass(new OutputPass());
composer.addPass(grade); // grain + vignette in display space

// ---------- camera ----------
const controls = new OrbitControls(camera, canvas);
controls.enabled = false;
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.46;
controls.rotateSpeed = 0.55; // a short drag is a small turn
controls.zoomSpeed = 0.8;
controls.panSpeed = 0.7;
// The camera belongs to the story until the viewer takes it: a drag or a scroll in any chapter hands it over, and the
// next chapter (or 'Back to the shot') gives it back.
let userCam = false;
controls.addEventListener('start', () => {
  if (!controls.enabled || userCam) return;
  userCam = true;
  $('viewReset').classList.add('on');
  $('orbitHint').classList.remove('on');
});
function armFreeCam(b: number) {
  const arm = () => {
    if (beat !== b || film || mode !== 'story') return;
    if (T.values.cam < 0.999 || T.values.ride > 0.001) return void setTimeout(arm, 250);
    controls.target.copy(camNow.t);
    controls.enabled = true;
  };
  setTimeout(arm, 400);
}
function releaseCam() {
  userCam = false;
  controls.enabled = false;
  $('viewReset').classList.remove('on');
}
function backToShot() {
  if (!userCam || mode !== 'story') return;
  releaseCam();
  camFrom.p.copy(camera.position);
  camFrom.t.copy(controls.target);
  const b = BEATS[beat];
  const [p, t] = portrait && b.camP ? b.camP : b.cam;
  const pose = fitPose(poseFor(p, t, portrait && !!b.camP), beat);
  camTo.p.copy(pose.p);
  camTo.t.copy(pose.t);
  T.values.cam = 0;
  T.to('cam', 1, 1.6, 0, easeInOut);
  armFreeCam(beat);
}

const camFrom = { p: new THREE.Vector3(), t: new THREE.Vector3() };
const camTo = { p: new THREE.Vector3(), t: new THREE.Vector3() };
const camNow = { p: new THREE.Vector3().fromArray(ORBIT[0]), t: new THREE.Vector3().fromArray(ORBIT[1]) };
let distScale = 1;
let portrait = false;

// ---------- state ----------
const T = new Tweens({
  pass1: 0, pass2: 0, amp: 0, fringe: 0, unwrap: 0, lift: 0, coh: 0, change: 0, disp: 1,
  cam: 1, epi: 0, places: 0, pick: 0, ghost: 0, split: 1, wave: 0, xf: 0, dive: 0, reveal: 0, ride: 0, pins: 0, orbit: 0, approach: 0, night: 0, cloud: 0, front: 1, frontLit: 0, cohWipe: 1,
});
let mode: 'boot' | 'picker' | 'story' = 'boot';

// The active site.
let site: SiteDef = SITES[0];
let F: Fields;
let SX = 273, SZ = 143, S = 1;
let mapper = makeMapper(site.aoi);
let BEATS: Beat[] = beatsFor(site);
let peak = 0;
let maxRelief = 0;
let dataTex: THREE.DataTexture | null = null;
let changeTex: THREE.DataTexture | null = null;
// The next pair's rasters: one interferogram melts into the other on the GPU, then the two swap roles.
let dataTex2: THREE.DataTexture | null = null;
let liftTex: THREE.DataTexture | null = null;
let liftTex2: THREE.DataTexture | null = null;
let liftCPU: Float32Array<ArrayBufferLike> = new Float32Array(0); // the smoothed lift of the pair on screen, for labels, probes and the camera

let changeTex2: THREE.DataTexture | null = null;
let xfPending = false;

let beat = -1;
// The real interferograms of the track around the event, oldest first. The playhead scrubs the whole chain
// (0 = first pass, 1 = last pass); the pair under it is the one on screen.
interface PairData {
  ref: string; sec: string; event: boolean; file?: string; hasDcoh: boolean;
  stats?: { losMinCm?: number; losMaxCm?: number; coherentShare?: number; granule?: string };
  los?: Float32Array; losH?: Uint16Array; coh8?: Uint8Array; dcoh8?: Uint8Array; lift?: Float32Array; liftH?: Uint16Array; loading?: Promise<void>;
}
let PAIRS: PairData[] = [];
let pairIdx = 0; // the pair whose data is in the textures
let pairWant = 0; // the pair the playhead is on, which may still be loading
let evIdx = 0; // the pair that spans the event
let passA = 0, passB = 1, eventAt = 0;
let tFrac = 1;
let playing = false;
let exploreMode: 'fringes' | 'displacement' = 'displacement';
let exploreCoh = true;
let rollActive = false;
let roll = 0;
let beamVis = 0;
let beamLit = 0; // the beam is on only while it sweeps the slab
// Riding with the satellite: 1 = over its shoulder on the first pass, 2 = ahead of it, looking back at its wake, on the second.
let rideKind: 0 | 1 | 2 = 0;
let rideTimer = 0;
let tourId = 0; // 'Play all' travels between places through the globe
let range = 0.35; // metres of line of sight mapped onto the displacement colours
let liftKm = 5; // km of rendered lift per metre (0 where the real map shows no motion)
let quietReal = false;
let heroKind: 'p2p' | 'sink' | 'fixed' | 'area' = 'p2p';
let lostKm2 = 0, sinkCm = 0;

// Sites where the radar reads coherence loss rather than motion (the surface was remade): the flood and the volcano.
const isFlood = () => site.kind === 'flood' || site.kind === 'volcano';
const noEvent = () => !!site.noEvent; // a continuing process: no shock inside a pair
// A pair is the difference between its two passes. In the pair that spans the event the ground moves (or loses coherence)
// at the event: 0 before it, 1 after, with a short ramp so the jump reads as a jump. Every other pair shows in full.
const dayMs = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const timeAt = (f: number) => passA + f * (passB - passA);
const fracOf = (t: number) => (t - passA) / (passB - passA);
const stepAt = (t: number) => {
  const w = 10 * 3600e3; // keep in step with EV_W
  const x = Math.min(1, Math.max(0, (t - (eventAt - w)) / (2 * w)));
  return x * x * (3 - 2 * x);
};
const pairAt = (t: number) => {
  let i = 0;
  PAIRS.forEach((p, k) => {
    if (t >= dayMs(p.ref)) i = k;
  });
  return i;
};
const dispFor = (f: number) => {
  const t = timeAt(f);
  return pairAt(t) === evIdx && !noEvent() ? stepAt(t) : 1;
};

// Camera pose for a chapter, authored for the reference slab and scaled to this one.
function poseFor(p: number[], t: number[], raw = false) {
  const to = new THREE.Vector3(), from = new THREE.Vector3();
  if (portrait && !raw) {
    // Look along the long axis so it runs into depth.
    to.set(t[2] * 0.3, t[1], -t[0] * 0.2);
    from.set(p[2], p[1], -p[0]).sub(new THREE.Vector3(t[2], t[1], -t[0]));
  } else {
    to.set(t[0], t[1], t[2]);
    from.set(p[0], p[1], p[2]).sub(to);
  }
  to.multiplyScalar(S);
  return { p: from.multiplyScalar(distScale * S).add(to), t: to };
}

// The part of the screen the slab may use: what is left once the text, the legend, the header and the controls have their room.
function safeRect(beat: number) {
  const w = innerWidth, h = innerHeight;
  if (w / h < 0.8) {
    // Upright screens stack the words above the slab and the controls below it: measure them, a phone and a tablet differ.
    const top = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().top ?? h;
    const words = Math.max($('eyebrow').getBoundingClientRect().bottom, $('headline').getBoundingClientRect().bottom, $('sub').getBoundingClientRect().bottom, 0.14 * h);
    const t = Math.min(0.36 * h, Math.max(words + 0.02 * h, 0.2 * h));
    const floor = beat === 5 ? top('#explore') : Math.min(top('#legend'), top('.nav'), beat === 3 || beat === 4 ? top('#hero') : h);
    const b = Math.min(0.5 * h, Math.max(h - floor + 0.02 * h, 0.18 * h));
    return { l: 0.04 * w, r: 0.04 * w, t, b };
  }
  if (h < 560) return beat === 5 ? { l: 0.03 * w, r: 0.13 * w, t: 64, b: 150 } : { l: 0.33 * w, r: 0.15 * w, t: 60, b: 96 };
  // The text sits low on the left, the legend high on the right: the slab may use the band above the headline…
  return beat === 5 ? { l: 0.04 * w, r: 0.1 * w, t: 88, b: 0.4 * h } : { l: 0.2 * w, r: 0.1 * w, t: 84, b: 0.3 * h };
}
// …or the full height to the right of the words, down to the controls. The framing takes whichever shows it larger.
function safeRects(beat: number) {
  const w = innerWidth, h = innerHeight;
  const a = safeRect(beat);
  if (w / h < 0.8 || h < 560 || beat === 5) return [a];
  const words = Math.max($('headline').getBoundingClientRect().right, $('sub').getBoundingClientRect().right, 0.26 * w);
  const heroL = beat === 3 || beat === 4 ? $('hero').getBoundingClientRect().left : w;
  const right = Math.max(0.1 * w, w - Math.min(heroL - 0.02 * w, w));
  return [a, { l: Math.min(words + 0.03 * w, 0.5 * w), r: Math.max(0.1 * w, beat === 3 || beat === 4 ? right : 0.1 * w), t: 84, b: 104 }];
}

// Keep a chapter's viewing direction but choose the distance and the aim so the whole slab lands inside the safe rectangle,
// whatever the window: it projects the slab's eight corners and settles by a few rounds of pan-and-zoom.
const fitCam = new THREE.PerspectiveCamera();
// The part of the slab a chapter is about, in slab uv (0..1): the event for the close chapters, everything for the overviews.
function focusBox(b: number) {
  let half = [[0.3, 0.36], [0.44, 0.48], [0.46, 0.5], [0.3, 0.4], [0.42, 0.46], [0.4, 0.44]][b] ?? [0.5, 0.5];
  let cu = 0.5, cv = 0.5;
  const k = site.focus?.scale[b];
  if (k && site.focus) {
    half = half.map((x) => x * k);
    cu = mapper.u(site.focus.at[0]);
    cv = mapper.v(site.focus.at[1]);
  } else if (half[0] < 0.5 && epiUv.length) {
    cu = cv = 0;
    const pts = [...epiUv];
    if (isFlood() && site.flood) for (const [lon, lat] of site.flood.waypoints) pts.push(new THREE.Vector2(mapper.u(lon), mapper.v(lat)));
    for (const e of pts) (cu += e.x / pts.length), (cv += e.y / pts.length);
  }
  const clampC = (c: number, h: number) => Math.min(1 - h, Math.max(h, c));
  cu = clampC(cu, half[0]);
  cv = clampC(cv, half[1]);
  return { u0: cu - half[0], u1: cu + half[0], v0: cv - half[1], v1: cv + half[1], whole: half[0] >= 0.5 };
}

function fitPose(pose: { p: THREE.Vector3; t: THREE.Vector3 }, beat: number, rectBeat = beat, extra: THREE.Vector3[] = []) {
  let best: ReturnType<typeof fitPoseIn> | null = null;
  for (const r of safeRects(rectBeat)) {
    const f = fitPoseIn(pose, beat, r, extra);
    if (!best || f.d < best.d) best = f;
  }
  return best!;
}
function fitPoseIn(pose: { p: THREE.Vector3; t: THREE.Vector3 }, beat: number, r: { l: number; r: number; t: number; b: number }, extra: THREE.Vector3[]) {
  const w = innerWidth, h = innerHeight;
  fitCam.fov = camera.fov;
  fitCam.aspect = w / h;
  fitCam.near = camera.near;
  fitCam.far = camera.far;
  fitCam.updateProjectionMatrix();
  const dir = pose.p.clone().sub(pose.t).normalize();
  const lift = liftKm * Math.max(Math.abs(F.losMax), Math.abs(F.losMin));
  const fb = focusBox(beat);
  const y0 = fb.whole ? -U.uBase.value : 0, y1 = maxRelief * (fb.whole ? 1 : 0.6) + lift;
  const corners: THREE.Vector3[] = [];
  for (const u of [fb.u0, fb.u1]) for (const v of [fb.v0, fb.v1]) for (const y of [y0, y1]) corners.push(new THREE.Vector3(-SX / 2 + u * SX, y, (v - 0.5) * SZ));
  corners.push(...extra);
  const tgt = new THREE.Vector3(-SX / 2 + ((fb.u0 + fb.u1) / 2) * SX, (y0 + y1) / 2, ((fb.v0 + fb.v1) / 2 - 0.5) * SZ);
  let d = pose.p.distanceTo(pose.t);
  const nx0 = -1 + (2 * r.l) / w, nx1 = 1 - (2 * r.r) / w, ny1 = 1 - (2 * r.t) / h, ny0 = -1 + (2 * r.b) / h;
  const cx = (nx0 + nx1) / 2, cy = (ny0 + ny1) / 2, hx = ((nx1 - nx0) / 2) * 0.96, hy = ((ny1 - ny0) / 2) * 0.96;
  const v = new THREE.Vector3(), right = new THREE.Vector3(), up = new THREE.Vector3();
  const tanH = Math.tan(THREE.MathUtils.degToRad(fitCam.fov / 2));
  for (let it = 0; it < 32; it++) { // steep upright views converge slowly
    fitCam.position.copy(tgt).addScaledVector(dir, d);
    fitCam.lookAt(tgt);
    fitCam.updateMatrixWorld(true);
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const c of corners) {
      v.copy(c).project(fitCam);
      minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x); miny = Math.min(miny, v.y); maxy = Math.max(maxy, v.y);
    }
    const mx = (minx + maxx) / 2, my = (miny + maxy) / 2;
    right.setFromMatrixColumn(fitCam.matrixWorld, 0);
    up.setFromMatrixColumn(fitCam.matrixWorld, 1);
    const halfH = d * tanH;
    tgt.addScaledVector(right, (mx - cx) * halfH * fitCam.aspect).addScaledVector(up, (my - cy) * halfH);
    const k = Math.max((maxx - minx) / 2 / hx, (maxy - miny) / 2 / hy);
    d = Math.min(1400 * S, Math.max(60 * S, d * Math.pow(k, 0.85)));
  }
  return { p: tgt.clone().addScaledVector(dir, d), t: tgt, d };
}

// The camera's offset from its aim, interpolated in spherical terms: azimuth the shorter way, elevation and log-distance
// linearly. Writes the offset into `out`.
const sphA = new THREE.Spherical(), sphB = new THREE.Spherical(), offA = new THREE.Vector3(), offB = new THREE.Vector3();
function orbitBlend(a: { p: THREE.Vector3; t: THREE.Vector3 }, b: { p: THREE.Vector3; t: THREE.Vector3 }, k: number, out: THREE.Vector3) {
  sphA.setFromVector3(offA.copy(a.p).sub(a.t));
  sphB.setFromVector3(offB.copy(b.p).sub(b.t));
  let dth = sphB.theta - sphA.theta;
  if (dth > Math.PI) dth -= 2 * Math.PI;
  if (dth < -Math.PI) dth += 2 * Math.PI;
  const r = Math.exp(Math.log(Math.max(sphA.radius, 1e-3)) * (1 - k) + Math.log(Math.max(sphB.radius, 1e-3)) * k);
  return out.setFromSphericalCoords(r, sphA.phi + (sphB.phi - sphA.phi) * k, sphA.theta + dth * k);
}

// ---------- the unwrap, told as an event ----------
// A front leaves the epicentres (for the flood, the collapse) and crosses the slab. Behind it the fringes untangle into
// the displacement map and the ground rises; the camera starts low by the event and cranes up as the front spreads.
const FRONT_S = 6.2;
const FRONT_KM = () => {
  let far = 0;
  for (const e of epiUv) for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1]]) far = Math.max(far, Math.hypot((u - e.x) * SX, (v - e.y) * SZ));
  return far + 10 * S;
};
let unwrapTimer = 0;
function unwrapShow(prev: number) {
  clearTimeout(unwrapTimer);
  if (REDUCED || prev > 3) {
    // Coming back from a later chapter, or with reduced motion: the finished map, no show.
    T.to('front', 1, 0);
    T.to('frontLit', 0, 0);
    return;
  }
  T.values.front = 0;
  T.to('front', 1, FRONT_S, 1.1, (t) => 1 - (1 - t) ** 1.45); // quick off the fault, slowing as it spreads
  T.values.frontLit = 0;
  T.to('frontLit', 1, 0.5, 1.0);
  unwrapTimer = window.setTimeout(() => beat === 3 && T.to('frontLit', 0, 1.6), (1.1 + FRONT_S - 1.4) * 1000);
  sound.riser(FRONT_S * 0.9, 1.1);
  // As the front settles: the place's own moment (the break, the groan of the sinking city, the lava), then the bowl.
  setTimeout(() => beat === 3 && mode === 'story' && climaxFx(), (1.1 + FRONT_S * 0.72) * 1000);
  setTimeout(() => beat === 3 && mode === 'story' && sound.reveal(0.4), (1.1 + FRONT_S * 0.9) * 1000);
  // Camera: first down by the event, looking along it…
  if (userCam || epiUv.length === 0) return;
  const c = new THREE.Vector2();
  for (const e of epiUv) c.add(e);
  c.multiplyScalar(1 / epiUv.length);
  const at = new THREE.Vector3(-SX / 2 + c.x * SX, cpuWorldH(c.x, c.y), (c.y - 0.5) * SZ);
  const wide = { p: camTo.p.clone(), t: camTo.t.clone() };
  const dir = wide.p.clone().sub(wide.t);
  const flat = new THREE.Vector3(dir.x, 0, dir.z).normalize();
  const close = at.clone().addScaledVector(flat, 62 * S).add(new THREE.Vector3(0, 30 * S, 0));
  camTo.p.copy(close);
  camTo.t.copy(at).add(new THREE.Vector3(-flat.x * 30 * S, 0, -flat.z * 30 * S));
  // …then up and out over the whole map as the front spreads.
  setTimeout(() => {
    if (beat !== 3 || userCam || mode !== 'story') return;
    camFrom.p.copy(camNow.p);
    camFrom.t.copy(camNow.t);
    camTo.p.copy(wide.p);
    camTo.t.copy(wide.t);
    T.values.cam = 0;
    T.to('cam', 1, FRONT_S - 0.4, 0, easeInOut);
  }, 2600);
}

function flyTo(i: number, dur = 2.6) {
  const b = BEATS[i];
  const shot = b;
  const [p, t] = portrait && shot.camP ? shot.camP : shot.cam;
  camFrom.p.copy(camNow.p);
  camFrom.t.copy(camNow.t);
  // A pass's wide shot also holds the point NISAR comes in from.
  const extra = i === 1 || (i === 2 && beat === 2 && rideKind === 2) ? [new THREE.Vector3(SX / 2 + 34 * S, 64 * S, satZ(0) + approachKm() * 0.55)] : [];
  const pose = fitPose(poseFor(p, t, portrait && !!b.camP), i, i, extra);
  camTo.p.copy(pose.p);
  camTo.t.copy(pose.t);
  controls.maxDistance = Math.max(420 * S, pose.d * 1.6);
  T.values.cam = 0;
  T.to('cam', 1, dur, 0, easeInOut);
}

// Slow drift above the slab while the picker is open.
function orbitPose(now: number) {
  const a = 0.62 + Math.sin(now * 0.045) * 0.5;
  const k = portrait ? 1.5 : 1; // a tall screen shows the slab across its short side, so stand further back
  return poseFor([Math.sin(a) * 470 * k, 340 * k, Math.cos(a) * 470 * k], [0, -6, 0]);
}

// ---------- the opening globe ----------
// The globe sits with its top point on the origin, so when it grows the ground it shows becomes the slab's floor.
const camDir = new THREE.Vector3(0, 0.27, 1).normalize();
const globePlaces = SITES.map((s) => ({ id: s.id, lat: (s.aoi.north + s.aoi.south) / 2, lon: (s.aoi.east + s.aoi.west) / 2 }));
const faceQ = new Map(globePlaces.map((p) => [p.id, faceQuat(p.lat, p.lon, camDir)]));
const topQ = new Map(globePlaces.map((p) => [p.id, topQuat(p.lat, p.lon)]));
const faceNow = new THREE.Quaternion();
// A drag on the globe turns it; left alone for a few seconds it turns back to the chosen place.
const gDrag = { on: false, x: 0, y: 0, yaw: 0, pitch: 0, last: -1e9, id: -1 };
const gUser = new THREE.Quaternion(), gEuler = new THREE.Euler(0, 0, 0, 'YXZ'), gAim = new THREE.Quaternion();
canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'picker' || !globe || $('app').classList.contains('tour')) return;
  Object.assign(gDrag, { on: true, x: e.clientX, y: e.clientY, id: e.pointerId });
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('grabbing');
});
canvas.addEventListener('pointermove', (e) => {
  if (!gDrag.on || e.pointerId !== gDrag.id) return;
  gDrag.yaw += (e.clientX - gDrag.x) * 0.006;
  gDrag.pitch = Math.max(-0.9, Math.min(0.9, gDrag.pitch + (e.clientY - gDrag.y) * 0.005));
  gDrag.x = e.clientX;
  gDrag.y = e.clientY;
  gDrag.last = performance.now();
});
const gRelease = () => {
  gDrag.on = false;
  gDrag.last = performance.now();
  canvas.classList.remove('grabbing');
};
canvas.addEventListener('pointerup', gRelease);
canvas.addEventListener('pointercancel', gRelease);
let globe: Globe | null = null;
let globeSel = SITES[0].id;
let siteReady = false; // a site's fields are on the slab (the slab itself stays hidden until revealed)
const globeLoaded = new THREE.TextureLoader()
  .loadAsync('data/globe.png')
  .then((tex) => {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    tex.wrapS = THREE.RepeatWrapping;
    globe = createGlobe(globePlaces, tex, new THREE.Vector3(-0.55, 0.32, 0.75));
    scene.add(globe.root, globe.stars);
    faceNow.copy(faceQ.get(globeSel)!).premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 1.9)); // it turns into place
    // Large screens then get the sharper picture (4096 wide, a WebP of about 0.4 MB) as soon as it arrives.
    if (Math.max(innerWidth, innerHeight) * Math.min(devicePixelRatio, 2) > 1400) {
      globeHd = new THREE.TextureLoader()
        .loadAsync('data/globe-hd.webp')
        .then((hd) => {
          hd.colorSpace = THREE.SRGBColorSpace;
          hd.anisotropy = renderer.capabilities.getMaxAnisotropy();
          hd.wrapS = THREE.RepeatWrapping;
          renderer.initTexture(hd); // uploaded now, behind the loader, not in the middle of the opening
          globe?.setMap(hd);
        })
        .catch(() => undefined); // the first picture stays
    }
    return true;
  })
  .catch(() => false);

// The dive grows the globe from its picker size to true scale (6,371 km = 6,371 units, the slab's own units),
// geometrically so it reads as a steady approach; the slab grows with it, so it always sits exactly on its patch of Earth.
const TRUE_SCALE = 6371 / GLOBE_R;
let globeHd: Promise<void> = Promise.resolve();
const SLAB_LIFT = 0.02; // globe units between the sphere and the slab laid on it

// Until the dive lands, the slab is laid on the globe at its own place, turning and growing with it: it surfaces
// exactly where its patch of Earth is. At the end of the dive this is the identity and the slab is back at the origin.
const slabM = new THREE.Matrix4(), slabB = new THREE.Matrix4(), slabT = new THREE.Matrix4(), slabS = new THREE.Matrix4();
function placeSlab() {
  const d = T.values.dive;
  if (!globe || d >= 0.9999) {
    terrain.matrix.identity();
    skirt.matrix.identity();
    terrain.matrixWorld.identity();
    skirt.matrixWorld.identity();
    return;
  }
  const lat = (site.aoi.north + site.aoi.south) / 2, lon = (site.aoi.east + site.aoi.west) / 2;
  const up = dirOf(lat, lon);
  const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), up).normalize();
  const north = new THREE.Vector3().crossVectors(up, east);
  slabB.makeBasis(east, up, north.negate());
  slabT.makeTranslation(up.clone().multiplyScalar(GLOBE_R + SLAB_LIFT));
  slabS.makeScale(1 / TRUE_SCALE, 1 / TRUE_SCALE, 1 / TRUE_SCALE);
  slabM.copy(globe.spin.matrixWorld).multiply(slabT).multiply(slabB).multiply(slabS);
  terrain.matrix.copy(slabM);
  skirt.matrix.copy(slabM);
  terrain.matrixWorld.copy(slabM);
  skirt.matrixWorld.copy(slabM);
}
const globeScale = (d: number) => TRUE_SCALE ** d;

// On a landscape screen the globe fills the gap between the header and the cards: measured, not guessed.
const pickerGap = { center: 0, cx: 0, radius: 0 };
function measurePicker() {
  const w = innerWidth, h = innerHeight;
  pickerGap.cx = w / 2;
  if (w / h < 0.8 || h < 560) return void (pickerGap.radius = 0);
  const cards = cardsEl.getBoundingClientRect();
  if (split()) {
    // Wide screens: the list on the left, the globe owns the rest of the screen.
    const left = Math.max(cards.right, document.querySelector('.picker-head')!.getBoundingClientRect().right) + 0.02 * w;
    pickerGap.cx = (left + w) / 2;
    pickerGap.center = h / 2 + 18;
    pickerGap.radius = Math.min(0.33 * h, 0.4 * (w - left));
    return;
  }
  const top = cards.top;
  if (!(top > 120)) return void (pickerGap.radius = 0);
  const head = 64;
  pickerGap.center = (head + top) / 2;
  pickerGap.radius = Math.min(0.44 * (top - head), 0.22 * h);
}
const split = () => innerWidth > 1000 && innerHeight >= 560 && innerWidth / innerHeight >= 0.8;
function globePose(now: number, back = 1) {
  const az = Math.sin(now * 0.06) * 0.1;
  let dist = GLOBE_R * (innerHeight < 560 ? 5.8 : Math.max(8.4, 4.6 / (innerWidth / innerHeight)));
  if (pickerGap.radius > 0) {
    const half = THREE.MathUtils.degToRad(camera.fov / 2);
    dist = GLOBE_R / Math.sin(Math.atan((pickerGap.radius / (innerHeight / 2)) * Math.tan(half)));
  }
  dist *= back;
  const c = new THREE.Vector3(0, -GLOBE_R, 0);
  const d = new THREE.Vector3(Math.sin(az) * 0.966, 0.26, Math.cos(az) * 0.966);
  return { p: c.clone().addScaledVector(d, dist), t: c };
}
const pickerPose = (now: number) => (globe ? globePose(now) : orbitPose(now));

// ---------- the opening ----------
// The Earth alone, with NISAR going round it and painting its swath; the title; then the places light up and the picker
// rises. Any click, key or scroll skips it; ?site= deep links and reduced motion never see it.
let introOn = false;
function introPose(now: number, back = 1) {
  const az = 0.35 + Math.sin(now * 0.05) * 0.12;
  const half = THREE.MathUtils.degToRad(camera.fov / 2);
  const r = innerWidth / innerHeight < 0.8 ? 0.34 : 0.25; // globe radius as a share of the screen height
  const dist = (GLOBE_R / Math.sin(Math.atan(r * 2 * Math.tan(half)))) * back;
  const c = new THREE.Vector3(0, -GLOBE_R, 0);
  const d = new THREE.Vector3(Math.sin(az) * 0.97, 0.22, Math.cos(az) * 0.97).normalize();
  return { p: c.clone().addScaledVector(d, dist), t: c };
}
function startIntro() {
  introOn = true;
  mode = 'picker';
  $('app').dataset.mode = 'picker';
  $('app').classList.add('opening');
  syncInert();
  T.values.pins = 0;
  T.to('orbit', 1, 2.4, 1.2);
  setTimeout(() => introOn && $('app').classList.add('opening-title'), 1700);
  const now = performance.now() / 1000;
  const a = introPose(now, 2.6), b = introPose(now);
  camNow.p.copy(a.p);
  camNow.t.copy(a.t);
  camFrom.p.copy(a.p);
  camFrom.t.copy(a.t);
  camTo.p.copy(b.p);
  camTo.t.copy(b.t);
  T.values.cam = 0;
  T.to('cam', 1, 6.5, 0, easeInOut);
  // The gesture that ends the opening does only that: it must not also press the card that appears under it.
  const swallow = (e: Event) => (e.stopPropagation(), e.preventDefault());
  const skip = (e?: Event) => {
    if (!introOn) return;
    for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) removeEventListener(ev, skip, { capture: true });
    if (e) {
      e.stopPropagation();
      if (e.type === 'pointerdown') {
        addEventListener('click', swallow, { capture: true, once: true });
        setTimeout(() => removeEventListener('click', swallow, { capture: true }), 700); // only this gesture's click
      }
    }
    endIntro();
  };
  for (const ev of ['pointerdown', 'keydown', 'wheel'] as const) addEventListener(ev, skip, { capture: true });
  setTimeout(() => skip(), 9000);
}
function endIntro() {
  if (!introOn || mode !== 'picker') return;
  introOn = false;
  $('app').classList.remove('opening', 'opening-title');
  syncInert();
  T.to('pick', 1, 1.8, 0.2);
  T.to('epi', 1, 1.6, 0.6);
  T.to('pins', 1, 2.4, 0.6, linear);
  T.to('orbit', 0.55, 2.4);
  camFrom.p.copy(camNow.p);
  camFrom.t.copy(camNow.t);
  const o = pickerPose(performance.now() / 1000);
  camTo.p.copy(o.p);
  camTo.t.copy(o.t);
  T.values.cam = 0;
  T.to('cam', 1, 2.6, 0, easeInOut);
}

// Names beside the markers: they are buttons too, so the globe can be used without the cards.
const gLabels = document.createElement('div');
gLabels.id = 'globeLabels';
gLabels.className = 'globe-labels';
$('app').appendChild(gLabels);
const gLabelEls = new Map<string, HTMLButtonElement>();
for (const st of SITES) {
  const b = document.createElement('button');
  b.className = 'gpin';
  b.innerHTML = `<i></i><b>${st.name}</b><em>${shortDate(new Date(st.date).toISOString().slice(0, 10))} · ${st.tag}</em>`;
  b.onmouseenter = () => mode === 'picker' && void previewSite(st);
  b.onfocus = () => mode === 'picker' && void previewSite(st);
  b.onclick = () => void enterSite(st);
  gLabels.appendChild(b);
  gLabelEls.set(st.id, b);
}
const gTmp = new THREE.Vector3(), gN = new THREE.Vector3(), gV = new THREE.Vector3();
function updateGlobe(dt: number, now: number, alpha: number) {
  if (!globe) return;
  const V = T.values;
  globe.setAlpha(alpha);
  if (!gDrag.on && performance.now() - gDrag.last > 3500) {
    const k = Math.exp(-dt * 1.4);
    gDrag.yaw *= k;
    gDrag.pitch *= k;
  }
  if (mode !== 'picker') gDrag.yaw = gDrag.pitch = 0;
  gUser.setFromEuler(gEuler.set(gDrag.pitch, gDrag.yaw, 0));
  gAim.copy(faceQ.get(globeSel)!).premultiply(gUser);
  faceNow.slerp(gAim, 1 - Math.exp(-dt * (gDrag.on ? 14 : 2.4)));
  // The place turns up to meet the camera in the first half of the dive, so the descent always falls onto it (turning
  // in step, a place at 55°N would put the pole under the camera halfway down).
  const turn = Math.min(1, V.dive / 0.55);
  globe.spin.quaternion.copy(faceNow).slerp(topQ.get(globeSel)!, turn * turn * (3 - 2 * turn));
  const sc = globeScale(V.dive);
  globe.root.scale.setScalar(sc);
  globe.root.position.set(0, -(GLOBE_R + SLAB_LIFT) * sc, 0); // the slab rides a hair above the sphere, never through it
  globe.root.updateMatrixWorld(true);
  placeSlab();
  if (alpha <= 0.003) {
    gLabels.classList.remove('on');
    return;
  }
  globe.update(now, globeSel, V.dive, sc, V.orbit, V.pins);
  // The footprint marks the chosen place on the picker and grows brighter as the dive goes into it.
  const selSite = siteById(globeSel);
  globe.setFootprint(selSite?.aoi ?? null, (mode === 'picker' && !introOn ? 0.55 : 0) + Math.sin(Math.PI * Math.min(1, V.dive / 0.6)) * 0.8 * (V.dive < 0.6 ? 1 : 0));
  const show = mode === 'picker' && V.dive < 0.02;
  gLabels.classList.toggle('on', show);
  if (!show) return;
  for (const st of SITES) {
    const pin = globe.pins.get(st.id)!;
    const el = gLabelEls.get(st.id)!;
    pin.getWorldPosition(gTmp);
    gN.copy(pin.userData.dir).applyQuaternion(globe.spin.quaternion);
    gV.copy(camera.position).sub(gTmp).normalize();
    const facing = gN.dot(gV);
    gTmp.project(camera);
    const x = (gTmp.x * 0.5 + 0.5) * innerWidth, y = (-gTmp.y * 0.5 + 0.5) * innerHeight;
    el.style.opacity = String(Math.max(0, Math.min(1, (facing - 0.32) / 0.28)) * alpha);
    el.style.pointerEvents = facing > 0.45 ? 'auto' : 'none';
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    el.classList.toggle('sel', st.id === globeSel);
  }
}

function sweep(key: 'pass1' | 'pass2', dur: number, delay = 0.5) {
  T.values[key] = 0;
  T.to(key, 1, dur, delay, linear);
}

// Where the satellite is along its pass, and the camera that travels with it.
// A pass is told as a sequence: the camera settles on a wide shot while NISAR comes in from beyond the slab, flies to
// it as it reaches the edge, rides with it across, and returns to the wide shot on the finished picture.
const PASS_S = 5.5; // seconds a pass takes to sweep the slab
const PASS_DELAY = 3.6; // NISAR's approach, seen from the wide shot, before its beam reaches the slab
const RIDE_AT = 2.3; // the camera leaves the wide shot for the satellite
const RIDE_IN = 2.3; // …and takes this long to reach it
const RIDE_OUT = 2.9; // the return to the wide shot
const satZ = (pass: number) => SZ / 2 + 6 * S - pass * (SZ + 12 * S);
// Before the pass, NISAR is still coming: at the pass's own speed, so the approach and the sweep are one motion.
const approachKm = () => (SZ + 12 * S) * (PASS_DELAY / PASS_S);
const satNow = (pass: number, approach: number) => (pass > 0 ? satZ(pass) : satZ(0) + (1 - approach) * approachKm());
function ridePose(kind: 1 | 2, z: number) {
  const satX = SX / 2 + 34 * S, satY = 64 * S;
  if (kind === 1) {
    // Over the shoulder: just behind NISAR on its line of sight, looking past the reflector at the strip it is imaging.
    const sat = new THREE.Vector3(satX, satY, z);
    const t = new THREE.Vector3(SX * 0.02, -2 * S, z - 30 * S);
    const back = sat.clone().sub(t).normalize();
    const side = new THREE.Vector3().crossVectors(back, new THREE.Vector3(0, 1, 0)).normalize();
    return { p: sat.addScaledVector(back, 72 * S).addScaledVector(side, 16 * S).add(new THREE.Vector3(0, 12 * S, 0)), t };
  }
  // In profile from the far (west) side of the swath: NISAR in the sky beyond, its beam crossing the ground towards
  // the camera, and the interferogram spreading behind the beam as it moves north.
  return {
    p: new THREE.Vector3(-SX * 0.7, 52 * S, z + 40 * S),
    t: new THREE.Vector3(SX * 0.2, 26 * S, z - 6 * S),
  };
}
let rideTimer2 = 0;
function startRide(kind: 1 | 2, beatNo: number) {
  rideKind = kind;
  clearTimeout(rideTimer);
  clearTimeout(rideTimer2);
  // NISAR comes in at once, seen from the wide shot.
  T.values.approach = 0;
  T.to('approach', 1, REDUCED ? 0.01 : PASS_DELAY, 0, linear);
  if (REDUCED) return;
  rideTimer2 = window.setTimeout(() => {
    if (beat !== beatNo || userCam) return;
    T.to('ride', 1, RIDE_IN, 0, easeInOut);
    sound.whoosh(RIDE_IN + 0.3);
  }, RIDE_AT * 1000);
  // Back to the wide shot as the pass ends, onto the finished picture.
  rideTimer = window.setTimeout(() => {
    if (beat !== beatNo) return;
    // The return frames the finished picture alone: NISAR's approach point no longer needs to be in shot.
    // The camera is on the satellite at this moment, so changing the base pose is invisible until the blend back.
    const b = BEATS[beatNo];
    const [p, t] = portrait && b.camP ? b.camP : b.cam;
    const pose = fitPose(poseFor(p, t, portrait && !!b.camP), beatNo);
    camFrom.p.copy(pose.p);
    camFrom.t.copy(pose.t);
    camTo.p.copy(pose.p);
    camTo.t.copy(pose.t);
    T.to('ride', 0, RIDE_OUT, 0, easeInOut);
    sound.whoosh(RIDE_OUT, false);
  }, (PASS_DELAY + PASS_S - 0.4) * 1000);
}

// ---------- site switching ----------
function textureOf(data: Uint16Array, w: number, h: number, fmt: THREE.PixelFormat) {
  const t = new THREE.DataTexture(data, w, h, fmt, THREE.HalfFloatType);
  t.minFilter = t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

const maxReliefOf = (h: ArrayLike<number>, vex: number) => {
  let m = 0;
  for (let k = 0; k < h.length; k++) if (h[k] > m) m = h[k];
  return m * 0.001 * vex;
};

function applySite(s: SiteDef, f: Fields, meta: TerrainMeta) {
  const tA = performance.now();
  site = s;
  F = f;
  [SX, SZ] = f.sizeKm;
  S = Math.max(SX / REF_WIDTH_KM, (SZ / 143) * 0.85); // squarer slabs need the camera further back
  mapper = makeMapper(s.aoi);
  const rm = realMeta.get(s.id);
  const series: any[] = !f.synthetic && (rm?.series?.length ?? 0) > 1 ? rm!.series : [];
  PAIRS = series.length
    ? series.map((p) => ({ ref: p.ref, sec: p.sec, event: !!p.event, file: p.file, hasDcoh: !!p.hasDcoh, stats: p }))
    : [{ ref: s.pair.ref, sec: s.pair.sec, event: true, hasDcoh: false }];
  evIdx = Math.max(0, PAIRS.findIndex((p) => p.event));
  pairIdx = pairWant = evIdx;
  BEATS = beatsFor(s, !f.synthetic, PAIRS.length > 1 ? PAIRS : []);
  passA = dayMs(PAIRS[0].ref);
  passB = dayMs(PAIRS[PAIRS.length - 1].sec);
  eventAt = s.eventAt;
  // A boundary belongs to the following pair in pairAt(). Start just inside
  // the event pair so Explore actually opens on the observations we describe.
  tFrac = Math.min(1, fracOf(dayMs(PAIRS[evIdx].sec) - 1000));
  playing = false;
  peak = (f.losMax - f.losMin) * 100;

  dataTex?.dispose();
  changeTex?.dispose();
  dataTex = textureOf(f.packed, f.W, f.H, THREE.RGBAFormat);
  changeTex = textureOf(f.packedChange, f.W, f.H, THREE.RGFormat);
  U.uData.value = dataTex;
  U.uChangeTex.value = changeTex;
  dataTex2?.dispose();
  changeTex2?.dispose();
  dataTex2 = changeTex2 = null;
  xfPending = false;
  T.values.xf = 0;
  U.uXf.value = 0;
  U.uData2.value = emptyTex;
  U.uChange2.value = emptyChange;
  if (PAIRS.length > 1) {
    dataTex2 = textureOf(f.packed.slice(), f.W, f.H, THREE.RGBAFormat);
    changeTex2 = textureOf(f.packedChange.slice(), f.W, f.H, THREE.RGFormat);
    U.uData2.value = dataTex2;
    U.uChange2.value = changeTex2;
  }
  U.uTexel.value.set(1 / f.W, 1 / f.H);
  U.uSize.value.set(SX, SZ);
  // With a real signal the colour scale follows the data (never tighter than the site's own); and where the real map
  // shows no measurable motion, atmospheric noise must not lift the terrain.
  range = f.range;
  // The relief's lift is clamped to this colour scale, so it is built once the scale is known.
  liftTex?.dispose();
  liftTex2?.dispose();
  liftCPU = f.lift; // smoothed in the field worker
  liftTex = textureOf(f.liftH, f.W, f.H, THREE.RedFormat);
  U.uLiftTex.value = liftTex;
  liftTex2 = PAIRS.length > 1 ? textureOf(f.liftH.slice(), f.W, f.H, THREE.RedFormat) : null;
  U.uLiftTex2.value = liftTex2 ?? emptyLift;
  quietReal = !f.synthetic && s.kind === 'quake-normal';
  liftKm = quietReal ? 0 : s.liftKm;
  U.uVex.value = s.vex;
  U.uLiftKm.value = liftKm;
  U.uRange.value = range;
  U.uIso.value = range / 7;
  U.uS.value = S;
  U.uWaveR.value = SX * 0.62;
  U.uBase.value = BASE_KM * S;
  U.uLook.value.set(s.look[0], s.look[2], -s.look[1]).normalize();
  T.values.disp = 1;

  // The mesh arrives built from the field worker: wrapping it costs nothing on this thread.
  terrain.geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(f.grid.pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(f.grid.uv, 2));
  g.setIndex(new THREE.BufferAttribute(f.grid.index, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.hypot(SX, SZ)); // the shader lifts the ground: no tight bounds
  terrain.geometry = g;
  ghost.geometry = g;
  // One stem every ~1/64 of the slab's long side; the ghost's grid a little coarser.
  {
    const long = Math.max(SX, SZ), nx = Math.round((64 * SX) / long), nz = Math.round((64 * SZ) / long);
    const uv = new Float32Array(nx * nz * 2);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) uv.set([(i + 0.5) / nx, (j + 0.5) / nz], (j * nx + i) * 2);
    stemGeo.setAttribute('aUv', new THREE.InstancedBufferAttribute(uv, 2));
    stemGeo.instanceCount = nx * nz;
    ghostU.uGrid.value = long / 30;
    ghostU.uStemW.value = (long / 64) * 0.06;
  }
  clouds.scale.set(SX, 1, SZ);
  clouds.position.y = maxReliefOf(f.heights, s.vex) + 9 * S;
  skirt.geometry.dispose();
  skirt.geometry = skirtGeometry(900, SX, SZ);
  track.geometry.dispose();
  track.geometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(SX / 2 + 34 * S, 64 * S, SZ),
    new THREE.Vector3(SX / 2 + 34 * S, 64 * S, -SZ),
  ]);
  track.computeLineDistances();
  trackMat.dashSize = 2 * S;
  trackMat.gapSize = 3 * S;
  satHalo.scale.setScalar(30 * S);
  satCore.scale.setScalar(5 * S);
  siteReady = true;

  controls.minDistance = 25 * S;
  controls.maxDistance = 420 * S;

  maxRelief = 0;
  for (let k = 0; k < f.heights.length; k++) if (f.heights[k] > maxRelief) maxRelief = f.heights[k];
  maxRelief = maxRelief * 0.001 * s.vex + 2.5 * S;

  epiUv.length = 0;
  for (const e of s.epicentres) epiUv.push(new THREE.Vector2(mapper.u(e.lon), mapper.v(e.lat)));
  for (let m = 0; m < 2; m++) U.uEpi.value[m].set(epiUv[m]?.x ?? 0, epiUv[m]?.y ?? 0, 0, 1);

  buildAnchors();
  buildChapters();
  buildTimeline();
  renderChrome();

  $('app').dataset.kind = s.kind;
  $('modeDisp').textContent = isFlood() ? 'Change' : 'Displacement';
  // Chapter 3's number: a published figure for the flood, what the data measures for the others.
  heroKind = site.hero ? 'fixed' : site.kind === 'subsidence' ? 'sink' : isFlood() ? 'area' : 'p2p';
  lostKm2 = 0;
  if (heroKind === 'area') {
    const px = (SX * SZ) / (f.W * f.H);
    for (let k = 0; k < f.dcoh.length; k++) if (f.dcoh[k] > 0.3 && f.coh[k] < 0.5) lostKm2 += px;
  }
  sinkCm = 0;
  if (heroKind === 'sink') {
    const v: number[] = [];
    for (let k = 0; k < f.los.length; k += 7) if (f.coh[k] > 0.3) v.push(f.los[k]);
    v.sort((a, b) => a - b);
    sinkCm = v.length ? -v[Math.floor(v.length * 0.005)] * 100 : 0; // the fastest-sinking 0.5%
  }
  const heroUnit = heroKind === 'fixed' ? site.hero!.unit : heroKind === 'area' ? 'km²' : 'cm';
  $('heroUnit').textContent = heroUnit;
  $('heroLabel').textContent =
    heroKind === 'fixed' ? site.hero!.label
    : heroKind === 'area' ? 'of surface remade · this pair'
    : heroKind === 'sink' ? `sunk at the fastest · since ${fmtDate(dayMs(PAIRS[0].ref))}`
    : 'peak-to-peak · line of sight';
  $('heroCompare').textContent = heroCompare();
  if (params.has('debug')) console.info(`[apply] total ${Math.round(performance.now() - tA)} ms`);
}

const epiUv: THREE.Vector2[] = [];

// The hero number in everyday terms: a length against the body, a rate per year, an area in football pitches.
function heroCompare() {
  const cm = (v: number) =>
    v < 1 ? 'less than a pencil’s thickness'
    : v < 3 ? 'a finger’s width'
    : v < 10 ? 'the width of a phone'
    : v < 25 ? 'a hand span'
    : v < 45 ? 'a forearm'
    : v < 80 ? 'knee height'
    : v < 150 ? 'waist height'
    : 'more than a person’s height';
  if (site.kind === 'subsidence' && PAIRS.length > 1) {
    const days = (dayMs(PAIRS[PAIRS.length - 1].sec) - dayMs(PAIRS[0].ref)) / 86400000;
    const v = heroKind === 'fixed' ? site.hero!.value : sinkCm;
    return `≈ ${Math.round((v * 365) / days)} cm a year at this pace`;
  }
  if (heroKind === 'fixed' && site.hero!.unit === 'km²') return `≈ ${Math.round(site.hero!.value / 0.00714 / 10) * 10} football pitches`;
  if (heroKind === 'fixed' && site.hero!.unit === 'km') return `≈ ${(site.hero!.value / 42.195).toFixed(1)} marathons of valley`;
  if (heroKind === 'area') return `≈ ${Math.round(lostKm2 / 0.00714 / 10) * 10} football pitches`;
  if (heroKind === 'p2p' && !quietReal) return `≈ ${cm(peak)}`;
  return '';
}

function resetTweens() {
  for (const k of ['pass1', 'pass2', 'amp', 'fringe', 'unwrap', 'lift', 'coh', 'change', 'wave', 'night', 'cloud', 'approach'] as const) T.to(k, 0, 0);
  rollActive = false;
  roll = 0;
  beamVis = 0;
}

let switchToken = 0;
const veil = $('veil');
async function loadSite(s: SiteDef) {
  const token = ++switchToken;
  if (!(mode === 'picker' && globe)) veil.classList.add('on'); // over the globe the slab is hidden anyway: no blackout
  const [f, terrainData] = await Promise.all([loadFields(s), loadTerrain(s)]);
  await new Promise((r) => setTimeout(r, 260));
  if (token !== switchToken) return false;
  resetTweens();
  applySite(s, f, terrainData.meta);
  veil.classList.remove('on');
  return true;
}

// Layers that are not showing must not take focus either.
function syncInert() {
  const set = (sel: string, off: boolean) => {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) el.inert = off;
  };
  set('#picker', mode !== 'picker' || introOn);
  set('#intro', !introOn);
  set('#globeLabels', mode !== 'picker');
  set('.nav', mode !== 'story');
  set('#explore', !(mode === 'story' && beat === 5));
  set('#about', !$('about').classList.contains('on'));
  set('#guide', !$('guide').classList.contains('on'));
  set('#keys', !$('keys').classList.contains('on'));
  set('#legend', true);
}

// ---------- chapters ----------
function go(i: number) {
  const prev = beat;
  const first = prev === -1;
  beat = (i + BEATS.length) % BEATS.length;
  const b = BEATS[beat];
  // A hover reading belongs to the previous chapter and must not follow a camera transition.
  $('probe').classList.remove('on');
  U.uProbe.value.z = 0;
  releaseCam();
  rollActive = false;
  clearTimeout(rideTimer);
  clearTimeout(rideTimer2);
  clearTimeout(unwrapTimer);
  if (beat !== 3) (T.to('front', 1, 0), T.to('frontLit', 0, 0.4));
  climaxOn = false;
  $('app').classList.remove('climax');
  T.to('ride', 0, 1.8, 0, easeInOut);
  if (beat !== 5) settleEventPair();
  flyTo(beat, first ? INTRO_S : 2.6);

  const done = (k: 'pass1' | 'pass2') => T.to(k, 1, 0);
  if (beat !== 1) T.to('cloud', 0, 1.4);
  if (beat !== 1 && beat !== 2) T.to('night', 0, 1.6);
  const pairDisp = 1;
  const flood = isFlood();
  // The old ground and its stems: once the motion is unwrapped, and in Explore.
  const ghostOn = (beat === 3 || beat === 5) && !flood && liftKm > 0;
  T.to('ghost', ghostOn ? 1 : 0, ghostOn ? 2.2 : 0.8, ghostOn && beat === 3 ? 1.1 + FRONT_S * 0.35 : 0);

  const placesOn = beat !== 1 && beat !== 2;
  T.to('places', placesOn ? 1 : 0, placesOn ? 1.2 : 0.4, placesOn ? (first ? INTRO_S - 0.8 : 1.4) : 0);
  T.to('epi', beat === 0 ? 1 : beat === 5 ? 0.55 : 0, beat === 0 ? 1.4 : 0.6, beat === 0 ? (first ? 0.6 : 1) : 0);

  // The seismic wave plays once when the story opens on the surface, and again whenever chapter 0 is revisited.
  T.to('wave', 0, 0);
  if (beat === 0 && !REDUCED && !noEvent()) {
    const at = first ? INTRO_S * 0.75 : 1.3;
    T.to('wave', 1, 6.5, at, linear);
    setTimeout(() => beat === 0 && mode === 'story' && (sound.boom(), shake(0.6, 1.4)), at * 1000);
  }

  switch (beat) {
    case 0:
      for (const k of ['amp', 'fringe', 'unwrap', 'lift', 'coh', 'change'] as const) T.to(k, 0, 1.2);
      T.to('pass1', 0, 0, 1.3);
      T.to('pass2', 0, 0, 1.3);
      T.to('disp', pairDisp, 0.8);
      break;
    case 1:
      T.to('amp', 1, 0.6);
      for (const k of ['fringe', 'unwrap', 'lift', 'coh', 'change'] as const) T.to(k, 0, 0.8);
      T.to('pass2', 0, 0, 0.8);
      // Night falls and cloud rolls in over the optical view; the radar picture comes through both.
      T.to('night', 1, 2.2, 0.2);
      T.to('cloud', 1, 2.4, 0.4);
      rideKind = 1;
      sweep('pass1', PASS_S, REDUCED ? 0.5 : PASS_DELAY);
      startRide(1, 1);
      break;
    case 2:
      done('pass1');
      T.to('amp', 1, 0.6);
      T.to('fringe', 1, 0.01);
      for (const k of ['unwrap', 'lift', 'coh', 'change'] as const) T.to(k, 0, 1.2);
      T.to('disp', pairDisp, 0.8);
      T.to('cloud', 0, 1.6);
      T.to('night', 0, 2.4, 1);
      if (prev === 1) {
        rideKind = 2;
        sweep('pass2', PASS_S, REDUCED ? 0.5 : PASS_DELAY);
        startRide(2, 2);
      } else done('pass2');
      setTimeout(() => (rollActive = beat === 2), prev === 1 ? (PASS_DELAY + PASS_S + 0.8) * 1000 : 400);
      break;
    case 3:
      done('pass1');
      done('pass2');
      T.to('amp', 1, 0.3);
      T.to('fringe', 1, 0.3);
      if (flood) {
        T.to('unwrap', 0, 0.8);
        T.to('lift', 0, 0.8);
        T.to('change', 1, 0.6, 0.2);
      } else {
        T.to('unwrap', 1, 0.6, 0.2);
        T.to('lift', 1, 0.6, 0.2);
        T.to('change', 0, 0.8);
      }
      unwrapShow(prev);
      T.to('coh', 0, 1);
      T.to('disp', pairDisp, 0.8);
      break;
    case 4:
      done('pass1');
      done('pass2');
      T.to('fringe', 1, 0.3);
      T.to('change', 0, 0.8);
      T.to('unwrap', flood ? 0 : 1, 0.8);
      T.to('lift', flood ? 0 : 1, 1.2);
      T.to('coh', 1, 0.4, 0.4);
      // The coherence check sweeps across the map rather than switching on.
      T.values.cohWipe = REDUCED || prev > 4 ? 1 : 0;
      if (!REDUCED && prev <= 4) T.to('cohWipe', 1.02, 3.4, 0.7, easeInOut);
      break;
    case 5:
      done('pass1');
      done('pass2');
      T.to('fringe', 1, 0.3);
      setExplore();
      break;
  }
  renderCopy(b, first ? INTRO_S * 1000 * 0.55 : 380);
  narrateChapter(b, beat, first);
  if (portrait) {
    // Upright screens frame the slab under the words, and the new words are only written once the old ones fade:
    // aim again at the free area they leave, while the flight is still young.
    const me = beat;
    setTimeout(() => {
      if (beat !== me || userCam || T.values.ride > 0.001 || T.values.cam > 0.5 || mode !== 'story') return;
      const [p, t] = b.camP ?? b.cam;
      const pose = fitPose(poseFor(p, t, !!b.camP), me);
      camTo.p.copy(pose.p);
      camTo.t.copy(pose.t);
    }, first ? INTRO_S * 1000 * 0.55 + 120 : 520);
  }
  postShock = isPostShock(); // Explore opens on the finished event pair: that is not a crossing
  armFreeCam(beat); // once the chapter's own move has landed (a deep link flies for longer)
  syncInert();
  if (mode === 'story') {
    const q = new URLSearchParams(location.search);
    if (beat > 0) q.set('ch', String(beat));
    else q.delete('ch');
    history.replaceState(null, '', `?${q.toString().replace(/=(?=&|$)/g, '')}`);
  }
  showHint(beat);
}

function setExplore() {
  const disp = exploreMode === 'displacement';
  const flood = isFlood();
  T.to('unwrap', disp && !flood ? 1 : 0, 1.4);
  T.to('lift', disp && !flood ? 1 : 0, 1.6, disp && !flood ? 0.6 : 0);
  T.to('change', disp && flood ? 1 : 0, 1.4);
  T.to('coh', exploreCoh ? 1 : 0, 0.9);
  T.to('disp', dispFor(tFrac), 0.9);
  $('modeFringes').classList.toggle('on', !disp);
  $('modeDisp').classList.toggle('on', disp);
  $('cohToggle').classList.toggle('on', exploreCoh);
  renderLegend();
  renderTimeline();
}

// ---------- UI ----------
function gradient(m: Uint8Array, stops = 18) {
  const parts: string[] = [];
  for (let s = 0; s < stops; s++) {
    const k = Math.round((s / (stops - 1)) * 255);
    parts.push(`rgb(${m[k * 3]},${m[k * 3 + 1]},${m[k * 3 + 2]})`);
  }
  return `linear-gradient(to top, ${parts.join(',')})`;
}
const cmRange = (r: number) => (r >= 0.1 ? `${Math.round(r * 100)} cm` : `${(r * 100).toFixed(0)} cm`);

function legendFor(key: 'radar' | 'phase' | 'disp' | 'change' | 'coh') {
  switch (key) {
    case 'radar': return { title: 'Radar backscatter', bar: gradient(grayC), ticks: ['bright', '', 'dark'], note: 'L-band · HH' };
    case 'phase': return { title: 'Wrapped phase', bar: gradient(romaO, 24), ticks: ['+π', '0', '−π'], note: '1 cycle = 12.1 cm' };
    case 'disp':
      return {
        title: 'Towards / away', bar: gradient(berlin),
        ticks: [`+${cmRange(range)} toward`, '0', `−${cmRange(range)} away`],
        note: liftKm > 0 ? 'motion exaggerated' : 'along satellite view',
      };
    case 'change':
      return {
        title: 'Coherence lost',
        bar: 'linear-gradient(to top, #080708, #e64d33 55%, #ffdb8c)',
        ticks: ['total', 'partial', 'none'],
        note: site.kind === 'volcano' ? 'vs the slopes around it' : 'vs a pre-event pair',
      };
    case 'coh':
      return {
        title: 'Coherence',
        bar: 'linear-gradient(to top, rgba(236,232,224,.06), rgba(236,232,224,.95))',
        ticks: ['1', '0.5', '0'],
        note: 'low → radar static',
      };
  }
}

function renderLegend() {
  const el = $('legend');
  let key: 'radar' | 'phase' | 'disp' | 'change' | 'coh' | null = null;
  const flood = isFlood();
  if (beat === 1) key = 'radar';
  if (beat === 2) key = 'phase';
  if (beat === 3) key = flood ? 'change' : 'disp';
  if (beat === 4) key = 'coh';
  if (beat === 5) key = exploreMode === 'displacement' ? (flood ? 'change' : 'disp') : 'phase';
  el.classList.toggle('on', key !== null && mode === 'story');
  if (!key) return;
  const L = legendFor(key);
  $('lgTitle').textContent = L.title;
  $('lgBar').style.background = L.bar;
  $('lgMax').textContent = L.ticks[0];
  $('lgMid').textContent = L.ticks[1];
  $('lgMin').textContent = L.ticks[2];
  $('lgNote').textContent = L.note;
}

let copyTimer = 0;
function renderCopy(b: Beat, delay = 380) {
  const copy = $('copy');
  copy.classList.add('out');
  clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => {
    $('eyebrow').textContent = b.eyebrow;
    $('headline').innerHTML = b.title;
    $('sub').textContent = b.sub;
    copy.classList.remove('out');
  }, delay);
  $('nextLabel').textContent = b.next;
  $('prev').toggleAttribute('disabled', beat === 0);
  document.querySelectorAll<HTMLElement>('#chapters li').forEach((li, i) => {
    li.classList.toggle('on', i === beat);
    li.classList.toggle('past', i < beat);
  });
  document.querySelectorAll<HTMLElement>('#dots i').forEach((d, i) => {
    d.classList.toggle('on', i === beat);
    d.classList.toggle('past', i < beat);
  });
  $('app').dataset.beat = String(beat);
  $('hero').classList.toggle('on', !quietReal && (beat === 3 || (beat === 4 && !isFlood())));
  $('explore').classList.toggle('on', beat === 5);
  renderLegend();
}

function buildChapters() {
  const ol = $('chapters');
  ol.replaceChildren();
  $('dots').innerHTML = BEATS.map(() => '<i></i>').join('');
  BEATS.forEach((b, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<button><span>${String(i + 1).padStart(2, '0')}</span>${b.label}</button>`;
    li.querySelector('button')!.onclick = () => (filmStop(), go(i));
    ol.appendChild(li);
  });
}

function hemisphere(v: number, pos: string, neg: string) {
  return `${Math.abs(v).toFixed(2)}°${v >= 0 ? pos : neg}`;
}
function renderChrome() {
  $('siteName').textContent = site.name;
  const c = document.getElementById('chip')!;
  c.innerHTML = F.synthetic ? 'Synthetic signal<span class="lg"> · real terrain</span>' : 'NISAR GUNW<span class="lg"> · real signal</span>';
  c.classList.toggle('real', !F.synthetic);
  const lat0 = (site.aoi.north + site.aoi.south) / 2, lon0 = (site.aoi.east + site.aoi.west) / 2;
  $('coords').textContent = `${hemisphere(lat0, 'N', 'S')} ${hemisphere(lon0, 'E', 'W')}`;
  document.title = `Invisible Earth · ${site.name}`;
}

// Loads one pair's raster on demand (the event pair is already on the GPU).
function ensurePair(i: number): Promise<void> {
  const p = PAIRS[i];
  if (!p.file || p.los) return Promise.resolve();
  const sid = site.id, W = F.W, H = F.H;
  p.loading ??= (async () => {
    const raw = await (await fetch(`data/${sid}/${p.file}`)).arrayBuffer();
    const r = await pairJob(raw, W, H, range, !!p.hasDcoh); // half floats and the smoothed lift, off this thread
    const n = W * H, b = r.buf;
    p.los = new Float32Array(b, 0, n);
    p.losH = r.losH;
    p.lift = r.lift;
    p.liftH = r.liftH;
    p.coh8 = new Uint8Array(b, n * 4, n);
    if (p.hasDcoh) p.dcoh8 = new Uint8Array(b, n * 5, n);
  })();
  return p.loading;
}

function prefetchSeries() {
  if (PAIRS.length < 2) return;
  const chain = PAIRS;
  chain.forEach((_, i) => setTimeout(() => chain === PAIRS && void ensurePair(i), 2500 + 900 * i));
}

// Writes a pair's line of sight, coherence and coherence loss into the next-pair textures (and the CPU-side arrays the probe reads).
const H16 = new Uint16Array(256);
function writePair(i: number) {
  const p = PAIRS[i];
  if (!p.los || !p.losH || !p.coh8 || !p.lift || !p.liftH || !dataTex2 || !changeTex2) return false;
  const n = F.W * F.H;
  const packed = dataTex2.image.data as Uint16Array;
  const change = changeTex2.image.data as Uint16Array;
  for (let v = 0; v < 256; v++) H16[v] = toHalf(v / 255);
  const d8 = p.dcoh8, losH = p.losH;
  F.los.set(p.los);
  for (let k = 0; k < n; k++) {
    packed[k * 4 + 1] = losH[k];
    const c8 = p.coh8[k];
    F.coh[k] = c8 / 255;
    packed[k * 4 + 2] = H16[c8];
    const dd = d8 ? d8[k] : 0;
    F.dcoh[k] = dd / 255;
    change[k * 2] = H16[dd];
  }
  dataTex2.needsUpdate = true;
  changeTex2.needsUpdate = true;
  if (liftTex2) {
    (liftTex2.image.data as Uint16Array).set(p.liftH);
    liftTex2.needsUpdate = true;
    liftCPU = p.lift;
  }
  return true;
}

// The crossfade has landed: the next pair becomes the current one and the two textures swap roles.
function settleCrossfade() {
  if (!xfPending || !dataTex || !dataTex2 || !changeTex || !changeTex2) return;
  [dataTex, dataTex2] = [dataTex2, dataTex];
  [changeTex, changeTex2] = [changeTex2, changeTex];
  U.uData.value = dataTex;
  U.uData2.value = dataTex2;
  U.uChangeTex.value = changeTex;
  U.uChange2.value = changeTex2;
  if (liftTex && liftTex2) {
    [liftTex, liftTex2] = [liftTex2, liftTex];
    U.uLiftTex.value = liftTex;
    U.uLiftTex2.value = liftTex2;
  }
  T.to('xf', 0, 0);
  U.uXf.value = 0;
  xfPending = false;
}

const PAIR_S = 3.4; // seconds of playback per pair
const EV_W = 10 * 3600e3; // half-width of the shock's ramp, as in stepAt
// Screen progress u (0..1) of the event pair against its time fraction: 38% before the ramp, 24% across it, 38% after.
const screenOf = (l: number, e0: number, e1: number) =>
  l < e0 ? (l / e0) * 0.38 : l < e1 ? 0.38 + ((l - e0) / (e1 - e0)) * 0.24 : 0.62 + ((l - e1) / (1 - e1)) * 0.38;
const localOf = (u: number, e0: number, e1: number) =>
  u < 0.38 ? (u / 0.38) * e0 : u < 0.62 ? e0 + ((u - 0.38) / 0.24) * (e1 - e0) : e1 + ((u - 0.62) / 0.38) * (1 - e1);
const XF_S = 0.85; // seconds one pair takes to melt into the next
let holdUntil = 0; // the playhead waits while a crossfade runs, so time does not race past the change

let pairToken = 0;
async function showPair(i: number, target?: number) {
  const token = ++pairToken;
  pairWant = i;
  const chain = PAIRS;
  await ensurePair(i);
  if (token !== pairToken || chain !== PAIRS) return;
  if (i !== pairIdx) {
    settleCrossfade(); // a crossfade still running lands first
    if (writePair(i)) {
      xfPending = true;
      T.values.xf = 0;
      T.to('xf', 1, XF_S, 0, easeInOut);
      holdUntil = performance.now() + XF_S * 700;
    }
    pairIdx = i;
  }
  renderTimeline();
  T.to('disp', target ?? dispFor(tFrac), 0.6);
  updateClimax();
}

function buildTimeline() {
  const ticks = $('ticks');
  const span = passB - passA;
  const pct = (t: number) => (((t - passA) / span) * 100).toFixed(3);
  const segs = PAIRS.map((p, k) => {
    const a = dayMs(p.ref), b = dayMs(p.sec);
    return `<i class="seg${p.event ? ' ev' : ''}" data-i="${k}" style="left:${pct(a)}%;width:calc(${(((b - a) / span) * 100).toFixed(3)}% - 3px)"></i><span class="pn" data-i="${k}" style="left:calc(${((((a + b) / 2 - passA) / span) * 100).toFixed(3)}% - 1.5px)">${PAIRS.length > 1 ? k + 1 : ''}</span>`;
  }).join('');
  const marks = [...PAIRS.map((p) => p.ref), PAIRS[PAIRS.length - 1].sec];
  const bounds = marks
    .map((d, k) => `<span class="bd${k === 0 ? ' first' : k === marks.length - 1 ? ' last' : ''}" style="left:${pct(dayMs(d))}%">${
      PAIRS.length === 1 ? `<b>${k === 0 ? 'Pass 1' : 'Pass 2'}</b>` : ''}${fmtDate(dayMs(d))}</span>`)
    .join('');
  ticks.innerHTML = `
    <i class="fill" id="tlFill"></i>${segs}${bounds}
    ${noEvent() ? '' : `<div class="event" style="left:${(fracOf(eventAt) * 100).toFixed(2)}%"><span>${site.tag} · ${fmtDate(site.date)}</span></div>`}
    <button class="head" id="tlHead" role="slider" aria-label="Scrub through the pairs" aria-valuemin="0" aria-valuemax="100"></button>`;
  shownPair = -1;
  const track = ticks.parentElement as HTMLElement;
  const at = (x: number) => {
    const r = ticks.getBoundingClientRect();
    return Math.min(1, Math.max(0, (x - r.left) / r.width));
  };
  let drag = false;
  track.onpointerdown = (e) => {
    drag = true;
    pause();
    track.setPointerCapture(e.pointerId);
    setTime(at(e.clientX));
  };
  track.onpointermove = (e) => drag && setTime(at(e.clientX));
  track.onpointerup = track.onpointercancel = () => (drag = false);
  $('tlHead').onkeydown = (e) => {
    const k = e.key === 'ArrowRight' ? 0.02 : e.key === 'ArrowLeft' ? -0.02 : e.key === 'Home' ? -2 : e.key === 'End' ? 2 : 0;
    if (!k) return;
    e.preventDefault();
    e.stopPropagation();
    pause();
    setTime(Math.abs(k) === 2 ? (k < 0 ? 0 : 1) : tFrac + k);
  };
  renderTimeline();
}

let shownPair = -1;
function renderTimeline() {
  const head = document.getElementById('tlHead');
  if (!head) return;
  head.style.left = `${tFrac * 100}%`;
  head.setAttribute('aria-valuenow', String(Math.round(tFrac * 100)));
  $('tlFill').style.width = `${tFrac * 100}%`;
  const t = timeAt(tFrac);
  const k = pairAt(t);
  $('ticks').querySelectorAll('.seg, .pn').forEach((el) => el.classList.toggle('on', Number((el as HTMLElement).dataset.i) === k));
  const p = PAIRS[k];
  const from = site.kind === 'subsidence' ? PAIRS[0].ref : p.ref; // a cumulative record runs from the first pass
  $('epochDate').textContent = PAIRS.length > 1 ? `${fmtDate(dayMs(from))} → ${fmtDate(dayMs(p.sec))}` : `${fmtDate(t)} ${new Date(t).getUTCFullYear()}`;
  if (PAIRS.length > 1 && k !== shownPair) {
    // A new pair: its segment pulses and the date rolls over, so the change of picture has a visible cause.
    if (shownPair >= 0) {
      sound.tick();
      const seg = $('ticks').querySelector<HTMLElement>(`.seg[data-i="${k}"]`);
      for (const el of [seg, $('epochDate').parentElement]) {
        if (!el) continue;
        const cls = el === seg ? 'pulse' : 'roll';
        el.classList.remove(cls);
        void el.offsetWidth;
        el.classList.add(cls);
      }
    }
    shownPair = k;
  }
  if (PAIRS.length > 1) {
    const mid = (dayMs(p.ref) + dayMs(p.sec)) / 2;
    const days = Math.round(Math.abs(mid - eventAt) / 86400000);
    const rel = site.kind === 'subsidence'
      ? `sunk since ${fmtDate(dayMs(PAIRS[0].ref))}`
      : noEvent()
        ? (p.event ? 'the most change' : `${Math.round((dayMs(p.sec) - dayMs(p.ref)) / 86400000)} days`)
        : p.event ? (stepAt(t) > 0.5 ? 'the event pair · after the shock' : 'the event pair · before the shock') : `${days} days ${mid < eventAt ? 'before' : 'after'} the event`;
    $('epochRel').textContent = `Pair ${k + 1} of ${PAIRS.length} · ${rel}`;
  } else {
    const h = (t - eventAt) / 3600e3;
    const days = Math.abs(h) / 24;
    $('epochRel').textContent =
      Math.abs(h) < 6 ? 'at the event' : `${days < 1.5 ? `${Math.round(Math.abs(h))} h` : `${Math.round(days)} days`} ${h < 0 ? 'before' : 'after'}`;
  }
}

// ---------- Explore's climax ----------
// When the playhead crosses the shock inside the event pair, the camera goes down to the event, the wave leaves the
// epicentre again and every place shows what the radar measured there. Leaving the event pair brings the overview back.
let climaxOn = false;
let postShock = false;
function valueAt(u: number, v: number) {
  // A small median, so one noisy pixel does not speak for a town.
  const vals: number[] = [];
  let coh = 0, n = 0;
  for (let dj = -2; dj <= 2; dj++)
    for (let di = -2; di <= 2; di++) {
      const i = Math.min(F.W - 1, Math.max(0, Math.round(u * F.W) + di));
      const j = Math.min(F.H - 1, Math.max(0, Math.round(v * F.H) + dj));
      const k = j * F.W + i;
      vals.push(isFlood() ? F.dcoh[k] : F.los[k]);
      coh += F.coh[k];
      n++;
    }
  vals.sort((a, b) => a - b);
  return { v: vals[vals.length >> 1], coh: coh / n };
}
function fillValues() {
  for (const a of ANCHORS) {
    const em = a.el.querySelector<HTMLElement>('em.pv');
    if (!em) continue;
    queueMicrotask(() => (a.valLen = (em.textContent ?? '').length));
    const { v, coh } = valueAt(a.u, a.v);
    if (isFlood()) {
      const pct = Math.round(v * 100);
      em.textContent = pct >= 8 ? `${pct}% coherence lost` : 'unchanged';
      em.dataset.sign = pct >= 8 ? 'loss' : '';
    } else if (coh < 0.3) {
      em.textContent = 'no reliable signal';
      em.dataset.sign = '';
    } else {
      const cm = v * 100;
      em.textContent = `${cm >= 0 ? '+' : '−'}${Math.abs(cm).toFixed(Math.abs(cm) < 10 ? 1 : 0)} cm`;
      em.dataset.sign = cm >= 0.5 ? 'up' : cm <= -0.5 ? 'down' : '';
    }
  }
}
function isPostShock() {
  // A continuing process has no shock: its climax is the pair that leads the story (Mexico City: the whole record).
  if (noEvent()) return beat === 5 && pairIdx === evIdx && pairWant === evIdx;
  return beat === 5 && pairIdx === evIdx && pairWant === evIdx && stepAt(timeAt(tFrac)) > 0.5;
}
function updateClimax() {
  const now = isPostShock();
  const was = postShock;
  postShock = now;
  if (mode !== 'story' || beat !== 5) return;
  if (now && !was && !climaxOn) {
    climaxOn = true;
    fillValues();
    climaxFx();
    setTimeout(() => climaxOn && sound.reveal(0.35), 1000);
    $('app').classList.add('climax');
    T.to('epi', 1, 0.8);
    if (!userCam) {
      // Same angle as Explore, closer: the change is the subject, the move only brings it near.
      releaseCam();
      const b = BEATS[5];
      const [p, t] = portrait && b.camP ? b.camP : b.cam;
      const pose = fitPose(poseFor(p, t, portrait && !!b.camP), 3, 5);
      camFrom.p.copy(camNow.p);
      camFrom.t.copy(camNow.t);
      camTo.p.copy(pose.p);
      camTo.t.copy(pose.t);
      T.values.cam = 0;
      T.to('cam', 1, 2.4, 0, easeInOut);
      armFreeCam(5);
    }
    if (playing) holdUntil = performance.now() + 3200; // time to arrive and read
  } else if (!now && climaxOn) {
    climaxOn = false;
    $('app').classList.remove('climax');
    T.to('epi', 0.55, 0.8);
    if (!userCam) {
      releaseCam();
      flyTo(5, 2.2);
      armFreeCam(5);
    }
  }
}

function setTime(f: number) {
  tFrac = Math.max(0, Math.min(1, f));
  const k = pairAt(timeAt(tFrac));
  if (k !== pairWant) void showPair(k); // fades the next pair in once its raster is here
  else if (k === evIdx && pairIdx === evIdx && !noEvent()) T.to('disp', stepAt(timeAt(tFrac)), 0);
  renderTimeline();
  updateClimax();
}

// Chapters before Explore always show the event pair, complete.
function settleEventPair() {
  if (PAIRS.length < 2 || (pairIdx === evIdx && pairWant === evIdx && tFrac >= fracOf(dayMs(PAIRS[evIdx].sec)) - 1e-3)) return;
  pause();
  tFrac = Math.min(1, fracOf(dayMs(PAIRS[evIdx].sec)));
  void showPair(evIdx, 1);
}

function play() {
  if (tFrac >= 0.999) setTime(0);
  playing = true;
  $('play').classList.add('on');
}
function pause() {
  playing = false;
  $('play').classList.remove('on');
}

// ---------- film mode ----------
// Runs the six chapters unattended and loops. Any key, tap or click ends it.
const FILM_DWELL = [10, 12.8, 14.5, 11.5, 8, 14]; // seconds per chapter (each covers its own animation)
// Explore runs long enough for the whole chain of pairs to play.
const dwell = (i: number) => (i === 5 && PAIRS.length > 1 ? 22 : FILM_DWELL[i]);
const filmTotal = () => FILM_DWELL.reduce((a, _, i) => a + dwell(i), 0);
let film = false;
let filmTimer = 0;
let filmExploreTimer = 0;
let filmChapter = 0;
let filmChapterT = 0;
let filmAllOn = false; // 'Play all': the film moves on to the next site when a site's last chapter ends

function filmStep(i: number, already = false) {
  filmChapter = i;
  filmChapterT = performance.now();
  if (!already) go(i);
  clearTimeout(filmExploreTimer);
  if (i === 5) {
    filmExploreTimer = window.setTimeout(() => {
      if (!film) return;
      setTime(0);
      play();
    }, 3200);
  }
  filmTimer = window.setTimeout(
    () => (i === BEATS.length - 1 && filmAllOn ? void filmNextSite() : filmStep((i + 1) % BEATS.length)),
    dwell(i) * 1000,
  );
}

function filmStart(already = false) {
  if (film || mode !== 'story') return;
  film = true;
  controls.enabled = false;
  $('app').classList.add('film');
  $('probe').classList.remove('on');
  U.uProbe.value.z = 0;
  pause();
  filmStep(0, already);
}

async function filmNextSite() {
  const idx = SITES.findIndex((s) => s.id === site.id);
  if (idx + 1 >= SITES.length) {
    filmStop();
    openPicker();
    return;
  }
  // Rise back to the globe, turn it to the next place and dive again: the tour reads as one journey.
  const next = SITES[idx + 1];
  const id = ++tourId;
  clearTimeout(filmTimer);
  clearTimeout(filmExploreTimer);
  film = false;
  $('app').classList.remove('film');
  $('app').classList.add('tour');
  openPicker(); // it ends the film; the tour keeps 'Play all' alive
  filmAllOn = true;
  T.to('pick', 0, 0);
  await new Promise((r) => setTimeout(r, RISE_S * 1000 * 0.6));
  if (id !== tourId || mode !== 'picker') return;
  void previewSite(next);
  await new Promise((r) => setTimeout(r, RISE_S * 1000 * 0.4 + 1800));
  if (id !== tourId || mode !== 'picker') return;
  await enterSite(next);
  $('app').classList.remove('tour');
  if (filmAllOn && id === tourId) filmStart(true);
}

// Any touch or key during the journey between places ends 'Play all' there, on the globe.
function endTour() {
  if (!$('app').classList.contains('tour')) return;
  tourId++;
  filmAllOn = false;
  $('app').classList.remove('tour');
  T.to('pick', 1, 1.2);
}

async function playAll() {
  filmAllOn = true;
  await enterSite(SITES[0]);
  if (filmAllOn) filmStart(true);
}

function filmStop() {
  filmAllOn = false;
  if (!film) return;
  film = false;
  clearTimeout(filmTimer);
  clearTimeout(filmExploreTimer);
  $('app').classList.remove('film');
  pause();
  if (mode === 'story' && beat >= 0) armFreeCam(beat);
}

// ---------- picker ----------
const cardsEl = $('cards');
const cardEls = new Map<string, HTMLButtonElement>();

// The card's picture comes ready from the field worker; here it is only put on the canvas, with the event marked.
function drawRelief(cv: HTMLCanvasElement, s: SiteDef, f: Fields) {
  const { w, h, rgba } = f.thumb;
  cv.width = w;
  cv.height = h;
  const g = cv.getContext('2d')!;
  g.putImageData(new ImageData(rgba, w, h), 0, 0);
  const m = makeMapper(s.aoi);
  for (const e of s.epicentres) {
    const x = m.u(e.lon) * w, y = m.v(e.lat) * h;
    g.strokeStyle = 'rgba(255,196,180,.75)';
    g.lineWidth = 1.6;
    g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.stroke();
    g.fillStyle = '#ffb4a2';
    g.beginPath(); g.arc(x, y, 3.4, 0, Math.PI * 2); g.fill();
  }
}

let pickerIndex = 0;
function buildCards() {
  cardsEl.style.setProperty('--n', String(SITES.length));
  $('pickerCount').textContent = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five'][SITES.length] ?? String(SITES.length);
  SITES.forEach((s, idx) => {
    const card = document.createElement('button');
    card.className = 'card';
    card.dataset.site = s.id;
    card.style.setProperty('--i', String(idx));
    const signal = s.kind === 'flood' || s.kind === 'volcano' ? 'Coherence loss' : s.kind === 'subsidence' ? 'Slow sinking' : 'Ground motion';
    const d = new Date(s.date);
    card.innerHTML = `
      <div class="card-art"><canvas></canvas><span class="card-date">${shortDate(d.toISOString().slice(0, 10))} ${d.getUTCFullYear()}</span><span class="card-n">${String(idx + 1).padStart(2, '0')}</span></div>
      <div class="card-body">
        <div class="card-head">
          <div><div class="card-name">${s.name}</div><div class="card-region">${s.region}</div></div>
          <div class="card-stat"><b>${s.stat.value}</b><span>${s.stat.unit}</span><em>${s.stat.label}</em></div>
        </div>
        <div class="card-line">${s.headline}</div>
        <div class="card-tags"><span class="card-kind">${signal}</span><span class="card-status">…</span></div>
      </div>`;
    card.onmouseenter = () => mode === 'picker' && (pickerIndex = idx, previewSite(s));
    card.onfocus = () => mode === 'picker' && (pickerIndex = idx, previewSite(s));
    card.onclick = () => enterSite(s);
    cardsEl.appendChild(card);
    cardEls.set(s.id, card);
    const paint = (f: Fields) => {
      const cv = card.querySelector('canvas')!;
      drawRelief(cv, s, f);
      const m = makeMapper(s.aoi);
      const e = s.epicentres[s.epicentres.length - 1];
      cv.style.objectPosition = `${(m.u(e.lon) * 100).toFixed(0)}% ${(m.v(e.lat) * 100).toFixed(0)}%`; // keep the event in the crop
    };
    loadFields(s).then((f) => {
      paint(f);
      const st = card.querySelector('.card-status')!;
      st.textContent = f.synthetic ? 'Synthetic signal' : 'NISAR data';
      st.classList.toggle('real', !f.synthetic);
      const n = realMeta.get(s.id)?.series?.length ?? 0;
      if (n > 1 && !card.querySelector('.card-pairs')) {
        const tag = document.createElement('span');
        tag.className = 'card-pairs';
        tag.textContent = `${n} real pairs`;
        card.querySelector('.card-tags')!.appendChild(tag);
      }
    });
  });
}

function markCard(id: string) {
  cardEls.forEach((el, k) => el.classList.toggle('on', k === id));
}

let previewToken = 0;
async function previewSite(s: SiteDef) {
  globeSel = s.id;
  if (s.id === site.id && siteReady) return markCard(s.id);
  const token = ++previewToken;
  markCard(s.id);
  const ok = await loadSite(s);
  if (!ok || token !== previewToken || mode !== 'picker') return;
  T.to('epi', 1, 1, 0.2);
}

function openPicker() {
  stopNarration();
  filmStop();
  if (mode === 'picker') return;
  sound.ambience('space');
  mode = 'picker';
  releaseCam();
  rollActive = false;
  climaxOn = false;
  $('app').classList.remove('climax');
  $('app').dataset.mode = 'picker';
  syncInert();
  showHint(-1);
  $('probe').classList.remove('on');
  U.uProbe.value.z = 0;
  for (const k of ['pass1', 'pass2', 'amp', 'fringe', 'unwrap', 'lift', 'coh', 'change'] as const) T.to(k, 0, 1.0);
  T.to('places', 0, 0.4);
  T.to('epi', 1, 1.2, 0.4);
  T.to('pick', 1, 1.2);
  T.to('pins', 1, 1.2);
  T.to('orbit', 0.55, 2);
  globeSel = site.id;
  if (globe) {
    // The exact reverse of the dive: globe and camera in step, so the camera never ends up inside a still-huge globe.
    T.to('dive', 0, RISE_S, 0, easeInOut);
    sound.whoosh(RISE_S, false);
    T.to('reveal', 0, RISE_S * 0.3, RISE_S * 0.3); // the slab stays until the globe has come back around it
  }
  camFrom.p.copy(camNow.p);
  camFrom.t.copy(camNow.t);
  T.values.cam = 0;
  T.to('cam', 1, globe ? RISE_S : 2.2, 0, easeInOut);
  markCard(site.id);
  beat = -1;
  const q = new URLSearchParams(location.search);
  q.delete('site');
  q.delete('ch');
  history.replaceState(null, '', q.size ? `?${q.toString().replace(/=(?=&|$)/g, '')}` : location.pathname);
  renderLegend();
}

async function enterSite(s: SiteDef) {
  previewToken++;
  if (introOn) {
    // Going straight in ends the opening without its hand-over to the picker.
    introOn = false;
    $('app').classList.remove('opening', 'opening-title');
  }
  if (!filmAllOn) $('app').classList.remove('tour');
  globeSel = s.id;
  const fromGlobe = mode === 'picker' && !!globe && !REDUCED;
  if (s.id !== site.id || !siteReady) {
    if (!(await loadSite(s))) return;
  }
  mode = 'story';
  $('app').dataset.mode = 'story';
  syncInert();
  sound.ambience(s.kind);
  T.to('pick', 0, 0.9);
  if (fromGlobe) {
    // The globe grows into the ground: the camera keeps flying from where it is, the slab surfaces as the globe fades.
    T.to('dive', 1, INTRO_S, 0, easeInOut); // in step with the camera's own descent
    sound.dive(INTRO_S);
    T.to('reveal', 1, 1.4, INTRO_S * 0.3);
  } else {
    T.to('dive', 1, 0);
    T.to('reveal', 1, 0);
    camNow.p.copy(poseFor(ORBIT[0], ORBIT[1]).p);
    camNow.t.copy(poseFor(ORBIT[0], ORBIT[1]).t);
  }
  beat = -1;
  const q = new URLSearchParams(location.search);
  q.set('site', s.id);
  history.replaceState(null, '', `?${q.toString().replace(/=(?=&|$)/g, '')}`);
  go(0);
  prefetchSeries();
}

// ---------- about ----------
function chainHtml(rm?: Record<string, any>) {
  const series: any[] = rm?.series ?? [];
  if (series.length < 2) return '';
  const cm = (v?: number) => (v == null ? '' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(0)}`);
  return `<h3>The chain of real pairs</h3><ul class="chain">${series
    .map(
      (p) =>
        `<li class="${p.event ? 'ev' : ''}"><b>${fmtDate(dayMs(p.ref))} → ${fmtDate(dayMs(p.sec))}</b><span>${p.event ? 'spans the event' : 'no event'}</span><em>${
          p.losMinCm != null ? `${cm(p.losMinCm)} … ${cm(p.losMaxCm)} cm · ` : ''
        }${Math.round((p.coherentShare ?? 0) * 100)}% coherent</em></li>`,
    )
    .join('')}</ul>`;
}

function openAbout() {
  const f = F;
  const meta = terrainCache.get(site.id);
  const real = f && !f.synthetic;
  const rm = realMeta.get(site.id);
  const pair = site.pair.ref
    ? `${shortDate(site.pair.ref)} → ${shortDate(site.pair.sec)} 2026 · track ${site.pair.track} · frame ${site.pair.frame} · ${site.pair.orbit === 'A' ? 'ascending' : 'descending'}`
    : 'to be confirmed from the CMR search';
  const status = real
    ? `<p class="ok"><b>NISAR GUNW</b> — the signal on screen is the real geocoded unwrapped interferogram.${
        rm?.granule ? `<br><code>${rm.granule}</code>` : `<br>${pair}`
      }${rm?.coherentShare != null ? `<br>${Math.round(rm.coherentShare * 100)}% of the area coherent (> 0.3)` : ''}${
        rm?.ionosphereRemoved ? '<br>Ionospheric phase removed with the product’s own layer.' : ''
      }</p>${real && site.finding ? `<h3>What this pair shows</h3><p>${site.finding}</p>` : ''}`
    : `<p class="warn"><b>Synthetic signal.</b> The terrain is real; the interferometric signal is a physically-motivated stand-in that stays until the real NISAR GUNW pair is extracted for this site (<code>scripts/fetch-gunw.py</code>). Numbers on screen are model values, not measurements.</p>`;
  $('aboutBody').innerHTML = `
    <div class="eyebrow">${site.region}</div>
    <h2>${site.name}</h2>
    ${status}
    <h3>What happened</h3>
    <dl>${site.facts.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${chainHtml(rm)}
    <h3>How to read it</h3>
    <dl>
      <dt>Radar</dt><dd>Each map compares two satellite passes. Displacement is measured along the satellite's line of sight, not the complete direction or amount of ground motion. One colour cycle of wrapped phase corresponds to about 12.1 cm along that line.</dd>
      <dt>Timeline</dt><dd>Each segment represents a comparison between passes, not a continuous recording. The event animation illustrates when the event occurred; it does not measure its moment-by-moment motion.</dd>
      <dt>Coherence</dt><dd>How well two passes still match, from 0 to 1. Where it is low the phase cannot be believed.</dd>
      <dt>Scale</dt><dd>Relief ×${site.vex}.${liftKm > 0 ? ` Ground motion is exaggerated ×${Math.round(liftKm * 1000)} so it can be seen.` : ' The terrain is not lifted here: the real map shows no measurable motion to exaggerate.'}</dd>
    </dl>
    <h3>Sources</h3>
    <ul>${site.sources.map((x) => `<li><a href="${x.url}" target="_blank" rel="noopener">${x.label}</a></li>`).join('')}</ul>
    <h3>Credits</h3>
    <ul class="small">
      <li>Radar: NASA-ISRO NISAR, products via ASF DAAC.</li>
      <li>Terrain: Mapzen Terrarium tiles on AWS Open Data (SRTM, ASTER, ETOPO1 and others).</li>
      <li>Colour maps: Scientific colour maps, F. Crameri (MIT) — romaO, berlin, grayC.</li>
      <li>Type: Instrument Serif, Inter, JetBrains Mono (SIL OFL). Rendering: three.js (MIT).</li>
      <li>English narration: AI-generated synthetic voice (Microsoft Edge text-to-speech).</li>
    </ul>`;
  const el = $('about');
  el.classList.add('on');
  el.setAttribute('aria-hidden', 'false');
  syncInert();
  $('aboutClose').focus({ preventScroll: true });
}
function closeAbout() {
  const el = $('about');
  el.classList.remove('on');
  el.setAttribute('aria-hidden', 'true');
  syncInert();
  $('aboutBtn').focus({ preventScroll: true });
}

// Short hints, each shown once, where the thing they explain first appears.
const shownHints = new Set<number>();
let hintTimers: number[] = [];
function showHint(b: number) {
  const el = $('orbitHint');
  hintTimers.forEach(clearTimeout);
  el.classList.remove('on');
  if (film || mode !== 'story' || shownHints.has(b)) return;
  const touch = matchMedia('(pointer: coarse)').matches;
  const text =
    b === 3 ? (touch ? 'Touch the map to read the value under your finger' : 'Move over the map to read the value under the cursor')
    : b === 5 ? (touch ? 'Drag to orbit · pinch to zoom · drag the dot to scrub' : 'Drag to orbit · scroll to zoom · drag the dot to scrub')
    : b === 0 ? (touch ? 'Drag to look around · pinch to zoom' : 'Drag to look around · scroll to zoom')
    : '';
  if (!text) return;
  shownHints.add(b);
  el.textContent = text;
  // Upright screens: just under the words (measured when it shows, once they are written), not over the scene's middle.
  const place = () => {
    el.style.top = portrait ? `${Math.round(safeRect(b).t - 4)}px` : '';
    el.style.bottom = portrait ? 'auto' : '';
  };
  hintTimers = [window.setTimeout(() => (place(), el.classList.add('on')), b === 5 ? 3200 : 4200), window.setTimeout(() => el.classList.remove('on'), b === 5 ? 11000 : 12000)];
}

// Save the current view. The frame is drawn and read back in the same task, before the browser clears the buffer.
function saveImage() {
  frame(performance.now(), true);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `invisible-earth-${site.id}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
}

// Keyboard help.
function toggleKeys(on = !$('keys').classList.contains('on')) {
  const el = $('keys');
  el.classList.toggle('on', on);
  el.setAttribute('aria-hidden', String(!on));
  syncInert();
  (on ? $('keysClose') : $('keysBtn')).focus({ preventScroll: true });
}

function toggleGuide(on = !$('guide').classList.contains('on')) {
  const el = $('guide');
  el.classList.toggle('on', on);
  el.setAttribute('aria-hidden', String(!on));
  syncInert();
  (on ? $('guideClose') : $('guideBtn')).focus({ preventScroll: true });
}

// ---------- wiring ----------
$('next').onclick = () => (beat === BEATS.length - 1 ? openPicker() : go(beat + 1));
$('prev').onclick = () => go(beat - 1);
$('modeFringes').onclick = () => ((exploreMode = 'fringes'), setExplore());
$('modeDisp').onclick = () => ((exploreMode = 'displacement'), setExplore());
$('cohToggle').onclick = () => ((exploreCoh = !exploreCoh), setExplore());

// ---------- eye vs radar ----------
// A split across the screen: the ground as the eye sees it on the left, what the radar measured on the right. Turning it
// on sweeps the line in from the right edge; the knob drags it.
let compareOn = false;
let splitX = 0.5;
function setCompare(on: boolean) {
  compareOn = on;
  $('compareBtn').classList.toggle('on', on);
  $('compareBtn').setAttribute('aria-pressed', String(on));
  $('split').classList.toggle('on', on);
  if (on) {
    T.values.split = 1;
    T.to('split', splitX, 1.4, 0, easeInOut);
  }
}
$('compareBtn').onclick = () => setCompare(!compareOn);
{
  const knob = $('splitKnob');
  let drag = false;
  knob.addEventListener('pointerdown', (e) => {
    drag = true;
    knob.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });
  knob.addEventListener('pointermove', (e) => {
    if (!drag) return;
    splitX = Math.min(0.95, Math.max(0.05, e.clientX / innerWidth));
    T.to('split', splitX, 0);
  });
  knob.addEventListener('pointerup', () => (drag = false));
}
$('play').onclick = () => (playing ? pause() : play());
$('shot').onclick = saveImage;
$('film').onclick = () => filmStart();
$('playAll').onclick = () => void playAll();
$('filmHud').onclick = filmStop;
$('brand').onclick = openPicker;
$('siteBtn').onclick = openPicker;
$('aboutBtn').onclick = openAbout;
$('viewReset').onclick = backToShot;
$('keysBtn').onclick = () => toggleKeys();
$('keysClose').onclick = () => toggleKeys(false);
$('guideBtn').onclick = () => toggleGuide();
$('guideClose').onclick = () => toggleGuide(false);
$('guide').onclick = (e) => e.target === $('guide') && toggleGuide(false);
$('keys').onclick = (e) => e.target === $('keys') && toggleKeys(false);
$('aboutClose').onclick = closeAbout;
$('about').onclick = (e) => e.target === $('about') && closeAbout();
canvas.addEventListener('pointerdown', () => (endTour(), filmStop()));
for (const ev of ['pointerdown', 'keydown'] as const) addEventListener(ev, () => { sound.wake(); unlockNarration(); }, { capture: true });
function renderSound() {
  const b = $('soundBtn');
  b.classList.toggle('off', !sound.on);
  b.setAttribute('aria-pressed', String(sound.on));
  b.setAttribute('aria-label', sound.on ? 'Mute sound' : 'Turn sound on');
}
function toggleSound() {
  sound.wake();
  sound.setOn(!sound.on);
  if (sound.on) unlockNarration();
  if (!sound.on) stopNarration();
  else if (mode === 'story' && beat >= 0) narrateChapter(BEATS[beat], beat, false);
  renderSound();
}
$('soundBtn').onclick = toggleSound;
renderSound();
if (!params.has('silent')) {
  if (!narrationAvailable) $('soundWelcomeDescription').textContent = 'Turn on your sound for an immersive experience. The written guide remains available on screen.';
  let chosen = false;
  try { chosen = sessionStorage.getItem('invisible-earth-sound-choice') === 'yes'; } catch { /* storage may be blocked */ }
  if (!chosen) $('soundWelcome').hidden = false;
  const chooseSound = (enabled: boolean) => {
    sound.setOn(enabled);
    if (enabled) {
      sound.wake();
      unlockNarration();
    } else stopNarration();
    try { sessionStorage.setItem('invisible-earth-sound-choice', 'yes'); } catch { /* storage may be blocked */ }
    $('soundWelcome').hidden = true;
    renderSound();
    if (enabled && mode === 'story' && beat >= 0) narrateChapter(BEATS[beat], beat, false);
  };
  $('soundWelcomeOn').onclick = () => chooseSound(true);
  $('soundWelcomeOff').onclick = () => chooseSound(false);
}
addEventListener('keydown', endTour, { capture: true });

// ---------- frame-rate readout (?fps or P) ----------
const fpsEl = $('fps');
let fpsOn = params.has('fps');
fpsEl.classList.toggle('on', fpsOn);
let fpsLast = 0, fpsWinT = 0, fpsN = 0, fpsSum = 0, fpsMax = 0;

function fpsTick(ms: number) {
  if (!fpsOn) return;
  if (fpsLast) {
    const d = ms - fpsLast;
    fpsN++;
    fpsSum += d;
    if (d > fpsMax) fpsMax = d;
  }
  fpsLast = ms;
  if (fpsWinT === 0) fpsWinT = ms;
  if (ms - fpsWinT < 500 || !fpsN) return;
  const r = renderer.info.render;
  fpsEl.textContent =
    `${(1000 * fpsN / fpsSum).toFixed(0)} fps · ${(fpsSum / fpsN).toFixed(1)} ms · worst ${fpsMax.toFixed(0)} ms · ` +
    `${(r.triangles / 1e6).toFixed(1)}M tris · ${r.calls} calls · ` +
    `${Math.round(innerWidth * dpr)}×${Math.round(innerHeight * dpr)} (×${dpr.toFixed(2)})`;
  fpsWinT = ms;
  fpsN = 0;
  fpsSum = 0;
  fpsMax = 0;
}

addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && $('about').classList.contains('on')) return closeAbout();
  if (e.code === 'Escape' && $('guide').classList.contains('on')) return toggleGuide(false);
  if (e.code === 'Escape' && $('keys').classList.contains('on')) return toggleKeys(false);
  if (e.key === '?') return toggleKeys();
  if ($('keys').classList.contains('on') || $('about').classList.contains('on') || $('guide').classList.contains('on')) return;
  if (e.code === 'KeyS' && !e.ctrlKey && !e.metaKey) return toggleSound();
  if (e.code === 'KeyP') {
    fpsOn = !fpsOn;
    fpsEl.classList.toggle('on', fpsOn);
    fpsLast = fpsWinT = fpsN = fpsSum = fpsMax = 0;
    return;
  }
  if (introOn) return;
  if (mode === 'picker') {
    const n = SITES.length;
    const go = (idx: number) => {
      pickerIndex = (idx + n) % n;
      cardEls.get(SITES[pickerIndex].id)?.focus({ preventScroll: true }); // focusing previews the site
    };
    if (e.code === 'ArrowRight' || e.code === 'ArrowDown') (e.preventDefault(), go(pickerIndex + 1));
    else if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') (e.preventDefault(), go(pickerIndex - 1));
    else if (/^Digit[1-9]$/.test(e.code) && +e.code.slice(5) <= n) void enterSite(SITES[+e.code.slice(5) - 1]);
    else if ((e.code === 'Enter' || e.code === 'Space') && !(document.activeElement as HTMLElement)?.classList.contains('card')) {
      e.preventDefault();
      void enterSite(SITES[pickerIndex]);
    }
    return;
  }
  if (mode !== 'story') return;
  if ((e.code === 'Space' || e.code === 'Enter') && (e.target as HTMLElement)?.closest?.('button')) return; // let the button act
  if (e.code === 'KeyR') return backToShot();
  if (e.code === 'KeyM') return film ? filmStop() : filmStart();
  if (film) {
    filmStop();
    if (e.code === 'Escape') return;
  }
  if (e.code === 'Space' || e.code === 'ArrowRight') {
    e.preventDefault();
    go(beat + 1);
  } else if (e.code === 'ArrowLeft') go(beat - 1);
  else if (e.code === 'Escape') openPicker();
});

// ---------- probe ----------
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const hit = new THREE.Vector3();

function cpuWorldH(u: number, v: number) {
  const i = Math.min(F.W - 1, Math.max(0, Math.floor(u * F.W)));
  const j = Math.min(F.H - 1, Math.max(0, Math.floor(v * F.H)));
  const k = j * F.W + i;
  // As in the shader: only trustworthy pixels rise, and never beyond the colour scale.
  const l = liftCPU.length === F.W * F.H ? liftCPU[k] * Math.min(1, Math.max(0, F.heights[k] / 4)) : 0;
  return Math.max(F.heights[k], 0) * 0.001 * site.vex + l * T.values.disp * T.values.lift * liftKm;
}

function probeAt(cx: number, cy: number) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  let h = 0;
  let u = -1, v = -1;
  for (let it = 0; it < 6; it++) {
    plane.constant = -h;
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    u = (hit.x + SX / 2) / SX;
    v = (hit.z + SZ / 2) / SZ;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    h = cpuWorldH(u, v);
  }
  return { u, v };
}

// What this one point did in every real pair: bars on the same scale as the colours, the event pair in ember.
function pairBars(k: number) {
  if (PAIRS.length < 2 || !PAIRS.every((p) => p.los)) return '';
  const flood = isFlood();
  const w = 176, h = 58, mid = flood ? h - 14 : h / 2 - 3, n = PAIRS.length, bw = w / n;
  const vals = PAIRS.map((p) => (flood ? ((p.dcoh8?.[k] ?? 0) / 255) : p.los![k] / range));
  const bars = vals
    .map((v, i) => {
      const lo = (PAIRS[i].coh8?.[k] ?? 255) / 255 < 0.3; // a point with no coherence in that pair says nothing
      const full = flood ? h - 26 : h / 2 - 8;
      const bh = Math.max(1, Math.min(1, Math.abs(v)) * full);
      const y = flood ? mid - bh : v >= 0 ? mid - bh : mid;
      return `<rect x="${(i * bw + 4).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 8).toFixed(1)}" height="${bh.toFixed(1)}" rx="2" class="${PAIRS[i].event ? 'ev' : ''}${lo ? ' lo' : ''}"/>`;
    })
    .join('');
  const labels = PAIRS.map((p, i) => {
    const x = (i * bw + bw / 2).toFixed(1), first = fmtDate(dayMs(p.ref)).replace(' ', '');
    return `<text x="${x}" y="${h - 1}" text-anchor="middle">${first}</text>`;
  }).join('');
  const title = flood ? 'Coherence lost, pair by pair' : 'Line of sight, pair by pair';
  return `<div class="spark-title">${title}</div>
    <svg viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><line class="zero" x1="0" x2="${w}" y1="${mid}" y2="${mid}"/>${bars}${labels}</svg>`;
}

function showProbe(e: PointerEvent) {
  const probe = $('probe');
  if (mode !== 'story' || film || beat < 3 || T.values.ride > 0.001) {
    probe.classList.remove('on');
    U.uProbe.value.z = 0;
    return;
  }
  const p = probeAt(e.clientX, e.clientY);
  if (!p) {
    probe.classList.remove('on');
    U.uProbe.value.z = 0;
    return;
  }
  const i = Math.min(F.W - 1, Math.floor(p.u * F.W)), j = Math.min(F.H - 1, Math.floor(p.v * F.H));
  const k = j * F.W + i;
  const hgt = F.heights[k];
  const los = F.los[k] * T.values.disp;
  const coh = F.coh[k];
  const flood = isFlood();
  const rows: string[] = [];
  const showDisp = !flood && (beat === 3 || beat === 4 || (beat === 5 && exploreMode === 'displacement'));
  const showChange = flood && (beat === 3 || (beat === 5 && exploreMode === 'displacement'));
  if (beat === 1) rows.push(`<b>${hgt > 0 ? 'land' : 'sea'}</b><span>surface</span>`);
  if (beat === 2 || (beat === 5 && !showDisp && !showChange)) {
    const ph = ((((los / HALF_LAMBDA) % 1) + 1.5) % 1) * 2 * Math.PI - Math.PI;
    rows.push(`<b>${ph >= 0 ? '+' : '−'}${Math.abs(ph).toFixed(2)}</b><span>rad phase</span>`);
  }
  // An incoherent pixel cannot support a displacement reading. In particular, a
  // zero-filled missing pixel must never be presented as measured zero motion.
  const reliable = Number.isFinite(coh) && coh > 0.3 && hgt > 0;
  if (showDisp) rows.push(reliable
    ? `<b>${los >= 0 ? '+' : '−'}${Math.abs(los * 100).toFixed(1)}</b><span>cm LOS</span>`
    : `<b>—</b><span>unreliable signal</span>`);
  if (showChange) rows.push(`<b>${Math.round(F.dcoh[k] * 100)}</b><span>% coherence lost</span>`);
  if (beat >= 4 || (showDisp && !reliable)) rows.push(`<b>${coh.toFixed(2)}</b><span>coherence</span>`);
  rows.push(`<b>${Math.max(hgt, 0)}</b><span>m elev.</span>`);
  $('probeRows').innerHTML = rows.map((r) => `<div>${r}</div>`).join('');
  $('probeCoord').textContent = `${Math.abs(mapper.latAt(p.v)).toFixed(3)}°${mapper.latAt(p.v) < 0 ? 'S' : 'N'}  ${Math.abs(mapper.lonAt(p.u)).toFixed(3)}°${mapper.lonAt(p.u) < 0 ? 'W' : 'E'}`;
  $('probeSpark').innerHTML = beat >= 3 ? pairBars(k) : '';
  probe.classList.add('on');
  // Beside the cursor, flipped to the other side near the window's right and bottom edges.
  const pw = probe.offsetWidth, ph = probe.offsetHeight;
  const px = e.clientX + 18 + pw > innerWidth - 8 ? e.clientX - 18 - pw : e.clientX + 18;
  const py = e.clientY + 18 + ph > innerHeight - 8 ? e.clientY - 18 - ph : e.clientY + 18;
  probe.style.transform = `translate(${Math.max(8, px)}px, ${Math.max(8, py)}px)`;
  U.uProbe.value.set(p.u, p.v, 1);
}

// A local, explicitly labelled demo: no model, network request or free-form claims.
type DemoPoint = { lat: number; lon: number; height: number; los: number; coherence: number; loss: number; synthetic: boolean; change: boolean; siteName: string; interval: string; accumulated: boolean };
let demoPoint: DemoPoint | null = null;
let selectingDemoPoint = false;
let demoPointerStart: { id: number; x: number; y: number } | null = null;
let demoContext = '';
const assistantPanel = $('assistantPanel');
const assistantRoot = $('pointAssistant');
function showAssistantPanel(open: boolean) {
  assistantPanel.hidden = !open;
  $('assistantLaunch').setAttribute('aria-expanded', String(open));
}
function resetDemoPoint(message = 'No point selected yet.') {
  demoPoint = null;
  ($('assistantAsk') as HTMLButtonElement).disabled = true;
  $('assistantPoint').textContent = message;
  $('assistantAnswer').hidden = true;
}
function syncAssistant() {
  const visible = mode === 'story' && !film && beat >= 3 && beat <= 5 && T.values.ride < 0.001 && !params.has('pitch');
  if (Boolean(assistantRoot.hidden) === visible) assistantRoot.hidden = !visible;
  if (!visible) {
    if (selectingDemoPoint) { selectingDemoPoint = false; $('assistantPrompt').hidden = true; }
    if (!assistantPanel.hidden) showAssistantPanel(false);
    if (demoPoint) resetDemoPoint('The view changed. Select a point again.');
    demoContext = '';
    return;
  }
  const key = `${site.id}|${beat}|${pairIdx}|${exploreMode}`;
  if (key !== demoContext) {
    if (demoContext) resetDemoPoint('The view or dates changed. Select a point again.');
    demoContext = key;
  }
}
$('assistantLaunch').onclick = () => showAssistantPanel(Boolean(assistantPanel.hidden));
$('assistantClose').onclick = () => showAssistantPanel(false);
$('assistantSelect').onclick = () => {
  selectingDemoPoint = true;
  showAssistantPanel(false);
  $('assistantPrompt').hidden = false;
};
$('assistantCancel').onclick = () => {
  selectingDemoPoint = false;
  $('assistantPrompt').hidden = true;
  showAssistantPanel(true);
};
canvas.addEventListener('pointerdown', (event) => {
  if (selectingDemoPoint) demoPointerStart = { id: event.pointerId, x: event.clientX, y: event.clientY };
});
canvas.addEventListener('pointerup', (event) => {
  if (!selectingDemoPoint || mode !== 'story' || beat < 3 || beat > 5) return;
  if (!demoPointerStart || demoPointerStart.id !== event.pointerId || Math.hypot(event.clientX - demoPointerStart.x, event.clientY - demoPointerStart.y) > 12) { demoPointerStart = null; return; }
  demoPointerStart = null;
  const point = probeAt(event.clientX, event.clientY);
  if (!point) { $('assistantPrompt').querySelector('span')!.textContent = 'Choose a point on the visible terrain'; return; }
  const x = Math.min(F.W - 1, Math.max(0, Math.floor(point.u * F.W)));
  const y = Math.min(F.H - 1, Math.max(0, Math.floor(point.v * F.H)));
  const k = y * F.W + x;
  const pair = PAIRS[pairIdx];
  demoPoint = {
    lat: mapper.latAt(point.v), lon: mapper.lonAt(point.u), height: F.heights[k],
    los: F.los[k] * T.values.disp, coherence: F.coh[k], loss: F.dcoh[k], synthetic: F.synthetic,
    change: isFlood(), siteName: site.name,
    interval: pair ? `${shortDate(site.kind === 'subsidence' ? PAIRS[0].ref : pair.ref)} – ${shortDate(pair.sec)}` : `${shortDate(site.pair.ref)} – ${shortDate(site.pair.sec)}`,
    accumulated: site.kind === 'subsidence',
  };
  selectingDemoPoint = false;
  $('assistantPrompt').hidden = true;
  $('assistantPrompt').querySelector('span')!.textContent = 'Tap or click a point on the terrain';
  $('assistantPoint').textContent = `${demoPoint.siteName} · ${Math.abs(demoPoint.lat).toFixed(3)}°${demoPoint.lat < 0 ? 'S' : 'N'}, ${Math.abs(demoPoint.lon).toFixed(3)}°${demoPoint.lon < 0 ? 'W' : 'E'} · ${demoPoint.interval}`;
  ($('assistantAsk') as HTMLButtonElement).disabled = false;
  $('assistantAnswer').hidden = true;
  showAssistantPanel(true);
});
$('assistantAsk').onclick = () => {
  if (!demoPoint) return;
  const p = demoPoint;
  const reliable = Number.isFinite(p.coherence) && p.coherence > 0.3 && p.height > 0;
  const quality = Number.isFinite(p.coherence) ? `Signal coherence is ${p.coherence.toFixed(2)} on a scale of 0 to 1; it is not a percentage accuracy.` : 'Signal coherence is unavailable.';
  let reading: string;
  if (p.height <= 0 || !Number.isFinite(p.coherence)) {
    reading = 'This point does not have a usable land reading. Select a point on land with coverage.';
  } else if (p.change) {
    reading = `The surface-change layer shows ${(Math.max(0, p.loss) * 100).toFixed(0)}% coherence loss in this processed view. A radar change alone does not identify its cause.`;
  } else if (!reliable) {
    reading = 'This point does not have a reliable displacement reading. Do not interpret it as zero movement.';
  } else {
    const cm = p.los * 100;
    reading = `The estimated ${p.accumulated ? 'accumulated ' : ''}change is ${Math.abs(cm).toFixed(1)} cm ${cm >= 0 ? 'toward' : 'away from'} the satellite, relative to a map reference. It is not necessarily vertical movement.`;
  }
  const elevation = p.height > 0 ? `Terrain elevation is approximately ${Math.round(p.height)} m; this is not the amount of change.` : 'The terrain grid does not provide a positive land elevation at this point.';
  $('assistantAnswer').textContent = `${p.synthetic ? 'This view uses a simulated signal, not a satellite measurement.\n\n' : ''}${reading}\n\n${quality}\n\n${elevation}\n\nThese are observations at selected dates, not continuous footage. This demonstration is not a scientific validation.`;
  $('assistantAnswer').hidden = false;
  $('assistantAnswer').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
};
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch') showProbe(e);
});
// A tap selects a point; a drag or multi-touch gesture belongs to the camera.
let probeTouch: { id: number; x: number; y: number; moved: boolean } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  if (probeTouch) { probeTouch.moved = true; return; }
  probeTouch = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (probeTouch?.id === e.pointerId && Math.hypot(e.clientX - probeTouch.x, e.clientY - probeTouch.y) > 12) probeTouch.moved = true;
});
canvas.addEventListener('pointerup', (e) => {
  if (probeTouch?.id !== e.pointerId) return;
  if (!probeTouch.moved) showProbe(e);
  probeTouch = null;
});
canvas.addEventListener('pointercancel', (e) => { if (probeTouch?.id === e.pointerId) probeTouch = null; });
canvas.addEventListener('pointerleave', (e) => {
  if (e.pointerType === 'touch') return;
  $('probe').classList.remove('on');
  U.uProbe.value.z = 0;
});

// ---------- places ----------
// HTML labels anchored to the relief, re-projected every frame.
interface Anchor {
  name: string;
  kind: 'city' | 'area' | 'peak' | 'epi' | 'note';
  epi: boolean;
  u: number;
  v: number;
  el: HTMLElement;
  clear: number; // smoothed line-of-sight visibility, 0 hidden by relief … 1 clear
  free: number; // smoothed screen-space room, 0 clipped or overlapped … 1 free
  valLen?: number; // characters of the measured value shown in Explore's climax
}
let ANCHORS: Anchor[] = [];

function buildAnchors() {
  $('places').replaceChildren();
  const list: Omit<Anchor, 'el' | 'clear' | 'free' | 'epi'>[] = [
    ...site.epicentres.map((e) => ({ name: e.label, kind: 'epi' as const, u: mapper.u(e.lon), v: mapper.v(e.lat) })),
    ...site.places.map((p) => ({ name: p.name, kind: p.kind, u: mapper.u(p.lon), v: mapper.v(p.lat) })),
  ];
  ANCHORS = list
    .filter((a) => a.u > 0.01 && a.u < 0.99 && a.v > 0.01 && a.v < 0.99)
    .map((a) => {
      const el = document.createElement('div');
      el.className = `place ${a.kind}`;
      el.innerHTML = a.kind === 'area' ? `<b>${a.name}</b>` : `<i></i><s></s><b>${a.name}</b>${a.kind === 'epi' ? '' : '<em class="pv"></em>'}`;
      $('places').appendChild(el);
      return { ...a, epi: a.kind === 'epi', el, clear: 1, free: 0 };
    });
}

const anchorW = new THREE.Vector3();
const anchorV = new THREE.Vector3();
const anchorS = new THREE.Vector3();

// Coarse heightfield march from the anchor towards the camera; only the part of the
// segment below the highest relief can be blocked.
function blockedByRelief(p: THREE.Vector3, c: THREE.Vector3) {
  if (c.y <= p.y) return false;
  const tMax = Math.min(1, (maxRelief - p.y) / (c.y - p.y));
  const n = 28;
  for (let i = 1; i <= n; i++) {
    anchorS.lerpVectors(p, c, (i / n) * tMax);
    const u = (anchorS.x + SX / 2) / SX, v = (anchorS.z + SZ / 2) / SZ;
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    if (cpuWorldH(u, v) > anchorS.y + 0.2 * S) return true;
  }
  return false;
}

// Screen-space declutter: labels keep clear of the viewport edge, the UI text and each other
// (ANCHORS is in priority order, so epicentres and cities win over area names).
interface Box { x0: number; y0: number; x1: number; y1: number }
const LABEL_CHAR_W = 7.6; // 10px mono + 0.14em tracking
const OBSTACLES_STORY = ['#eyebrow', '#headline', '#sub', '#legend.on', '#hero.on', '.nav', '.explore.on', '.top'];
const OBSTACLES_PICKER = ['.picker-head', '.card', '.top'];
const hits = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

// Measuring the page forces a layout, so the boxes are measured a few times a second, not every frame: the panels they
// stand for move only with chapter changes and their eased entrances.
let obstacleCache: { at: number; mode: string; beat: number; boxes: Box[] } = { at: -1e9, mode: '', beat: -2, boxes: [] };
function obstacleBoxes(): Box[] {
  const t = performance.now();
  if (obstacleCache.mode === mode && obstacleCache.beat === beat && t - obstacleCache.at < 200) return obstacleCache.boxes;
  obstacleCache = { at: t, mode, beat, boxes: measureObstacles() };
  return obstacleCache.boxes;
}
function measureObstacles(): Box[] {
  const out: Box[] = [];
  for (const sel of mode === 'picker' ? OBSTACLES_PICKER : OBSTACLES_STORY) {
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) out.push({ x0: r.left - 10, y0: r.top - 8, x1: r.right + 10, y1: r.bottom + 8 });
    });
  }
  return out;
}

function updateAnchors(dt: number) {
  const w = innerWidth, h = innerHeight;
  const blocks = mode === 'boot' ? [] : obstacleBoxes();
  const placed: Box[] = [];
  for (const a of ANCHORS) {
    // Names belong to the landed slab; a note only speaks where it is read: on the displacement map, of the event pair.
    const noteOn = a.kind !== 'note' || (!isFlood() && (beat === 3 || (beat === 5 && exploreMode === 'displacement' && pairIdx === evIdx)));
    const vis = (a.epi ? T.values.epi : T.values.places) * T.values.reveal * Math.max(0, (T.values.dive - 0.9) / 0.1) * (noteOn ? 1 : 0);
    if (vis < 0.005) {
      a.el.style.opacity = '0';
      continue;
    }
    anchorW.set(-SX / 2 + a.u * SX, cpuWorldH(a.u, a.v) + 0.5 * S, (a.v - 0.5) * SZ);
    anchorV.copy(anchorW).applyMatrix4(camera.matrixWorldInverse);
    anchorS.copy(anchorW).project(camera);
    const onScreen = anchorV.z < -1 && Math.abs(anchorS.x) < 1.05 && Math.abs(anchorS.y) < 1.05;
    if (!onScreen) {
      a.el.style.opacity = '0';
      a.free = 0;
      continue;
    }
    const x = (anchorS.x * 0.5 + 0.5) * w, y = (0.5 - anchorS.y * 0.5) * h;
    anchorV.copy(anchorW).setY(anchorW.y + S); // test from just above the ground
    const target = blockedByRelief(anchorV, camera.position) ? 0 : 1;
    a.clear += (target - a.clear) * (1 - Math.exp(-dt * 8));

    const bw = Math.max(a.name.length, climaxOn ? a.valLen ?? 0 : 0) * LABEL_CHAR_W + 8;
    const yOff = a.epi ? 38 : 22;
    const tall = climaxOn && a.valLen ? 15 : 0; // the value line sits above the name
    const box: Box =
      a.kind === 'area'
        ? { x0: x - bw / 2, y0: y - 10, x1: x + bw / 2, y1: y + 10 }
        : { x0: x + 4, y0: y - yOff - 17 - tall, x1: x + 8 + bw, y1: y - yOff + 4 };
    const blocked =
      box.x0 < 10 || box.x1 > w - 10 || box.y0 < 10 || box.y1 > h - 10 ||
      blocks.some((b) => hits(box, b)) || placed.some((b) => hits(box, b));
    a.free += ((blocked ? 0 : 1) - a.free) * (1 - Math.exp(-dt * 7));
    if (a.free > 0.02 && a.clear > 0.3) placed.push(box);

    a.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
    a.el.style.opacity = (vis * a.clear * a.free).toFixed(3);
  }
}

// ---------- layout ----------
function applySize() {
  const w = innerWidth, h = innerHeight;
  if (w < 2 || h < 2) return; // a hidden pane reports a zero-size window; keep the last good size
  renderer.setPixelRatio(dpr);
  composer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  composer.setSize(w, h);
  bloom.resolution.set(w, h);
  grade.uniforms.uRes.value.set(w * dpr, h * dpr);
  U.uScreen.value.set(w * dpr, h * dpr);
}

// Keep the frame time near 60 fps: drop the render resolution when frames run long, and probe upwards when they do not.
// Under vsync the gap between frames never goes below one refresh interval, so "fast" means "holding the refresh rate":
// after a raise that does not hold, go back and treat that value as the ceiling. Frames over 200 ms are ignored — that
// is a hidden or throttled tab, not a slow GPU.
let emaMs = 16;
let adaptClock = 0;
let clockMs = 0;
let fastFor = 0;
let dprCeil = DPR_CAP;
let prevDpr = DPR_CAP;
let lastRaise = -1e9;
function adaptQuality(gapMs: number) {
  if (gapMs > 200 || gapMs <= 0 || document.visibilityState !== 'visible') return;
  emaMs += (gapMs - emaMs) * 0.06;
  adaptClock += gapMs;
  clockMs += gapMs;
  if (adaptClock < 1500) return;
  adaptClock = 0;
  if (emaMs > 19.5 && dpr > DPR_MIN) {
    fastFor = 0;
    if (clockMs - lastRaise < 14000 && prevDpr < dpr) {
      dpr = prevDpr; // the last raise did not hold
      dprCeil = prevDpr;
    } else dpr = Math.max(DPR_MIN, +(dpr * 0.86).toFixed(3));
    applySize();
  } else if (emaMs < 18.5 && dpr < Math.min(DPR_CAP, dprCeil)) {
    fastFor += 1.5;
    if (fastFor >= 8) {
      prevDpr = dpr;
      dpr = Math.min(DPR_CAP, dprCeil, +(dpr * 1.12).toFixed(3));
      lastRaise = clockMs;
      fastFor = 0;
      applySize();
    }
  } else if (emaMs >= 18.5) fastFor = 0;
}

function resize() {
  const w = innerWidth, h = innerHeight;
  if (w < 2 || h < 2) return;
  applySize();
  camera.aspect = w / h;
  camera.fov = w / h < 1 ? 46 : 34;
  camera.updateProjectionMatrix();
  const nextPortrait = w / h < 0.8;
  const next = nextPortrait ? 1.05 : w / h < 1.3 ? 1.45 : 1;
  distScale = next;
  portrait = nextPortrait;
  // Any change of window re-frames the chapter (once the resizing settles), unless the viewer is steering in Explore.
  clearTimeout(refitTimer);
  refitTimer = window.setTimeout(() => {
    if (mode === 'story' && beat >= 0 && !userCam && F) flyTo(beat, 0.8);
  }, 160);
}
let refitTimer = 0;
addEventListener('resize', resize);
addEventListener('resize', () => measurePicker());
resize();

// ---------- loop ----------
let shakeAt = -1e9, shakeFor = 1, shakeAmp = 0;
const shakeOff = new THREE.Vector3();
function shake(amp: number, seconds: number) {
  shakeAt = performance.now();
  shakeAmp = amp;
  shakeFor = seconds;
}
// The place's moment, felt: the quake shakes the camera hard, the sinking city trembles slowly, the rest only sound.
function climaxFx() {
  sound.climax(site.kind);
  if (site.kind === 'quake') shake(0.9, 1.6);
  else if (site.kind === 'subsidence') shake(0.25, 3.5);
  else if (site.kind === 'volcano') shake(0.2, 2.5);
}
// ?debug: report any frame where a transition value or the camera leaps (the film script collects these lines).
const DEBUG_JUMPS = params.has('debug');
const jumpPrev: Record<string, number> = {};
const jumpCam = new THREE.Vector3();
function watchJumps(V: typeof T.values) {
  for (const k of ['dive', 'reveal', 'pick', 'orbit'] as const) {
    const v = V[k], p = jumpPrev[k];
    if (p !== undefined && Math.abs(v - p) > 0.2) console.info(`[jump] ${k} ${p.toFixed(3)} → ${v.toFixed(3)} · mode ${mode} · site ${site?.id} · beat ${beat}`);
    jumpPrev[k] = v;
  }
  const d = camera.position.distanceTo(jumpCam);
  if (jumpPrev.cam !== undefined && d > Math.max(40, 0.35 * camera.position.length())) console.info(`[jump] camera ${d.toFixed(0)} · mode ${mode} · site ${site?.id} · beat ${beat} · dive ${V.dive.toFixed(3)}`);
  jumpPrev.cam = 1;
  jumpCam.copy(camera.position);
}
const drift = new THREE.Vector3();
const epiW = new THREE.Vector3();
let lastNow = 0;
function frame(ms: number, once?: boolean) {
  const now = ms / 1000;
  const dt = lastNow ? Math.min(now - lastNow, 0.1) : 1 / 60;
  if (!once && lastNow) adaptQuality((now - lastNow) * 1000);
  if (DEBUG_JUMPS && !once && lastNow && now - lastNow > 0.05) console.info(`[slow frame] ${Math.round((now - lastNow) * 1000)} ms · mode ${mode}`);
  lastNow = now;
  T.update(now);
  syncAssistant();
  const V = T.values;
  if (DEBUG_JUMPS) watchJumps(V);
  if (playing && performance.now() >= holdUntil) {
    if (PAIRS.length > 1) {
      // Every pair gets the same screen time (the event pair a little more), whatever its length in days.
      const t = timeAt(tFrac), k = pairAt(t);
      const a = dayMs(PAIRS[k].ref), b = dayMs(PAIRS[k].sec);
      const ev = PAIRS[k].event && !noEvent();
      const local = (t - a) / (b - a);
      // The event pair is played in slow motion around the shock: quickly up to it, a clear jump, then time to look at what remains.
      const u = ev ? screenOf(local, (eventAt - EV_W - a) / (b - a), (eventAt + EV_W - a) / (b - a)) : local;
      const un = u + dt / (ev ? PAIR_S * 1.8 : PAIR_S);
      const ln = ev ? localOf(un, (eventAt - EV_W - a) / (b - a), (eventAt + EV_W - a) / (b - a)) : un;
      setTime(fracOf(a + ln * (b - a)));
    } else setTime(tFrac + dt / 8);
    if (tFrac >= 1) pause();
  }

  if (!F) {
    if (!once) requestAnimationFrame(frame);
    return;
  }

  if (mode === 'picker') {
    const o = introOn ? introPose(now) : pickerPose(now);
    camTo.p.copy(o.p);
    camTo.t.copy(o.t);
  }

  // The slab rides higher while the picker's cards take the lower half of the screen.
  const w = innerWidth, h = innerHeight;
  const lift = globe && pickerGap.radius > 0 ? h / 2 - pickerGap.center : h * (w / h < 0.8 ? 0.16 : 0.2);
  const off = V.pick * lift + (introOn ? h * 0.115 : 0); // in the opening the globe sits above the title
  const offX = globe && pickerGap.radius > 0 ? V.pick * (w / 2 - pickerGap.cx) : 0; // wide screens: the globe to the right
  if (Math.abs(off) > 0.5 || Math.abs(offX) > 0.5) camera.setViewOffset(w, h, offX, off, w, h);
  else if (camera.view?.enabled) camera.clearViewOffset();

  if (controls.enabled && userCam) {
    controls.update();
    // Keep the aim over the slab: a long pan should not lose it.
    const tg = controls.target;
    const previousTarget = tg.clone();
    tg.x = Math.min(SX * 0.6, Math.max(-SX * 0.6, tg.x));
    tg.z = Math.min(SZ * 0.6, Math.max(-SZ * 0.6, tg.z));
    tg.y = Math.min(40 * S, Math.max(-10 * S, tg.y));
    camera.position.add(tg.clone().sub(previousTarget));
    camNow.p.copy(camera.position);
    camNow.t.copy(tg);
  } else {
    const onGround = mode === 'story' && V.dive > 0.99;
    if (onGround && V.cam < 1) {
      // Moves between shots on the ground orbit the terrain: the aim slides, and the camera turns around it (the shorter
      // way), rises or dips, and moves in or out geometrically. A straight line would cut across the slab.
      camNow.t.lerpVectors(camFrom.t, camTo.t, V.cam);
      orbitBlend(camFrom, camTo, V.cam, camNow.p);
      camNow.p.add(camNow.t);
      // …with a light crane rise in the middle, so it clears ridges and the satellite it flies past.
      camNow.p.y += Math.sin(Math.PI * V.cam) * Math.min(30 * S, camFrom.p.distanceTo(camTo.p) * 0.08);
    } else {
      camNow.p.lerpVectors(camFrom.p, camTo.p, V.cam);
      camNow.t.lerpVectors(camFrom.t, camTo.t, V.cam);
    }
    if (V.ride > 0.001 && rideKind) {
      const r = ridePose(rideKind, satNow(rideKind === 1 ? V.pass1 : V.pass2, V.approach));
      const lift = Math.sin(Math.PI * V.ride) * Math.min(55 * S, camNow.p.distanceTo(r.p) * 0.3);
      camNow.p.lerp(r.p, V.ride);
      camNow.t.lerp(r.t, V.ride);
      camNow.p.y += lift;
    }
    const dg = (film ? 2.4 : 1) * S * (1 - 0.85 * V.ride); // a wider, slower float when nobody is steering; still while riding
    drift.set(Math.sin(now * 0.071) * 5 * dg, Math.sin(now * 0.053) * 1.6 * dg, Math.cos(now * 0.061) * 3.5 * dg);
    camera.position.copy(camNow.p).add(drift);
    // Explore turns slowly about the map while nobody is steering: a living overview, not a still.
    if (beat === 5 && mode === 'story') {
      const a = Math.sin(now * 0.07) * 0.16 * V.cam ** 4; // eases in as the flight into Explore lands
      const off = camera.position.clone().sub(camNow.t).applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      camera.position.copy(camNow.t).add(off);
    }
    // Never inside the ground: a path between two poses may cut through a ridge.
    const cu = (camera.position.x + SX / 2) / SX, cv = camera.position.z / SZ + 0.5;
    if (F && T.values.dive > 0.99 && cu > -0.02 && cu < 1.02 && cv > -0.02 && cv < 1.02) {
      const floor = cpuWorldH(Math.min(1, Math.max(0, cu)), Math.min(1, Math.max(0, cv))) + 5 * S;
      if (camera.position.y < floor) camera.position.y = floor;
    }
    camera.lookAt(camNow.t);
    if (controls.enabled) controls.target.copy(camNow.t);
  }
  camera.updateMatrixWorld();

  if (rollActive) roll += 0.0022;
  else roll *= 0.96;

  U.uPass1.value = V.pass1;
  U.uPass2.value = V.pass2;
  U.uAmp.value = V.amp;
  U.uFringe.value = V.fringe;
  U.uUnwrap.value = V.unwrap;
  U.uChange.value = V.change;
  U.uLossK.value = beat === 5 && isFlood() ? V.disp : 1;
  U.uWave.value = V.wave;
  // The unwrapping front, in km from the epicentres; once it has crossed the slab, everything is simply unwrapped.
  const frontLive = beat === 3 && V.front < 0.999;
  U.uFront.value = frontLive ? V.front * FRONT_KM() : -1;
  U.uFrontW.value = 7 * S;
  U.uFrontLit.value = frontLive ? V.frontLit : 0;
  U.uSweepLit.value = mode === 'story' && (beat === 1 || beat === 2) ? 1 : 0; // not while the passes rewind
  U.uLift.value = V.lift;
  U.uLava.value = site.kind === 'volcano' ? V.change : 0;
  U.uFlow.value = site.kind === 'flood' ? V.change : 0;
  const splitLive = compareOn && mode === 'story' && beat === 5;
  U.uSplit.value = splitLive ? V.split : -1;
  if (splitLive) $('app').style.setProperty('--split', V.split.toFixed(4));
  $('split').classList.toggle('on', splitLive);
  ghostU.uGhost.value = V.ghost * V.lift;
  ghostU.uGapMin.value = liftKm * range * 0.06; // km of relief: gaps smaller than this are noise, not motion
  U.uCoh.value = V.coh;
  U.uCohWipe.value = beat === 4 && V.cohWipe < 1.01 ? V.cohWipe : -1;
  U.uDisp.value = beat === 5 && isFlood() ? 1 : V.disp;
  U.uXf.value = V.xf;
  U.uNight.value = V.night;
  cloudU.uCloud.value = V.cloud * V.reveal;
  cloudU.uPass.value = V.pass1;
  cloudU.uTime.value = now;
  clouds.visible = V.cloud * V.reveal > 0.003 && siteReady;
  U.uReveal.value = V.reveal;
  terrain.visible = skirt.visible = siteReady && V.reveal > 0.002;
  (terrain.material as THREE.Material).transparent = (skirt.material as THREE.Material).transparent = V.reveal < 0.999;
  if (xfPending && V.xf >= 0.999) settleCrossfade();
  U.uRoll.value = roll;
  U.uTime.value = now;
  grade.uniforms.uTime.value = now;
  // The dive passes through cloud where the globe's picture runs out of detail and the ground takes over.
  const mk = Math.min(1, Math.max(0, (V.dive - 0.42) / 0.36));
  grade.uniforms.uMist.value = globe && !REDUCED ? Math.sin(Math.PI * mk) * 0.92 : 0;
  grade.uniforms.uMistZ.value = mk * 1.6;

  // Epicentre markers keep a constant on-screen size: pass km per CSS pixel at each one.
  const fovK = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / innerHeight;
  for (let m = 0; m < 2; m++) {
    const e = epiUv[m];
    const uv = U.uEpi.value[m];
    if (!e) {
      uv.z = 0;
      continue;
    }
    epiW.set(-SX / 2 + e.x * SX, cpuWorldH(e.x, e.y), (e.y - 0.5) * SZ);
    uv.z = V.epi;
    uv.w = camera.position.distanceTo(epiW) * fovK;
  }

  // Satellite follows whichever pass is sweeping; the beam is lit only while a pass is live.
  const which = rideKind === 2 && beat === 2 ? V.pass2 : V.pass1;
  const live = which > 0 && which < 1;
  const flying = mode === 'story' && (beat === 1 || beat === 2) && V.approach > 0.001 && which < 1;
  const sweeping = flying && live;
  sound.radar(sweeping && beamVis > 0.25);
  beamVis += ((flying ? 1 : 0) - beamVis) * (1 - Math.exp(-dt * (flying ? 2.6 : 1.8)));
  beamLit += ((sweeping ? 1 : 0) - beamLit) * (1 - Math.exp(-dt * (sweeping ? 4 : 3)));
  const z = satNow(which, V.approach);
  const satX = SX / 2 + 34 * S, satY = 64 * S;
  sat.position.set(satX, satY, z);
  const bp = beamGeo.attributes.position as THREE.BufferAttribute;
  bp.setXYZ(0, satX, satY, z);
  bp.setXYZ(1, -SX / 2, 1.2 * S, z);
  bp.setXYZ(2, SX / 2, 1.2 * S, z);
  bp.needsUpdate = true;
  beamU.uOpacity.value = beamVis * beamLit * (1 - 0.6 * V.ride); // up close the fan would wash out the picture
  // Up close the glow would blind; from afar it is how the satellite reads. It fades with the ride and with the real
  // distance to the camera, so a pass that sweeps by the lens never flares across the frame.
  const dCam = camera.position.distanceTo(sat.position) / S;
  const close = 1 - Math.min(1, Math.max(0, (dCam - 30) / 70));
  const near = Math.max(rideKind === 1 ? V.ride : 0, close * close * (3 - 2 * close));
  satHalo.material.opacity = beamVis * (1 - 0.9 * near);
  satCore.material.opacity = beamVis * (1 - 0.6 * near) * (1 - 0.8 * close);
  nisar.scale.setScalar(Math.max(1e-3, 2.5 * S * beamVis));
  nisar.rotation.y = Math.sin(now * 0.4) * 0.12; // a slow sway
  sat.visible = beam.visible = beamVis > 0.002;
  trackMat.opacity = beamVis * 0.35;

  if (beat === 3 || beat === 4) {
    const fp = beat === 3 ? Math.min(1, V.front * 1.25) : 1; // the number grows with the front
    $('heroVal').textContent =
      heroKind === 'fixed' ? (site.hero!.value * (isFlood() ? V.change : V.lift * V.disp) * fp).toFixed(site.hero!.value < 20 ? 1 : 0)
      : heroKind === 'area' ? (lostKm2 * V.change * fp).toFixed(1)
      : heroKind === 'sink' ? (sinkCm * V.lift * V.disp * fp).toFixed(1)
      : (peak * V.lift * V.disp * fp).toFixed(1);
  }
  if (film) {
    let before = 0;
    for (let i = 0; i < filmChapter; i++) before += dwell(i);
    const inside = Math.min((performance.now() - filmChapterT) / 1000, dwell(filmChapter));
    $('filmBar').style.transform = `scaleX(${((before + inside) / filmTotal()).toFixed(4)})`;
  }

  updateAnchors(dt);
  // The globe hands over while it is still sharp: its picture is 20 km a pixel, the slab's is a few hundred metres.
  const gk = Math.min(1, Math.max(0, (V.dive - 0.5) / 0.4));
  updateGlobe(dt, now, 1 - gk * gk * (3 - 2 * gk));
  // A quake shakes the camera for a moment: decaying, a few hertz, never with reduced motion.
  const shakeK = REDUCED ? 0 : Math.max(0, 1 - (performance.now() - shakeAt) / (shakeFor * 1000));
  if (shakeK > 0) {
    const t = performance.now() / 1000, a = shakeAmp * S * shakeK * shakeK;
    shakeOff.set(Math.sin(t * 31) + Math.sin(t * 17.3) * 0.6, Math.sin(t * 27.1 + 1) * 0.8, Math.sin(t * 23.7 + 2) + Math.sin(t * 13.1) * 0.5).multiplyScalar(a);
    camera.position.add(shakeOff);
  }
  renderer.info.reset();
  composer.render();
  if (shakeK > 0) camera.position.sub(shakeOff);
  fpsTick(ms);
  if (!once) requestAnimationFrame(frame);
}

// ---------- boot ----------
async function boot() {
  const say = (t: string) => ($('loaderText').textContent = t);
  buildCards();
  requestAnimationFrame(() => measurePicker());
  document.fonts?.ready.then(() => measurePicker());
  const wanted = siteById(params.get('site') ?? '');
  const first = wanted ?? SITES[0];
  loadTerrain(first).then(() => say('Reading the radar signal'));
  loadFields(first).then(() => say('Building the scene'));
  sound.prepare();
  sound.ambience(params.has('site') ? first.kind : 'space');
  await Promise.all([loadSite(first), globeLoaded]);
  await Promise.race([globeHd, new Promise((r) => setTimeout(r, 2500))]); // a slow network never holds the page
  // Compile every program now, off the main thread where the driver allows it: otherwise the first switch and the first
  // dive each stall for a quarter of a second while the slab's, the clouds' and the satellite's shaders compile.
  const hidden = [terrain, skirt, clouds, sat, beam].filter((o) => !o.visible);
  for (const o of hidden) o.visible = true;
  // Against the composer's buffer, not the canvas: the scene is drawn there, in linear colour, and that is a different program.
  const rt = renderer.getRenderTarget();
  renderer.setRenderTarget(composer.readBuffer);
  await renderer.compileAsync(scene, camera).catch(() => undefined);
  renderer.setRenderTarget(rt);
  for (const o of hidden) o.visible = false;
  if (params.has('debug')) console.info(`[boot] first site ready at ${Math.round(performance.now())} ms`);
  $('loader').classList.add('done');
  requestAnimationFrame(frame);
  if (wanted) {
    await enterSite(wanted);
    const ch = Number(params.get('ch'));
    if (ch > 0 && ch < BEATS.length && !params.has('film')) go(ch);
    if (params.has('film')) filmStart(true);
  } else if (globe && !REDUCED && !params.has('nointro')) {
    markCard(first.id);
    startIntro();
  } else {
    mode = 'picker';
    $('app').dataset.mode = 'picker';
    syncInert();
    T.to('pins', 1, 1.6, 0.4, linear);
    T.to('orbit', 0.55, 2);
    T.to('pick', 1, 1.6);
    T.to('epi', 1, 1.6, 0.6);
    markCard(first.id);
    if (!globe) T.to('reveal', 1, 1.2);
    const start = globe ? globePose(performance.now() / 1000, 1.9) : poseFor(ORBIT[0], ORBIT[1]); // the globe arrives from afar
    camNow.p.copy(start.p);
    camNow.t.copy(start.t);
    const o = pickerPose(performance.now() / 1000);
    camFrom.p.copy(camNow.p);
    camFrom.t.copy(camNow.t);
    camTo.p.copy(o.p);
    camTo.t.copy(o.t);
    T.values.cam = 0;
    T.to('cam', 1, 4.2, 0, easeInOut);
  }
}
void boot();

// ?debug: a synchronous GPU benchmark, usable even when the tab is hidden and requestAnimationFrame is throttled.
if (params.has('debug')) {
  (window as unknown as Record<string, unknown>).__ie = {
    bench(frames = 30, w = innerWidth, h = innerHeight, ratio = dpr) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      const before = { w: innerWidth, h: innerHeight, dpr: renderer.getPixelRatio() };
      renderer.setPixelRatio(ratio);
      composer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
      composer.setSize(w, h);
      bloom.resolution.set(w, h);
      grade.uniforms.uRes.value.set(w * ratio, h * ratio);
      composer.render();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        renderer.info.reset();
        composer.render();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      const ms = (performance.now() - t0) / frames;
      const r = renderer.info.render;
      void before;
      applySize();
      return { ms: +ms.toFixed(2), fps: +(1000 / ms).toFixed(1), size: `${Math.round(w * ratio)}x${Math.round(h * ratio)}`, tris: r.triangles, calls: r.calls };
    },
    // Whole frame() cycle (JS updates, labels, DOM, render) run back to back with a GPU sync after each.
    full(frames = 40) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      let cpu = 0;
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        const a = performance.now();
        frame(a, true);
        cpu += performance.now() - a;
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      }
      const ms = (performance.now() - t0) / frames;
      return { ms: +ms.toFixed(2), fps: +(1000 / ms).toFixed(1), jsMs: +(cpu / frames).toFixed(2) };
    },
    // Advance the animation by hand for `sec` seconds of wall time: a hidden tab does not run requestAnimationFrame at all.
    run(sec = 1) {
      const gl = renderer.getContext();
      const px = new Uint8Array(4);
      const t0 = performance.now();
      let n = 0;
      while (performance.now() - t0 < sec * 1000) {
        frame(performance.now(), true);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        n++;
      }
      return n;
    },
    go: (i: number) => go(i),
    filmNext: () => filmNextSite(),
    playAll: () => playAll(),
    get state() { return { mode, film, filmAllOn, site: site.id, beat }; },
    get beat() { return beat; },
    cam: () => ({ p: camera.position.toArray().map((v) => +v.toFixed(1)), t: controls.target.toArray().map((v) => +v.toFixed(1)), ctl: controls.enabled, S, dist: +camera.position.distanceTo(controls.target).toFixed(1), from: camFrom.p.toArray().map((v) => +v.toFixed(1)), to: camTo.p.toArray().map((v) => +v.toFixed(1)), cam: T.values.cam }),
    get dpr() { return dpr; },
    get ema() { return emaMs; },
    enter: (id: string) => enterSite(siteById(id)!),
    preview: (id: string) => previewSite(siteById(id)!),
    picker: () => openPicker(),
    film: () => filmStart(),
    play: () => play(),
    rec: null as unknown,
    sound,
    // The slab's bounding box on screen (CSS px) and how much of it is inside the window, for the layout checks.
    slabRect: () => {
      const v = new THREE.Vector3();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const x of [-SX / 2, SX / 2]) for (const z of [-SZ / 2, SZ / 2]) for (const y of [-U.uBase.value, maxRelief]) {
        v.set(x, y, z).applyMatrix4(terrain.matrixWorld).project(camera);
        const px = (v.x * 0.5 + 0.5) * innerWidth, py = (0.5 - v.y * 0.5) * innerHeight;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      const ix = Math.max(0, Math.min(x1, innerWidth) - Math.max(x0, 0)), iy = Math.max(0, Math.min(y1, innerHeight) - Math.max(y0, 0));
      return { x0, y0, x1, y1, visible: (ix * iy) / Math.max(1, (x1 - x0) * (y1 - y0)) };
    },
    // The chapter's region of interest on screen, and how much of it is inside the window.
    focusRect: () => {
      const fb = focusBox(beat < 0 ? 0 : beat);
      const v = new THREE.Vector3();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const u of [fb.u0, fb.u1]) for (const w of [fb.v0, fb.v1]) for (const y of [0, maxRelief * 0.5]) {
        v.set(-SX / 2 + u * SX, y, (w - 0.5) * SZ).project(camera);
        const px = (v.x * 0.5 + 0.5) * innerWidth, py = (0.5 - v.y * 0.5) * innerHeight;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px); y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      const ix = Math.max(0, Math.min(x1, innerWidth) - Math.max(x0, 0)), iy = Math.max(0, Math.min(y1, innerHeight) - Math.max(y0, 0));
      return { x0, y0, x1, y1, visible: (ix * iy) / Math.max(1, (x1 - x0) * (y1 - y0)) };
    },
    camAboveGround: () => {
      const u = (camera.position.x + SX / 2) / SX, v = camera.position.z / SZ + 0.5;
      if (u < 0 || u > 1 || v < 0 || v > 1) return true;
      return camera.position.y >= cpuWorldH(u, v) + 1;
    },
    diag: () => ({
      dive: +T.values.dive.toFixed(3), reveal: +T.values.reveal.toFixed(3), cam: +T.values.cam.toFixed(3), pick: +T.values.pick.toFixed(3), wave: +T.values.wave.toFixed(3), shaking: performance.now() - shakeAt < shakeFor * 1000,
      globe: globe ? globe.root.visible : null, terrain: terrain.visible, calls: renderer.info.render.calls, F: !!F, site: site.id,
      camPos: camera.position.toArray().map((v) => +v.toFixed(0)), far: camera.far, mode, siteReady,
    }),
    programs: () => renderer.info.programs?.map((p) => `#${p.id} ${p.cacheKey.slice(0, 160)}`) ?? [],
    // The relief's smoothed lift: its range and its steepest step between neighbours (metres of line of sight).
    lift: () => {
      let lo = 0, hi = 0, step = 0;
      for (let k = 0; k < liftCPU.length; k++) {
        const v = liftCPU[k];
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
        if (k % F.W) step = Math.max(step, Math.abs(v - liftCPU[k - 1]));
      }
      return { lo, hi, step, W: F.W, H: F.H, liftKm: site.liftKm, range };
    },
  };
  // The recorder is a development tool: it needs the dev server's frame sink and never ships.
  if (import.meta.env.DEV) void import('./recorder').then((m) => {
    ((window as unknown as Record<string, Record<string, unknown>>).__ie).rec = m.makeRecorder((ms) => {
      frame(ms, true);
      const gl = renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); // settle the GPU so the canvas can be copied
    }, canvas, () => {
      lastNow = 0;
      requestAnimationFrame(frame);
    });
  });
}
