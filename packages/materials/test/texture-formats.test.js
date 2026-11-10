import { speedEnabled } from '../../../scripts/support/speed-phase.mjs';
import { speedBudget } from '../../../scripts/speed/budgets.mjs';
// Texture sources beyond 8-bit 2D images: float, one- and two-channel data, 3D and array layouts, borrowed GPU
// textures, transcoded KTX2 files, Display P3 pixels and cube maps, recorded on a mock device (what is allocated and
// uploaded, and which views bind). scripts/mat-more-gpu-check.js samples them on a real adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpuTimer } from '../../../scripts/support/cpu-budget.mjs';
import { mockGPU } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { P3_TO_SRGB } from '../../math/dist/color.js';
import { pbrShader } from '../../gltf-pro/src/shader.ts';
import { toHalf, toHalfArray } from '../src/texture-kinds.ts';
import { CubeTexture, Material, Texture, WgslMaterial, loadKTX2Texture } from '../dist/index.js';

function device(features = []) {
  const gpu = mockGPU();
  gpu.device.features = new Set(features);
  gpu.device.limits.maxTextureDimension3D = 2048;
  gpu.device.createCommandEncoder = () => ({ ...gpu.encoder, finish: () => ({}) });
  return gpu;
}
const calls = (log, name) => log.filter((e) => e[0] === name);
const textures = (log) => calls(log, 'texture').map((e) => e[2]);
const hex = (values, Type) => Type.name + ':' + Buffer.from(new Type(values).buffer).toString('hex');

test('data textures validate their format, array type, size and dimension', () => {
  const data = (d) => ({ width: 2, height: 2, ...d });
  assert.throws(() => new Texture(data({ data: new Uint8Array(16), format: 'rgb8unorm' })), /format 'rgb8unorm'/);
  assert.throws(() => new Texture(data({ data: new Uint8Array(16), format: 'r32float' })), /must be a Float32Array/);
  assert.throws(() => new Texture(data({ data: new Float32Array(3), format: 'r32float' })), RangeError);
  assert.throws(() => new Texture(data({ data: new Float32Array(8), format: 'r32float', depth: 2 })), /dimension/);
  assert.throws(
    () =>
      new Texture(data({ data: new Float32Array(8), format: 'r32float', depth: 2 }), {
        dimension: '3d',
        mipmaps: true,
      }),
    /3D data/,
  );
  assert.throws(
    () => new Texture(data({ data: new Float32Array(4), format: 'r32float' }), { colorSpace: 'srgb' }),
    TypeError,
  );
  assert.throws(
    () => new Texture(data({ data: new Uint16Array(16), format: 'rgba16float' }), { colorSpace: 'display-p3' }),
    /display-p3/,
  );
  assert.throws(() => new Texture({ data: new Uint8Array(16), width: 2, height: 2 }, { dimension: 'cube' }), TypeError);
  const volume = new Texture(data({ data: new Float32Array(8), format: 'r32float', depth: 2 }), { dimension: '3d' });
  assert.deepEqual(
    [volume.width, volume.height, volume.depth, volume.dimension, volume.mipmaps],
    [2, 2, 2, '3d', false],
  );
  assert.throws(() => {
    volume.dimension = '2d';
  }, TypeError);
  assert.equal(new Texture({ data: new Uint8Array(4), width: 1, height: 1 }).mipmaps, true, 'raw RGBA8 unchanged');
});

test('half floats round to nearest even, keep subnormals and overflow to infinity', () => {
  assert.deepEqual(
    [1, 0.5, -2, 65504, 65520, 1e6, 2 ** -24, 2 ** -25, 0.1, -0].map(toHalf),
    [0x3c00, 0x3800, 0xc000, 0x7bff, 0x7c00, 0x7c00, 1, 0, 0x2e66, 0x8000],
  );
  assert.equal(toHalf(Number.NaN) & 0x7c00, 0x7c00);
});

test('bulk half conversion equals toHalf per value and is fast on large images (p-hdr-load, p-exr-load)', () => {
  // Regression: Float32Array data converted with Uint16Array.from(data, toHalf) took about 165 ms for one 800 x 800
  // RGBA image (most of the p-hdr-load and p-exr-load parity rows).
  const bits = new Uint32Array(1 << 20);
  let seed = 7;
  for (let i = 0; i < bits.length; i++) bits[i] = seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  const values = new Float32Array(bits.buffer),
    expected = Uint16Array.from(values, toHalf);
  for (const native of [true, false]) {
    assert.deepEqual(toHalfArray(values, native), expected, `native ${native}`);
    if (speedEnabled()) {
      const big = new Float32Array(4_194_304).map((_, i) => (i % 9973) * 0.37 - 900);
      toHalfArray(big, native);
      const cpu = cpuTimer();
      toHalfArray(big, native);
      const ms = cpu();
      speedBudget('materials-half', { ms, native });
    }
  }
});

