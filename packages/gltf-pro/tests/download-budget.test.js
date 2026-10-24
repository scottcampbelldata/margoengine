import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGLTFAsync, loadGLTF } from '../dist/index.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

// The root file counts toward maxDownloadBytes together with its resources: a 1128-byte GLB plus a 70-byte PNG.
// Only fetch, createImageBitmap and the GPU are stubbed.
const externalGLB = Buffer.from(
  'Z2xURgIAAABoBAAApAMAAEpTT057ImFzc2V0Ijp7InZlcnNpb24iOiIyLjAiLCJnZW5lcmF0b3IiOiJFMDMgaXNvbGF0ZWQgcmVncmVzc2lvbiBmaXh0dXJlIn0sInNjZW5lcyI6W3sibm9kZXMiOlswXX1dLCJzY2VuZSI6MCwibm9kZXMiOlt7Im5hbWUiOiJ0ZXh0dXJlZC10cmlhbmdsZSIsIm1lc2giOjB9XSwiYnVmZmVycyI6W3siYnl0ZUxlbmd0aCI6MTY4fV0sImJ1ZmZlclZpZXdzIjpbeyJidWZmZXIiOjAsImJ5dGVPZmZzZXQiOjAsImJ5dGVMZW5ndGgiOjM2fSx7ImJ1ZmZlciI6MCwiYnl0ZU9mZnNldCI6MzYsImJ5dGVMZW5ndGgiOjM2fSx7ImJ1ZmZlciI6MCwiYnl0ZU9mZnNldCI6NzIsImJ5dGVMZW5ndGgiOjI0fSx7ImJ1ZmZlciI6MCwiYnl0ZU9mZnNldCI6OTYsImJ5dGVMZW5ndGgiOjcwfV0sImFjY2Vzc29ycyI6W3siYnVmZmVyVmlldyI6MCwiY29tcG9uZW50VHlwZSI6NTEyNiwidHlwZSI6IlZFQzMiLCJjb3VudCI6MywibWluIjpbLTAuNSwtMC41LDBdLCJtYXgiOlswLjUsMC41LDBdfSx7ImJ1ZmZlclZpZXciOjEsImNvbXBvbmVudFR5cGUiOjUxMjYsInR5cGUiOiJWRUMzIiwiY291bnQiOjN9LHsiYnVmZmVyVmlldyI6MiwiY29tcG9uZW50VHlwZSI6NTEyNiwidHlwZSI6IlZFQzIiLCJjb3VudCI6M31dLCJtZXNoZXMiOlt7InByaW1pdGl2ZXMiOlt7ImF0dHJpYnV0ZXMiOnsiUE9TSVRJT04iOjAsIk5PUk1BTCI6MSwiVEVYQ09PUkRfMCI6Mn0sIm1hdGVyaWFsIjowfV19XSwibWF0ZXJpYWxzIjpbeyJwYnJNZXRhbGxpY1JvdWdobmVzcyI6eyJiYXNlQ29sb3JUZXh0dXJlIjp7ImluZGV4IjowfSwibWV0YWxsaWNGYWN0b3IiOjAsInJvdWdobmVzc0ZhY3RvciI6MX19XSwidGV4dHVyZXMiOlt7InNvdXJjZSI6MH1dLCJpbWFnZXMiOlt7InVyaSI6Imh0dHBzOi8vZml4dHVyZS5pbnZhbGlkL3BpeGVsLnBuZyIsIm1pbWVUeXBlIjoiaW1hZ2UvcG5nIn1dfagAAABCSU4AAAAAvwAAAL8AAAAAAAAAPwAAAL8AAAAAAAAAAAAAAD8AAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAAAAAAAAD8AAIA/iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJgggAA',
  'base64',
);
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);
const rootURL = 'https://fixture.invalid/asset.glb';
const imageURL = 'https://fixture.invalid/pixel.png';
const rootJSONLength = externalGLB.readUInt32LE(12);
const baseDocument = JSON.parse(new TextDecoder().decode(externalGLB.subarray(20, 20 + rootJSONLength)));
const binary = externalGLB.subarray(28 + rootJSONLength);
const budgetError = (error) => error.name === 'RangeError' && /maxDownloadBytes/.test(error.message);
const encoded = (value) => new TextEncoder().encode(value);
function jsonFixture() {
  const doc = structuredClone(baseDocument);
  doc.nodes[0].name = 'budget \u03bb\ud83d\ude00';
  const text = JSON.stringify(doc);
  return { doc, text, bytes: encoded(text) };
}
async function scene(run) {
  const h = optionalGPU(),
    device = h.engine.gpu;
  const saved = globalThis.createImageBitmap;
  const stats = { fetched: [], decoded: [], uploads: 0 };
  device.limits.maxTextureDimension2D = 8192;
  device.queue.copyExternalImageToTexture = () => stats.uploads++;
  const engine = new Engine(
    { width: 16, height: 16, clientWidth: 16, clientHeight: 16 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: device, add() {}, remove() {}, render() {}, dispose() {} },
  );
  globalThis.createImageBitmap = async (blob) => {
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), new Uint8Array(png));
    const bitmap = {
      width: 1,
      height: 1,
      closes: 0,
      close() {
        this.closes++;
      },
    };
    stats.decoded.push(bitmap);
    return bitmap;
  };
  const options = (maxDownloadBytes) => ({
    maxDownloadBytes,
    allowedURLs: ['https://fixture.invalid/'],
    fetch: async (target) => {
      const url = String(target);
      stats.fetched.push(url);
      if (url === rootURL) return new Response(externalGLB);
      if (url === imageURL) return new Response(png);
      throw new Error('Unexpected URL ' + url);
    },
  });
  try {
    return await run({ engine, stats, options });
  } finally {
    engine.dispose();
    h.cleanup();
    if (saved === undefined) delete globalThis.createImageBitmap;
    else globalThis.createImageBitmap = saved;
  }
}
async function rejectsWithoutPublication(engine, operation, stats) {
  await assert.rejects(async () => {
    const unexpected = await operation();
    unexpected.dispose(); // Also clean up an intentionally failing RED's unexpected success.
    return unexpected;
  }, budgetError);
  assert.equal(stats.decoded.length, 0, 'aggregate budget refusal precedes bitmap decoding');
  assert.equal(stats.uploads, 0, 'aggregate budget refusal precedes GPU upload');
  assert.equal(engine.meshes.size, 0, 'no partial model is published');
}
async function acceptsAndDisposes(engine, operation, stats) {
  const model = await operation();
  try {
    assert.equal(model.primitives.length, 1);
    assert.equal(stats.decoded.length, 1);
    assert.equal(stats.uploads, 1);
  } finally {
    model.dispose();
  }
  assert.equal(stats.decoded[0].closes, 1);
  assert.equal(engine.meshes.size, 0);
}

