// Profiles the first place switch in the picker and the first dive with the Chrome CPU profiler, and prints the
// functions with the most self time. Real clock, real GPU.
//
//   node tests/e2e/profile-switch.mjs
import { chromium } from '@playwright/test';
import { BASE } from './harness.mjs';

const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
await page.goto(`${BASE}?nointro&debug`);
await page.waitForFunction(() => window.__ie?.state?.mode === 'picker', null, { timeout: 60000 });
await page.waitForTimeout(6000);
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });

async function profile(label, act, ms) {
  await cdp.send('Profiler.start');
  await act();
  await page.waitForTimeout(ms);
  const { profile: p } = await cdp.send('Profiler.stop');
  const dt = new Map();
  const deltas = p.timeDeltas;
  for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (deltas[i] ?? 0) / 1000);
  const rows = p.nodes
    .map((n) => ({ ms: dt.get(n.id) ?? 0, fn: `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}` }))
    .filter((r) => r.ms > 4 && !r.fn.startsWith('(idle)') && !r.fn.startsWith('(program)'));
  const agg = new Map();
  for (const r of rows) agg.set(r.fn, (agg.get(r.fn) ?? 0) + r.ms);
  console.log(`\n== ${label}`);
  for (const [fn, ms] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`${ms.toFixed(0).padStart(6)} ms  ${fn}`);
}
await profile('first switch', () => page.keyboard.press('ArrowDown'), 2500);
const before = await page.evaluate(() => window.__ie.programs());
await profile('first dive', () => page.keyboard.press('Enter'), 3000);
const after = await page.evaluate(() => window.__ie.programs());
console.log('programs compiled by the dive:', after.filter((p) => !before.includes(p)));
await browser.close();
