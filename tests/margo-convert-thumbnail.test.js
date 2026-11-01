// margo-convert thumbnail on a fake GPU: real core, gltf-pro and headless code, no device. What it draws is proved by
// @margoengine/headless's real-GPU test; here, the command: files, views, inputs and every refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { joinGLB } from '@margoengine/exporters';
import { optimizeModel } from '../tools/margo-convert/pipeline/optimize.js';
import { PRESETS } from '../tools/margo-convert/pipeline/presets.js';
import { runThumbnail, thumbnail, VIEWS } from '../tools/margo-convert/pipeline/thumbnail.js';
import { record } from './support/fake-webgpu.mjs';

const FAKE = resolve(import.meta.dirname, 'support/fake-webgpu.mjs'),
  sharp = createRequire(import.meta.url)('sharp');

/** One triangle. @returns {{doc: any, bin: Uint8Array}} */
function triangle(extra = {}) {
  const bin = new Uint8Array(68),
    view = new DataView(bin.buffer);
  [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((v, i) => view.setFloat32(i * 4, v, true));
  [0, 1, 2].forEach((v, i) => view.setUint16(36 + i * 2, v, true));
  [0, 0, 1, 0, 0, 1].forEach((v, i) => view.setFloat32(44 + i * 4, v, true));
  return {
    bin,
    doc: {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 2 }, indices: 1 }] }],
      buffers: [{ byteLength: 68 }],
      bufferViews: [
        { buffer: 0, byteLength: 36 },
        { buffer: 0, byteOffset: 36, byteLength: 6 },
        { buffer: 0, byteOffset: 44, byteLength: 24 },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
        { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      ],
      ...extra,
    },
  };
}
const glb = ({ doc, bin }) => joinGLB({ json: doc, bin });
const folder = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'margo-thumb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const png = (file) => {
  const bytes = readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], file);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

test('a GLB becomes a PNG of the asked size, drawn, with everything released', async (t) => {
  const dir = folder(t),
    input = join(dir, 'tri.glb'),
    out = join(dir, 'deep', 'er', 'thumb.png');
  writeFileSync(input, glb(triangle()));
  const before = { ...record };
  assert.equal(await runThumbnail([input, '--out', out, '--size', '64', '--gpu', FAKE, '--quiet']), 0);
  assert.deepEqual(png(out), [64, 64]);
  assert.ok(record.draws > before.draws, 'the model drew');
  assert.equal(record.copies, before.copies + 1, 'one readback');
  assert.equal(record.deviceDestroyed, before.deviceDestroyed + 1, 'the device is released');
  assert.equal(navigator.gpu, undefined, 'the globals are restored');
  assert.equal('GPUBufferUsage' in globalThis, false);
});

test('several views write one file each, named by view; one view writes --out itself', async (t) => {
  const dir = folder(t),
    input = join(dir, 'tri.glb');
  writeFileSync(input, glb(triangle()));
  const files = await thumbnail({ input, out: join(dir, 't.png'), size: 8, views: ['front', 'iso'], gpu: FAKE });
  assert.deepEqual(files, [join(dir, 't.front.png'), join(dir, 't.iso.png')]);
  for (const file of files) assert.deepEqual(png(file), [8, 8]);
  assert.equal(existsSync(join(dir, 't.png')), false);
  assert.equal(await runThumbnail([input, '--size', '8', '--gpu', FAKE, '--quiet']), 0);
  assert.deepEqual(png(join(dir, 'tri.thumb.png')), [8, 8], 'the default name sits beside the model');
});

test('a .gltf reads its external buffer beside it, and one outside the folder is refused', async (t) => {
  const dir = folder(t),
    model = triangle();
  model.doc.buffers[0].uri = 'tri%20data.bin';
  writeFileSync(join(dir, 'tri data.bin'), model.bin);
  writeFileSync(join(dir, 'tri.gltf'), JSON.stringify(model.doc));
  assert.deepEqual(await thumbnail({ input: join(dir, 'tri.gltf'), out: join(dir, 'a.png'), size: 4, gpu: FAKE }), [
    join(dir, 'a.png'),
  ]);
  model.doc.buffers[0].uri = '../outside.bin';
  writeFileSync(join(dir, 'bad.gltf'), JSON.stringify(model.doc));
  await assert.rejects(thumbnail({ input: join(dir, 'bad.gltf'), out: join(dir, 'b.png'), gpu: FAKE }), /outside/);
});

