import { buildFields, smoothLift, toHalf, type RealSignal, type TerrainMeta } from './field';
import { siteById } from './sites';

interface Job {
  kind?: 'fields';
  id: number;
  siteId: string;
  meta: TerrainMeta;
  heights: Int16Array;
  real?: RealSignal;
}

// One pair of a series: its raw raster in, everything the main thread needs out (half floats and the smoothed lift),
// so switching pairs in Explore is only a copy.
interface PairJob {
  kind: 'pair';
  id: number;
  buf: ArrayBuffer;
  W: number;
  H: number;
  range: number;
  hasDcoh: boolean;
}

function pair({ id, buf, W, H, range, hasDcoh }: PairJob) {
  const n = W * H;
  const los = new Float32Array(buf, 0, n);
  const losH = new Uint16Array(n);
  for (let k = 0; k < n; k++) losH[k] = toHalf(los[k]);
  const coh8 = new Uint8Array(buf, n * 4, n);
  const { lift, liftH } = smoothLift(los, coh8, 1 / 255, W, H, range);
  (self as unknown as Worker).postMessage({ id, buf, losH, lift, liftH, hasDcoh }, [buf, losH.buffer, lift.buffer, liftH.buffer]);
}

self.onmessage = (e: MessageEvent<Job | PairJob>) => {
  if (e.data.kind === 'pair') return pair(e.data);
  const { id, siteId, meta, heights, real } = e.data;
  const site = siteById(siteId)!;
  const f = buildFields(meta, heights, site, real);
  (self as unknown as Worker).postMessage({ id, fields: f }, [
    f.heights.buffer, f.los.buffer, f.coh.buffer, f.dcoh.buffer, f.packed.buffer, f.packedChange.buffer,
    f.lift.buffer, f.liftH.buffer, f.grid.pos.buffer, f.grid.uv.buffer, f.grid.index.buffer, f.thumb.rgba.buffer,
  ]);
};
