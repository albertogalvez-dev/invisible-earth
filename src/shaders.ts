// GLSL for the terrain slab, its cut walls, the radar beam and the final grade.

const common = /* glsl */ `
uniform sampler2D uData;   // r height m, g LOS m (full step), b coherence, a roughness
uniform vec2 uTexel;
uniform vec2 uSize;        // km
uniform float uVex;        // vertical exaggeration of terrain
uniform float uLiftKm;     // km of lift per metre of LOS at full lift
uniform float uLift;
uniform float uDisp;       // displacement factor of the current epoch
uniform sampler2D uData2;  // the next pair, while one interferogram melts into the other
uniform float uXf;         // 0..1 crossfade from uData to uData2 (line of sight and coherence only; the terrain is shared)
uniform sampler2D uLiftTex;  // the line of sight the ground rises by: coherence-weighted and smoothed over ~9 px, clamped
uniform sampler2D uLiftTex2; // the same for the next pair
uniform vec4 uEpi[2];      // xy duv, z strength, w km per CSS pixel at the marker
uniform float uRange;      // metres of line of sight at the ends of the colour scale
uniform float uFront;      // km: the unwrapping front's distance from the epicentres (< 0: no front, all unwrapped)
uniform float uFrontW;     // km: the width of the front's edge
uniform float uSplit;      // eye vs radar: left of this screen fraction the ground is drawn as the eye sees it (< 0: off)
uniform vec2 uScreen;      // drawing-buffer size in pixels

// 1 behind the unwrapping front (the ground it has passed), 0 ahead of it.
float frontD(vec2 duv){
  float d = 1e9;
  for (int m = 0; m < 2; m++) if (uEpi[m].x > 0.) d = min(d, length((duv - uEpi[m].xy) * uSize));
  return d;
}
float frontK(vec2 duv){
  if (uFront < 0.) return 1.;
  return 1. - smoothstep(uFront - uFrontW, uFront, frontD(duv));
}

vec4 dataAt(vec2 duv, float lod){
  vec4 d = textureLod(uData, duv, lod);
  if (uXf > 0.){
    vec4 d2 = textureLod(uData2, duv, lod);
    d.g = mix(d.g, d2.g, uXf);
    d.b = mix(d.b, d2.b, uXf);
  }
  return d;
}

float worldH(vec2 duv){
  float h = textureLod(uData, duv, 0.).r;
  // The ground rises by a smoothed, coherence-weighted line of sight (built on the CPU, see smoothLift): the colours keep
  // every pixel, the relief keeps only what the neighbourhood agrees on, so noise and stray unwrapping errors never spike.
  float l = textureLod(uLiftTex, duv, 0.).r;
  if (uXf > 0.) l = mix(l, textureLod(uLiftTex2, duv, 0.).r, uXf);
  l *= smoothstep(0., 4., h); // the sea stays flat: the smoothing must not carry the coast's motion out onto the water
  return max(h, 0.) * .001 * uVex + l * uDisp * uLift * uLiftKm * frontK(duv);
}
`;

export const terrainVert = /* glsl */ `
${common}
out vec2 vD;
out vec3 vW;
void main(){
  vD = vec2(uv.x, 1. - uv.y);
  vec3 p = position;
  p.y = worldH(vD);
  vec4 w = modelMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * viewMatrix * w;
  // Eye vs radar: on the eye's side the ground stays where it is, at its true height, without the motion.
  if (uSplit >= 0. && gl_Position.x / gl_Position.w * .5 + .5 < uSplit){
    p.y = max(textureLod(uData, vD, 0.).r, 0.) * .001 * uVex;
    w = modelMatrix * vec4(p, 1.);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
  vW = w.xyz;
}
`;

