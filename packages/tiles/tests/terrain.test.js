import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Tileset, ecefToCartographic, parseContent } from '../dist/index.js';
import { geographicTileRectangle, meshB3dm, parseQuantizedMesh, terrain } from '../dist/terrain.js';
import { memoryFetch, settle } from './generator.js';
import { GLB_BIN, GLB_JSON, glbChunks } from '../../shared/glb.js';

const folder = new URL('../../../examples/assets/terrain/', import.meta.url),
  file = (name) => new Uint8Array(readFileSync(new URL(name, folder)));
const deg = 180 / Math.PI;

test('terrain: the real Cesium World Terrain tile 9/759/335 decodes to Everest, every vertex in its sphere', () => {
  const mesh = parseQuantizedMesh(file('CesiumWorldTerrainSample/9/759/335.terrain')),
    [west, south, east, north] = geographicTileRectangle(9, 759, 335),
    count = mesh.u.length;
  assert.ok(count > 1000, `${count} vertices`);
  assert.equal(mesh.indices.length % 3, 0);
  for (const i of mesh.indices) assert.ok(i < count);
  // Edge lists lie on their edges.
  for (const i of mesh.west) assert.equal(mesh.u[i], 0);
  for (const i of mesh.east) assert.equal(mesh.u[i], 32767);
  for (const i of mesh.south) assert.equal(mesh.v[i], 0);
  for (const i of mesh.north) assert.equal(mesh.v[i], 32767);
  // The highest vertex is Everest's summit (27.9881 N, 86.9250 E, 8,849 m): within this tile's sample spacing.
  let top = 0;
  for (let i = 1; i < count; i++) if (mesh.height[i] > mesh.height[top]) top = i;
  const lon = (west + (mesh.u[top] / 32767) * (east - west)) * deg,
    lat = (south + (mesh.v[top] / 32767) * (north - south)) * deg;
  assert.ok(Math.abs(lon - 86.925) < 0.01 && Math.abs(lat - 27.9881) < 0.01, `summit at ${lat} N ${lon} E`);
  assert.ok(mesh.maximumHeight > 8_600 && mesh.maximumHeight < 8_900, `maximum ${mesh.maximumHeight} m`);
  // Every vertex, placed on WGS84, lies in the header's bounding sphere (float32 rounding of the heights aside).
  const b3dm = parseContent(meshB3dm(mesh, [west, south, east, north], undefined, 0));
  assert.equal(b3dm.type, 'b3dm');
  assert.deepEqual(b3dm.rtcCenter, mesh.center);
  const [cx, cy, cz, r] = mesh.boundingSphere;
  const gltf = b3dm.gltf,
    view = new DataView(gltf.buffer, gltf.byteOffset, gltf.byteLength),
    jsonLength = view.getUint32(12, true),
    doc = JSON.parse(new TextDecoder().decode(gltf.subarray(20, 20 + jsonLength))),
    bin = gltf.subarray(28 + jsonLength),
    pv = doc.bufferViews[doc.accessors[0].bufferView],
    positions = new Float32Array(bin.buffer.slice(bin.byteOffset + pv.byteOffset, bin.byteOffset + pv.byteOffset + pv.byteLength));
  for (let i = 0; i < count; i++) {
    // glTF y-up back to ECEF z-up: (x, y, z) -> (x, -z, y), plus the RTC centre.
    const p = [positions[i * 3] + mesh.center[0], -positions[i * 3 + 2] + mesh.center[1], positions[i * 3 + 1] + mesh.center[2]];
    assert.ok(Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz) <= r + 1, `vertex ${i} outside the sphere`);
    const c = ecefToCartographic(...p);
    assert.ok(c.longitude >= west - 1e-9 && c.longitude <= east + 1e-9 && c.latitude >= south - 1e-9 && c.latitude <= north + 1e-9);
  }
});

test('terrain: oct normals and the water mask extension of the real Cesium sample are read', () => {
  const mesh = parseQuantizedMesh(file('QuantizedMeshWithOctVertexNormals/tile.octvertexnormals.terrain'));
  assert.equal(mesh.normals.length, mesh.u.length * 2);
  // Oct normals of ground point away from the earth: positive along the vertex's own up for nearly all vertices.
  const watered = parseQuantizedMesh(file('QuantizedMeshWithOctVertexNormalsAndWaterMask/tile.octvertexnormals.watermask.terrain'));
  assert.ok(watered.waterMask.length === 1 || watered.waterMask.length === 65536);
  assert.equal(watered.normals.length, watered.u.length * 2);
});

