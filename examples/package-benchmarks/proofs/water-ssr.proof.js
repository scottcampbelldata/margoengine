// Proof for water's SSR capture (`setCapture`, `draw(c, 'capture', ...)`, for @margoengine/post SSR's `ssr.add(water)`):
// with no capture hook set, Water makes exactly the GPU calls it made before the hook existed, over a story of resizes,
// canvas-format and sample-count changes, a terrain heightmap (coastal flow and spray), a sky reflection texture, a
// shadow source, light edits, a wave-height change, device restoration and disposal. Each frame runs onPreUpdate and
// then the passes, as the engine does, so the wave time (values[20]) is the same whichever of the two moves the clock.
// Run (after npm run build:packages): node examples/package-benchmarks/proofs/water-ssr.proof.js [ref] [pin] [--current]
// Pinned: 6c20076d (before the hook) against 49f3e971, the commit that made this claim. --current: caf466b4cc (the viewport row, the HDR sky transform, the horizon quad and the other public water work restored after the 2026-11-24 sync, on top of the far field); previously 1c1163117d (the far field's 288 B more of frame uniform and its WGSL, FG-05 and FG-06); previously f616fc9327 (above-water refraction depth, KB-WATER-REFRACTDEPTH1); previously 294127ec66 (every tanh of the surf's WGSL on a bounded argument, KB-WATER-SURGEVOL1); previously c82e6722a (HDR optics shader); previously 1de24300d9 (the wind-wave filtering and sky reflection shader changes); previously 1faee7666e (the coastal flow's first-step set-up in submissions of at most 2^18 workgroups, KB-SCENES-DUNE-ARCHANG1; 8e9572277b, the coast flow's momentum step and the surf's 40 s spin-up, KB-WATER-SWASH1; 8f03a1c435, the surf field's sweeps in a plain-word module of their own, KB-WATER-SURFCPU1, and the surf field's wavenumber from the tallest train, KB-WATER-SURFFIELD1; 7ca35c286f, the flood's foam, breaker and record pass, and breaker spray at any depth, disaster water push 7; 1aad5eb0b4, the flood's film clock, disaster water push 4; ab5edc5194, the glitter, foam softness and shallow band rows and their 560 B frame uniform, KB-PROOF-WATERSSR3; b4be8f6045, flow-driven wall jets in the spray shader, disaster water push 1; 47249ef410, the default sea of a 6 m/s wind; 58db723060, foam, glitter and body light from the wind, elements step 4; c5c012ed5d, the default
// beach surf, KB-WATER-SURF1; 7ffd4a64ca before it) against the working tree.
import assert from 'node:assert/strict';
import { refs, versions, current, golden, coreAt } from './compare.js';
import { mockGPU, context } from './gpu-recorder.js';

// The current stories include the wind-wave filtering and sky reflection shader changes.
const { ref, pin } = refs('6c20076d', '49f3e971', 'caf466b4cc');
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
      // The engine's frame order: each plugin's onPreUpdate, then the passes. Since 2026-11-16 Water's wave clock moves
      // in onPreUpdate (advanceTime), not in the draw pass; the commits pinned below have no onPreUpdate and move it there.
      water.onPreUpdate?.(view.c.delta);
      try {
        for (const p of passes) p.execute(view.c);
      } catch {
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