export const terrainFrag = /* glsl */ `
${common}
uniform sampler2D uCmap;   // rows: romaO, berlin, grayC
uniform vec3 uSun;
uniform vec3 uLook;
uniform float uHalfLambda;
uniform float uPass1;
uniform float uPass2;
uniform float uAmp;
uniform float uFringe;
uniform float uUnwrap;
uniform float uCoh;
uniform float uRoll;
uniform float uTime;
uniform vec3 uProbe;       // xy duv, z on/off
uniform sampler2D uChangeTex; // r: coherence lost against the pre-event pair, g: baked sun shadow
uniform sampler2D uChange2;   // the next pair's coherence loss (r)
uniform float uLossK;      // scales the coherence loss: in the flood's event pair it appears with the collapse
uniform float uChange;     // 0..1 blend of the coherence-loss map
uniform float uIso;        // metres between iso-lines of the displacement map
uniform float uWave;       // 0..1 progress of the seismic wave leaving the epicentres (0 = off)
uniform float uWaveR;      // km the wave travels by the end
uniform float uS;          // site scale: slab width / 273 km, the size the constants below were tuned at
uniform float uReveal;     // 0..1: the slab surfaces out of the globe
uniform float uNight;      // 0..1: night over the optical view (the radar does not care)
uniform float uFrontLit;   // 0..1: how bright the unwrapping front burns
uniform float uSweepLit;   // 1 while the passes are being told: the sweep lines only burn then
uniform float uCohWipe;    // 0..1 west→east: how far the coherence check has swept (< 0: everywhere)
uniform float uLava;       // 0..1: the volcano's lost ground burns as moving lava
uniform float uFlow;       // 0..1: the flood's scoured valley runs with water, downhill
in vec2 vD;
in vec3 vW;
out vec4 fragColor;

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
vec3 cmap(float row, float t){ return texture(uCmap, vec2(.5/256. + clamp(t,0.,1.) * 255./256., (row + .5) / 3.)).rgb; }

float lossAt(vec2 p){
  float a = texture(uChangeTex, p).r;
  if (uXf > 0.) a = mix(a, texture(uChange2, p).r, uXf);
  return a * uLossK;
}

float sweepLine(float pass){ float h = uSize.y * .5 + 6.; return mix(h, -h, pass); }

void main(){
  vec4 d = dataAt(vD, 0.);
  float h = d.r, los = d.g * uDisp, coh = d.b, rough = d.a;
  bool sea = h <= 0.;

  vec2 e = uTexel;
  float hl = worldH(vD - vec2(e.x, 0.)), hr = worldH(vD + vec2(e.x, 0.));
  float hn = worldH(vD - vec2(0., e.y)), hs = worldH(vD + vec2(0., e.y));
  vec3 N = normalize(vec3(-(hr - hl) / (2. * uSize.x * e.x), 1., -(hs - hn) / (2. * uSize.y * e.y)));
  vec3 L = normalize(uSun);
  float sh = texture(uChangeTex, vD).g; // sun shadow, baked when the site loads
  float diff = max(dot(N, L), 0.) * sh;

  // Cinematic base: dusk-lit relief over a dark sea.
  vec3 land = mix(vec3(.046, .043, .040), vec3(.098, .088, .074), smoothstep(0., 1800., h));
  land = mix(land, vec3(.022, .030, .026), smoothstep(200., 900., h) * (1. - smoothstep(1500., 2200., h)) * .7);
  float cav = smoothstep(.55, 1., N.y);
  // Warm low sun on the lit faces, cool sky in the hollows, and a thin grazing highlight on the crests.
  float rim = pow(max(1. - max(dot(N, normalize(cameraPosition - vW)), 0.), 0.), 3.) * smoothstep(.15, .7, diff);
  vec3 base = land * (vec3(1., .72, .46) * diff * 4.2 + vec3(.16, .22, .32) * (.25 + .75 * N.y) * .5 * cav) + vec3(1., .66, .38) * rim * .05;
  base *= mix(1., .14, uNight);
  if (sea){
    float depth = smoothstep(0., -1800., h);
    base = mix(vec3(.006, .013, .019), vec3(.002, .004, .007), depth);
    vec3 V = normalize(cameraPosition - vW);
    float spec = pow(max(dot(reflect(-L, vec3(0,1,0)), V), 0.), 60.);
    float waves = .75 + .5 * hash(floor(vW.xz * 3.));
    base += vec3(1., .72, .46) * spec * .5 * waves;
  }

  // Radar backscatter: local incidence + speckle, stable in data space.
  vec2 sp = floor(vD / e * 2.);
  float c = dot(N, normalize(uLook));
  float amp = pow(clamp(c, 0., 1.), 2.4) * (.55 + .9 * rough) + smoothstep(.95, 1., c) * .5;
  float spk = (hash(sp) + hash(sp + 17.1) + hash(sp + 41.7) + hash(sp + 73.3)) * .5;
  amp *= mix(1., spk, .75);
  if (sea) amp = .035 + .05 * hash(sp);
  float ampv = pow(clamp(amp, 0., 1.), .62);
  vec3 radar = cmap(2., ampv * .94) * .74; // grayC runs dark → light

  // Acquisition sweeps.
  float z1 = sweepLine(uPass1), z2 = sweepLine(uPass2);
  float rev1 = smoothstep(z1 - .2, z1 + 1.8, vW.z) * step(.0001, uPass1);
  float rev2 = smoothstep(z2 - .2, z2 + 1.8, vW.z) * step(.0001, uPass2);

  // Interferometric phase: amplitude-modulated cyclic colour; fringes widen while unwrapping.
  float fk = frontK(vD);
  float uw = uUnwrap * fk; // the ground the front has passed is unwrapped; ahead of it the fringes still wrap
  float k = mix(1., .09, smoothstep(0., .75, uw));
  float phaseNoise = (hash(sp * .5 + 3.1) - .5) * (1. - smoothstep(.12, .75, coh)) * 1.6;
  float cyc = los / uHalfLambda * k + uRoll + phaseNoise * (1. - uw);
  vec3 fringe = cmap(0., fract(cyc)) * mix(.34, 1.18, ampv);
  if (sea) fringe = vec3(.02, .025, .03) + .035 * hash(sp); // the sea has no phase to show: faint static, not colour noise

  float lit = .7 + .55 * diff;
  vec3 disp = cmap(1., .5 + los / (2. * uRange)) * lit + radar * .1;
  // Contours follow the smoothed lift: on the raw pixels, noise would draw a maze of tiny loops.
  float ls = textureLod(uLiftTex, vD, 0.).r;
  if (uXf > 0.) ls = mix(ls, textureLod(uLiftTex2, vD, 0.).r, uXf);
  float v = ls * uDisp / uIso;
  float iso = 1. - min(abs(fract(v - .5) - .5) / max(fwidth(v), 1e-6), 1.); // a flat field has no width: never divide by zero (a NaN blooms into a white blob)
  disp = mix(disp, vec3(.9), iso * .14 * smoothstep(.4 * uIso, 1.2 * uIso, abs(ls * uDisp)));
  if (sea) disp = vec3(.03, .035, .04) + .04 * hash(sp);
  vec3 data = mix(fringe, disp, smoothstep(.45, 1., uw));

  // Coherence-loss map (damage-proxy style): dark → ember → pale gold.
  // Damage runs along channels only a pixel or two wide: take the strongest loss within ~1.5 texels so it reads from afar.
  float cl = lossAt(vD);
  cl = max(cl, max(lossAt(vD + vec2(e.x, 0.) * 1.5), lossAt(vD - vec2(e.x, 0.) * 1.5)));
  cl = max(cl, max(lossAt(vD + vec2(0., e.y) * 1.5), lossAt(vD - vec2(0., e.y) * 1.5)));
  vec3 chg = mix(vec3(.030, .026, .028), vec3(.95, .32, .20), smoothstep(.1, .5, cl));
  chg = mix(chg, vec3(1., .86, .55), smoothstep(.5, 1., cl));
  chg = mix(radar * (.2 + .2 * lit) * (1. - .55 * uLava), chg * 1.25, smoothstep(.1, .3, cl)); // weak loss is background noise, not damage; the lava burns in the dark
  if (sea) chg = vec3(.03, .035, .04) + .04 * hash(sp);
  // The climax of the change sites. Lava: where the volcano's ground was remade it glows, slowly churning (HDR, for the
  // bloom). Flood: the scoured valley runs with water, streaks moving downhill along the slope.
  float hot = smoothstep(.08, .32, cl);
  if (uLava > .001 || uFlow > .001){
    // The ground around the flow is lit by it: the loss averaged over a wide ring, added as light (warm lava, cold water).
    float glow = 0.;
    for (int i = 0; i < 8; i++){
      float a = float(i) * .785;
      glow += lossAt(vD + vec2(cos(a), sin(a)) * e * 7.) + lossAt(vD + vec2(cos(a + .39), sin(a + .39)) * e * 16.) * .6;
    }
    glow = glow / 12.8;
    chg += vec3(1.4, .38, .08) * smoothstep(.0, .35, glow) * uLava * (.8 + .2 * sin(uTime * 2.1));
    chg += vec3(.25, .6, 1.) * smoothstep(.12, .45, glow) * uFlow * .9;
  }
  if (uLava > .001 && hot > 0.){
    vec2 q = vW.xz / (.35 * uS);
    float n = hash(floor(q)) * .5 + hash(floor(q * 2.3 + 7.1)) * .3 + hash(floor(q * 5.1 - uTime * .6)) * .2;
    float churn = .55 + .45 * sin(uTime * 1.3 + n * 9.);
    vec3 lava = mix(vec3(1.6, .32, .06), vec3(3.2, 1.5, .45), churn * n);
    chg = mix(chg, lava, hot * uLava);
  }
  float wet = smoothstep(.25, .5, cl); // only the strong loss is the flood: weak, scattered loss is slopes and monsoon
  if (uFlow > .001 && wet > 0.){
    vec2 down = -vec2(hr - hl, hs - hn);
    float gl = length(down);
    vec2 dir = gl > 1e-6 ? down / gl : vec2(0., 1.);
    float along = dot(vW.xz, dir) / (1.1 * uS) - uTime * 1.6;
    float across = dot(vW.xz, vec2(-dir.y, dir.x)) / (.5 * uS);
    float streak = pow(max(.5 + .5 * sin(along * 6.283 + hash(vec2(floor(across), 3.)) * 6.283), 0.), 6.);
    vec3 water = mix(vec3(.2, .5, .75), vec3(1.6, 2.1, 2.4), streak);
    chg = mix(chg, water, wet * uFlow);
  }
  data = mix(data, chg, uChange * fk);

  // Coherence: untrustworthy pixels fall back to dim radar static.
  float trust = smoothstep(.3, .62, coh);
  // The check sweeps west to east: behind it, pixels that cannot be believed crumble into static.
  float wipeK = uCohWipe < 0. ? 1. : smoothstep(uCohWipe + .012, uCohWipe - .012, vD.x);
  float ch = uCoh * wipeK;
  // Sea is always incoherent: keep its static faint so it reads as 'no data' without drowning the land.
  vec3 staticC = vec3(.02 + .12 * hash(sp + floor(uTime * 10.))) * (sea ? .3 : 1.);
  data *= 1. + .3 * trust * ch;
  data = mix(data, staticC, (1. - trust) * ch);

  vec3 col = mix(base, radar * (.8 + .35 * sh), rev1 * uAmp);
  col = mix(col, data, rev2 * uFringe);

  // Beam lines (HDR for bloom).
  float live1 = step(.0001, uPass1) * step(uPass1, .9999) * uSweepLit;
  float live2 = step(.0001, uPass2) * step(uPass2, .9999) * uSweepLit;
  col += vec3(.55, .85, 1.) * 1.8 * (exp(-abs(vW.z - z1) * 3. / uS) * live1 + exp(-abs(vW.z - z2) * 3. / uS) * live2);
  col += vec3(.4, .7, 1.) * .12 * (exp(-max(vW.z - z1, 0.) * .18 / uS) * live1 * step(z1, vW.z));

  // Epicentre: dot + slow pulsing rings, sized in screen pixels so it reads from orbit too.
  for (int m = 0; m < 2; m++){
    if (uEpi[m].z < .001) continue;
    float px = length((vD - uEpi[m].xy) * uSize) / uEpi[m].w;
    vec3 ec = vec3(.745, .188, .144); // #e0786a in linear
    float core = 1. - smoothstep(3., 4.2, px);
    float halo = exp(-px * px / 220.);
    float pulse = 0.;
    for (int i = 0; i < 2; i++){
      float ph = fract(uTime * .3 + float(i) * .5 + float(m) * .37);
      float R = mix(6., 52., 1. - (1. - ph) * (1. - ph));
      pulse += (1. - smoothstep(0., 1.6, abs(px - R))) * pow(max(1. - ph, 0.), 1.5);
    }
    float rim = 1. - smoothstep(0., 1.2, abs(px - 7.5));
    float s = uEpi[m].z;
    col *= 1. - halo * .55 * s;
    col += ec * (pulse * 1.5 + rim * .8 + halo * .35) * s;
    col = mix(col, ec * 3.6, core * s);
  }

  // Seismic wave: an ember front that leaves each epicentre and lights the crests it crosses.
  if (uWave > .001 && uWave < .999){
    for (int m = 0; m < 2; m++){
      if (uEpi[m].x <= 0.) continue;
      float r = length((vD - uEpi[m].xy) * uSize);
      float R = max(uWave - .09 * float(m), 0.) * uWaveR;
      float w = 2.6 * uS + R * .035;
      float fq = (r - R) / w; float front = exp(-fq * fq); // pow(x, 2.) is undefined for x < 0 (NaN on D3D)
      float trail = exp(-max(R - r, 0.) / (9. * uS)) * step(r, R) * .16;
      float life = (1. - uWave) * smoothstep(0., .06, uWave);
      col += vec3(.95, .38, .22) * (front * 1.9 + trail) * life * (.35 + .65 * diff + .5 * rim * 20.);
    }
  }

  // The unwrapping front: a bright line leaving the epicentres, with a glow on the ground it has just passed.
  if (uFront >= 0. && uFrontLit > .001){
    float fd = frontD(vD);
    float w = .9 * uS + uFront * .006;
    float eq = (fd - uFront) / w; float edge = exp(-eq * eq);
    float wake = exp(-max(uFront - fd, 0.) / (10. * uS)) * step(fd, uFront) * .1;
    col += vec3(.3, .72, 1.) * (edge * .75 + wake) * uFrontLit * (.6 + .4 * diff);
  }

  // The coherence check's edge: a thin line across the slab.
  if (uCohWipe >= 0. && uCohWipe < 1.){
    float wq = (vD.x - uCohWipe) / (e.x * 3.); float wl = exp(-wq * wq);
    col += vec3(.75, .9, 1.) * wl * .55 * uCoh * rev2 * uFringe;
  }

  // Probe ring.
  if (uProbe.z > .5){
    float r = length((vD - uProbe.xy) * uSize);
    float ring = 1. - smoothstep(0., max(fwidth(r), 1e-6) * 1.5, abs(r - 2.2 * uS));
    col = mix(col, vec3(1.), ring * .9);
  }

  // Eye vs radar: left of the split, the same ground as an eye would see it.
  if (uSplit >= 0. && gl_FragCoord.x < uSplit * uScreen.x) col = base;

  float fog = 1. - exp(-length(cameraPosition - vW) * .0016 / uS);
  col = mix(col, vec3(.004, .006, .009), fog * .5);
  if (any(isnan(col)) || any(isinf(col))) col = vec3(0.); // one bad pixel would bloom into a white blob
  fragColor = vec4(col, uReveal);
}
`;