test('float, one- and two-channel, 3D and array data allocate and upload as given', () => {
  const gpu = device(),
    half = new Texture({ data: new Float32Array([1, 0.5, -2, 65504]), width: 1, height: 1, format: 'rgba16float' }),
    volume = new Texture(
      { data: new Float32Array(8).map((_, i) => i), width: 2, height: 2, depth: 2, format: 'r32float' },
      { dimension: '3d' },
    ),
    layers = new Texture(
      { data: new Uint8Array(4 * 4 * 2), width: 2, height: 2, depth: 4, format: 'rg8unorm' },
      { dimension: '2d-array', mipmaps: true },
    );
  let log = gpu.record(() => half.bind(gpu.device, true));
  assert.deepEqual(textures(log)[0].format, 'rgba16float');
  assert.equal(calls(log, 'writeTexture')[0][2], hex([0x3c00, 0x3800, 0xc000, 0x7bff], Uint16Array), 'half bits');
  log = gpu.record(() => volume.bind(gpu.device, true));
  assert.deepEqual(textures(log)[0], {
    dimension: '3d',
    format: 'r32float',
    mipLevelCount: 1,
    size: [2, 2, 2],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const [write] = calls(log, 'writeTexture');
  assert.deepEqual(write[3], { bytesPerRow: 8, offset: 0, rowsPerImage: 2 });
  assert.deepEqual(write[4], [2, 2, 2]);
  assert.deepEqual(calls(log, 'view')[0][2], { dimension: '3d', format: 'r32float' });
  // A region of slice 1 uploads only that box, at the offset of its first texel.
  volume.update({ x: 1, y: 0, z: 1, width: 1, height: 2, depth: 1 });
  log = gpu.record(() => volume.bind(gpu.device, true));
  const [box] = calls(log, 'writeTexture');
  assert.deepEqual([box[1].origin, box[3].offset, box[4]], [[1, 0, 1], 20, [1, 2, 1]]);
  assert.throws(() => volume.update({ x: 0, y: 0, z: 2, width: 1, height: 1 }), RangeError);
  log = gpu.record(() => layers.bind(gpu.device, true));
  assert.deepEqual([textures(log)[0].size, textures(log)[0].mipLevelCount], [[2, 2, 4], 2]);
  assert.equal(calls(log, 'beginRenderPass').length, 4, 'one mip pass per layer');
  assert.equal(calls(log, 'view').at(-1)[2].dimension, '2d-array');
});

test('a borrowed GPUTexture or cube target binds as is and stays its owner', () => {
  const gpu = device(),
    own = gpu.device.createTexture({ size: [4, 4, 6], format: 'rgba16float', mipLevelCount: 3 }),
    cube = new Texture(own, { dimension: 'cube' }),
    target = { texture: own, view: own.createView({ dimension: 'cube' }) },
    borrowed = new Texture(target);
  assert.deepEqual([cube.dimension, cube.mipmaps, borrowed.dimension], ['cube', true, 'cube']);
  assert.throws(() => new Texture(own, { dimension: '3d' }), TypeError);
  assert.throws(() => new Texture(own, { colorSpace: 'srgb' }), /borrowed GPUTexture/);
  const log = gpu.record(() => cube.bind(gpu.device, true));
  assert.deepEqual(calls(log, 'view')[0][2], { dimension: 'cube', format: 'rgba16float' });
  assert.equal(borrowed.bind(gpu.device, true)[0], target.view);
  cube.dispose();
  borrowed.dispose();
  assert.ok(!own.destroyed, 'dispose leaves a borrowed texture alone');
});

test('a transcoded KTX2 file uploads every mip at block size and decodes sRGB per slot', async () => {
  const mip = (width, height) => ({ data: new Uint8Array(16), width, height }),
    result = {
      width: 4,
      height: 4,
      mipmaps: [mip(4, 4), mip(2, 2), mip(1, 1)],
      format: 'bc7-rgba-unorm-srgb',
      target: 'bc7',
      srgb: true,
    };
  assert.throws(() => new Texture({ ...result, format: 'bc1-rgba-unorm' }), TypeError);
  assert.throws(() => new Texture({ ...result, mipmaps: [mip(4, 4), mip(2, 1)] }), RangeError);
  const texture = new Texture(result);
  assert.throws(() => texture.bind(device().device, true), /texture-compression-bc/);
  const gpu = device(['texture-compression-bc']);
  let log = gpu.record(() => texture.bind(gpu.device, true));
  assert.deepEqual(textures(log)[0], {
    format: 'bc7-rgba-unorm',
    mipLevelCount: 3,
    size: [4, 4],
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    viewFormats: ['bc7-rgba-unorm-srgb'],
  });
  assert.deepEqual(
    calls(log, 'writeTexture').map((e) => [e[1].mipLevel, e[3].bytesPerRow, e[4]]),
    [
      [0, 16, [4, 4]],
      [1, 16, [4, 4]],
      [2, 16, [4, 4]],
    ],
  );
  assert.equal(calls(log, 'view')[0][2].format, 'bc7-rgba-unorm-srgb', 'a colour slot decodes sRGB');
  log = gpu.record(() => texture.bind(gpu.device, false));
  assert.equal(calls(log, 'view')[0][2].format, 'bc7-rgba-unorm', 'a data slot reads it linear');
  // loadKTX2Texture fetches the file and hands it to the decoder.
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array([0xab, 0x4b]));
  try {
    let seen;
    const loaded = await loadKTX2Texture('https://example.test/a.ktx2', {
      decoder: { transcode: async (bytes) => ((seen = bytes), result) },
    });
    assert.deepEqual([...seen], [0xab, 0x4b]);
    assert.equal(loaded.source, result);
    await assert.rejects(loadKTX2Texture('https://example.test/a.ktx2', {}), /needs a decoder/);
  } finally {
    globalThis.fetch = fetch;
  }
});

test('compat compressed KTX2 uploads each colour space directly and reuses both copies', () => {
  for (const first of [true, false]) {
    const gpu = device(['texture-compression-bc']);
    gpu.device.adapterInfo = { vendor: 'margo-webgl2' };
    const allocate = gpu.device.createTexture;
    gpu.device.createTexture = (descriptor) => {
      const result = allocate(descriptor),
        view = result.createView;
      result.createView = (options) => {
        assert.equal(options.format, result.format, 'compressed views must match the uploaded internal format');
        return view(options);
      };
      return result;
    };
    const source = {
      width: 4,
      height: 4,
      format: 'bc7-rgba-unorm',
      target: 'bc7',
      srgb: false,
      mipmaps: [{ width: 4, height: 4, data: new Uint8Array(16) }],
    };
    const texture = new Texture(source);
    const log = gpu.record(() => {
      texture.bind(gpu.device, first);
      texture.bind(gpu.device, !first);
      texture.bind(gpu.device, first);
    });
    assert.deepEqual(
      textures(log).map((t) => t.format),
      first ? ['bc7-rgba-unorm-srgb', 'bc7-rgba-unorm'] : ['bc7-rgba-unorm', 'bc7-rgba-unorm-srgb'],
    );
    assert.equal(calls(log, 'writeTexture').length, 2, 'one upload per colour space, not per draw');
    assert.ok(Number.isFinite(texture.steady(gpu.device)));
    texture.update();
    const refreshed = gpu.record(() => {
      texture.bind(gpu.device, false);
      texture.bind(gpu.device, true);
    });
    assert.equal(textures(refreshed).length, 2, 'both copies refresh after update');
    assert.equal(calls(refreshed, 'destroy').length, 2, 'both old copies are freed');
    assert.equal(
      calls(
        gpu.record(() => texture.dispose()),
        'destroy',
      ).length,
      2,
      'dispose frees both copies',
    );
  }
});

test('Display P3 pixels stage as sRGB and convert to rgba16float linear sRGB with math P3_TO_SRGB', () => {
  const gpu = device(),
    texture = new Texture(
      { data: new Uint8Array([255, 0, 0, 255]), width: 1, height: 1 },
      { colorSpace: 'display-p3' },
    ),
    log = gpu.record(() => texture.bind(gpu.device, true)),
    made = textures(log);
  assert.deepEqual(
    made.map((t) => [t.format, t.mipLevelCount]),
    [
      ['rgba8unorm-srgb', 1],
      ['rgba16float', 1],
    ],
  );
  const code = calls(log, 'module').find((e) => e[2].code.includes('mat3x3f('))[2].code,
    matrix = /mat3x3f\(([^)]*)\)/.exec(code)[1].split(',').map(Number),
    columns = [0, 3, 6, 1, 4, 7, 2, 5, 8].map((k) => P3_TO_SRGB[k]);
  matrix.forEach((v, i) => assert.ok(Math.abs(v - columns[i]) < 1e-8, 'matrix entry ' + i));
  assert.equal(calls(log, 'beginRenderPass').length, 1, 'one conversion pass');
  assert.equal(calls(log, 'view').at(-1)[2].format, 'rgba16float', 'the material reads the converted copy');
  // Linear P3 red in linear sRGB: red above 1, green and blue negative.
  const red = [P3_TO_SRGB[0], P3_TO_SRGB[3], P3_TO_SRGB[6]];
  assert.ok(red[0] > 1.2 && red[1] < 0 && red[2] < 0);
});

