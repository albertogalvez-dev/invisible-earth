// Records one scene as rendered, for review: a query, timed page actions, a duration.
//   node tests/e2e/scene.mjs <take> "<query>" <seconds> [fps] [width] [height] [actions-json]
// actions-json: [[seconds, "js to evaluate in the page"], ...]. Writes .cache/rec/<take>/ frames, .cache/video/<take>.mp4
// and a contact sheet .cache/video/<take>-sheet.jpg (one frame every half second).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { open, advance, booted } from './harness.mjs';

const [take, query = 'debug', secs = '10', FPS = '24', W = '1280', H = '720', acts = '[]'] = process.argv.slice(2);
const fps = +FPS, dt = 1000 / fps;
const actions = JSON.parse(acts).sort((a, b) => a[0] - b[0]);
const dir = path.resolve('.cache/rec', take);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(path.resolve('.cache/video'), { recursive: true });
const mobile = +W < 800 && +W < +H;
const { browser, page, problems } = await open({ width: +W, height: +H, query, mobile });
await booted(page);
for (let n = 0; n < +secs * fps; n++) {
  const t = n / fps;
  // Fire and forget: an action may wait on timers, and the clock only moves between frames.
  while (actions.length && actions[0][0] <= t) await page.evaluate(`void (${actions.shift()[1]})`);
  await advance(page, dt, dt);
  await page.screenshot({ path: path.join(dir, `f${String(n).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85 });
}
await browser.close();
const frames = ['-framerate', String(fps), '-i', path.join(dir, 'f%05d.jpg')];
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...frames, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-movflags', '+faststart', path.resolve('.cache/video', `${take}.mp4`)]);
const every = Math.max(1, Math.round(fps / 2));
const count = Math.ceil((+secs * fps) / every);
const cols = 6, rows = Math.ceil(count / cols);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...frames, '-vf', `select='not(mod(n\\,${every}))',scale=${+W > +H ? 400 : 200}:-1,tile=${cols}x${rows}`, '-frames:v', '1', path.resolve('.cache/video', `${take}-sheet.jpg`)]);
console.log(JSON.stringify({ take, frames: +secs * fps, problems }));
