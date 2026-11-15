// Development only (loaded with ?debug): renders the app frame by frame on a virtual clock and posts each frame to the
// dev server (/__rec, see vite.config.ts), so every animation can be reviewed as a smooth video even in a hidden tab.
//
//   __ie.rec.start({ take: 'venezuela', fps: 24, seconds: 60, script: [[0.5, () => __ie.playAll()]] })
//   __ie.rec.status   → { frame, t, done }
//
// The clock: performance.now, setTimeout/clearTimeout, requestAnimationFrame and every CSS transition or animation
// advance only when a frame is taken. Each frame is the WebGL canvas with the page's text, lines and pills drawn over it.

type Step = (ms: number) => void;
interface Timer { at: number; fn: () => void; id: number }

export function makeRecorder(step: Step, gl: HTMLCanvasElement, resume: () => void) {
  const status = { frame: 0, t: 0, done: true, error: '' };
  let stopped = false;
  let virt = 0;
  let timers: Timer[] = [];
  let nextId = 1e6;
  const real = {
    now: performance.now.bind(performance),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    raf: window.requestAnimationFrame.bind(window),
  };
  const seen = new WeakSet<Animation>();

  function install() {
    virt = real.now();
    performance.now = () => virt;
    (window as any).setTimeout = (fn: TimerHandler, ms = 0, ...args: unknown[]) => {
      const id = nextId++;
      timers.push({ at: virt + Math.max(0, Number(ms) || 0), fn: () => (typeof fn === 'function' ? fn(...args) : undefined), id });
      return id;
    };
    (window as any).clearTimeout = (id?: number) => {
      timers = timers.filter((t) => t.id !== id);
      if (id !== undefined && id < 1e6) real.clearTimeout(id);
    };
    (window as any).requestAnimationFrame = () => 0; // the live loop stops at its next frame; the recorder drives it
  }
  function uninstall() {
    performance.now = real.now;
    window.setTimeout = real.setTimeout as typeof window.setTimeout;
    window.clearTimeout = real.clearTimeout;
    window.requestAnimationFrame = real.raf;
    for (const t of timers) real.setTimeout(t.fn, 0);
    timers = [];
    for (const a of document.getAnimations()) if (a.playState === 'paused') a.play();
    resume();
  }

  function advance(dt: number) {
    virt += dt;
    // Fire due timers in order; a callback may add more.
    for (let guard = 0; guard < 500; guard++) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > virt) break;
      timers.shift();
      try { t.fn(); } catch (e) { console.error(e); }
    }
    for (const a of document.getAnimations()) {
      if (!seen.has(a)) {
        seen.add(a);
        a.pause();
        a.currentTime = 0;
        continue;
      }
      const end = a.effect?.getComputedTiming().endTime;
      const cur = Number(a.currentTime ?? 0) + dt;
      if (typeof end === 'number' && Number.isFinite(end) && cur >= end) a.finish();
      else a.currentTime = cur;
    }
  }

  // ---------- compositing the page over the canvas ----------
  const out = document.createElement('canvas');
  const g = out.getContext('2d')!;
  const rgba = (c: string) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const opacityOf = new Map<Element, number>();
  function effOpacity(el: Element): number {
    if (opacityOf.has(el)) return opacityOf.get(el)!;
    const cs = getComputedStyle(el);
    let o = cs.visibility === 'hidden' || cs.display === 'none' ? 0 : Number(cs.opacity);
    if (el.parentElement && o > 0) o *= effOpacity(el.parentElement);
    opacityOf.set(el, o);
    return o;
  }
  function rounded(x: number, y: number, w: number, h: number, r: number) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.roundRect(x, y, w, h, r);
  }
  function drawBox(el: HTMLElement, cs: CSSStyleDeclaration, o: number) {
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) return;
    const rad = parseFloat(cs.borderTopLeftRadius) || 0;
    let bg = rgba(cs.backgroundColor);
    if ((!bg || bg.a < 0.02) && cs.backgroundImage.includes('gradient')) bg = rgba(cs.backgroundImage);
    if (bg && bg.a > 0.02) {
      g.globalAlpha = o * bg.a;
      g.fillStyle = `rgb(${bg.r},${bg.g},${bg.b})`;
      rounded(r.left, r.top, r.width, r.height, rad);
      g.fill();
    }
    const bw = parseFloat(cs.borderTopWidth) || 0;
    const bc = rgba(cs.borderTopColor);
    if (bw > 0 && bc && bc.a > 0.02) {
      g.globalAlpha = o * bc.a;
      g.strokeStyle = `rgb(${bc.r},${bc.g},${bc.b})`;
      g.lineWidth = bw;
      rounded(r.left + bw / 2, r.top + bw / 2, r.width - bw, r.height - bw, rad);
      g.stroke();
    }
    if (el instanceof HTMLCanvasElement && el !== gl && el.width > 0) {
      g.globalAlpha = o;
      try { g.drawImage(el, r.left, r.top, r.width, r.height); } catch { /* tainted or empty */ }
    }
  }
  const range = document.createRange();
  function drawText(node: Text, cs: CSSStyleDeclaration, o: number) {
    const text = node.data;
    if (!text.trim()) return;
    const col = rgba(cs.color);
    if (!col) return;
    g.globalAlpha = o * col.a;
    g.fillStyle = `rgb(${col.r},${col.g},${col.b})`;
    g.font = cs.font || `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`; // the shorthand is empty when variants are set
    (g as any).letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing;
    g.textBaseline = 'middle';
    const upper = cs.textTransform === 'uppercase';
    const re = /\S+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      range.setStart(node, m.index);
      range.setEnd(node, m.index + m[0].length);
      const rr = range.getBoundingClientRect();
      if (rr.width < 0.5) continue;
      g.fillText(upper ? m[0].toUpperCase() : m[0], rr.left, rr.top + rr.height / 2);
    }
  }
  function walk(el: Element) {
    if (el === gl || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    const o = effOpacity(el);
    if (o < 0.015) return;
    const cs = getComputedStyle(el);
    if (el instanceof HTMLElement && !el.contains(gl)) drawBox(el, cs, o); // the canvas's own containers sit under it
    for (const c of el.childNodes) {
      if (c.nodeType === 3) drawText(c as Text, cs, o);
      else if (c.nodeType === 1 && c.nodeName !== 'svg') walk(c as Element);
    }
  }

  async function snap(take: string, n: number, width: number) {
    const w = innerWidth, h = innerHeight;
    const k = width / w;
    out.width = Math.round(w * k);
    out.height = Math.round(h * k);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.fillStyle = '#010203';
    g.fillRect(0, 0, out.width, out.height);
    g.drawImage(gl, 0, 0, out.width, out.height);
    g.setTransform(k, 0, 0, k, 0, 0);
    opacityOf.clear();
    walk(document.body);
    // Synchronous encoding: toBlob's callback is throttled to about once a second in a hidden tab.
    const b64 = out.toDataURL('image/jpeg', 0.86).split(',')[1];
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    await fetch(`/__rec?take=${take}&n=${n}`, { method: 'POST', body: bytes });
  }

  return {
    status,
    stop() {
      stopped = true;
    },
    // script: [seconds, action] pairs, run on the virtual clock.
    async start(o: { take: string; fps?: number; seconds: number; width?: number; script?: [number, () => unknown][]; until?: () => boolean }) {
      const fps = o.fps ?? 24, dt = 1000 / fps, width = o.width ?? 1280;
      const script = [...(o.script ?? [])].sort((a, b) => a[0] - b[0]);
      Object.assign(status, { frame: 0, t: 0, done: false, error: '' });
      stopped = false;
      await fetch(`/__rec?take=${o.take}`, { method: 'DELETE' });
      install();
      const t0 = virt;
      try {
        for (let n = 0; n * dt <= o.seconds * 1000; n++) {
          const t = (virt - t0) / 1000;
          while (script.length && script[0][0] <= t) script.shift()![1]();
          step(virt);
          await snap(o.take, n, width);
          status.frame = n;
          status.t = t;
          if (stopped || o.until?.()) break;
          advance(dt);
        }
      } catch (e) {
        status.error = String(e);
      } finally {
        uninstall();
        status.done = true;
      }
    },
  };
}
