// The picker at every size: the opening skipped, one place previewed.
import { open, advance, booted } from './harness.mjs';
import { chromium } from '@playwright/test';
void chromium;
const sizes = [[1920, 1080], [1440, 900], [1280, 720], [768, 1024], [390, 844], [844, 390]];
for (const [w, h] of sizes) {
  const { browser, page } = await open({ width: w, height: h, query: 'debug&nointro', mobile: w < 800 && w < h });
  await booted(page);
  await advance(page, 5000);
  await page.evaluate(() => void window.__ie.preview('nepal'));
  await advance(page, 3000);
  await page.screenshot({ path: `.cache/test-results/shots/picker-${w}x${h}.jpg`, type: 'jpeg', quality: 80 });
  await browser.close();
}
console.log('ok');