test('six faces and an equirect image make six-layer cube textures', () => {
  const gpu = device(),
    face = (v) => ({ data: new Uint8Array(16).fill(v), width: 2, height: 2 }),
    faces = new CubeTexture([1, 2, 3, 4, 5, 6].map(face), { mipmaps: false });
  assert.throws(() => new CubeTexture([face(1)]), /six/);
  assert.throws(
    () =>
      new CubeTexture([face(1), face(1), face(1), face(1), face(1), { data: new Uint8Array(64), width: 4, height: 4 }]),
    /same size/,
  );
  assert.equal(faces.dimension, 'cube');
  let log = gpu.record(() => faces.bind(gpu.device, true));
  assert.deepEqual([textures(log)[0].size, textures(log)[0].format], [[2, 2, 6], 'rgba8unorm-srgb']);
  assert.deepEqual(
    calls(log, 'writeTexture').map((e) => e[1].origin[2]),
    [0, 1, 2, 3, 4, 5],
  );
  assert.deepEqual(calls(log, 'view')[0][2], { dimension: 'cube', format: 'rgba8unorm-srgb' });
  const image = new Texture({ data: new Uint8Array(8 * 4 * 4), width: 8, height: 4 }, { mipmaps: false }),
    equirect = new CubeTexture(image);
  assert.throws(() => new CubeTexture(image, { colorSpace: 'linear' }), /source Texture/);
  log = gpu.record(() => equirect.bind(gpu.device, true));
  const cube = textures(log).find((t) => t.format === 'rgba16float');
  assert.deepEqual([cube.size, cube.mipLevelCount], [[16, 16, 6], 5]);
  assert.equal(calls(log, 'beginRenderPass').length, 6 + 6 * 4, 'six faces, then four mips per face');
  log = gpu.record(() => equirect.bind(gpu.device, true));
  assert.equal(calls(log, 'beginRenderPass').length, 0, 'drawn once');
  image.update();
  log = gpu.record(() => equirect.bind(gpu.device, true));
  assert.equal(calls(log, 'beginRenderPass').length, 30, 'redrawn after the source updates');
});

