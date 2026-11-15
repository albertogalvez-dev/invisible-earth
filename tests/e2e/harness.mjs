// Shared harness for the end-to-end checks: a real Chromium on a fake clock, so animations can be stepped frame by frame
// and captured exactly as the page renders them (DOM included), whatever the machine's speed.
import { chromium } from '@playwright/test';

export const BASE = process.env.IE_URL ?? 'http://localhost:5178/';

export async function open({ width = 1280, height = 720, query = '', mobile = false } = {}) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    isMobile: mobile,
    hasTouch: mobile,
    reducedMotion: 'no-preference',
  });
  const page = await context.newPage();
  const problems = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000); // time moves only when a script pushes it: screenshots must not let it run
  // CSS transitions and animations run on the compositor's clock, not the fake one: pin them to the fake clock.
  await page.addInitScript(() => {
    const born = new WeakMap();
    window.__syncAnimations = () => {
      const now = performance.now();
      for (const a of document.getAnimations()) {
        if (!born.has(a)) {
          born.set(a, now);
          a.pause();
        }
        const t = now - born.get(a);
        const end = a.effect?.getComputedTiming().endTime;
        if (typeof end === 'number' && Number.isFinite(end) && t >= end) a.finish();
        else a.currentTime = t;
      }
    };
  });
  await page.goto(BASE + (query ? `?${query}` : ''), { waitUntil: 'domcontentloaded' });
  return { browser, context, page, problems };
}

// Advance the fake clock by `ms`, letting real work (fetches, workers) complete between steps.
export async function advance(page, ms, step = 1000 / 30) {
  for (let t = 0; t < ms; t += step) {
    await page.clock.runFor(Math.min(step, ms - t));
    await page.evaluate(() => window.__syncAnimations?.());
  }
}

// Advance until a condition holds in the page (checked every `step` ms of fake time), or fail after `limit` ms.
export async function until(page, fn, arg, limit = 30000, step = 100) {
  for (let t = 0; t < limit; t += step) {
    if (await page.evaluate(fn, arg)) return t;
    await page.clock.runFor(step);
    await page.evaluate(() => window.__syncAnimations?.());
    await new Promise((r) => setTimeout(r, 5)); // real time for network and workers
  }
  throw new Error(`timed out waiting for ${fn.toString().slice(0, 80)}`);
}

export const booted = (page) => until(page, () => document.getElementById('loader')?.classList.contains('done'), null, 60000);
