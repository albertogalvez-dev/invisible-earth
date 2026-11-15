// GPU cost per chapter at a given size: node tests/e2e/bench.mjs [width] [height]
import { open, advance, booted } from './harness.mjs';
const [W = '1920', H = '1080'] = process.argv.slice(2);
const { browser, page } = await open({ width: +W, height: +H, query: 'site=venezuela&debug' });
await booted(page);
await advance(page, 7000);
const out = {};
for (const [ch, wait] of [[0, 3000], [1, 7000], [2, 7500], [3, 4000], [5, 4000], [0, 4000]]) {
  if (ch) await page.evaluate((c) => window.__ie.go(c), ch);
  await advance(page, wait);
  // performance.now is the fake clock here: time the 60 synchronous renders from outside the page.
  const t0 = performance.now();
  const r = await page.evaluate(() => window.__ie.bench(60, innerWidth, innerHeight, 1));
  out[`ch${ch}${out[`ch${ch}`] ? "-again" : ""}`] = { ms: +((performance.now() - t0) / 60).toFixed(2), calls: r.calls, tris: r.tris };
}
console.log(JSON.stringify(out, null, 1));
await browser.close();
