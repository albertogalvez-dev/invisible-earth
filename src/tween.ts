export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
export const easeOut = (t: number) => 1 - (1 - t) ** 4;
export const linear = (t: number) => t;

interface Tween {
  from: number | null; // captured when the tween actually starts
  to: number;
  start: number;
  dur: number;
  ease: (t: number) => number;
}

// Keyed tweens over a plain record of numbers; a new tween on a key replaces the old one.
export class Tweens<K extends string> {
  private active = new Map<K, Tween>();
  constructor(public values: Record<K, number>) {}

  to(key: K, to: number, dur = 1, delay = 0, ease = easeInOut) {
    if (dur <= 0 && delay <= 0) {
      this.active.delete(key);
      this.values[key] = to;
      return;
    }
    this.active.set(key, { from: null, to, start: performance.now() / 1000 + delay, dur: Math.max(dur, 1e-3), ease });
  }

  update(now: number) {
    for (const [key, tw] of this.active) {
      if (now < tw.start) continue;
      if (tw.from === null) tw.from = this.values[key];
      const t = Math.min(1, (now - tw.start) / tw.dur);
      this.values[key] = tw.from + (tw.to - tw.from) * tw.ease(t);
      if (t >= 1) this.active.delete(key);
    }
  }
}