export const skirtVert = /* glsl */ `
${common}
in float aBottom;
uniform float uBase;
out float vSeabed;
out float vTop;
out vec3 vW;
out vec3 vN;
void main(){
  vec2 duv = vec2(uv.x, 1. - uv.y);
  float top = worldH(duv);
  vSeabed = min(textureLod(uData, duv, 0.).r, 0.) * .001 * uVex;
  vTop = top;
  vec3 p = position;
  p.y = mix(top, -uBase, aBottom);
  vec4 w = modelMatrix * vec4(p, 1.);
  vW = w.xyz;
  vN = normal;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const skirtFrag = /* glsl */ `
uniform vec3 uSun;
uniform float uBase;
uniform float uReveal;
in float vSeabed;
in float vTop;
in vec3 vW;
in vec3 vN;
out vec4 fragColor;
void main(){
  float y = vW.y;
  float light = .45 + .55 * max(dot(normalize(vN), normalize(uSun)), 0.);
  float depth = clamp(-y / uBase, 0., 1.);
  float strata = .85 + .15 * smoothstep(.3, .7, abs(fract(y * .9 + sin(vW.x * .08 + vW.z * .05) * .6) - .5) * 2.);
  vec3 rock = mix(vec3(.022, .019, .016), vec3(.004, .004, .004), pow(max(depth, 0.), .6)) * strata * light;
  vec3 water = mix(vec3(.010, .034, .05), vec3(.002, .008, .014), clamp(-y / 8., 0., 1.)) * (.8 + .4 * light);
  vec3 col = (y > vSeabed && vSeabed < 0.) ? water : rock;
  float edge = 1. - smoothstep(0., .18, vTop - y);
  col += vec3(.30, .27, .22) * edge * .35;
  fragColor = vec4(col, uReveal);
}
`;

export const beamVert = /* glsl */ `
in float aGround;
out float vG;
void main(){ vG = aGround; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }
`;

export const beamFrag = /* glsl */ `
uniform float uOpacity;
in float vG;
out vec4 fragColor;
void main(){
  float a = (.04 + .96 * vG * vG) * uOpacity;
  fragColor = vec4(vec3(.45, .75, 1.) * a * .42, 1.);
}
`;

export const gradeFrag = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uRes;
uniform float uTime;
uniform float uMist;   // 0..1: cloud the camera is flying through (the dive between the globe and the ground)
uniform float uMistZ;  // how far into it: drives the cloud rushing outwards past the camera
varying vec2 vUv;
float hash(vec2 p){ p = fract(p * vec2(443.8975, 397.2973)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p){ float a = .5, s = 0.; for (int i = 0; i < 5; i++){ s += a * vn(p); p = p * 2.02 + 7.3; a *= .5; } return s; }
void main(){
  vec2 q = vUv - .5;
  q.x *= uRes.x / uRes.y;
  float r = length(q);
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  if (uMist > .002){
    // Two layers of cloud grow from the centre outwards, as if the camera were falling through them.
    float m = 0.;
    for (int l = 0; l < 2; l++){
      float z = fract(uMistZ + float(l) * .5);
      float sc = mix(2.6, .35, z);
      float n = fbm(q * sc * 3. + float(l) * 13.1);
      m += smoothstep(.45, .8, n) * sin(z * 3.14159);
    }
    col = mix(col, vec3(.78, .84, .92) * (.75 + .25 * m), clamp(m, 0., 1.) * uMist);
  }
  col *= mix(1., .38, smoothstep(.4, 1.1, r));
  float g = hash(vUv * uRes + fract(uTime * 13.7) * 100.) - .5;
  col += g * .028 * (1. - .6 * dot(col, vec3(.33)));
  gl_FragColor = vec4(max(col, 0.), 1.);
}
`;

