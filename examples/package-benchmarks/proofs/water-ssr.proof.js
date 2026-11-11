// Proof for water's SSR capture (`setCapture`, `draw(c, 'capture', ...)`, for @margoengine/post SSR's `ssr.add(water)`):
// with no capture hook set, Water makes exactly the GPU calls it made before the hook existed, over a story of resizes,
// canvas-format and sample-count changes, a terrain heightmap (coastal flow and spray), a sky reflection texture, a
// shadow source, light edits, a wave-height change, device restoration and disposal.
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/water-ssr.proof.js [ref] [pin] [--current]
// Pinned: 6c20076d (before the hook) against 49f3e971, the commit that made this claim. --current: 268bfc625 against the
// working tree.
import assert from 'node:assert/strict';
import { refs, versions, current, golden, coreAt } from './compare.js';
import { mockGPU, context } from './gpu-recorder.js';

const { ref, pin } = refs('6c20076d', '49f3e971', 'da12bd07e');
await coreAt(pin); // water imports core's extension entry: in a pinned run, core as it was at the pin
const { baseline, candidate } = await versions('water', ref, undefined, pin);

function story(m, options) {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 4, format: 'rgba16float' }),
    depths = new Map(),
    sized = (key, make) => {
      const k = key + view.state.width + 'x' + view.state.height;
      if (!depths.has(k)) depths.set(k, make());
      return depths.get(k);
    },
    texture = (format, extra = {}) =>
      gpu.device.createTexture({
        size: [view.state.width, view.state.height],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        ...extra,
      });
  const engine = {
    gpu: gpu.device,
    lighting: { direction: new Float32Array([3, 5, 4, 3]), radiance: new Float32Array([1, 0.9, 0.8, 0.15]) },
    stats: { drawCalls: 0 },
    removePlugin() {},
    // Direct setup registers nothing, so like the real Engine it names no scene for the plugin.
    sceneOf() {
      return undefined;
    },
  };
  const heightmap = gpu.device.createTexture({
    size: [64, 64],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const sky = gpu.device.createTexture({
    size: [64, 32],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING,
  });
  const shadowEntries = [{ binding: 0, resource: { buffer: {} } }],
    shadows = {
      pbr: () => ({
        declarations:
          '@group(1) @binding(0) var<uniform> sv:vec4f;\nfn shadowVisibility(p:vec3f,n:vec3f)->f32 {return sv.x;}',
      }),
      bindings: () => shadowEntries,
    };
  return gpu.record(() => {
    const water = new m.Water({
      depth: () => sized('depth', () => texture(view.state.depthFormat)),
      ...(options.terrain
        ? { terrain: { heightmap: () => heightmap, origin: [-32, -32], size: [64, 64] }, spray: true }
        : {}),
      ...(options.reflection ? { reflection: () => sky, horizon: true } : {}),
      ...(options.shadows ? { shadows } : {}),
    });
    water.setup(engine);
    const passes = [];
    water.registerPasses({ add: (p) => passes.push(p) });
    for (let i = 0; i < 30; i++) {
      if (i === 5) {
        view.state.width = 640;
        view.state.height = 360;
      }
      if (i === 9) view.state.format = 'bgra8unorm';
      if (i === 12) view.state.samples = 1;
      if (i === 15) view.state.depthFormat = 'depth32float';
      if (i === 18) engine.lighting.direction[3] = 0.5;
      if (i === 20) water.setWaveHeight(0.6);
      if (i === 23) water.onDeviceRestored(engine);
      view.begin(i);
      try {
        for (const p of passes) p.execute(view.c);
      } catch (error) {
        gpu.note('throw');
      }
      view.end();
    }
    water.dispose();
  });
}
let calls = 0;
for (const options of [{}, { terrain: true }, { reflection: true, shadows: true }]) {
  const expected = await golden(JSON.stringify(options), () => story(baseline, options)),
    actual = story(candidate, options);
  assert.ok(expected.length > 300, 'story must exercise the GPU');
  assert.ok(
    !expected.some((e) => e[0] === 'throw'),
    `the story must render: ${JSON.stringify(expected.find((e) => e[0] === 'throw'))}`,
  );
  assert.deepEqual(actual, expected, `Water GPU calls differ (${JSON.stringify(options)})`);
  calls += expected.length;
}
assert.equal(typeof new candidate.Water().setCapture, 'function', 'candidate has the capture hook');
if (!current) assert.equal(new baseline.Water().setCapture, undefined, 'baseline does not');
console.log(
  `Water without a capture hook: GPU call sequences identical to ${ref}: ${calls} recorded calls in 3 stories.`,
);
