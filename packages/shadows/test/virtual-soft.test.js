import test from 'node:test';
import assert from 'node:assert/strict';
import { shadowSampling } from '../src/shader.ts';
import { VirtualShadows } from '../dist/virtual.js';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { Engine, TransformStore } from '../../core/dist/extension.js';
import { box } from '../../core/dist/index.js';

// Before: VirtualShadows' 'soft' filter kept 16 blocker reads and 32 comparison taps as WGSL constants and had no
// focus, while Shadows took all three as live options (samples, blockerSamples, focus). Both filters now come from one
// PCSS body in shader.ts and both entries check the options with one function.
const loops = (source) =>
  source
    .split('\n')
    .filter((line) => /searchTaps|u32\(taps\)|blockers==0|let blocker=|let taps=|return visibility\/taps/.test(line))
    .map((line) => line.replace(/let radius=clamp\(penumbra,[^)]*\)/, 'let radius=clamp(penumbra)'));

test('the virtual soft filter reads its tap counts and focus from the frame, through the same PCSS body as Shadows', () => {
  const source = new VirtualShadows().pbr(0).declarations;
  assert.ok(source.includes('soft:vec4f,nearest:array<vec4f,4>}'), 'the frame carries the soft vec4f');
  assert.ok(source.includes('let searchTaps=shadowFrame.soft.y;'));
  assert.ok(source.includes('let taps=shadowFrame.soft.x;'));
  assert.ok(
    source.includes('let penumbra=lightSize*abs((reference-blocker)*range-shadowFrame.soft.z);'),
    'the penumbra is sharpest where the blocker gap equals focus',
  );
  assert.doesNotMatch(source, /j<16u|j<32u|\/16\.0|\/32\.0/, 'no constant tap counts');
  assert.deepEqual(loops(source), loops(shadowSampling(0)), 'the same loops in both entries');
});

test('VirtualShadows writes samples, blockerSamples and focus to the frame uniform live, and rejects bad values', async () => {
  const gpu = mockGPU(),
    store = await TransformStore.create(4),
    engine = new Engine(
      { width: 128, height: 96, clientWidth: 128, clientHeight: 96 },
      store,
      { backend: 'webgpu', gpu: gpu.device, add() {}, remove() {}, render() {}, dispose() {} },
      { position: [0, 2, 6], target: [0, 0, 0] },
      null,
    ),
    view = context(gpu, { samples: 1, shader: 'let linear=direct*vec3f(1);' }),
    shadows = new VirtualShadows({ poolSize: 1024, levels: 4 });
  const soft = (i) => {
    store.tick(false);
    view.begin(i);
    const write = gpu
      .record(() => passes(shadows)(view.c))
      .find((e) => e[0] === 'writeBuffer' && e[3].length === 480 * 2);
    assert.ok(write, 'one 480-byte frame write (the soft vec4f before the nearest-depth copy at 480)');
    return [...new Float32Array(Uint8Array.from(Buffer.from(write[3], 'hex')).buffer).subarray(116, 119)];
  };
  try {
    shadows.setup(engine);
    shadows.add(engine.createMesh().setGeometry(box()));
    assert.deepEqual(soft(0), [32, 16, 0], 'defaults: 32 taps, 16 blocker reads, focus 0');
    Object.assign(shadows.options, { samples: 10, blockerSamples: 10, focus: 0.5 });
    assert.deepEqual(soft(1), [10, 10, 0.5]);
    for (const bad of [{ samples: 0 }, { samples: 129 }, { blockerSamples: 2.5 }, { samples: NaN }, { focus: -1 }, { focus: Infinity }]) {
      const before = { ...shadows.options };
      Object.assign(shadows.options, bad);
      assert.throws(() => soft(2), RangeError, JSON.stringify(bad));
      assert.throws(() => new VirtualShadows(bad), RangeError, JSON.stringify(bad));
      for (const key of Object.keys(shadows.options)) delete shadows.options[key];
      Object.assign(shadows.options, before);
    }
  } finally {
    shadows.dispose();
    engine.dispose();
  }
});
