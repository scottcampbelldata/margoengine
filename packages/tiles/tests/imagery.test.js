import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { wmsURL, wmtsURL, terrainRectangle, terrainImagery } from '../dist/imagery.js';
import { parseQuantizedMesh, meshB3dm } from '../dist/terrain.js';
import { parseB3dm, ecefToCartographic } from '../dist/index.js';
import { GLTFAsset } from '../../gltf-pro/dist/index.js';
import { glbChunks } from '../../shared/glb.js';
const tile = new Uint8Array(
  readFileSync(
    new URL(
      '../../../examples/assets/terrain/QuantizedMeshWithOctVertexNormals/tile.octvertexnormals.terrain',
      import.meta.url,
    ),
  ),
);
const rectangle = [-Math.PI / 2, -Math.PI / 6, Math.PI / 3, Math.PI / 4];
test('WMS versions use normative axes, correct CRS/SRS key and preserve access parameters', () => {
  const url = new URL(
    wmsURL({ url: 'https://map.test/wms?token=private&request=old', layers: 'roads', crs: 'EPSG:4326' }, rectangle),
  );
  assert.equal(url.searchParams.get('CRS'), 'EPSG:4326');
  assert.equal(url.searchParams.get('REQUEST'), 'GetMap');
  // Exact IEEE-754 conversion of the supplied radian values, retaining its rounding rather than rounding the URL.
  assert.deepEqual(
    url.searchParams.get('BBOX').split(',').map(Number),
    [-29.999999999999996, -90, 45, 59.99999999999999],
  );
  assert.equal(url.searchParams.get('token'), 'private');
  assert.equal(url.searchParams.has('request'), false);
  const old = new URL(
    wmsURL({ url: 'https://map.test/wms', layers: 'roads', version: '1.1.1', crs: 'EPSG:4326' }, rectangle),
  );
  assert.deepEqual(
    old.searchParams.get('BBOX').split(',').map(Number),
    [-90, -29.999999999999996, 59.99999999999999, 45],
  );
  assert.equal(old.searchParams.get('SRS'), 'EPSG:4326');
  const crs84 = new URL(wmsURL({ url: 'https://map.test/wms', layers: 'roads' }, rectangle));
  assert.equal(crs84.searchParams.get('CRS'), 'CRS:84');
});
test('WMTS supports KVP, matrix labels, dimensions and ResourceURL templates', () => {
  const options = {
    url: 'https://map.test/wmts?key=private',
    layer: 'ortho',
    matrixSet: 'WebMercator',
    parameters: { TIME: '2026' },
  };
  const url = new URL(wmtsURL(options, 'EPSG:3857:4', 3, 2));
  assert.equal(url.searchParams.get('TILEMATRIX'), 'EPSG:3857:4');
  assert.equal(url.searchParams.get('TILECOL'), '3');
  assert.equal(url.searchParams.get('TILEROW'), '2');
  assert.equal(url.searchParams.get('TIME'), '2026');
  assert.equal(
    wmtsURL(
      { ...options, url: 'https://map.test/{Layer}/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.png' },
      '4',
      3,
      2,
    ),
    'https://map.test/ortho/WebMercator/4/2/3.png?TIME=2026',
  );
});
test('Mercator terrain rectangles have one root and nonlinear latitude subdivision', () => {
  const root = terrainRectangle(0, 0, 0, 'EPSG:3857');
  assert.equal(root[0], -Math.PI);
  assert.equal(root[2], Math.PI);
  assert.equal(root[3], Math.atan(Math.sinh(Math.PI)));
  const child = terrainRectangle(2, 0, 2, 'EPSG:3857');
  assert.equal(child[1], 0);
  assert.equal(child[3], Math.atan(Math.sinh(Math.PI / 2)));
  assert.notEqual(child[3], root[3] / 2);
  assert.deepEqual(terrainRectangle(0, 0, 0, 'EPSG:4326'), [-Math.PI, -Math.PI / 2, 0, Math.PI / 2]);
});
test('invalid imagery rectangles, WMS versions and terrain pyramid coordinates are rejected', () => {
  assert.throws(() => wmsURL({ url: 'https://map.test/wms', layers: 'a', version: '2' }, rectangle), /version/);
  assert.throws(() => wmsURL({ url: 'https://map.test/wms', layers: 'a' }, [0, 0, 1, 2]), /bounds/);
  for (const args of [
    [-1, 0, 0, 'EPSG:3857'],
    [0, 1, 0, 'EPSG:3857'],
    [2, 0, 4, 'EPSG:4326'],
  ])
    assert.throws(() => terrainRectangle(...args), /coordinates/);
});
function metadataTile(ranges) {
  const json = new TextEncoder().encode(JSON.stringify({ available: ranges })),
    extension = new Uint8Array(9 + json.length),
    view = new DataView(extension.buffer);
  extension[0] = 4;
  view.setUint32(1, json.length + 4, true);
  view.setUint32(5, json.length, true);
  extension.set(json, 9);
  const bytes = new Uint8Array(tile.length + extension.length);
  bytes.set(tile);
  bytes.set(extension, tile.length);
  return bytes;
}
test('metadataAvailability overrides manifest available and prunes lazy children before requests', async () => {
  const requests = [],
    headers = [];
  const fetch = async (url, init) => {
    requests.push(url);
    headers.push(init?.headers?.Accept);
    if (url.endsWith('layer.json'))
      return new Response(
        JSON.stringify({
          tiles: ['{z}/{x}/{y}.terrain'],
          projection: 'EPSG:3857',
          maxzoom: 1,
          metadataAvailability: 1,
          available: [[]],
        }),
      );
    return new Response(metadataTile([[{ startX: 1, startY: 0, endX: 1, endY: 0 }]]));
  };
  const source = await terrainImagery('https://terrain.test/layer.json', { fetch });
  const root = await (await source.fetch(source.url)).json();
  assert.equal(root.root.children.length, 1);
  const branch = await (await source.fetch(root.root.children[0].content.uri)).json();
  assert.equal(branch.root.children.length, 1);
  assert.ok(branch.root.children[0].content.uri.endsWith('1/1/0.json'));
  assert.ok(headers.some((h) => h?.includes('metadata')));
  const content = parseB3dm(new Uint8Array(await (await source.fetch(branch.root.content.uri)).arrayBuffer()));
  assert.ok(content.gltf.byteLength > 0);
  assert.equal(
    requests.filter((u) => u.endsWith('.terrain')).length,
    1,
    'branch selection and content share the staging decode',
  );
  source.dispose();
  await assert.rejects(source.fetch(source.url), (e) => e.name === 'AbortError');
});
test('slippyMap terrain URL flips north-origin y and missing metadata fails explicitly', async () => {
  const requested = [];
  const fetch = async (url) => {
    requested.push(url);
    if (url.endsWith('layer.json'))
      return new Response(
        JSON.stringify({ tiles: ['{z}/{x}/{y}.terrain'], projection: 'EPSG:3857', scheme: 'slippyMap', maxzoom: 1 }),
      );
    return new Response(tile);
  };
  const source = await terrainImagery('https://terrain.test/layer.json', { fetch });
  await source.fetch(source.url.replace('tileset.json', '1/0/0.json'));
  assert.ok(requested.includes('https://terrain.test/1/0/1.terrain'));
  source.dispose();
  const broken = await terrainImagery('https://terrain.test/layer.json', {
    fetch: async (url) =>
      url.endsWith('layer.json')
        ? new Response(JSON.stringify({ tiles: ['{z}/{x}/{y}.terrain'], metadataAvailability: 1 }))
        : new Response(tile),
  });
  await assert.rejects(broken.fetch(broken.url.replace('tileset.json', '0/0/0.json')), /omitted metadata/);
  broken.dispose();
});
test('Mercator quantized v is interpolated in projected space before ECEF placement', () => {
  const mesh = parseQuantizedMesh(tile),
    rect = terrainRectangle(2, 1, 2, 'EPSG:3857'),
    south = 0,
    north = Math.PI / 2;
  const bytes = meshB3dm(mesh, rect, undefined, 0, (f) => Math.atan(Math.sinh(south + (north - south) * f))),
    gltf = parseB3dm(bytes).gltf,
    chunks = glbChunks(gltf),
    doc = JSON.parse(new TextDecoder().decode(chunks[0].data)),
    asset = new GLTFAsset(doc, [], chunks[1].data),
    positions = asset.accessor(doc.meshes[0].primitives[0].attributes.POSITION, 'VEC3');
  let vertex = 0;
  for (let i = 1; i < mesh.v.length; i++)
    if (Math.abs(mesh.v[i] - 16384) < Math.abs(mesh.v[vertex] - 16384)) vertex = i;
  const p = positions.subarray(vertex * 3, vertex * 3 + 3),
    world = [p[0] + mesh.center[0], -p[2] + mesh.center[1], p[1] + mesh.center[2]],
    latitude = ecefToCartographic(...world).latitude;
  assert.ok(Math.abs(latitude - Math.atan(Math.sinh(((mesh.v[vertex] / 32767) * Math.PI) / 2))) < 2e-7);
});
