// VolumetricFog (`@margoengine/environment/volumetric`) on the recording mock GPU: its passes, uniform, depth sources,
// MSAA variants, light/shadow composition, fog conflicts and lifecycle. Real-GPU checks: examples/package-benchmarks/volumetric-gpu.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, passes, context } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Camera } from '../../core/dist/extension.js';
import { SceneTarget } from '../../shared/msaa.js';
import { VolumetricFog } from '../dist/volumetric.js';

const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
const floats = (hex) => {
  const b = Buffer.from(hex, 'hex');
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
};

function rig({ samples = 4, format = 'rgba16float', capture = true, plugins = [], options = {} } = {}) {
  const gpu = mockGPU(),
    view = context(gpu, { samples, format, shader: 'lit shader' }),
    size = [view.state.width, view.state.height];
  const engine = {
    gpu: gpu.device,
    plugins: new Map(plugins.map((p) => [p.name, p])),
    lighting: { direction: new Float32Array([0, 0.6, -0.8, 3]), radiance: new Float32Array([1, 0.9, 0.8, 0.1]) },
    removed: [],
    removePlugin(name) {
      this.removed.push(name);
      this.plugins.get(name)?.dispose();
      this.plugins.delete(name);
    },
  };
  const target = capture
    ? new SceneTarget(
        gpu.device,
        gpu.device.createTexture({ size, format, usage }),
        gpu.device.createTexture({ size, format: 'depth24plus-stencil8', usage }),
        samples,
      )
    : undefined;
  const fog = new VolumetricFog(options);
  engine.plugins.set(fog.name, fog);
  fog.setup(engine);
  const run = passes(fog);
  const frame = (i) => {
    view.begin(i);
    target?.begin(view.c);
    const camera = new Camera({ position: [0, 2, 0], target: [0, 2, -10], near: 0.1, far: 500 });
    camera.update(16 / 9, true);
    view.c.camera = camera;
    run(view.c);
  };
  return { gpu, view, engine, fog, frame, record: (work) => gpu.record(work) };
}
const uniformWrites = (log, fog) =>
  log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 304 * 2).map((e) => floats(e[3]));

