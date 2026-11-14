import * as THREE from 'three';

interface TerrainMeta {
  width: number;
  height: number;
  metersPerPixel: number;
  source: string;
}

/** Read the signed 16-bit elevation grid and build a reduced, interactive mesh. */
export async function loadTerrain(): Promise<THREE.Mesh> {
  const [metaResponse, gridResponse] = await Promise.all([
    fetch('data/venezuela/terrain.json'),
    fetch('data/venezuela/terrain.bin'),
  ]);
  if (!metaResponse.ok || !gridResponse.ok) throw new Error('Terrain files are unavailable.');
  const meta = await metaResponse.json() as TerrainMeta;
  const buffer = await gridResponse.arrayBuffer();
  if (!Number.isInteger(meta.width) || !Number.isInteger(meta.height) || meta.width < 2 || meta.height < 2 || buffer.byteLength !== meta.width * meta.height * 2) {
    throw new Error('The terrain grid has invalid dimensions.');
  }
  const heights = new DataView(buffer);
  const segmentsX = 256;
  const segmentsY = Math.max(2, Math.round(segmentsX * meta.height / meta.width));
  const width = 4;
  const depth = width * meta.height / meta.width;
  const geometry = new THREE.PlaneGeometry(width, depth, segmentsX, segmentsY);
  geometry.rotateX(-Math.PI / 2);
  const positions = geometry.getAttribute('position');
  for (let row = 0; row <= segmentsY; row++) {
    const y = Math.round(row * (meta.height - 1) / segmentsY);
    for (let col = 0; col <= segmentsX; col++) {
      const x = Math.round(col * (meta.width - 1) / segmentsX);
      const metres = heights.getInt16((y * meta.width + x) * 2, true);
      positions.setY(row * (segmentsX + 1) + col, metres / (meta.width * meta.metersPerPixel) * width * 5);
    }
  }
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: '#718e88', roughness: 0.85, side: THREE.DoubleSide });
  return new THREE.Mesh(geometry, material);
}
