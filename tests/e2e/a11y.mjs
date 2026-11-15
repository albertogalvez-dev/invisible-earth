// Accessibility audit (axe-core) of the opening, the picker, every chapter of one place, About and the key help.
import AxeBuilder from '@axe-core/playwright';
import { open, advance, booted } from './harness.mjs';

const { browser, page } = await open({ width: 1440, height: 900, query: 'debug' });
await booted(page);
const found = new Map();
const audit = async (where) => {
  // axe needs timers: let the clock run while it works, then pause it again.
  await page.clock.resume();
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice']).analyze();
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 50);
  for (const v of r.violations) {
    const k = v.id;
    if (!found.has(k)) found.set(k, { impact: v.impact, help: v.help, where: new Set(), nodes: new Set() });
    const f = found.get(k);
    f.where.add(where);
    for (const n of v.nodes.slice(0, 6)) f.nodes.add(n.target.join(' ') + (n.any?.[0]?.message ? ` — ${n.any[0].message.slice(0, 140)}` : ''));
  }
};
await advance(page, 3000);
await audit('opening');
await page.keyboard.press('Enter');
await advance(page, 4000);
await audit('picker');
await page.evaluate(() => void window.__ie.enter('venezuela'));
await advance(page, 7000);
for (let ch = 0; ch < 6; ch++) {
  if (ch) await page.evaluate((c) => window.__ie.go(c), ch);
  await advance(page, ch === 1 || ch === 2 ? 13000 : 4500);
  await audit(`chapter ${ch}`);
}
await page.locator('#aboutBtn').click();
await advance(page, 800);
await audit('about');
await page.keyboard.press('Escape');
await advance(page, 500);
await page.keyboard.press('?');
await advance(page, 800);
await audit('keys');
await browser.close();
for (const [id, f] of found) console.log(`\n[${f.impact}] ${id}: ${f.help}\n  in: ${[...f.where].join(', ')}\n  ${[...f.nodes].join('\n  ')}`);
console.log(`\n${found.size} kinds of violation`);
