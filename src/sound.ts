// Sound: real recordings (CC0, BigSoundBank — see README) layered with sounds synthesised in the browser, through one
// shared room (a convolution reverb) and a gentle compressor. The audio context is created while the page loads and
// stays suspended until the first click or key (browsers do not allow sound before that); it can be muted, and the
// choice is remembered. Recordings are decoded once, in the background, after the context exists.

const KEY = 'invisible-earth-sound';
const FILES = ['rumble', 'crack', 'wind', 'whistle', 'underwater', 'fire', 'city', 'bowl', 'torrent'] as const;
type Sample = (typeof FILES)[number];
export type Ambience = 'space' | 'quake' | 'quake-normal' | 'flood' | 'subsidence' | 'volcano' | null;

interface Loop {
  src: AudioBufferSourceNode;
  gain: GainNode;
  filter: BiquadFilterNode;
}

export class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode; // after the mute
  private dry!: GainNode; // everything goes here…
  private wet!: GainNode; // …and a share of it into the room
  private muffle!: BiquadFilterNode; // the whole mix, dulled while the camera is inside the clouds
  private bed!: GainNode;
  private noise!: AudioBuffer;
  private buffers = new Map<Sample, AudioBuffer>();
  private loops = new Map<Sample, Loop>();
  private radarTimer = 0;
  private radarOn = false;
  private scene: Ambience = null;
  private meter: AnalyserNode | null = null;
  private narrating = false;
  on: boolean;

  constructor() {
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch { /* storage may be blocked */ }
    this.on = !new URLSearchParams(location.search).has('silent') && saved !== 'off';
  }

  // Called while the page loads: creating the audio context opens the audio device, which on Windows takes a quarter of
  // a second, so it happens behind the loader. Browsers keep it suspended until the first gesture calls wake().
  prepare() {
    if (this.ctx) return;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.knee.value = 12;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.01;
    comp.release.value = 0.35;
    this.master = ctx.createGain();
    this.master.gain.value = this.on ? 0.95 : 0;
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 20000;
    this.muffle.Q.value = 0.4;
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.32;
    const room = ctx.createConvolver();
    room.buffer = this.impulse(3.6, 2.6);
    this.dry.connect(this.muffle);
    this.dry.connect(this.wet).connect(room).connect(this.muffle);
    // A brick-wall limiter last: layered one-shots must never clip.
    const limit = ctx.createDynamicsCompressor();
    limit.threshold.value = -4;
    limit.knee.value = 0;
    limit.ratio.value = 20;
    limit.attack.value = 0.002;
    limit.release.value = 0.12;
    this.muffle.connect(comp).connect(this.master).connect(limit).connect(ctx.destination);
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 2048;
    this.master.connect(this.meter);
    this.noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.startBed();
    void this.load();
  }

  // For checks: the output's loudness right now (RMS and peak, dBFS) and how many recordings are decoded.
  level() {
    if (!this.meter) return null;
    const d = new Float32Array(this.meter.fftSize);
    this.meter.getFloatTimeDomainData(d);
    let s = 0, p = 0;
    for (const v of d) (s += v * v), (p = Math.max(p, Math.abs(v)));
    const db = (x: number) => +(20 * Math.log10(Math.max(x, 1e-6))).toFixed(1);
    return { rms: db(Math.sqrt(s / d.length)), peak: db(p), decoded: this.buffers.size, state: this.ctx?.state, loops: [...this.loops.keys()] };
  }

  // Called from the first user gesture.
  wake() {
    if (!this.ctx) this.prepare();
    if (this.ctx?.state === 'suspended') void this.ctx.resume().then(() => this.ambience(this.scene, true));
  }

  setOn(on: boolean) {
    this.on = on;
    try {
      localStorage.setItem(KEY, on ? 'on' : 'off');
    } catch { /* ignore */ }
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(on ? (this.narrating ? 0.24 : 0.95) : 0, t, 0.15);
  }

  // Keep the ambient effects below the voice while a narration is playing.
  setNarrating(narrating: boolean) {
    this.narrating = narrating;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.on ? (narrating ? 0.24 : 0.95) : 0, t, 0.15);
  }

  private get live() {
    return this.ctx && this.ctx.state === 'running' ? this.ctx : null; // suspended: nothing may queue up
  }

  // A synthetic room: two channels of decaying noise, darker as they fade, so every sound sits in the same space.
  private impulse(seconds: number, decay: number) {
    const ctx = this.ctx!;
    const n = Math.round(ctx.sampleRate * seconds);
    const ir = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const k = i / n;
        const a = 0.35 + 0.6 * k; // high frequencies die first
        lp += (Math.random() * 2 - 1 - lp) * (1 - a);
        d[i] = lp * Math.pow(1 - k, decay) * (i < 40 ? i / 40 : 1);
      }
    }
    return ir;
  }

  private async load() {
    const ctx = this.ctx!;
    await Promise.all(
      FILES.map(async (f) => {
        try {
          const b = await (await fetch(`data/sound/${f}.m4a`)).arrayBuffer();
          this.buffers.set(f, await ctx.decodeAudioData(b));
        } catch { /* a missing recording leaves only the synthesised layer */ }
      }),
    );
    if (this.live) this.ambience(this.scene, true);
  }

  // ---------- the bed ----------
  // A low drone of slowly beating fifths through a breathing filter: always there, quiet.
  private startBed() {
    const ctx = this.ctx!;
    this.bed = ctx.createGain();
    this.bed.gain.value = 0;
    this.bed.gain.setTargetAtTime(0.09, ctx.currentTime, 3);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 260;
    lp.Q.value = 0.5;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.037;
    lfoGain.gain.value = 110;
    lfo.connect(lfoGain).connect(lp.frequency);
    lfo.start();
    for (const [f, type, g] of [[41.2, 'sine', 0.5], [41.45, 'triangle', 0.28], [61.8, 'sine', 0.22], [82.4, 'triangle', 0.12], [123.6, 'sine', 0.05]] as const) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = type;
      o.frequency.value = f;
      og.gain.value = g;
      o.connect(og).connect(lp);
      o.start();
    }
    lp.connect(this.bed);
    this.bed.connect(this.dry);
  }

  // A recording looping under the scene, faded in and out: the sound of the place.
  private loop(name: Sample, level: number, fade = 2.5, cutoff = 20000) {
    const ctx = this.ctx!;
    const buf = this.buffers.get(name);
    let l = this.loops.get(name);
    if (!l && buf && level > 0) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.loopStart = 0.6; // skip the fades baked into the file
      src.loopEnd = buf.duration - 0.6;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = cutoff;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.dry);
      src.start(ctx.currentTime, 0.6 + Math.random() * (buf.duration - 1.2));
      l = { src, gain, filter };
      this.loops.set(name, l);
    }
    if (!l) return;
    const t = ctx.currentTime;
    l.gain.gain.cancelScheduledValues(t);
    l.gain.gain.setTargetAtTime(level, t, fade / 3);
    l.filter.frequency.setTargetAtTime(cutoff, t, fade / 3);
    if (level <= 0) {
      const dead = l;
      this.loops.delete(name);
      setTimeout(() => dead.src.stop(), fade * 2000);
    }
  }

  // Which place the sound is in: the globe is space; each place has its own ground sound.
  ambience(scene: Ambience, force = false) {
    if (scene === this.scene && !force) return;
    this.scene = scene;
    if (!this.live) return;
    type Mix = Partial<Record<Sample, [number, number]>>; // level, low-pass cutoff
    const mixes: Record<string, Mix> = {
      space: { whistle: [0.05, 2400] },
      quake: { wind: [0.035, 900] },
      'quake-normal': { wind: [0.03, 900] },
      flood: { torrent: [0.07, 2600] },
      subsidence: { city: [0.09, 1400] },
      volcano: { fire: [0.055, 4200], rumble: [0.035, 380] },
    };
    const want = mixes[scene ?? 'space'] ?? {};
    for (const f of ['whistle', 'wind', 'torrent', 'city', 'fire', 'rumble'] as Sample[]) {
      const w = want[f];
      this.loop(f, w ? w[0] : 0, 3, w ? w[1] : 20000);
    }
  }

  // ---------- one-shots ----------
  private play(name: Sample, { at = 0, gain = 1, rate = 1, cutoff = 20000, wet = 1, offset = 0 } = {}) {
    const ctx = this.live;
    const buf = this.buffers.get(name);
    if (!ctx || !buf) return null;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g);
    g.connect(this.dry);
    if (wet !== 1) {
      const w = ctx.createGain();
      w.gain.value = wet - 1;
      g.connect(w).connect(this.wet);
    }
    src.start(t, offset);
    return { src, g, f, t };
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private sub(t: number, from: number, to: number, dur: number, peak: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    this.env(g, t, peak, 0.03, dur);
    o.connect(g).connect(this.dry);
    o.start(t);
    o.stop(t + dur + 0.1);
  }

  // The ground breaking: a thunder crack pitched down into the ground, a sub drop and a long rolling rumble.
  quake(strength = 1) {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    this.play('crack', { gain: 0.9 * strength, rate: 0.55, cutoff: 2400, wet: 1.4 });
    this.play('rumble', { at: 0.12, gain: 0.8 * strength, rate: 0.7, cutoff: 700, wet: 1.3 });
    this.sub(t, 58, 22, 3.2, 0.55 * strength);
  }

  // Air moving past: filtered noise that rises and falls over `dur` seconds, with a gust of real wind under it.
  whoosh(dur = 3, up = true) {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    const [a, b, c] = up ? [180, 1300, 320] : [320, 1300, 180];
    bp.frequency.setValueAtTime(a, t);
    bp.frequency.exponentialRampToValueAtTime(b, t + dur * 0.55);
    bp.frequency.exponentialRampToValueAtTime(c, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.1, t + dur * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(bp).connect(g).connect(this.dry);
    n.start(t);
    n.stop(t + dur + 0.1);
    const w = this.play('wind', { gain: 0.0001, cutoff: 1800, offset: Math.random() * 4 });
    if (w) {
      w.g.gain.setValueAtTime(0.0001, w.t);
      w.g.gain.exponentialRampToValueAtTime(0.2, w.t + dur * 0.5);
      w.g.gain.exponentialRampToValueAtTime(0.0001, w.t + dur);
      w.src.stop(w.t + dur + 0.1);
    }
  }

  // Falling through the atmosphere: the wind builds, the clouds swallow the sound, then the ground opens up quiet.
  dive(dur: number) {
    const ctx = this.live;
    if (!ctx) return;
    this.whoosh(dur * 0.95, true);
    const w = this.play('whistle', { gain: 0.0001, cutoff: 3000 });
    if (w) {
      w.g.gain.setValueAtTime(0.0001, w.t);
      w.g.gain.exponentialRampToValueAtTime(0.14, w.t + dur * 0.45);
      w.g.gain.exponentialRampToValueAtTime(0.0001, w.t + dur * 0.8);
      w.src.stop(w.t + dur);
    }
    const t = ctx.currentTime;
    const m = this.muffle.frequency;
    m.cancelScheduledValues(t);
    m.setValueAtTime(20000, t + dur * 0.5);
    m.exponentialRampToValueAtTime(700, t + dur * 0.62); // inside the cloud deck
    m.exponentialRampToValueAtTime(20000, t + dur * 0.86);
    const u = this.play('underwater', { at: dur * 0.5, gain: 0.0001, cutoff: 1200 });
    if (u) {
      u.g.gain.setValueAtTime(0.0001, u.t);
      u.g.gain.exponentialRampToValueAtTime(0.25, u.t + dur * 0.12);
      u.g.gain.exponentialRampToValueAtTime(0.0001, u.t + dur * 0.36);
      u.src.stop(u.t + dur * 0.4);
    }
  }

  // A radar ping: a short falling tone with a click, thrown into the room.
  private chirp() {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1760, t);
    o.frequency.exponentialRampToValueAtTime(1180, t + 0.09);
    this.env(g, t, 0.028, 0.003, 0.14);
    const s = ctx.createGain();
    s.gain.value = 1.6;
    o.connect(g);
    g.connect(this.dry);
    g.connect(s).connect(this.wet);
    o.start(t);
    o.stop(t + 0.2);
  }

  // Pings repeat while a pass is sweeping.
  radar(on: boolean) {
    if (on === this.radarOn) return;
    this.radarOn = on;
    clearInterval(this.radarTimer);
    if (on && this.live) {
      this.chirp();
      this.radarTimer = window.setInterval(() => this.chirp(), 420);
    }
  }

  // A rising tension under the unwrapping front: detuned saws through an opening filter over a building noise wash.
  riser(dur: number, delay = 0) {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 4;
    lp.frequency.setValueAtTime(140, t);
    lp.frequency.exponentialRampToValueAtTime(1900, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + dur * 0.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.25);
    for (const det of [-6, 0, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(41.2, t);
      o.frequency.exponentialRampToValueAtTime(164.8, t + dur);
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.4);
    }
    lp.connect(g).connect(this.dry);
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(400, t);
    hp.frequency.exponentialRampToValueAtTime(3000, t + dur);
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.03, t + dur);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.2);
    n.connect(hp).connect(ng).connect(this.dry);
    n.start(t);
    n.stop(t + dur + 0.3);
  }

  // The reveal: a singing bowl struck once, long in the room.
  reveal(gain = 0.5) {
    if (!this.play('bowl', { gain, wet: 1.8 })) this.chimeSynth();
  }
  chime() {
    this.reveal(0.35);
  }
  private chimeSynth() {
    const ctx = this.live;
    if (!ctx) return;
    [523.25, 783.99].forEach((f, i) => {
      const t = ctx.currentTime + 0.05 + i * 0.16;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      this.env(g, t, 0.05, 0.01, 1.4);
      o.connect(g).connect(this.dry);
      o.start(t);
      o.stop(t + 1.6);
    });
  }

  // Each place's moment: the break for a quake, the long groan of a sinking city, the surge of a flood, lava.
  climax(scene: Ambience) {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime + 0.02;
    if (scene === 'quake') this.quake(1);
    else if (scene === 'quake-normal') this.sub(t, 40, 30, 2.4, 0.18); // barely anything: that is the finding
    else if (scene === 'subsidence') {
      this.play('rumble', { gain: 0.7, rate: 0.42, cutoff: 380, wet: 1.5 });
      this.sub(t, 46, 18, 5.5, 0.4);
    } else if (scene === 'flood') {
      const s = this.play('torrent', { gain: 0.0001, cutoff: 5000, rate: 0.85 });
      if (s) {
        s.g.gain.setValueAtTime(0.0001, s.t);
        s.g.gain.exponentialRampToValueAtTime(0.6, s.t + 1.6);
        s.g.gain.exponentialRampToValueAtTime(0.0001, s.t + 7);
        s.src.stop(s.t + 7.2);
      }
      this.sub(t, 50, 30, 3, 0.3);
    } else if (scene === 'volcano') {
      this.play('fire', { gain: 0.8, cutoff: 7000, wet: 1.3 });
      this.play('rumble', { gain: 0.6, rate: 0.6, cutoff: 500, wet: 1.4 });
      this.sub(t, 36, 24, 4, 0.35);
    }
  }

  // Kept for the chapters that call it: a quake of a given strength.
  boom(strength = 1) {
    this.quake(strength);
  }

  // A soft wooden tick when the picture changes to another pair.
  tick() {
    const ctx = this.live;
    if (!ctx) return;
    const t = ctx.currentTime + 0.01;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1500, t);
    o.frequency.exponentialRampToValueAtTime(900, t + 0.05);
    this.env(g, t, 0.035, 0.002, 0.08);
    o.connect(g).connect(this.dry);
    o.start(t);
    o.stop(t + 0.12);
  }
}
