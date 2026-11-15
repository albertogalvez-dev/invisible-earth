// End-to-end checks: every place and chapter at six window sizes, the opening, the picker, free camera, Explore's
// climax, film mode, sound and the About panel. A real Chromium on a paused fake clock steps the animations.
import { test, expect, type Page } from '@playwright/test';

const VIEWPORTS = [
  { name: 'desktop-1920', width: 1920, height: 1080 },
  { name: 'laptop-1440', width: 1440, height: 900 },
  { name: 'laptop-1280', width: 1280, height: 720 },
  { name: 'tablet', width: 768, height: 1024, mobile: true },
  { name: 'phone', width: 390, height: 844, mobile: true },
  { name: 'phone-landscape', width: 844, height: 390, mobile: true },
];
const SITES = ['venezuela', 'nepal', 'granada', 'mexico', 'krasheninnikov'];

type Rect = { x0: number; y0: number; x1: number; y1: number };
const overlap = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

async function prepare(page: Page, problems: string[]) {
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  await page.clock.install({ time: 0 });
  await page.clock.pauseAt(1000);
  await page.addInitScript(() => {
    // These tests exercise the application after the user has made the sound choice.
    // The welcome dialog otherwise covers the controls throughout the test.
    sessionStorage.setItem('invisible-earth-sound-choice', 'yes');
    const born = new WeakMap<Animation, number>();
    (window as any).__syncAnimations = () => {
      const now = performance.now();
      for (const a of document.getAnimations()) {
        if (!born.has(a)) (born.set(a, now), a.pause());
        const t = now - born.get(a)!;
        const end = a.effect?.getComputedTiming().endTime;
        if (typeof end === 'number' && Number.isFinite(end) && t >= end) a.finish();
        else a.currentTime = t;
      }
    };
  });
}
async function advance(page: Page, ms: number, step = 50) {
  for (let t = 0; t < ms; t += step) {
    await page.clock.runFor(Math.min(step, ms - t));
    await page.evaluate(() => (window as any).__syncAnimations?.());
  }
}
async function until(page: Page, fn: () => boolean, limit = 60000) {
  for (let t = 0; t < limit; t += 100) {
    if (await page.evaluate(fn)) return;
    await advance(page, 100, 100);
    await page.waitForTimeout(5);
  }
  const where = await page.evaluate(() => ({ loader: document.getElementById('loaderText')?.textContent, now: performance.now(), state: (window as any).__ie?.state }));
  throw new Error(`timed out: ${fn} — ${JSON.stringify(where)}`);
}
const booted = (page: Page) => until(page, () => !!document.getElementById('loader')?.classList.contains('done'));

// The visible boxes of the overlay: header, headline block, legend, hero number, nav, explore panel.
async function boxes(page: Page) {
  return page.evaluate(() => {
    const r = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity < 0.5) return null;
      const b = el.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) return null;
      return { x0: b.left, y0: b.top, x1: b.right, y1: b.bottom };
    };
    return {
      top: r('.top .meta'), brand: r('.brand'), headline: r('#headline'), eyebrow: r('#eyebrow'), sub: r('#sub'), legend: r('#legend'), hero: r('#hero'),
      nav: r('.nav-actions'), dots: r('#chapters'), explore: r('#explore'), vw: innerWidth, vh: innerHeight,
    };
  });
}

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.mobile, hasTouch: !!vp.mobile });

    for (const site of SITES) {
      test(`${site}: every chapter is framed and laid out`, async ({ page }) => {
        const problems: string[] = [];
        await prepare(page, problems);
        await page.goto(`/?site=${site}&debug`);
        await booted(page);
        await advance(page, 7000);
        const report: string[] = [];
        for (let ch = 0; ch < 6; ch++) {
          if (ch > 0) await page.evaluate((c) => (window as any).__ie.go(c), ch);
          await advance(page, ch === 1 || ch === 2 ? 13000 : ch === 3 ? 9000 : ch === 4 ? 5500 : 4500); // passes ~12 s, the unwrap ~8 s, the coherence sweep ~5 s
          const b = await boxes(page);
          // Close chapters frame a region of interest and may crop the rest of the slab; Explore shows it all.
          const slab = await page.evaluate(() => (window as any).__ie.focusRect());
          const above = await page.evaluate(() => (window as any).__ie.camAboveGround());
          const tag = `${site} ch${ch}`;
          // The words never leave the window, and never run into the header or the controls.
          for (const k of ['headline', 'eyebrow', 'sub', 'legend', 'hero', 'explore'] as const) {
            const r = b[k];
            if (!r) continue;
            if (r.x0 < -1 || r.y0 < -1 || r.x1 > b.vw + 1 || r.y1 > b.vh + 1) report.push(`${tag}: ${k} leaves the window ${JSON.stringify(r)}`);
            for (const o of ['top', 'nav'] as const) if (b[o] && overlap(r, b[o]!) > 4) report.push(`${tag}: ${k} runs into ${o}`);
          }
          if (b.headline && b.hero && overlap(b.headline, b.hero) > 4) report.push(`${tag}: headline and hero number overlap`);
          if (b.headline && b.legend && overlap(b.headline, b.legend) > 4) report.push(`${tag}: headline and legend overlap`);
          if (b.explore && b.legend && overlap(b.explore, b.legend) > 4) report.push(`${tag}: explore panel and legend overlap`);
          // The slab is on screen and not a speck.
          if (slab.visible < 0.85) report.push(`${tag}: only ${(slab.visible * 100).toFixed(0)}% of the region of interest is in the window`);
          const tall = (Math.min(slab.y1, b.vh) - Math.max(slab.y0, 0)) / b.vh, wide = (Math.min(slab.x1, b.vw) - Math.max(slab.x0, 0)) / b.vw;
          if (Math.max(tall, wide) < 0.4) report.push(`${tag}: the slab is small (${(tall * 100).toFixed(0)}% tall, ${(wide * 100).toFixed(0)}% wide)`);
          if (!above) report.push(`${tag}: the camera is under the ground`);
          await page.screenshot({ path: `.cache/test-results/shots/${vp.name}-${site}-ch${ch}.jpg`, type: 'jpeg', quality: 80 });
        }
        expect(problems, 'console errors').toEqual([]);
        expect(report, 'layout').toEqual([]);
      });
    }
  });
}