// ---------- cloud deck ----------
export const cloudVert = /* glsl */ `
out vec3 vW;
out vec2 vUv;
void main(){
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const cloudFrag = /* glsl */ `
uniform float uCloud;
uniform float uPass;
uniform float uTime;
uniform float uS;
uniform vec2 uSize;
in vec3 vW;
in vec2 vUv;
out vec4 fragColor;
float h2(vec2 p){ p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(h2(i), h2(i + vec2(1, 0)), f.x), mix(h2(i + vec2(0, 1)), h2(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p){
  float a = .5, s = 0.;
  for (int i = 0; i < 5; i++){ s += a * vnoise(p); p = p * 2.03 + 11.7; a *= .5; }
  return s;
}
void main(){
  vec2 q = vW.xz / (38. * uS) + vec2(uTime * .02, uTime * .008);
  float n = fbm(q + .6 * fbm(q * .7 - uTime * .01));
  float a = smoothstep(.42, .72, n);
  // Behind the sweep the radar has seen through: the deck thins to a veil over the radar picture.
  float z1 = mix(uSize.y * .5 + 6., -uSize.y * .5 - 6., uPass);
  float seen = smoothstep(z1 - .5, z1 + 6. * uS, vW.z) * step(.0001, uPass);
  a *= 1. - .82 * seen;
  // Soft at the slab's edges.
  vec2 e = min(vUv, 1. - vUv);
  a *= smoothstep(0., .06, min(e.x, e.y));
  float shade = .55 + .45 * smoothstep(.4, .9, n);
  vec3 col = vec3(.52, .58, .68) * shade;
  fragColor = vec4(col, a * .82 * uCloud);
}
`;

// ---------- the ground as it was ----------
// A ghost of the surface before the motion: a thin grid at the terrain's own height, without the lift. Where the ground
// sank it floats above it; the stems below join each point to where it went.
export const ghostVert = /* glsl */ `
${common}
out vec2 vD;
out vec3 vW;
out float vGap;
void main(){
  vD = vec2(uv.x, 1. - uv.y);
  vec3 p = position;
  float base = max(textureLod(uData, vD, 0.).r, 0.) * .001 * uVex;
  vGap = worldH(vD) - base; // km: > 0 the ground rose above its old place, < 0 it sank below it
  p.y = base;
  vec4 w = modelMatrix * vec4(p, 1.);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const ghostFrag = /* glsl */ `
uniform float uGhost;      // 0..1 how much the old ground shows
uniform float uGrid;       // km between grid lines
uniform float uGapMin;     // km of gap below which the ghost stays hidden (it would sit on the ground)
uniform float uSplit;
uniform vec2 uScreen;
in vec2 vD;
in vec3 vW;
in float vGap;
out vec4 fragColor;
void main(){
  if (uSplit >= 0. && gl_FragCoord.x < uSplit * uScreen.x) discard; // the eye does not see the motion
  vec2 g = vW.xz / uGrid;
  vec2 f = abs(fract(g - .5) - .5) / max(fwidth(g), vec2(1e-6));
  float line = 1. - min(min(f.x, f.y), 1.);
  float show = smoothstep(max(uGapMin, 1e-4), max(uGapMin, 1e-4) * 3., abs(vGap)) * uGhost;
  vec3 c = vGap < 0. ? vec3(.5, .72, 1.) : vec3(1., .62, .5);
  fragColor = vec4(c * (.35 + line * .55), (line * .32 + .045) * show); // under the bloom threshold: a sheet, not a glare
}
`;

// The stems: one thin column per grid point, from where the ground was to where it is now, blue where it sank and red
// where it rose. Their length is the motion, at the same exaggeration as the relief.
export const stemVert = /* glsl */ `
${common}
uniform float uStemW;      // km: a stem's width
in vec2 aUv;               // the stem's place on the slab (data uv)
out float vGap;
out float vY;
void main(){
  float base = max(textureLod(uData, aUv, 0.).r, 0.) * .001 * uVex;
  float top = worldH(aUv);
  vGap = top - base;
  vY = position.y;
  vec3 c = vec3((aUv.x - .5) * uSize.x, mix(base, top, position.y), (aUv.y - .5) * uSize.y);
  vec3 p = c + vec3(position.x, 0., position.z) * uStemW;
  vec4 w = modelMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

export const stemFrag = /* glsl */ `
uniform float uGhost;
uniform float uGapMin;
uniform float uSplit;
uniform vec2 uScreen;
in float vGap;
in float vY;
out vec4 fragColor;
void main(){
  float show = smoothstep(max(uGapMin, 1e-4), max(uGapMin, 1e-4) * 3., abs(vGap)) * uGhost;
  if (show < .01 || (uSplit >= 0. && gl_FragCoord.x < uSplit * uScreen.x)) discard;
  vec3 c = vGap < 0. ? vec3(.45, .72, 1.) : vec3(1., .55, .42);
  // Brightest where the ground is now: the eye follows the stem from the ghost down (or up) to the new ground.
  float now = vY;
  fragColor = vec4(c * (.45 + 1.1 * now * now), (.25 + .45 * now) * show);
}
`;