for (const limit of [1128, 1197])
  test(`serialized GLB root plus external PNG refuses aggregate limit ${limit}`, () =>
    scene(async ({ engine, stats, options }) => {
      assert.equal(externalGLB.byteLength, 1128);
      assert.equal(png.byteLength, 70);
      await rejectsWithoutPublication(engine, () => parseGLTFAsync(engine, externalGLB, options(limit)), stats);
    }));
test('serialized GLB accepts the exact 1198-byte aggregate and releases its image', () =>
  scene(async ({ engine, stats, options }) =>
    acceptsAndDisposes(engine, () => parseGLTFAsync(engine, externalGLB, options(1198)), stats),
  ));
for (const limit of [1128, 1197])
  test(`URL root already charges its encoded file and rejects limit ${limit}`, () =>
    scene(async ({ engine, stats, options }) =>
      rejectsWithoutPublication(engine, () => loadGLTF(engine, rootURL, options(limit)), stats),
    ));
test('URL root is not charged twice at the exact aggregate limit', () =>
  scene(async ({ engine, stats, options }) =>
    acceptsAndDisposes(engine, () => loadGLTF(engine, rootURL, options(1198)), stats),
  ));
test('a JSON string root counts its UTF-8 bytes', () =>
  scene(async ({ engine, stats, options }) => {
    const f = jsonFixture();
    assert.ok(f.bytes.byteLength > f.text.length);
    const load = (limit) => parseGLTFAsync(engine, f.text, { ...options(limit), buffers: [binary] });
    await rejectsWithoutPublication(engine, () => load(f.bytes.byteLength + 69), stats);
    await acceptsAndDisposes(engine, () => load(f.bytes.byteLength + 70), stats);
  }));
