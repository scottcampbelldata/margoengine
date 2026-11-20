import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  inverseCurvilinearCell,
  curvilinearVolume,
  CurvilinearVolume,
  CurvilinearSection,
} from '../dist/curvilinear.js';
import { VolumeLayer } from '../dist/index.js';
import { inlinedCopies } from '../../../scripts/support/wgsl-inline.mjs';
test('curvilinear entry exposes direct mapped volumes and owned coordinate sections', () => {
  assert.equal(typeof curvilinearVolume, 'function');
  assert.equal(typeof CurvilinearVolume.prototype.slice, 'function');
  assert.equal(typeof CurvilinearSection.prototype.dispose, 'function');
});
function point(x, y, z) {
  return [x + 0.3 * y * z, y + 0.2 * x * z, z + 0.15 * x * y];
}
const corners = Array.from({ length: 8 }, (_, k) => point(k & 1, (k >> 1) & 1, k >> 2)).flat();
test('inverse trilinear mapping recovers warped cell coordinates including corners and faces', () => {
  for (let i = 0; i <= 10; i++)
    for (let j = 0; j <= 10; j++)
      for (let k = 0; k <= 10; k++) {
        const q = [i / 10, j / 10, k / 10],
          p = point(...q),
          actual = inverseCurvilinearCell(corners, p);
        assert.ok(actual);
        actual.forEach((v, a) => assert.ok(Math.abs(v - q[a]) < 1e-8));
      }
});
test('inverse mapping rejects extrapolation and singular cells, with coded validation', () => {
  assert.equal(inverseCurvilinearCell(corners, [2, 2, 2]), null);
  assert.equal(inverseCurvilinearCell(new Float32Array(24), [0, 0, 0]), null);
  assert.throws(
    () => inverseCurvilinearCell([1], [0, 0, 0]),
    (e) => e instanceof RangeError && e.message.includes('https://margoengine.com/errors#sciviz'),
  );
});
test('inverse mapping is invariant to physical translation, scale and reversed orientation', () => {
  for (const scale of [1e-6, 1, 1e6]) {
    const c = corners.map((v, i) => v * scale * (i % 3 === 0 ? -1 : 1) + 3 * scale);
    const p = point(0.23, 0.47, 0.81).map((v, i) => v * scale * (i === 0 ? -1 : 1) + 3 * scale);
    const q = inverseCurvilinearCell(c, p);
    assert.ok(q);
    q.forEach((v, a) => assert.ok(Math.abs(v - [0.23, 0.47, 0.81][a]) < 1e-8));
  }
});
test('a mapped topology past the 2D texture limit is refused before the source layer or any GPU resource exists', () => {
  const calls = [];
  const device = new Proxy(
    { limits: { maxTextureDimension2D: 4, maxTextureDimension3D: 2048 } },
    {
      get: (target, key) => (key in target ? target[key] : (calls.push(String(key)), () => ({}))),
    },
  );
  const figure = { renderer: { device }, volume: () => (calls.push('volume'), { visible: true, colormap: {} }) };
  const n = 3,
    points = [];
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) points.push(x, y, z);
  assert.throws(
    () => new CurvilinearVolume(figure, { dims: [n, n, n], points }, new Float32Array(n ** 3)),
    /texture limit/,
  );
  assert.deepEqual(calls, []);
});

