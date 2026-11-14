// The opening globe: the whole Earth as hill-shaded relief, one marker per place, and the maths that turns it into the ground.
import * as THREE from 'three';

export const GLOBE_R = 150;

export interface GlobePlace { id: string; lat: number; lon: number }

const D2R = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);

// Unit vector of a place in the globe's own frame (longitude 0 on +x, longitude 90 E on -z, as three's sphere UVs run).
export function dirOf(lat: number, lon: number, out = new THREE.Vector3()) {
  return out.set(Math.cos(lat * D2R) * Math.cos(lon * D2R), Math.sin(lat * D2R), -Math.cos(lat * D2R) * Math.sin(lon * D2R));
}

// The rotation that brings a place to face `dir`, with north kept as upright as the view allows.
export function faceQuat(lat: number, lon: number, dir: THREE.Vector3, out = new THREE.Quaternion()) {
  const s = dirOf(lat, lon);
  const east = new THREE.Vector3().crossVectors(UP, s).normalize();
  const north = new THREE.Vector3().crossVectors(s, east);
  const zT = dir.clone().normalize();
  const xT = new THREE.Vector3().crossVectors(UP, zT).normalize();
  const yT = new THREE.Vector3().crossVectors(zT, xT);
  const src = new THREE.Matrix4().makeBasis(east, north, s);
  const dst = new THREE.Matrix4().makeBasis(xT, yT, zT);
  return out.setFromRotationMatrix(dst.multiply(src.transpose()));
}

// The rotation that lays a place flat at the top of the sphere with east on +x and north on -z: the way the slab is oriented.
export function topQuat(lat: number, lon: number, out = new THREE.Quaternion()) {
  const s = dirOf(lat, lon);
  const east = new THREE.Vector3().crossVectors(UP, s).normalize();
  const north = new THREE.Vector3().crossVectors(s, east);
  const src = new THREE.Matrix4().makeBasis(east, north, s);
  const dst = new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 1, 0));
  return out.setFromRotationMatrix(dst.multiply(src.transpose()));
}

