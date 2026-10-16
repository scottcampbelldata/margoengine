import test from 'node:test';
import assert from 'node:assert/strict';
import { SSAO } from '../dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { viewMatrix } from '../../shared/view.js';
import { invertMatrixStable } from '../../math/src/mat4.ts';
import { wgsl } from '../../core/src/shaders.ts';

function recorded(shader = wgsl) {
  const gpu = mockGPU(),
    ssao = new SSAO();
  ssao.setup({ gpu: gpu.device, hasPlugin: () => false, removePlugin() {} });
  const run = passes(ssao),
    view = context(gpu, { samples: 1, shader });
  return {
    gpu,
    ssao,
    view,
    frame(i, camera = () => {}, bindings = [], draws = []) {
      return gpu.record(() => {
        view.begin(i);
        camera(view.camera);
        view.c.bindings.push(...bindings);
        view.c.draw = (o) => draws.push(o);
        run(view.c);
      });
    },
  };
}
const uniform = (log) => {
  const e = log.find((entry) => entry[0] === 'writeBuffer' && entry[3].length === 448),
    b = Buffer.from(e[3], 'hex');
  return new Float32Array(b.buffer, b.byteOffset, 56);
};

test("SSAO keeps the perspective sample projection and uses the camera's own orthographic one", () => {
  const s = recorded();
  // Perspective: core's projection from fov/near/far, unchanged.
  const p = uniform(s.frame(0)).slice(32, 48),
    c = s.view.camera,
    f = 1 / Math.tan((c.fov * Math.PI) / 360),
    expected = new Float32Array(16);
  expected[0] = (f * 720) / 1280;
  expected[5] = f;
  expected[10] = c.near / (c.far - c.near);
  expected[11] = -1;
  expected[14] = (c.far * c.near) / (c.far - c.near);
  assert.deepEqual([...p], [...expected]);
  // Orthographic like @margoengine/cameras: off-centre, near plane 3 units behind the eye (signed), reversed-Z.
  const l = -3,
    r = 5,
    t = 2,
    b = -2,
    n = -3,
    fa = 20,
    P = [
      2 / (r - l),
      0,
      0,
      0,
      0,
      2 / (t - b),
      0,
      0,
      0,
      0,
      1 / (fa - n),
      0,
      -(r + l) / (r - l),
      -(t + b) / (t - b),
      fa / (fa - n),
      1,
    ];
  const ortho = (camera) => {
    const v = viewMatrix(new Float64Array(16), camera);
    for (let col = 0; col < 4; col++)
      for (let row = 0; row < 4; row++)
        camera.matrix[col * 4 + row] =
          P[row] * v[col * 4] +
          P[4 + row] * v[col * 4 + 1] +
          P[8 + row] * v[col * 4 + 2] +
          P[12 + row] * v[col * 4 + 3];
  };
  const values = uniform(s.frame(1, ortho)),
    q = values.slice(32, 48);
  for (let i = 0; i < 16; i++) assert.ok(Math.abs(q[i] - P[i]) < 1e-5, `projection[${i}] ${q[i]} vs ${P[i]}`);
  // Consistent with the depth reconstruction: projection * view * inverse(camera) is the identity.
  const view = values.slice(16, 32),
    inverse = values.slice(0, 16),
    mul = (a, m) => {
      const o = new Float64Array(16);
      for (let col = 0; col < 4; col++)
        for (let row = 0; row < 4; row++)
          for (let k = 0; k < 4; k++) o[col * 4 + row] += a[k * 4 + row] * m[col * 4 + k];
      return o;
    };
  const identity = mul(mul(q, view), inverse);
  for (let i = 0; i < 16; i++)
    assert.ok(Math.abs(identity[i] - (i % 5 === 0 ? 1 : 0)) < 1e-4, `P*V*M^-1 [${i}] = ${identity[i]}`);
  assert.ok(invertMatrixStable(s.view.camera.matrix, new Float64Array(16)), 'test matrix invertible');
  s.ssao.dispose();
});