// KB-COMPAT-FXCTIME1: Direct3D's HLSL compiler, under ANGLE's WebGL2 on Windows, inlines every call and unrolls every
// loop it can count. The ray caster's inverse map (a 32-step bisection per axis, 24 Newton steps over 8 corners) was
// copied 21 times once unrolled, 310,068 characters of function body, and took 38 to 62 s to link cold. Its fixed
// loop bounds now add u.zero, a uniform that is always 0, and the gradient reads its six samples through one call.
test('the mapped volume shader has no loop a compiler can count and one sample call per gradient (KB-COMPAT-FXCTIME1)', () => {
  const codes = [],
    anything = () =>
      new Proxy(function () {}, {
        get: (_, key) => (key === 'then' ? undefined : anything()),
        apply: () => anything(),
      }),
    device = new Proxy(
      { limits: { maxTextureDimension2D: 8192, maxTextureDimension3D: 2048 } },
      {
        get: (target, key) =>
          key in target
            ? target[key]
            : key === 'queue'
              ? anything()
              : key === 'createShaderModule'
                ? (d) => (codes.push(d.code), anything())
                : () => anything(),
      },
    ),
    renderer = { device, pipeline: (_key, _context, build) => build({}), frameLayout: {}, depthLayout: {} },
    figure = { renderer, volume: () => ({ visible: true, colormap: {} }) },
    n = 3,
    points = [];
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) points.push(x, y, z);
  globalThis.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, VERTEX: 32 };
  globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  const volume = new CurvilinearVolume(figure, { dims: [n, n, n], points }, new Float32Array(n ** 3));
  volume.render(anything(), {}, renderer, {});
  const code = codes.find((c) => c.includes('fn inverseMap(')),
    { copies, size } = inlinedCopies(code, 'fragment'),
    { copies: gradient } = inlinedCopies(code, 'gradient');
  assert.equal(gradient.get('sample'), 1);
  // One corner read and three bisections per inverse map: no loop of theirs is unrolled.
  assert.equal(copies.get('nodePoint'), copies.get('inverseMap'));
  assert.equal(copies.get('interval'), 3 * copies.get('inverseMap'));
  assert.ok(copies.get('inverseMap') <= 6, `${copies.get('inverseMap')} inverse maps`);
  assert.ok(size < 50000, `${size} characters inlined`);
  assert.doesNotMatch(code, /for\(var \w+=0u;\w+<\d+u[;&]/);
});

// KB-COMPAT-FXCTIME1: the loop bounds add u.zero.x, so u.zero must read 0. The classification uniforms are eight
// floats (four, then the voxel spacing and a pad); written whole at float 40 they put the spacing in u.zero, and a grid
// in large units ran the Newton loop for as many steps as its spacing: DXGI_ERROR_DEVICE_HUNG on Direct3D 12.
test('the mapped volume uniform keeps u.zero at 0 whatever the grid spacing (KB-COMPAT-FXCTIME1)', () => {
  const writes = [],
    codes = [],
    anything = () =>
      new Proxy(function () {}, {
        get: (_, key) => (key === 'then' ? undefined : anything()),
        apply: () => anything(),
      }),
    queue = {
      writeBuffer: (_buffer, offset, data) => writes.push({ offset, data: Float32Array.from(data) }),
      writeTexture: () => {},
    },
    device = new Proxy(
      { limits: { maxTextureDimension2D: 8192, maxTextureDimension3D: 2048 }, queue },
      {
        get: (target, key) =>
          key in target
            ? target[key]
            : key === 'createShaderModule'
              ? (d) => (codes.push(d.code), anything())
              : () => anything(),
      },
    ),
    renderer = { device, pipeline: (_key, _context, build) => build({}), frameLayout: {}, depthLayout: {} },
    // The real classifier source, so its uniforms are the ones the volume packs.
    figure = { renderer, volume: (data, options) => new VolumeLayer(renderer, data, options) },
    n = 3;
  globalThis.GPUBufferUsage ??= { COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128, VERTEX: 32 };
  globalThis.GPUTextureUsage ??= { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, RENDER_ATTACHMENT: 16 };
  globalThis.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  for (const scale of [0.5, 10, 1e20]) {
    const points = [];
    for (let z = 0; z < n; z++)
      for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) points.push(x * scale, y * scale, z * scale);
    const volume = new CurvilinearVolume(
      figure,
      { dims: [n, n, n], points },
      Float32Array.from({ length: n ** 3 }, (_, i) => i),
    );
    writes.length = 0;
    volume.prepare();
    volume.render(anything(), {}, renderer, {});
    const uniform = writes.find((w) => w.offset === 0 && w.data.length >= 80);
    assert.ok(uniform, `scale ${scale}: the mapped uniform is written`);
    assert.deepEqual([...uniform.data.subarray(44, 48)], [0, 0, 0, 0], `scale ${scale}: u.zero`);
  }
  // u.zero is the sixth vec4 of the struct (after two mat4x4f and four vec4f): floats 44 to 47.
  const struct = codes.find((c) => c.includes('fn inverseMap(')).match(/struct Mapped \{([^}]*)\}/)[1],
    fields = struct.split(',').map((f) => f.trim().split(':'));
  let floats = 0;
  for (const [name, type] of fields) {
    if (name === 'zero') break;
    floats += type === 'mat4x4f' ? 16 : 4;
  }
  assert.equal(floats, 44);
  assert.match(
    codes.find((c) => c.includes('fn inverseMap(')),
    /fn Z\(\)->u32 \{return u32\(u\.zero\.x\);\}/,
  );
});