const surfVert = /* glsl */ `
out vec2 vUv;
out vec3 vN;
out vec3 vW;
out vec3 vO;
void main(){
  vUv = uv;
  vO = normal; // the globe's own frame, which turns with the Earth
  vN = mat3(modelMatrix) * normal;
  vec4 w = modelMatrix * vec4(position, 1.);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const surfFrag = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uSun;
uniform float uAlpha;
uniform vec3 uOrbN;    // NISAR's orbit plane, in the globe's frame
uniform vec3 uSatDir;  // where NISAR is now, in the globe's frame
uniform float uSwath;  // 0..1: the strip it has just imaged
uniform vec4 uAoi;     // the chosen place's footprint: west, south, east, north (degrees)
uniform float uAoiOn;  // 0..1
in vec2 vUv;
in vec3 vN;
in vec3 vW;
in vec3 vO;
out vec4 fragColor;
void main(){
  vec4 t = texture(uMap, vUv);
  bool sea = t.a > .95;
  vec3 n = normalize(vN);
  vec3 L = normalize(uSun);
  vec3 V = normalize(cameraPosition - vW);
  float ndl = dot(n, L);
  float lit = .22 + 1.05 * smoothstep(-.25, .85, ndl);
  vec3 col = t.rgb * lit * 1.3;
  if (sea){
    vec3 R = reflect(-L, n);
    col += vec3(1., .9, .78) * pow(max(dot(R, V), 0.), 900.) * .22; // a small, sharp sun glint (the bloom widens it)
  }
  // A graticule every 30 degrees: it says 'planet', and it says 'measured'.
  vec2 g = vUv * vec2(12., 6.);
  vec2 gl = 1. - min(abs(fract(g - .5) - .5) / (fwidth(g) * 1.2), 1.);
  col += vec3(.45, .72, 1.) * max(gl.x, gl.y) * .05 * (.4 + .6 * smoothstep(-.2, .6, ndl));
  // The swath: the strip along the ground track (drawn wider than its real 240 km), bright where NISAR is, fading behind it.
  if (uSwath > .001){
    vec3 o = normalize(vO);
    float across = abs(dot(o, uOrbN));
    vec3 ip = o - dot(o, uOrbN) * uOrbN;
    vec3 inPlane = ip / max(length(ip), 1e-5); // at the orbit's poles the projection vanishes: never normalise zero
    float along = -atan(dot(cross(uSatDir, inPlane), uOrbN), dot(uSatDir, inPlane)); // < 0 behind the satellite
    float strip = 1. - smoothstep(.036, .044, across); // widened: 240 km would be a hair at this scale
    float trail = smoothstep(-2.6, -.02, along) * (1. - smoothstep(-.02, .01, along));
    float edge = exp(-along * along * 900.) * strip;
    // Inside: the ground as radar sees it, brighter and cooler, with fine scan lines across the track.
    float scan = .82 + .18 * sin(along * 900.);
    vec3 imaged = (col * 1.25 + vec3(.05, .1, .16)) * scan;
    col = mix(col, imaged, strip * trail * uSwath * .85);
    // The swath's edges, faint, and the line where NISAR is imaging now, bright.
    float rim = (1. - smoothstep(.0, .004, abs(across - .04))) * trail * .35;
    col += vec3(.45, .75, 1.) * (edge * 1.1 + rim) * uSwath;
  }
  // The chosen place's footprint: a glowing frame on the ground, the area the dive lands in.
  if (uAoiOn > .001){
    float lon = vUv.x * 360. - 180., lat = vUv.y * 180. - 90.;
    vec2 lo = vec2(uAoi.x, uAoi.y), hi = vec2(uAoi.z, uAoi.w);
    vec2 p = vec2(lon, lat);
    vec2 dd = max(lo - p, p - hi);
    float outside = max(dd.x, dd.y); // < 0 inside, degrees
    float px = fwidth(lon) * 1.5;
    float frame = 1. - smoothstep(0., px * 1.4, abs(outside));
    float inside = step(outside, 0.);
    col = mix(col, col * 1.35 + vec3(.9, .45, .32) * .12, inside * uAoiOn);
    col += vec3(1., .55, .42) * frame * 1.4 * uAoiOn;
  }
  float fres = pow(max(1. - max(dot(n, V), 0.), 0.), 3.2);
  col += vec3(.28, .52, 1.) * fres * .5;
  fragColor = vec4(col, uAlpha);
}
`;

const glowFrag = /* glsl */ `
uniform float uAlpha;
in vec3 vN;
in vec3 vW;
out vec4 fragColor;
void main(){
  vec3 V = normalize(cameraPosition - vW);
  // Seen from behind the globe: brightest at the limb, gone at the outer edge of the shell.
  float t = clamp(-dot(normalize(vN), V), 0., 1.);
  float k = pow(smoothstep(0., .52, t), 1.8);
  fragColor = vec4(vec3(.24, .48, 1.) * k * .62 * uAlpha, 1.);
}
`;

export interface Globe {
  root: THREE.Group; // positioned and scaled by the caller: its top point rides at the origin
  spin: THREE.Group; // holds the sphere and the markers; rotated to face a place
  stars: THREE.Points;
  pins: Map<string, THREE.Object3D>;
  setAlpha(a: number): void;
  // orbit: 0..1 how much of NISAR's orbit, satellite and swath to show; pins: 0..1 the places lighting up in turn
  update(now: number, selected: string, dive: number, scale: number, orbit?: number, pins?: number): void;
  setFootprint(aoi: { west: number; south: number; east: number; north: number } | null, on: number): void;
  setMap(map: THREE.Texture): void; // swap the picture (the sharper one arrives after the first)
}