test('one compute pass (inject, integrate) and one composite draw; the lit shader and its bindings are untouched', () => {
  for (const samples of [1, 4]) {
    const { fog, frame, record, view } = rig({ samples });
    const log = record(() => frame(0));
    const dispatches = log.filter((e) => e[0] === 'pass.dispatchWorkgroups').map((e) => e.slice(1, 4));
    assert.deepEqual(
      dispatches,
      [
        [40, 23, 16],
        [20, 12, undefined],
      ],
      'inject over 160x90x64 froxels in 4^3 groups, integrate per 8x8 column',
    );
    assert.equal(log.filter((e) => e[0] === 'beginComputePass').length, 1);
    assert.deepEqual(
      log.filter((e) => e[0] === 'pass.draw').map((e) => e[1]),
      [3],
    );
    const textures = log.filter((e) => e[0] === 'texture' && e[2].dimension === '3d');
    assert.equal(textures.length, 3);
    for (const t of textures) assert.deepEqual([t[2].size, t[2].format], [[160, 90, 64], 'rgba16float']);
    const composite = log.find((e) => e[0] === 'renderPipeline');
    assert.equal(composite[2].multisample.count, samples);
    assert.deepEqual(
      composite[2].fragment.targets[0].blend.color,
      { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      'premultiplied over: keeps a transparent canvas valid',
    );
    const code = log
      .filter((e) => e[0] === 'module')
      .map((e) => e[2].code)
      .join('\n');
    assert.equal(
      /texture_depth_multisampled_2d/.test(code) && /sample_index/.test(code),
      samples === 4,
      'per-sample composite only over multisampled depth',
    );
    assert.equal(view.c.shader, 'lit shader');
    assert.deepEqual(view.c.bindings, []);
    assert.ok(fog.texture);
    fog.dispose();
  }
});

test('uniform: near-plane distance plane, grid, shape, sun and ambient from engine lighting, temporal weight after the first frame', () => {
  const { fog, frame, record } = rig({
    options: { density: 0.05, heightFalloff: 0.2, height: 1, anisotropy: 0.3, range: 80 },
  });
  const [first, second] = uniformWrites(
    record(() => {
      frame(0);
      frame(1);
    }),
    fog,
  );
  // Camera at y=2 looking along -z, near 0.1: t = -z - 0.1.
  assert.deepEqual(
    [...first.subarray(32, 36)].map((v) => +v.toFixed(5)),
    [0, 0, -1, -0.1],
  );
  assert.deepEqual(
    [...first.subarray(40, 48)].map((v) => +v.toFixed(4)),
    [160, 90, 64, 0, 80, 0.05, 0.2, 1],
  );
  assert.equal(second[43].toFixed(2), '0.90', 'history weight once a previous frame exists');
  assert.deepEqual(
    [...second.subarray(36, 40)].map((v) => +v.toFixed(5)),
    [0, 0, -1, -0.1],
    'previous plane',
  );
  assert.deepEqual(
    [...first.subarray(52, 55)].map((v) => +v.toFixed(3)),
    [0, 0.6, -0.8],
  );
  assert.deepEqual(
    [...first.subarray(56, 59)].map((v) => +v.toFixed(3)),
    [3, 2.7, 2.4],
    'sun radiance x intensity',
  );
  assert.deepEqual(
    [...first.subarray(60, 63)].map((v) => +v.toFixed(3)),
    [0.1, 0.1, 0.1],
    'engine ambient as grey',
  );
  assert.equal(first[67], 1, 'HDR target: linear composite');
  assert.ok(
    first.subarray(68, 71).some((v) => v !== 0),
    'sub-froxel jitter',
  );
  const still = rig({ options: { temporal: 0 } }),
    [a, b] = uniformWrites(
      still.record(() => {
        still.frame(0);
        still.frame(1);
      }),
      still.fog,
    );
  assert.deepEqual([a[43], b[43], ...b.subarray(68, 71)], [0, 0, 0, 0, 0], 'temporal 0: no history, no jitter');
});

test("depth: the capture's, an explicit provider, or a clear error; display targets tone map the fog", () => {
  assert.throws(() => rig({ capture: false }).frame(0), /needs scene depth/);
  const { gpu } = rig({ capture: false }),
    depth = gpu.device.createTexture({ size: [1280, 720], format: 'depth32float', usage, sampleCount: 1 });
  const provided = rig({ capture: false, samples: 4, format: 'bgra8unorm', options: { depth: () => depth } });
  const log = provided.record(() => provided.frame(0));
  assert.equal(uniformWrites(log)[0][67], 0, 'display target');
  assert.equal(log.filter((e) => e[0] === 'pass.draw').length, 1);
  assert.match(
    log.find((e) => e[0] === 'module' && /fn fragment/.test(e[2].code))[2].code,
    /texture_depth_2d/,
    '1x depth on a 4x target: per pixel',
  );
  const none = rig({ capture: false, options: { depth: () => undefined } });
  assert.equal(
    none.record(() => none.frame(0)).filter((e) => e[0] === 'pass.draw').length,
    0,
    'no depth this frame: skipped',
  );
  const wrong = rig({
    capture: false,
    options: { depth: () => gpu.device.createTexture({ size: [64, 64], format: 'depth32float', usage }) },
  });
  assert.throws(() => wrong.frame(0), /matching the viewport/);
});

test('shadows and clustered lights compose through their declared WGSL and bindings (groups 1 and 2)', () => {
  const source = (declarations, entries) => ({
    pbr: (group) => ({ declarations: declarations(group) }),
    bindings: () => entries,
  });
  const lightEntries = [{ binding: 4, resource: {} }],
    shadowEntries = [{ binding: 1, resource: {} }];
  const lights = source((g) => `// clustered group ${g}\nfn clusterShadow(){}`, lightEntries),
    shadows = source((g) => `// shadows group ${g}`, shadowEntries);
  const { frame, record } = rig({ options: { lights, shadows } }),
    log = record(() => {
      frame(0);
      frame(1);
    });
  const code = log.find((e) => e[0] === 'module' && /fn inject/.test(e[2].code))[2].code;
  assert.match(code, /clustered group 1/);
  assert.match(code, /shadows group 2/);
  assert.match(code, /lit\+=0\.25\*sunShadow\(n\+d\*/);
  assert.match(code, /\*clusterShadow\(light,p,vec3f\(0\)\)/);
  const groups = log.filter((e) => e[0] === 'pass.setBindGroup').map((e) => e[1]);
  assert.deepEqual(groups, [0, 1, 2, 0, 0, 0, 1, 2, 0, 0], 'per frame: inject 0-2, integrate 0, composite 0');
  assert.equal(
    log.filter((e) => e[0] === 'group' && e[2].entries.length === 1).length,
    2,
    'light and shadow groups built once',
  );
  const shadowOnly = rig({ options: { shadows } }),
    only = shadowOnly.record(() => shadowOnly.frame(0));
  assert.match(only.find((e) => e[0] === 'module')[2].code, /shadows group 1/);
  const plain = rig(),
    base = plain.record(() => plain.frame(0)).find((e) => e[0] === 'module')[2].code;
  assert.doesNotMatch(base, /sunShadow|localLight/);
});

test("contract with clustered and shadows: the froxel light loop repeats clusterLighting's cell lookup and the cascade bias", async () => {
  const { Clustered } = await import('../../clustered/dist/index.js'),
    { Shadows } = await import('../../shadows/dist/index.js');
  const gpu = mockGPU(),
    lights = new Clustered({ grid: [4, 3, 2] });
  lights.setup({ gpu: gpu.device, removePlugin() {} });
  const clustered = lights.pbr(1).declarations,
    cascades = new Shadows().pbr(2).declarations;
  const { frame, record } = rig({
    options: {
      lights: { pbr: (g) => lights.pbr(g), bindings: () => [] },
      shadows: { pbr: () => ({ declarations: cascades }), bindings: () => [] },
    },
  });
  const code = record(() => frame(0)).find((e) => e[0] === 'module' && /fn inject/.test(e[2].code))[2].code,
    local = code.slice(code.indexOf('fn localLight('));
  for (const line of [
    'let grid=clusterFrame.grid.xyz;let depth=-(clusterFrame.view*vec4f(',
    'let screenPixel=pixel-clusterFrame.depth.zw*clusterFrame.screen.xy;',
    'let xy=min(vec2u(max(screenPixel,vec2f(0))/clusterFrame.screen.xy*vec2f(grid.xy)),grid.xy-vec2u(1));',
    'let z=min(u32(max(0.0,select(log(depth/near)/log(far/near),(depth-near)/(far-near),clusterFrame.intensity.w>0.5)*f32(grid.z))),grid.z-1);',
    'let cell=xy.x+grid.x*(xy.y+grid.y*z);let count=clusterCounts[cell];',
    'let light=clusterLights[clusterIndices[cell*1024u+j]];',
    'let falloff=pow(max(0.0,1-pow(distance/light.positionRange.w,4.0)),2.0)/max(distance*distance,0.01);',
    'var cone=1.0;if(light.params.y>0.5){cone=clamp((dot(-l,light.directionOuter.xyz)-light.directionOuter.w)/max(light.params.x-light.directionOuter.w,0.00001),0.0,1.0);cone*=cone*(3-2*cone);}',
    'return result*clusterFrame.intensity.x;',
  ]) {
    assert.ok(clustered.includes(line), `clustered no longer has: ${line}`);
    assert.ok(local.includes(line), `volumetric lost: ${line}`);
  }
  for (const text of [
    'struct ShadowFrame {matrices:array<mat4x4f,4>,view:mat4x4f,splits:vec4f,ranges:vec4f,settings:vec4f}',
    'var reference=projected.z-shadowFrame.settings.y;',
    'let depth=-(shadowFrame.view*vec4f(position,1)).z;',
    'let cascade=u32(depth>shadowFrame.splits.x)+u32(depth>shadowFrame.splits.y)+u32(depth>shadowFrame.splits.z);',
    '@group(2) @binding(3) var shadowSampler:sampler_comparison;',
  ])
    assert.ok(cascades.includes(text), `shadows no longer has: ${text}`);
  lights.dispose();
});

test('refuses to fog twice: environment Fog or sky fog switched on', () => {
  const fog = { name: 'fog', heightFalloff: 0, enabled: true },
    sky = { name: 'sky', options: { fog: { depth: () => undefined } } };
  assert.throws(() => rig({ plugins: [fog] }).frame(0), /replaces environment Fog 'fog'/);
  assert.doesNotThrow(() => rig({ plugins: [{ ...fog, enabled: false }] }).frame(0));
  assert.throws(() => rig({ plugins: [sky] }).frame(0), /replaces sky fog/);
  assert.throws(
    () => rig({ plugins: [{ name: 'post-processing', options: { atmosphere: { density: 0.1 } } }] }).frame(0),
    /replaces creative atmosphere fog/,
  );
  assert.doesNotThrow(() =>
    rig({
      plugins: [
        { name: 'sky', options: { fog: { depth: () => undefined, density: 0 } } },
        { name: 'sky2', options: {} },
      ],
    }).frame(0),
  );
});

test('validation, grid changes, device restore and dispose', () => {
  for (const bad of [
    { density: -1 },
    { anisotropy: 1 },
    { grid: [160, 90, 1] },
    { grid: [160.5, 90, 64] },
    { temporal: 0.99 },
    { color: [2, 0, 0] },
    { noise: 2 },
    { range: 0 },
    { depth: 1 },
    { lights: {} },
  ])
    assert.throws(() => new VolumetricFog(bad), RangeError, JSON.stringify(bad));
  const { fog, frame, record, engine } = rig();
  frame(0);
  fog.options.grid = [80, 45, 32];
  const log = record(() => frame(1));
  assert.deepEqual(
    log.filter((e) => e[0] === 'texture').map((e) => e[2].size),
    [
      [80, 45, 32],
      [80, 45, 32],
      [80, 45, 32],
    ],
  );
  assert.equal(log.filter((e) => e[0] === 'destroy').length, 3, 'old grid released');
  assert.equal(uniformWrites(log)[0][43], 0, 'history reset with the grid');
  fog.onDeviceRestored(engine);
  const restored = record(() => frame(2));
  assert.equal(restored.filter((e) => e[0] === 'computePipeline').length, 2);
  assert.equal(uniformWrites(restored)[0][43], 0);
  const released = record(() => fog.dispose());
  assert.equal(released.filter((e) => e[0] === 'destroy').length, 4, 'three volumes and the uniform');
  assert.deepEqual(engine.removed, ['volumetric-fog']);
  fog.dispose();
  assert.equal(record(() => frame(3)).length, 0, 'nothing after dispose');
  const scoped = rig();
  {
    using _ = scoped.fog;
  }
  assert.deepEqual(scoped.engine.removed, ['volumetric-fog']);
});
