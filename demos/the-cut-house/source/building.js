import asset from './assets/building.bin?url';
export const sourceURL = new URL('./assets/cut-house.ifc', import.meta.url).href;

export async function loadBuilding(signal) {
  const response = await fetch(asset, { signal });
  if (!response.ok) throw new Error('The IFC building geometry could not be opened (' + response.status + ').');
  const text = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).text();
  signal.throwIfAborted();
  const payload = JSON.parse(text);
  const geometries = new Map(payload.sources.map(([id, xyz, n, index]) => [id, {
    positions: Float32Array.from(xyz), normals: Float32Array.from(n), indices: Uint32Array.from(index),
  }]));
  const placements = payload.placements.map(({ matrix, ...placement }) => ({ ...placement, matrix: Float64Array.from(matrix) }));
  return { schema: payload.schema, origin: payload.origin, placements,
    products: payload.products, geometries, sourceSHA: payload.sourceSHA };
}