test('material map slots take 2D textures only, and 32-bit floats only with float32-filterable', () => {
  const volume = new Texture(
      { data: new Float32Array(8), width: 2, height: 2, depth: 2, format: 'r32float' },
      { dimension: '3d' },
    ),
    flat = new Texture({ data: new Float32Array(4), width: 1, height: 1, format: 'r32float' });
  assert.throws(() => new Material({ map: volume }).bindings(device().device), /needs a 2D Texture/);
  assert.throws(() => new Material({ map: flat }).bindings(device().device), /float32-filterable/);
  assert.equal(new Material({ map: flat }).bindings(device(['float32-filterable']).device).length, 10);
});

test('WgslMaterial declares each texture by its dimension and keeps it on swaps', () => {
  const volume = new Texture(
      { data: new Float32Array(8), width: 2, height: 2, depth: 2, format: 'r32float' },
      { dimension: '3d' },
    ),
    layers = new Texture(
      { data: new Uint8Array(32), width: 2, height: 2, depth: 2, format: 'rgba8unorm' },
      { dimension: '2d-array' },
    ),
    cube = new CubeTexture(Array.from({ length: 6 }, () => ({ width: 0, height: 0 }))),
    m = new WgslMaterial({
      wgsl: 'fn shade(i: Out, s: Surface) -> Surface {return s;}',
      textures: { volume, stack: layers, sky: cube },
    }),
    code = m.shader(pbrShader, 2);
  assert.ok(code.includes('var volume:texture_3d<f32>;'));
  assert.ok(code.includes('var stack:texture_2d_array<f32>;'));
  assert.ok(code.includes('var sky:texture_cube<f32>;'));
  assert.throws(() => {
    m.textures.volume = layers;
  }, /3d texture/);
  const gpu = device(),
    log = gpu.record(() => m.bindings(gpu.device)),
    views = calls(log, 'view').map((e) => e[2]?.dimension);
  assert.ok(views.includes('cube'), 'a cube whose faces are still loading binds a white cube');
});
