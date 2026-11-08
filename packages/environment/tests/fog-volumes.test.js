// FogVolumes (`@margoengine/environment/fog-volumes`) on the recording mock GPU: validation, the buffer layout the shader
// reads, VolumetricFog's composition (the medium's WGSL and bind group after lights and shadows) and an unchanged froxel
// shader without volumes. Real-GPU checks against a CPU mirror: tests/fog-volumes-browser.js (npm run test:fog-volumes:browser).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Camera } from '../../core/dist/extension.js';
import { SceneTarget } from '../../shared/msaa.js';
import { VolumetricFog } from '../dist/volumetric.js';
import { FogVolumes, MAX_FOG_VOLUMES } from '../dist/fog-volumes.js';

const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
function rig(options = {}) {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 1, format: 'rgba16float', shader: 'lit shader' }),
    size = [view.state.width, view.state.height];
  const engine = {
    gpu: gpu.device,
    plugins: new Map(),
    lighting: { direction: new Float32Array([0, 0.6, -0.8, 3]), radiance: new Float32Array([1, 0.9, 0.8, 0.1]) },
    removePlugin() {},
  };
  const target = new SceneTarget(
    gpu.device,
    gpu.device.createTexture({ size, format: 'rgba16float', usage }),
    gpu.device.createTexture({ size, format: 'depth24plus-stencil8', usage }),
    1,
  );
  const fog = new VolumetricFog(options);
  engine.plugins.set(fog.name, fog);
  fog.setup(engine);
  const run = passes(fog);
  const frame = (i) => {
    view.begin(i);
    target.begin(view.c);
    const camera = new Camera({ position: [0, 2, 0], target: [0, 2, -10], near: 0.1, far: 500 });
    camera.update(16 / 9, true);
    view.c.camera = camera;
    run(view.c);
  };
  return { gpu, fog, frame, record: (work) => gpu.record(work) };
}
const injectCode = (log) => log.find((e) => e[0] === 'module' && /fn inject/.test(e[2].code))[2].code;
const box = { shape: 'box', min: [-1, 0, -2], max: [1, 2, 2] },
  sphere = { shape: 'sphere', center: [0, 1, -5], radius: 2 };

test('validation: shapes, ranges and the volume count', () => {
  for (const bad of [
    [{ ...box, min: [1, 0, 0], max: [1, 1, 1] }],
    [{ ...box, max: [1, 2] }],
    [{ ...sphere, radius: 0 }],
    [{ ...sphere, radius: Number.NaN }],
    [{ shape: 'cone', center: [0, 0, 0], radius: 1 }],
    [{ ...box, density: -1 }],
    [{ ...box, color: [1, 2, 0] }],
    [{ ...box, edge: -0.1 }],
    [{ ...box, noise: 1.5 }],
    [{ ...box, noiseScale: 0 }],
    [null],
    Array.from({ length: MAX_FOG_VOLUMES + 1 }, () => box),
  ])
    assert.throws(() => new FogVolumes(bad), RangeError);
  const volumes = new FogVolumes([box]);
  volumes.volumes.push({ ...sphere, density: Number.POSITIVE_INFINITY });
  assert.throws(() => volumes.pack(), RangeError, 'checked again every frame');
  assert.equal(new FogVolumes().pack().length, 16, 'no volumes: one empty entry');
  assert.throws(() => new VolumetricFog({ volumes: {} }), RangeError);
});

test('layout: 16 floats per volume, doubling capacity padded with zero density', () => {
  const volumes = new FogVolumes([
    { ...box, density: 0.5, color: [1, 0.5, 0.25], edge: 0.3, noise: 0.4, noiseScale: 4 },
    sphere,
    box,
  ]);
  const d = volumes.pack();
  assert.equal(d.length, 64);
  assert.deepEqual(
    [...d.subarray(0, 16)],
    [-1, 0, -2, 0, 1, 2, 2, Math.fround(0.3), 1, 0.5, 0.25, 0.5, Math.fround(0.4), 0.25, 0, 0],
  );
  assert.deepEqual([...d.subarray(16, 32)], [0, 1, -5, 1, 2, 0, 0, 0, 1, 1, 1, Math.fround(0.1), 0, 0.5, 0, 0]);
  assert.ok(
    d.subarray(48).every((v) => v === 0),
    'padding has zero density',
  );
});

test('VolumetricFog adds the medium after lights and shadows; without volumes its froxel shader is unchanged', () => {
  // SHA-256 of the froxel (inject + integrate) shader with no lights, shadows or volumes at 2a161fdce, before volumes.
  const plain = rig(),
    base = injectCode(plain.record(() => plain.frame(0)));
  assert.equal(
    createHash('sha256').update(base).digest('hex'),
    'b68de0e316cec876773e0cf7d44c18f2b05cd57d478dfb0c2144a9d4dded074e',
  );
  assert.doesNotMatch(base, /fogMedium/);

  const volumes = new FogVolumes([box]),
    shadows = {
      pbr: (g) => ({ declarations: `// shadows group ${g}` }),
      bindings: () => [{ binding: 1, resource: {} }],
    };
  const { frame, record } = rig({ density: 0, volumes, shadows });
  const log = record(() => {
    frame(0);
    frame(1);
  });
  const code = injectCode(log);
  assert.match(code, /shadows group 1/);
  assert.match(code, /@group\(2\) @binding\(0\) var<storage,read> fogVolumes/);
  assert.match(
    code,
    /let local=fogMedium\(p\);var value=vec4f\(\(sigma\*volume\.scatter\.rgb\+local\.rgb\)\*light,sigma\+local\.a\);/,
  );
  const groups = log.filter((e) => e[0] === 'pass.setBindGroup').map((e) => e[1]);
  assert.deepEqual(groups, [0, 1, 2, 0, 0, 0, 1, 2, 0, 0], 'per frame: inject 0-2, integrate 0, composite 0');
  const uploads = log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 64 * 2);
  assert.equal(uploads.length, 2, 'the volumes upload every frame');
  // More volumes than the buffer holds: a bigger buffer and a new bind group; the old buffer is destroyed.
  volumes.volumes.push(sphere, sphere);
  const grown = record(() => frame(2));
  assert.ok(grown.some((e) => e[0] === 'writeBuffer' && e[3].length === 256 * 2));
  assert.ok(grown.some((e) => e[0] === 'destroy'));
  volumes.dispose();
  assert.throws(() => frame(3), RangeError);
  using _scoped = new FogVolumes();
});
