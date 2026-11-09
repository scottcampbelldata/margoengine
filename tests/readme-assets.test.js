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
  sampleRange,
  serveSample,
} from '../scripts/support/readme-assets.mjs';
import { parseIES } from '../packages/clustered/dist/ies.js';

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
