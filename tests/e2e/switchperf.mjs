// Real-time check of the picker: browse every place with the arrow keys, as a person would, and report the frames that
// ran long while the globe turned (the app logs them in ?debug). No fake clock: this measures the real main thread.
//
//   node tests/e2e/switchperf.mjs [width] [height]
import { chromium } from '@playwright/test';
import { BASE } from './harness.mjs';

const [W = '1440', H = '900'] = process.argv.slice(2);
const browser = await chromium.launch({
  headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: +W, height: +H }, deviceScaleFactor: 1 });
const log = [];
let phase = 'boot';
page.on('console', (m) => {
  const t = m.text();
  if (t.startsWith('[slow frame]') || t.startsWith('[apply]') || t.startsWith('[fields]')) log.push(`${phase}: ${t}`);
});
await page.goto(`${BASE}?nointro&debug`);
await page.waitForFunction(() => (window).__ie?.state?.mode === 'picker', null, { timeout: 60000 });
await page.waitForTimeout(6000); // every place's fields are built in the workers by now
for (let round = 0; round < 2; round++) {
  for (let i = 0; i < 5; i++) {
    phase = `round ${round + 1} · step ${i + 1}`;
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(3500);
  }
}
// Then go into each place and back out: the dive and the rise.
for (let i = 0; i < 5; i++) {
  phase = `dive ${i + 1}`;
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(2500);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
  phase = `rise ${i + 1}`;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(4000);
}
const slow = log.filter((l) => l.includes('[slow frame]'));
console.log(log.join('\n'));
console.log(`\n${slow.length} slow frames (> 50 ms) while browsing; worst ${Math.max(0, ...slow.map((l) => +l.match(/(\d+) ms/)[1]))} ms`);
await browser.close();