test.describe('behaviour (laptop)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the opening plays, and the key that ends it does nothing else', async ({ page }) => {
    const problems: string[] = [];
    await prepare(page, problems);
    await page.goto('/?debug');
    await booted(page);
    await advance(page, 2500);
    await expect(page.locator('#app')).toHaveClass(/opening-title/);
    await expect(page.locator('#intro')).toBeVisible();
    await page.keyboard.press('Enter');
    await advance(page, 3000);
    const st = await page.evaluate(() => (window as any).__ie.state);
    expect(st.mode).toBe('picker');
    await expect(page.locator('.card')).toHaveCount(SITES.length);
    expect(problems).toEqual([]);
  });

  test('the picker: keys browse, Enter opens, Esc comes back', async ({ page }) => {
    await prepare(page, []);
    await page.goto('/?debug&nointro');
    await booted(page);
    await advance(page, 3000);
    await page.keyboard.press('ArrowRight');
    await advance(page, 1500);
    await page.keyboard.press('Enter');
    await until(page, () => (window as any).__ie.state.mode === 'story');
    expect(await page.evaluate(() => (window as any).__ie.state.site)).toBe('nepal');
    await advance(page, 6000);
    await page.keyboard.press('Escape');
    await advance(page, 4000);
    expect(await page.evaluate(() => (window as any).__ie.state.mode)).toBe('picker');
  });

  test('free camera: a drag takes it, R gives it back, the next chapter resets it', async ({ page }) => {
    await prepare(page, []);
    await page.goto('/?site=venezuela&debug');
    await booted(page);
    await advance(page, 8000);
    const before = await page.evaluate(() => (window as any).__ie.cam().p);
    await page.mouse.move(700, 300);
    await page.mouse.down();
    for (let i = 0; i < 10; i++) (await page.mouse.move(700 - i * 12, 300 + i * 3), await advance(page, 20, 20));
    await page.mouse.up();
    await advance(page, 800);
    await expect(page.locator('#viewReset')).toHaveClass(/on/);
    const moved = await page.evaluate(() => (window as any).__ie.cam().p);
    expect(Math.hypot(moved[0] - before[0], moved[2] - before[2])).toBeGreaterThan(20);
    await page.keyboard.press('r');
    await advance(page, 2500);
    await expect(page.locator('#viewReset')).not.toHaveClass(/on/);
    const back = await page.evaluate(() => (window as any).__ie.cam().p);
    expect(Math.hypot(back[0] - before[0], back[2] - before[2])).toBeLessThan(25);
  });

  test('Explore: crossing the shock brings the climax and the measured values', async ({ page }) => {
    const problems: string[] = [];
    await prepare(page, problems);
    await page.goto('/?site=venezuela&ch=5&debug');
    await booted(page);
    await advance(page, 9000);
    await page.locator('#tlHead').press('Home');
    await advance(page, 1500);
    await page.evaluate(() => (window as any).__ie.play());
    await until(page, () => document.getElementById('app')!.classList.contains('climax'), 60000);
    await advance(page, 3000);
    const values = await page.locator('.place em.pv').allTextContents();
    expect(values.filter((v) => /cm|signal/.test(v)).length).toBeGreaterThan(3);
    await until(page, () => !document.getElementById('app')!.classList.contains('climax'), 60000);
    expect(problems).toEqual([]);
  });

  test('film: M plays, any key stops it', async ({ page }) => {
    await prepare(page, []);
    await page.goto('/?site=granada&debug');
    await booted(page);
    await advance(page, 6000);
    await page.keyboard.press('m');
    await advance(page, 1000);
    await expect(page.locator('#app')).toHaveClass(/film/);
    await advance(page, 12000);
    expect(await page.evaluate(() => (window as any).__ie.state.beat)).toBeGreaterThan(0);
    await page.keyboard.press('ArrowLeft');
    await advance(page, 500);
    await expect(page.locator('#app')).not.toHaveClass(/film/);
  });

  test('sound: the button and S mute, and the choice is remembered', async ({ page }) => {
    await prepare(page, []);
    await page.goto('/?site=venezuela&debug');
    await booted(page);
    await advance(page, 2000);
    await expect(page.locator('#soundBtn')).not.toHaveClass(/off/);
    await page.keyboard.press('s');
    await expect(page.locator('#soundBtn')).toHaveClass(/off/);
    expect(await page.evaluate(() => localStorage.getItem('invisible-earth-sound'))).toBe('off');
    await page.locator('#soundBtn').click();
    await expect(page.locator('#soundBtn')).not.toHaveClass(/off/);
  });

  test('eye vs radar: the split sweeps in, follows its knob and leaves with Explore', async ({ page }) => {
    const problems: string[] = [];
    await prepare(page, problems);
    await page.goto('/?site=venezuela&ch=5&debug');
    await booted(page);
    await advance(page, 7000);
    await page.locator('#compareBtn').click();
    await advance(page, 2000);
    await expect(page.locator('#split')).toHaveClass(/on/);
    const split = () => page.evaluate(() => +getComputedStyle(document.getElementById('app')!).getPropertyValue('--split'));
    expect(Math.abs((await split()) - 0.5)).toBeLessThan(0.02);
    const k = (await page.locator('#splitKnob').boundingBox())!;
    const vw = page.viewportSize()!.width;
    await page.mouse.move(k.x + k.width / 2, k.y + k.height / 2);
    await page.mouse.down();
    await page.mouse.move(vw * 0.3, k.y + k.height / 2, { steps: 6 });
    await page.mouse.up();
    await advance(page, 300);
    expect(Math.abs((await split()) - 0.3)).toBeLessThan(0.03);
    await page.evaluate(() => (window as any).__ie.go(4));
    await advance(page, 1500);
    await expect(page.locator('#split')).not.toHaveClass(/on/);
    expect(problems).toEqual([]);
  });

  test('About opens, traps nothing, and Esc returns focus', async ({ page }) => {
    await prepare(page, []);
    await page.goto('/?site=nepal&debug');
    await booted(page);
    await advance(page, 3000);
    await page.locator('#aboutBtn').click();
    await advance(page, 800);
    await expect(page.locator('#about')).toHaveClass(/on/);
    await expect(page.locator('#aboutBody')).toContainText('Nepal');
    await page.keyboard.press('Escape');
    await advance(page, 800);
    await expect(page.locator('#about')).not.toHaveClass(/on/);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('aboutBtn');
  });

  test('Play all visits every place and ends on the picker', async ({ page }) => {
    test.setTimeout(600_000); // five films back to back
    const problems: string[] = [];
    await prepare(page, problems);
    await page.goto('/?debug&nointro');
    await booted(page);
    await advance(page, 3000);
    await page.evaluate(() => (window as any).__ie.playAll());
    const seen = new Set<string>();
    for (let t = 0; t < 600; t += 2) {
      await advance(page, 2000, 100);
      const s = await page.evaluate(() => (window as any).__ie.state);
      if (s.mode === 'story') seen.add(s.site);
      if (seen.size === SITES.length && s.mode === 'picker' && !s.filmAllOn) break;
    }
    expect([...seen].sort()).toEqual([...SITES].sort());
    expect(await page.evaluate(() => (window as any).__ie.state.mode)).toBe('picker');
    expect(problems).toEqual([]);
  });
});
