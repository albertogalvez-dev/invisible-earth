// Restore the data package published with this project. Run: npm run data
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';

const url = 'https://github.com/albertogalvez-dev/invisible-earth/releases/download/invisible-earth-data-v1/invisible-earth-data.tar.gz';
const expected = '8242d78edb9787d776a62475027e4bea5b6d34ec7869054e537d8ed2fb58367e';
const archive = path.resolve('.cache/invisible-earth-data.tar.gz');
const partial = `${archive}.partial`;
mkdirSync(path.dirname(archive), { recursive: true });

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

if (!existsSync(archive) || await checksum(archive) !== expected) {
  console.log('Downloading Invisible Earth data (~254 MiB)…');
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Data download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  if (await checksum(partial) !== expected) {
    rmSync(partial);
    throw new Error('Data archive checksum does not match; nothing was extracted.');
  }
  renameSync(partial, archive);
}

mkdirSync('public', { recursive: true });
console.log('Restoring data to public/data. Existing data files with the same names will be replaced.');
execFileSync('tar', ['-xzf', archive, '-C', 'public'], { stdio: 'inherit' });
console.log('Data restored. Run npm run dev or npm run build.');