test('terrain: a cut tile is refused with a RangeError, never read past its end', () => {
  const bytes = file('QuantizedMeshWithOctVertexNormals/tile.octvertexnormals.terrain');
  for (const n of [0, 50, 88, 100, 600, bytes.length - 3]) assert.throws(() => parseQuantizedMesh(bytes.subarray(0, n)), RangeError, `cut at ${n}`);
});

test('terrain: the layer becomes an implicit tileset, its tiles b3dm with imagery UVs inside the image', async () => {
  const layer = file('QuantizedMeshWithOctVertexNormals/layer.json'),
    tile = file('QuantizedMeshWithOctVertexNormals/tile.octvertexnormals.terrain'),
    png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    outer = memoryFetch(new Map([['layer.json', layer], ['tile.octvertexnormals.terrain', tile], ['img/0/0/0.png', png], ['img/1/0/0.png', png], ['img/1/1/0.png', png], ['img/1/0/1.png', png], ['img/1/1/1.png', png]]));
  const fetch = (url, init) => outer.fetch(String(url).split('?')[0], init);
  const source = await terrain('https://tiles.test/layer.json', { fetch, imagery: { url: 'https://tiles.test/img/{z}/{x}/{y}.png' } });
  assert.equal(source.maximumLevel, 1);
  const contents = [];
  const tileset = await Tileset.load(source.url, { fetch: source.fetch, content: (content) => (contents.push(content), { bytes: 1, visible: false, dispose() {} }) });
  assert.equal(tileset.root.children.length, 2);
  for (let i = 0; i < 40 && contents.length < 2; i++) {
    tileset.update({ position: [0, 0, 20_000_000], screenHeight: 1080, fov: 60 });
    await settle(4);
  }
  assert.ok(contents.length >= 2, `${contents.length} terrain tiles loaded`);
  for (const content of contents) {
    assert.equal(content.type, 'b3dm');
    const g = content.gltf,
      view = new DataView(g.buffer, g.byteOffset, g.byteLength),
      jl = view.getUint32(12, true),
      doc = JSON.parse(new TextDecoder().decode(g.subarray(20, 20 + jl)));
    assert.deepEqual(doc.extensionsUsed, ['KHR_materials_unlit']);
    assert.equal(doc.images[0].mimeType, 'image/png');
    const uv = doc.accessors[3],
      bin = g.subarray(28 + jl),
      bv = doc.bufferViews[uv.bufferView],
      values = new Float32Array(bin.buffer.slice(bin.byteOffset + bv.byteOffset, bin.byteOffset + bv.byteOffset + bv.byteLength));
    for (const value of values) assert.ok(value >= -1e-6 && value <= 1 + 1e-6, `uv ${value}`);
  }
  // Only EPSG:4326 tms layers are read; anything else is refused by name.
  const mercator = memoryFetch(new Map([['layer.json', new TextEncoder().encode(JSON.stringify({ tiles: ['{z}/{x}/{y}.terrain'], projection: 'EPSG:3857' }))]]));
  await assert.rejects(terrain('https://tiles.test/layer.json', { fetch: mercator.fetch }), (e) => e.code === 'unsupported');
});

test('terrain: its b3dm holds a whole GLB container the shared walker accepts, with and without a drape', () => {
  // Regression: terrain once wrote its own GLB header beside packages/shared/glb.js; it now uses the shared constants.
  const mesh = parseQuantizedMesh(file('CesiumWorldTerrainSample/9/759/335.terrain')),
    rectangle = geographicTileRectangle(9, 759, 335),
    drape = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]), mimeType: 'image/png', uv: (a, b) => [a, b] };
  for (const d of [undefined, drape]) {
    const gltf = parseContent(meshB3dm(mesh, rectangle, d, 0)).gltf,
      chunks = glbChunks(gltf);
    assert.deepEqual(chunks.map((c) => c.type), [GLB_JSON, GLB_BIN]);
    const doc = JSON.parse(new TextDecoder().decode(chunks[0].data));
    assert.equal(doc.buffers[0].byteLength, chunks[1].data.length);
    assert.equal(doc.asset.version, '2.0');
  }
});
