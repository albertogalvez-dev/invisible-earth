import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// Development only: `?debug` can post rendered frames here, one JPEG per request, so the animations can be reviewed as video.
function frameSink(): Plugin {
  return {
    name: 'frame-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__rec', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x');
        const take = (url.searchParams.get('take') ?? 'take').replace(/[^\w-]/g, '');
        const dir = path.resolve('.cache/rec', take);
        if (req.method === 'DELETE') {
          fs.rmSync(dir, { recursive: true, force: true });
          res.end('ok');
          return;
        }
        const n = Number(url.searchParams.get('n'));
        if (req.method !== 'POST' || !Number.isInteger(n) || n < 0) {
          res.statusCode = 400;
          res.end('bad request');
          return;
        }
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `f${String(n).padStart(5, '0')}.jpg`), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  build: { target: 'es2022' },
  // .cache holds tile caches and recorded frames (tens of thousands of files): watching it would stall the server.
  server: { port: 5178, watch: { ignored: ['**/.cache/**', '**/dist/**', '**/.venv-gunw/**'] } },
  plugins: [frameSink()],
});