export function createGlobe(places: GlobePlace[], map: THREE.Texture, sun: THREE.Vector3): Globe {
  const root = new THREE.Group();
  const spin = new THREE.Group();
  root.add(spin);

  const surf = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: {
      uMap: { value: map }, uSun: { value: sun }, uAlpha: { value: 1 },
      uOrbN: { value: new THREE.Vector3(0, 1, 0) }, uSatDir: { value: new THREE.Vector3(1, 0, 0) }, uSwath: { value: 0 },
      uAoi: { value: new THREE.Vector4() }, uAoiOn: { value: 0 },
    },
    vertexShader: surfVert,
    fragmentShader: surfFrag,
    transparent: true,
  });
  const ball = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R, 128, 80), surf);
  ball.frustumCulled = false;
  ball.renderOrder = -4;
  spin.add(ball);

  const glowMat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    uniforms: { uAlpha: { value: 1 } },
    vertexShader: surfVert,
    fragmentShader: glowFrag,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.BackSide,
  });
  const glow = new THREE.Mesh(new THREE.SphereGeometry(GLOBE_R * 1.13, 96, 64), glowMat);
  glow.frustumCulled = false;
  glow.renderOrder = -5;
  root.add(glow);

  const pins = new Map<string, THREE.Object3D>();
  const pinMats: THREE.MeshBasicMaterial[] = [];
  const coral = new THREE.Color(0xe0786a);
  for (const p of places) {
    const g = new THREE.Group();
    const dir = dirOf(p.lat, p.lon);
    g.position.copy(dir).multiplyScalar(GLOBE_R);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    const core = new THREE.Mesh(new THREE.SphereGeometry(1.5, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd9c9, transparent: true }));
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 14, 6, 1, true).rotateX(Math.PI / 2).translate(0, 0, 7), new THREE.MeshBasicMaterial({ color: coral, transparent: true, opacity: 0.6 }));
    const ringMat = new THREE.MeshBasicMaterial({ color: coral, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.2, 3.7, 48), ringMat);
    ring.name = 'ring';
    const ring2 = ring.clone();
    ring2.name = 'ring2';
    ring2.material = ringMat.clone();
    g.add(core, stem, ring, ring2);
    g.userData = { core, stem, ring, ring2, dir };
    spin.add(g);
    pins.set(p.id, g);
    pinMats.push(core.material as THREE.MeshBasicMaterial, stem.material as THREE.MeshBasicMaterial, ringMat, ring2.material as THREE.MeshBasicMaterial);
  }

  // NISAR's orbit: 747 km up, nearly polar, fixed in space while the Earth turns under it.
  const ORBIT_R = GLOBE_R * (1 + 747 / 6371);
  const orbN = new THREE.Vector3(1, 0.1, -0.52).normalize();
  const orbU = new THREE.Vector3().crossVectors(orbN, new THREE.Vector3(0, 1, 0)).normalize();
  const orbV = new THREE.Vector3().crossVectors(orbN, orbU);
  const ringPts: THREE.Vector3[] = [];
  for (let i = 0; i <= 256; i++) {
    const a = (i / 256) * Math.PI * 2;
    ringPts.push(orbU.clone().multiplyScalar(Math.cos(a) * ORBIT_R).addScaledVector(orbV, Math.sin(a) * ORBIT_R));
  }
  const orbitMat = new THREE.LineBasicMaterial({ color: 0x9fc4dd, transparent: true, opacity: 0, depthWrite: false });
  const orbitLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(ringPts), orbitMat);
  orbitLine.frustumCulled = false;
  root.add(orbitLine);
  const glowC = document.createElement('canvas');
  glowC.width = glowC.height = 64;
  const gg = glowC.getContext('2d')!;
  const rg = gg.createRadialGradient(32, 32, 0, 32, 32, 32);
  rg.addColorStop(0, 'rgba(255,255,255,1)');
  rg.addColorStop(0.12, 'rgba(255,236,200,0.9)');
  rg.addColorStop(0.35, 'rgba(160,200,255,0.25)');
  rg.addColorStop(1, 'rgba(160,200,255,0)');
  gg.fillStyle = rg;
  gg.fillRect(0, 0, 64, 64);
  const satMat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(glowC), transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const sat = new THREE.Sprite(satMat);
  sat.scale.setScalar(16);
  root.add(sat);
  const satPos = new THREE.Vector3(), qInv = new THREE.Quaternion();

  // A sparse field of stars far behind everything.
  const n = 1400;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = Math.random() * 2 - 1, a = Math.random() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    pos.set([r * Math.cos(a) * 2900, u * 2900, r * Math.sin(a) * 2900], i * 3);
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const starMat = new THREE.PointsMaterial({ color: 0xb9cdf5, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.55, depthWrite: false });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;

  let alpha = 1;
  const globe: Globe = {
    root,
    spin,
    stars,
    pins,
    setMap(map) {
      const old = surf.uniforms.uMap.value as THREE.Texture;
      surf.uniforms.uMap.value = map;
      if (old !== map) old.dispose();
    },
    setFootprint(aoi, on) {
      if (aoi) surf.uniforms.uAoi.value.set(aoi.west, aoi.south, aoi.east, aoi.north);
      surf.uniforms.uAoiOn.value = on;
    },
    setAlpha(a) {
      alpha = a;
      surf.uniforms.uAlpha.value = a;
      glowMat.uniforms.uAlpha.value = a;
      starMat.opacity = 0.55 * a;
      root.visible = a > 0.003;
      stars.visible = a > 0.003;
    },
    update(now, selected, dive, scale, orbit = 1, pinsOn = 1) {
      // The markers keep their size and step aside as the globe grows into the ground; so does the halo.
      const k = 1 - Math.min(1, dive / 0.22);
      glowMat.uniforms.uAlpha.value = alpha * (1 - Math.min(1, dive / 0.35));
      let i = 0;
      pins.forEach((g, id) => {
        // The places light up one after another.
        const lit = Math.min(1, Math.max(0, pinsOn * (pins.size + 1) - i++));
        g.scale.setScalar((1 / scale) * (0.3 + 0.7 * lit));
        g.visible = lit > 0.001;
        const on = id === selected;
        const { core, stem, ring, ring2 } = g.userData as Record<string, THREE.Mesh>;
        core.scale.setScalar(on ? 1.5 : 1);
        (core.material as THREE.MeshBasicMaterial).opacity = alpha * k * lit * (on ? 1 : 0.7);
        (stem.material as THREE.MeshBasicMaterial).opacity = alpha * k * lit * (on ? 0.75 : 0.35);
        [ring, ring2].forEach((r, j) => {
          const ph = (now * (on ? 0.55 : 0.3) + j * 0.5) % 1;
          r.scale.setScalar(0.6 + ph * (on ? 3.2 : 2));
          (r.material as THREE.MeshBasicMaterial).opacity = alpha * k * lit * (1 - ph) * (on ? 0.85 : 0.35);
        });
      });
      // NISAR goes round about every 20 s here (every 97 minutes in reality).
      const o = orbit * k;
      const th = -now * 0.31; // up the visible face, so the strip it leaves is in view
      satPos.copy(orbU).multiplyScalar(Math.cos(th) * ORBIT_R).addScaledVector(orbV, Math.sin(th) * ORBIT_R);
      sat.position.copy(satPos);
      satMat.opacity = alpha * o;
      orbitMat.opacity = alpha * o * 0.38;
      sat.visible = orbitLine.visible = o > 0.003;
      qInv.copy(spin.quaternion).invert();
      surf.uniforms.uOrbN.value.copy(orbN).applyQuaternion(qInv);
      surf.uniforms.uSatDir.value.copy(satPos).normalize().applyQuaternion(qInv);
      surf.uniforms.uSwath.value = o;
    },
  };
  return globe;
}
