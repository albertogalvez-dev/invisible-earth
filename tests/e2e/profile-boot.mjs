// Profiles the first seconds after load (real clock) and prints the functions with the most self time.
//
//   node tests/e2e/profile-boot.mjs [query]
import { chromium } from '@playwright/test';
import { BASE } from './harness.mjs';

const [query = 'debug'] = process.argv.slice(2);
const browser = await chromium.launch({ headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const slow = [];
page.on('console', (m) => (m.text().startsWith('[slow frame]') || m.text().startsWith('[boot]')) && slow.push(m.text()));
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
await page.goto(`${BASE}?${query}`);
await page.waitForTimeout(12000);
const { profile: p } = await cdp.send('Profiler.stop');
const dt = new Map();
for (let i = 0; i < p.samples.length; i++) dt.set(p.samples[i], (dt.get(p.samples[i]) ?? 0) + (p.timeDeltas[i] ?? 0) / 1000);
const agg = new Map();
for (const n of p.nodes) {
  const fn = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop().split('?')[0]}:${n.callFrame.lineNumber + 1}`;
  if (fn.startsWith('(idle)') || fn.startsWith('(program)')) continue;
  agg.set(fn, (agg.get(fn) ?? 0) + (dt.get(n.id) ?? 0));
}
console.log(slow.join('\n'));
for (const [fn, ms] of [...agg].sort((a, b) => b[1] - a[1]).slice(0, 16)) console.log(`${ms.toFixed(0).padStart(6)} ms  ${fn}`);
await browser.close();
