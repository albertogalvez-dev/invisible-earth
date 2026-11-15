// Records the whole 'Play all' journey (opening included) as a real render, frame by frame on the fake clock, then
// checks the frames: black frames, hard cuts, console errors. Output: .cache/rec/<take>/ frames, .cache/video/<take>.mp4
// and .cache/video/<take>-report.json.
//
//   node tests/e2e/film.mjs [take] [width] [height] [fps]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { open, advance, booted } from './harness.mjs';

const [take = 'film', W = '1280', H = '720', FPS = '24'] = process.argv.slice(2);
const width = +W, height = +H, fps = +FPS, dt = 1000 / fps;
const dir = path.resolve('.cache/rec', take);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(path.resolve('.cache/video'), { recursive: true });

const { browser, page, problems } = await open({ width, height, query: 'debug' });
const jumps = []; // [jump] lines the app logs in ?debug when a transition value or the camera leaps in one frame
page.on('console', (m) => m.text().startsWith('[jump]') && jumps.push({ frame: n, text: m.text() }));
const t0 = Date.now();
let n = 0;
const marks = [];
const shot = async () => {
  await page.screenshot({ path: path.join(dir, `f${String(n).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 85 });
  n++;
};
const film = async (seconds, label) => {
  if (label) marks.push({ t: +(n / fps).toFixed(2), label });
  for (let i = 0; i < seconds * fps; i++) {
    await advance(page, dt, dt);
    await shot();
  }
};

await booted(page);
await film(9, 'opening');
marks.push({ t: +(n / fps).toFixed(2), label: 'play all' });
await page.evaluate(() => window.__ie.playAll());
// Film until the journey is back on the picker (and not merely passing through it between places).
for (let guard = 0; guard < 400 * fps; guard++) {
  await advance(page, dt, dt);
  await shot();
  if (guard % fps === 0) {
    const s = await page.evaluate(() => ({ ...window.__ie.state, tour: document.getElementById('app').classList.contains('tour') }));
    if (s.mode === 'picker' && !s.tour && !s.filmAllOn && guard > 60 * fps) break;
  }
}
await film(3, 'end');
await browser.close();
console.log(`${n} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

// ---------- analysis ----------
const video = path.resolve('.cache/video', `${take}.mp4`);
const frames = ['-framerate', String(fps), '-i', path.join(dir, 'f%05d.jpg')];
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', ...frames, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-preset', 'medium', '-movflags', '+faststart', video]);
// Every frame as a 32x18 grey thumbnail: its mean is the brightness, its difference from the previous one a cut.
const TW = 32, TH = 18, px = TW * TH;
const raw = execFileSync('ffmpeg', ['-loglevel', 'error', ...frames, '-vf', `scale=${TW}:${TH},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
const count = Math.floor(raw.length / px);
const mean = (k) => {
  let s = 0;
  for (let i = 0; i < px; i++) s += raw[k * px + i];
  return s / px;
};
const diff = (k) => {
  let s = 0;
  for (let i = 0; i < px; i++) s += Math.abs(raw[k * px + i] - raw[(k - 1) * px + i]);
  return s / px;
};
const from = Math.round(1.5 * fps); // the opening fades in from black on purpose
const black = [], cuts = [], flashes = [];
for (let k = from; k < count; k++) {
  if (mean(k) < 6) black.push(+(k / fps).toFixed(2));
  const d = diff(k);
  // A flash: one frame unlike both its neighbours, which are alike (a glitch, not a change of shot).
  if (k + 1 < count && d > 12 && diff(k + 1) > 12) {
    let s = 0;
    for (let i = 0; i < px; i++) s += Math.abs(raw[(k + 1) * px + i] - raw[(k - 1) * px + i]);
    if (s / px < d * 0.4) flashes.push({ t: +(k / fps).toFixed(2), frame: k, diff: +d.toFixed(1) });
  } else if (d > 22) cuts.push({ t: +(k / fps).toFixed(2), frame: k, diff: +d.toFixed(1) });
}
const report = { take, frames: n, fps, seconds: +(n / fps).toFixed(1), marks, blackFrames: black, flashes, hardCuts: cuts, jumps, problems };
fs.writeFileSync(path.resolve('.cache/video', `${take}-report.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, blackFrames: black.length ? `${black.length} frames, first at ${black[0]} s` : 'none' }, null, 2));
