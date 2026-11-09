// Execute the original Node README setup and load, then inspect the actual full model and rendered pixels.
// Run after building packages, through scripts/gpu-lock.mjs. No browser, mocked GPU or replacement model.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { transformWithOxc } from 'vite';
import { fileURLToPath } from 'node:url';
import { readmeEntries } from '../../../scripts/support/readme-types.mjs';
import { requireExternalAssets } from '../../../scripts/support/external-test-assets.mjs';

requireExternalAssets('helmet/');
const folder = new URL('../test-results/node-gltf/', import.meta.url);
mkdirSync(folder, { recursive: true });
const entries = readmeEntries(readFileSync(new URL('../README.md', import.meta.url), 'utf8'));
const examples = entries.filter(({ code }) => code.includes('ktx2: nodeKTX2'));
assert.equal(examples.length, 1, 'the original loadGLTF integration example must exist');
const before = `
import assert from 'node:assert/strict';
import {Camera} from 'margoengine/core';
import {readPixels} from 'margoengine/headless';
import {createHash} from 'node:crypto';
assert.equal(typeof document, 'undefined');
assert.equal(typeof Worker, 'undefined');
const requests = [], decoded = [], errors = [];
const request = globalThis.fetch;
globalThis.fetch = async (...args) => { requests.push(String(args[0])); return request(...args); };
const transcode = nodeKTX2.transcode;
nodeKTX2.transcode = async (...args) => {
  const bytes = args[0], header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = header.getUint32(20, true), height = header.getUint32(24, true), levels = header.getUint32(40, true);
  const result = await transcode(...args);
  assert.equal(result.target, 'rgba8');
  assert.equal(result.width, width);
  assert.equal(result.height, height);
  assert.equal(result.mipmaps.length, levels);
  for (const [level, mip] of result.mipmaps.entries()) {
    assert.equal(mip.width, Math.max(1, width >> level));
    assert.equal(mip.height, Math.max(1, height >> level));
    assert.equal(mip.data.length, mip.width * mip.height * 4);
  }
  decoded.push({width: result.width, height: result.height, levels: result.mipmaps.length,
    bytes: result.mipmaps.reduce((sum, mip) => sum + mip.data.length, 0)});
  return result;
};
const createEngine = Engine.create;
Engine.create = async (...args) => {
  const engine = await createEngine.apply(Engine, args);
  engine.gpu.addEventListener('uncapturederror', event => errors.push(event.error.message));
  engine.gpu.pushErrorScope('validation');
  return engine;
};
`;
const after = `
assert.equal(requests.length, 17);
assert.equal(new Set(requests).size, 17);
assert.equal(decoded.length, 15);
assert.equal(model.primitives.length, 6);
assert.deepEqual(decoded.map(image => image.width).sort((a, b) => a - b), [...Array(3).fill(1024), ...Array(12).fill(2048)]);
const vertices = model.primitives.reduce((sum, p) => sum + p.vertices.length / 20, 0);
const indices = model.primitives.reduce((sum, p) => sum + p.indices.length, 0);
assert.equal(vertices, 55392);
assert.equal(indices, 284166);
engine.render({camera: new Camera({position: [0, 0.25, 1.5], target: [0, 0.25, 0]})});
await engine.gpu.queue.onSubmittedWorkDone();
const pixels = await readPixels(engine);
let drawn = 0;
for (let i = 0; i < pixels.data.length; i += 4)
  if (pixels.data[i] !== pixels.data[0] || pixels.data[i + 1] !== pixels.data[1] || pixels.data[i + 2] !== pixels.data[2]) drawn++;
assert.ok(drawn > 0, 'the complete textured model must draw visible pixels');
assert.equal(await engine.gpu.popErrorScope(), null);
assert.deepEqual(errors, []);
console.log(JSON.stringify({requests: requests.length, textures: decoded.length,
  mipLevels: decoded.reduce((sum, image) => sum + image.levels, 0),
  decodedBytes: decoded.reduce((sum, image) => sum + image.bytes, 0), primitives: model.primitives.length,
  vertices, indices, drawn, width: pixels.width, height: pixels.height,
  pixelSha256: createHash('sha256').update(pixels.data).digest('hex'), validationErrors: errors}));
`;
const source = before + examples[0].code + after;
const file = new URL('example.mjs', folder);
writeFileSync(file, (await transformWithOxc(source, 'example.ts')).code);
const child = spawnSync(
  process.execPath,
  [
    '--unhandled-rejections=strict',
    '--import',
    new URL('../../../scripts/support/readme-node-assets.mjs', import.meta.url).href,
    fileURLToPath(file),
  ],
  { encoding: 'utf8', timeout: 120_000 },
);
assert.ifError(child.error);
assert.equal(child.status, 0, child.stderr + child.stdout);
const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1));
writeFileSync(new URL('result.json', folder), JSON.stringify(result, null, 2) + '\n');
console.log('Node Basis glTF README GPU check: ' + JSON.stringify(result));
