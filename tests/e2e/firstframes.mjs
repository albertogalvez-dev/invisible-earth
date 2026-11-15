// The very first moments of a real visit (real clock, no helpers): what does a visitor see before the app boots?
import fs from 'node:fs';
import { chromium } from '@playwright/test';
const url = process.argv[2] ?? 'http://localhost:5178/';
const out = '.cache/first';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
const t0 = Date.now();
await page.goto(url, { waitUntil: 'commit' });
let n = 0;
while (Date.now() - t0 < 5000) {
  try {
    await page.screenshot({ path: `${out}/f${String(n).padStart(3, '0')}-${Date.now() - t0}ms.jpg`, type: 'jpeg', quality: 80 });
    n++;
  } catch { /* not painted yet */ }
}
console.log(n, 'frames');
await browser.close();
