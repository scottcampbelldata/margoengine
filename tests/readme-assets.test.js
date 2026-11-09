import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { createServer } from 'node:http';
import {
  README_FILES,
  README_DOWNLOADS,
  readmeFixture,
  readmeNodeEnv,
  readmeNodeFetch,
  sampleRange,
  serveSample,
} from '../scripts/support/readme-assets.mjs';
import { parseIES } from '../packages/clustered/dist/ies.js';
import { parseUSDZ } from '../packages/usdz/dist/index.js';
import { createHash } from 'node:crypto';
import { parsePly, parseSplat, parseSpz, parseSog, validateSplats } from '../packages/splats/dist/data.js';
import { MeshoptSIMDDecoder, meshoptDecodeGltfBufferSIMD } from '../packages/decoders/dist/meshopt-simd.js';
import { externalAssets } from '../scripts/support/external-test-assets.mjs';

test('Node README fetch serves every exact pinned FlightHelmet resource and refuses missing or changed bytes', async () => {
  const family = externalAssets.filter(({ file }) => file.startsWith('helmet/'));
  assert.equal(family.length, 17);
  const neverNetwork = () => {
    throw new Error('A required model resource escaped to the network');
  };
  const request = readmeNodeFetch(neverNetwork);
  for (const item of family) {
    const response = await request(new URL(item.url));
    assert.equal(response.status, 200);
    assert.equal(
      createHash('sha256')
        .update(new Uint8Array(await response.arrayBuffer()))
        .digest('hex'),
      item.sha256,
    );
  }
  const doc = await (await request(family[0].url)).json();
  assert.ok(doc.extensionsRequired.includes('KHR_texture_basisu'));
  for (const resource of [...doc.buffers, ...doc.images]) {
    const url = new URL(resource.uri, family[0].url).href;
    assert.ok(
      family.some((item) => item.url === url),
      resource.uri,
    );
  }
  const empty = mkdtempSync(join(tmpdir(), 'readme-node-'));
  try {
    const local = readmeNodeFetch(neverNetwork, empty);
    await assert.rejects(local(family[0].url), /FlightHelmet\.gltf[\s\S]*fetch-skip-assets/);
    mkdirSync(join(empty, 'helmet'));
    writeFileSync(join(empty, family[0].file), '{}');
    await assert.rejects(local(family[0].url), /Changed required test fixture[\s\S]*FlightHelmet\.gltf/);
    const controller = new AbortController();
    controller.abort(new Error('stop before serving the model'));
    await assert.rejects(request(new Request(family[0].url, { signal: controller.signal })), /stop before serving/);
    let forwarded;
    const fallback = readmeNodeFetch((...args) => {
      forwarded = args;
      return new Response('outside');
    });
    const init = { headers: { test: 'forwarded' } };
    assert.equal(await (await fallback('https://example.test/other', init)).text(), 'outside');
    assert.deepEqual(forwarded, ['https://example.test/other', init]);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('Potree README aliases preserve the complete outside folder and refuse a missing node', () => {
  const family = externalAssets.filter(({ file }) => file.startsWith('potree-lion/'));
  assert.equal(family.length, 80);
  assert.equal(
    family.reduce((sum, item) => sum + item.size, 0),
    6157310,
  );
  for (const item of family) {
    const pathname = '/scans/site/' + item.file.slice('potree-lion/'.length);
    const fixture = readmeFixture(pathname);
    assert.ok(fixture, pathname + ' needs an explicit, format-correct required input');
    assert.equal(createHash('sha256').update(readFileSync(fixture.path)).digest('hex'), item.sha256, pathname);
  }
  assert.equal(readmeFixture('/scans/site/metadata.json'), undefined, 'a 1.7 folder has no 2.0 metadata');
  const empty = mkdtempSync(join(tmpdir(), 'readme-potree-'));
  try {
    assert.throws(
      () => readmeFixture('/scans/site/data/r/r606.bin', undefined, undefined, empty),
      /r606\.bin[\s\S]*fetch-skip-assets/,
    );
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('the Draco README serves the exact published Avocado compressed view with matching attribute IDs', () => {
  const fixture = readmeFixture('/mesh.drc');
  assert.ok(fixture, 'Draco needs an explicit compressed mesh view, not another .drc format');
  const bytes = readFileSync(fixture.path);
  const doc = JSON.parse(readFileSync('packages/decoders/tests/fixtures/Avocado.gltf', 'utf8'));
  const ext = doc.meshes[0].primitives[0].extensions.KHR_draco_mesh_compression;
  const view = doc.bufferViews[ext.bufferView];
  const buffer = readFileSync('packages/decoders/tests/fixtures/Avocado.bin');
  assert.deepEqual(bytes, buffer.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
  assert.equal(bytes.length, 8722);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    '21dfb8f305c178834bc4d860388bfffe6bc26fc66847a476306e4127c38179f5',
  );
  assert.deepEqual(ext.attributes, { TEXCOORD_0: 0, NORMAL: 1, TANGENT: 2, POSITION: 3 });
});

test('the meshopt SIMD README serves a whole outside ATTRIBUTES view and matches the independent oracle', async () => {
  const fixture = readmeFixture('/meshopt.bin');
  assert.ok(fixture, 'Meshopt needs its own compressed bufferView, not a generic .bin');
  const bytes = readFileSync(fixture.path);
  const doc = JSON.parse(readFileSync('examples/assets/khronos/MeshoptCubeTest/MeshoptCubeTest.gltf', 'utf8'));
  const ext = doc.bufferViews[25].extensions.KHR_meshopt_compression;
  const buffer = readFileSync('examples/assets/khronos/MeshoptCubeTest/MeshoptCubeTest.bin');
  assert.deepEqual(bytes, buffer.subarray(ext.byteOffset, ext.byteOffset + ext.byteLength));
  assert.deepEqual([ext.count, ext.byteStride, ext.mode, ext.filter ?? 'NONE'], [24, 12, 'ATTRIBUTES', 'NONE']);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'a68a0aff67b80b4b3d554dfcb25c3672b88dd405fac553f467a41219663ad64e',
  );
  await MeshoptSIMDDecoder.ready;
  const decoded = meshoptDecodeGltfBufferSIMD(bytes, ext.count, ext.byteStride, ext.mode, ext.filter);
  const oracle = JSON.parse(readFileSync('packages/decoders/tests/fixtures/meshopt-views.json', 'utf8'))
    .gltfs.find(({ path }) => path.includes('MeshoptCubeTest'))
    .views.find(({ bufferView }) => bufferView === 25);
  assert.equal(decoded.length, 288);
  assert.equal(createHash('sha256').update(decoded).digest('hex'), oracle.result.sha256);
});

test('splat README aliases keep the real 8385-point capture excerpt in each documented format', async () => {
  const examples = [
    ['/capture.splat', 'ec80ad829ffc324798c6bd7680ce53d2dd28819639b593e1393e39b83a8b1e25', parseSplat],
    ['/capture.ply', 'a0f8332242dd99f6b8a8c8aff6df829bafef0eb0e557d4e531ffc031906cd9a6', parsePly],
    ['/capture.spz', '872d127cee8f9040dc7b41bd832c7caa9b1a7cec09c0e1010e03f62722eb2cee', parseSpz],
    ['/capture.sog', 'f728da7afc311db69dd0d5876cdc5264ed230b0fc66aef486366673e46052553', parseSog],
  ];
  const decoded = [];
  for (const [url, hash, parse] of examples) {
    const fixture = readmeFixture(url);
    assert.ok(fixture, `${url} needs its explicit capture input`);
    const bytes = readFileSync(fixture.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash, url);
    const data = await parse(bytes);
    assert.equal(validateSplats(data), 8385, url);
    decoded.push(data);
  }
  // .splat was serialized here from the independent PlayCanvas PLY: every source position is preserved.
  assert.deepEqual(decoded[0].positions, decoded[1].positions);
  assert.equal(decoded[0].sphericalHarmonics, undefined, '.splat stores base colour only');
});

test('the static USDZ introduction resolves the complete outside Blender box with its archived texture', async () => {
  const fixture = readmeFixture('/model.usdz');
  assert.ok(fixture, 'The USDZ introduction needs its explicit outside static sample');
  const bytes = readFileSync(fixture.path);
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'b63a1ec0d388b5ffe22fc65812ad0e91a28eefb5c4d552fe86417685d356a6ab',
  );
  const asset = await parseUSDZ(bytes);
  assert.equal(asset.meshes.length, 1);
  assert.equal(asset.meshes[0].positions.length, 108);
  assert.equal(asset.meshes[0].indices.length, 36);
  assert.equal(asset.meshes[0].uvs.length, 72);
  assert.deepEqual([...asset.entries.keys()], ['BoxTextured.glb.blender-5-1.usdc', 'textures/Image_0.png']);
  assert.deepEqual(asset.issues, []);
});

test('the IES README resolves the complete published photometric profile and its candela values', () => {
  assert.equal(README_FILES['/downlight.ies'], 'packages/gltf-pro/tests/fixtures/lights/LightProfile.ies');
  const fixture = readmeFixture('/downlight.ies');
  const text = readFileSync(fixture.path, 'utf8');
  assert.match(text, /^IES:LM-63-2019/);
  const profile = parseIES(text);
  assert.equal(profile.peak, 8500);
  assert.ok(profile.flux > 0);
});

test('explicit README formats never become another extension sample, HTML, or an LFS pointer', () => {
  const base = mkdtempSync(join(tmpdir(), 'readme-required-'));
  try {
    assert.throws(() => readmeFixture('/texture.ktx2', base), /Missing Required test fixture.*alpha-uastc-zstd\.ktx2/);
    const path = join(base, README_FILES['/texture.ktx2']);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'version https://git-lfs.github.com/spec/v1\n');
    assert.throws(() => readmeFixture('/texture.ktx2', base), /Git LFS pointer/);
    writeFileSync(path, 'real file');
    assert.equal(readmeFixture('/texture.ktx2', base).path, path);
    assert.equal(readmeFixture('/unmapped.ktx2', base), undefined);
    assert.throws(() => readmeFixture('/sims/smoke.vdb', base, base), /fetch-readme-assets/);
    assert.throws(
      () => readmeFixture('/model.usdz', base, base, base),
      /Missing Required test fixture.*BoxTextured.*fetch-skip-assets/,
    );
    assert.ok(README_DOWNLOADS['/sims/smoke.vdb'].endsWith('.vdb'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a selected FFmpeg executable is required and enters only the example child environment', () => {
  const folder = mkdtempSync(join(tmpdir(), 'readme-ffmpeg-')),
    file = join(folder, 'ffmpeg.exe');
  try {
    const env = { PATH: 'original', MARGO_README_FFMPEG: file };
    assert.throws(() => readmeNodeEnv(env), /fetch-readme-assets.*--ffmpeg/);
    writeFileSync(file, 'test executable');
    assert.equal(readmeNodeEnv(env).PATH, folder + delimiter + 'original');
    assert.equal(env.PATH, 'original');
    const ordinary = { PATH: 'normal' };
    assert.equal(readmeNodeEnv(ordinary), ordinary);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('byte ranges handle closed, open, suffix and unsatisfiable requests', () => {
  assert.deepEqual(sampleRange('bytes=2-4', 10), { start: 2, end: 4 });
  assert.deepEqual(sampleRange('bytes=2-', 10), { start: 2, end: 9 });
  assert.deepEqual(sampleRange('bytes=-3', 10), { start: 7, end: 9 });
  assert.deepEqual(sampleRange('bytes=-20', 10), { start: 0, end: 9 });
  assert.deepEqual(sampleRange('bytes=0-20', 10), { start: 0, end: 9 });
  assert.equal(sampleRange(undefined, 10), undefined);
  for (const value of ['bytes=-0', 'bytes=10-', 'bytes=4-2', 'bytes=0-1,4-5', 'bad', 'bytes=-'])
    assert.equal(sampleRange(value, 10), null);
  assert.equal(sampleRange('bytes=0-', 0), null);
});

test('OBJ materials, image companions, TMX tilesets and waveform pairs keep their relative paths', () => {
  const obj = new URL('https://readme.test/models/crate.obj');
  assert.equal(README_DOWNLOADS[new URL('doorman.mtl', obj).pathname], 'obj-mtl-doorman/doorman.mtl');
  assert.equal(README_DOWNLOADS[new URL('t_eye_d.png', obj).pathname], 'obj-mtl-doorman/t_eye_d.png');
  assert.equal(README_DOWNLOADS[new URL('objs.tsx', 'https://readme.test/map.tmx').pathname], 'tmx-objects/objs.tsx');
  assert.equal(README_DOWNLOADS['/scans/fullwave.wdp'], 'laz-format10/fullwave.wdp');
  assert.equal(README_DOWNLOADS['/scans/fullwave.laz'], 'laz-format10/fullwave.laz');
});

test('the README prebuilt font JSON and its relative PNG page are required tracked assets', () => {
  const json = readmeFixture('/fonts/source-sans.json');
  const png = readmeFixture(new URL('source-sans.png', 'http://readme.test/fonts/source-sans.json').pathname);
  assert.match(json.path, /source-sans\.json$/);
  assert.match(png.path, /source-sans\.png$/);
});

test('real HTTP byte-range reads return exactly the requested file bytes', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'readme-range-'));
  const file = join(folder, 'sample.bin');
  writeFileSync(file, Buffer.from([0, 1, 2, 3, 4, 5]));
  const server = createServer((request, response) => serveSample(request, response, file));
  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.address().port}/sample.bin`;
    const response = await fetch(url, { headers: { range: 'bytes=2-4' }, signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-4/6');
    assert.equal(response.headers.get('content-length'), '3');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([2, 3, 4]));
    const full = await fetch(url, { signal: AbortSignal.timeout(5000) });
    assert.equal(full.status, 200);
    assert.equal((await full.arrayBuffer()).byteLength, 6);
    const bad = await fetch(url, { headers: { range: 'bytes=6-' }, signal: AbortSignal.timeout(5000) });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get('content-range'), 'bytes */6');
    await bad.arrayBuffer();
    const head = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    assert.equal(head.headers.get('content-length'), '6');
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(folder, { recursive: true, force: true });
  }
});

test('material texture aliases preserve 2D and cube shape, and E57 resolves the complete room sample', () => {
  assert.equal(README_FILES['/textures/albedo.ktx2'], README_FILES['/texture.ktx2']);
  assert.equal(README_FILES['/textures/sky-cube.ktx2'], README_FILES['/sky.ktx2']);
  assert.equal(README_DOWNLOADS['/scans/plant-room.e57'], 'e57-room/room-scan-two-stations.e57');
});