test('a model margo-convert optimize compressed with meshopt renders in Node', async (t) => {
  const dir = folder(t),
    input = join(dir, 'tri.glb'),
    { glb: optimized, compressedViews } = await optimizeModel(
      new Uint8Array(
        readFileSync(resolve(import.meta.dirname, '../examples/assets/khronos/OrientationTest/OrientationTest.glb')),
      ),
      PRESETS.web.model,
      {
        textures: { preset: PRESETS.web.texture, sharp: null },
      },
    );
  assert.ok(compressedViews > 0, 'meshopt views were written');
  writeFileSync(input, optimized);
  const before = record.draws;
  await thumbnail({ input, out: join(dir, 'm.png'), size: 4, gpu: FAKE, sharp });
  assert.ok(record.draws > before);
});

test('textures decode through sharp and upload as raw pixels; without sharp the error says so', async (t) => {
  const dir = folder(t),
    image = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#336699' } })
      .png()
      .toBuffer(),
    model = triangle({
      images: [{ uri: `data:image/png;base64,${image.toString('base64')}` }],
      textures: [{ source: 0 }],
      materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
    }),
    input = join(dir, 'tex.glb');
  model.doc.meshes[0].primitives[0].material = 0;
  writeFileSync(input, glb(model));
  const before = record.draws;
  await thumbnail({ input, out: join(dir, 't.png'), size: 4, gpu: FAKE, sharp });
  assert.ok(record.draws > before, 'the textured model drew');
  await assert.rejects(thumbnail({ input, out: join(dir, 'n.png'), gpu: FAKE, sharp: null }), {
    code: 'unsupported',
    message: /npm i sharp/,
  });
});

test('Draco and KTX2 fail with a coded error naming optimize, before any device', async (t) => {
  const dir = folder(t),
    adapters = record.adapters;
  for (const [name, used] of [
    ['draco', 'KHR_draco_mesh_compression'],
    ['ktx2', 'KHR_texture_basisu'],
  ]) {
    const input = join(dir, `${name}.glb`);
    writeFileSync(input, glb(triangle({ extensionsUsed: [used] })));
    await assert.rejects(thumbnail({ input, out: join(dir, 'x.png'), gpu: FAKE }), {
      name: 'MargoError',
      code: 'unsupported',
      message: /margo-convert optimize/,
    });
  }
  assert.equal(record.adapters, adapters);
  assert.equal(existsSync(join(dir, 'x.png')), false);
});

test('a missing binding says what to install; a module with no gpu says so too', async (t) => {
  const dir = folder(t),
    input = join(dir, 'tri.glb'),
    empty = join(dir, 'empty.mjs');
  writeFileSync(input, glb(triangle()));
  writeFileSync(empty, 'export const other = 1;\n');
  await assert.rejects(thumbnail({ input, out: join(dir, 'x.png'), gpu: 'margo-no-such-binding' }), {
    code: 'unsupported',
    message: /Install webgpu \(npm i webgpu\) or pass --gpu <module>/,
  });
  await assert.rejects(thumbnail({ input, out: join(dir, 'x.png'), gpu: empty }), { code: 'unsupported' });
});

test('the command rejects bad arguments with exit 1 and writes nothing', async (t) => {
  const dir = folder(t),
    input = join(dir, 'tri.glb'),
    out = join(dir, 'x.png'),
    { error } = console;
  writeFileSync(input, glb(triangle()));
  const messages = [];
  console.error = (m) => messages.push(m);
  t.after(() => (console.error = error));
  for (const args of [
    [],
    [join(dir, 'tri.obj')],
    [input, '--size', '0'],
    [input, '--size', '4097'],
    [input, '--size', '1.5'],
    [input, '--views', 'sideways'],
    [input, '--views', 'constructor'],
    [input, '--out', input],
    [input, '--unknown'],
  ])
    assert.equal(
      await runThumbnail([...args, ...(args[1] === '--out' ? [] : ['--out', out]), '--gpu', FAKE]),
      1,
      `${args}`,
    );
  assert.equal(messages.length, 9);
  assert.equal(existsSync(out), false);
  assert.ok(VIEWS.iso && VIEWS.front);
});