test('SSAO occludes the ambient light a plugin names margoAmbient (environment IBL), with every pass binding', () => {
  const taa = { binding: 18, resource: { buffer: {} } },
    ibl = { binding: 20, resource: {} },
    fog = { binding: 25, resource: { buffer: {} } };
  const replay = (shader, bindings) => {
    const s = recorded(shader),
      draws = [],
      log = s.frame(0, undefined, bindings, draws),
      modules = log.filter((e) => e[0] === 'module').map((e) => e[2].code);
    s.ssao.dispose();
    return { code: modules.find((code) => code.includes('struct Input')), draws };
  };
  // Without the marker: the constant ambient term, TAA's camera binding only (unchanged).
  const plain = replay(wgsl, [taa, ibl, fog]);
  assert.match(plain.code, /return vec4f\(i\.color\*\(1\.0-i\.material\.y\)\*frame\.radiance\.w,1\);\s*\}$/);
  assert.doesNotMatch(plain.code, /let direct=/);
  assert.deepEqual(
    plain.draws.map((d) => d.bindings.map((e) => e.binding)),
    [[18]],
  );
  // With it: the lit shader is kept whole (statically using every binding) and returns margoAmbient.
  const marked = wgsl.replace(/let linear=([^;]+);/, 'let margoAmbient=vec3f(0.5);let linear=$1+margoAmbient;'),
    lit = replay(marked, [taa, ibl, fog]);
  assert.match(
    lit.code,
    /let margoAmbient=vec3f\(0\.5\);let linear=[^;]+\+margoAmbient;\s*_=vec4f\(linear,1\);return vec4f\(margoAmbient,1\);\s*\}$/,
  );
  assert.match(lit.code, /let direct=/);
  assert.deepEqual(
    lit.draws.map((d) => d.bindings.map((e) => e.binding)),
    [[18, 20, 25]],
  );
});

test('SSAO retains frame upload arrays, updates radius and restores owned resources', () => {
  const h = optionalGPU(),
    effect = new SSAO(),
    writes = new Map(),
    upload = h.engine.gpu.queue.writeBuffer;
  h.engine.gpu.queue.writeBuffer = (buffer, offset, data) => {
    writes.set(buffer, data);
    upload(buffer, offset, data);
  };
  h.engine.use(effect);
  const frame = () => {
    h.context.color = h.originalColor;
    h.context.depth = h.originalDepth;
    h.context.format = 'bgra8unorm';
    h.context.bindings.length = 0;
    h.context.shader =
      'let direct=vec3f(1);let linear=direct*vec3f(1);\nlet mapped=linear/(1.0+linear); return vec4f(mapped,1);';
    h.engine.frameGraph.execute(h.context);
  };
  try {
    frame();
    const allocated = { ...h.counts },
      directions = h.resources.filter((resource) => resource.size === 16),
      data = directions.map((buffer) => writes.get(buffer));
    assert.equal(directions.length, 2);
    assert.deepEqual(
      data.map((value) => Array.from(value)),
      [
        [1, 0, 0.5, 0],
        [0, 1, 0.5, 0],
      ],
    );
    const F32 = globalThis.Float32Array;
    let arrayAllocations = 0;
    globalThis.Float32Array = new Proxy(F32, {
      construct(target, args) {
        arrayAllocations++;
        return Reflect.construct(target, args);
      },
    });
    try {
      for (let i = 0; i < 120; i++) frame();
    } finally {
      globalThis.Float32Array = F32;
    }
    assert.equal(arrayAllocations, 0, 'Steady SSAO frames allocated typed arrays');
    for (let i = 0; i < 2; i++) assert.equal(writes.get(directions[i]), data[i]);
    for (const key of ['buffers', 'textures', 'views', 'groups']) assert.equal(h.counts[key], allocated[key]);
    effect.options.radius = 2;
    frame();
    assert.deepEqual(
      data.map((value) => Array.from(value)),
      [
        [1, 0, 2, 0],
        [0, 1, 2, 0],
      ],
    );
    const depth = effect.depthTexture;
    h.context.width = 64;
    frame();
    assert.equal(effect.depthTexture.width, 64);
    assert.ok(depth.destroyed);
    effect.onDeviceRestored(h.engine);
    frame();
    const restored = h.resources.filter((resource) => !resource.destroyed && resource.size === 16);
    assert.deepEqual(
      restored.map((buffer) => Array.from(writes.get(buffer))),
      [
        [1, 0, 2, 0],
        [0, 1, 2, 0],
      ],
    );
  } finally {
    effect.dispose();
  }
  assert.ok(h.resources.every((resource) => resource.destroyed));
});
