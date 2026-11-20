// GAP-FILM-TIME: a planar surface's normal scroll and the volumetric fog's wind drift started at film time T hold what a
// continuous run holds at T. Run A takes n + 1 frame updates; run B is fresh, replays n steps with `advanceTime` (what
// `seek` from @margoengine/cutscene/seek runs), then takes one update. Both clocks used to move inside the draw pass,
// which a seek does not run; the frame update moves them now, and a draw moves neither.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mockGPU, context, passes } from '../../../examples/package-benchmarks/proofs/gpu-recorder.js';
import { SceneTarget } from '../../shared/msaa.js';
import { Refractor } from '../dist/refractor.js';
import { Reflector } from '../dist/reflector.js';
import { VolumetricFog } from '../dist/volumetric.js';

const FPS = 60;
const run = (clock, n, live) => {
  for (let step = 0; step < n; step++) live ? clock.onPreUpdate(1 / FPS) : clock.advanceTime(1 / FPS);
};

for (const n of [1, 600, 54000])
  test(`planar scroll and fog wind replayed ${n} steps equal a continuous run`, () => {
    for (const make of [
      () => new Refractor({ normalScroll: [0.02, 0.01] }),
      () => new Reflector({ normalScroll: [0.03, -0.01] }),
      () => new VolumetricFog({ noise: 0.5, wind: [2, 0, -1] }),
    ]) {
      const a = make(),
        b = make();
      assert.equal(b.time, 0, `a fresh ${b.constructor.name} starts at 0`);
      run(a, n + 1, true);
      run(b, n, false);
      b.onPreUpdate(1 / FPS);
      assert.ok(Object.is(b.time, a.time), b.constructor.name);
      if (a instanceof VolumetricFog) assert.deepEqual(b['offset'], a['offset']);
    }
  });

test('a planar surface draw does not move its scroll clock (the draw used to move it, out of reach of a seek)', () => {
  const surface = new Refractor({ normalScroll: [0.02, 0.01] });
  // Attached enough to reach the draw, with nothing captured yet: the old pass moved the clock first, then returned.
  Object.assign(surface, { nodeValue: {}, engine: {} });
  surface['draw']({ delta: 0.5, device: {} });
  surface['draw']({ delta: 0.5, device: {} });
  assert.equal(surface.time, 0);
  surface.onPreUpdate(0.5);
  assert.equal(surface.time, 0.5);
  Object.assign(surface, { nodeValue: undefined, engine: undefined });
  surface.dispose();
  surface.advanceTime(1);
  assert.equal(surface.time, 0.5, 'a disposed surface does not move');
});

test('the fog wind moves in the frame update, not in the passes (they used to move it, out of reach of a seek)', () => {
  const gpu = mockGPU(),
    view = context(gpu, { samples: 1, format: 'rgba16float' }),
    engine = {
      gpu: gpu.device,
      plugins: new Map(),
      lighting: { direction: new Float32Array([0, 0.6, -0.8, 3]), radiance: new Float32Array([1, 0.9, 0.8, 0.1]) },
      sceneOf() {
        return this;
      },
      removePlugin() {},
    },
    fog = new VolumetricFog({ grid: [16, 12, 8], noise: 0.5, wind: [2, 0, -1] });
  gpu.record(() => {
    fog.setup(engine);
    const draw = passes(fog);
    for (let i = 0; i < 3; i++) {
      fog.onPreUpdate(0.25);
      // Two draws of each frame: neither moves the wind.
      for (let pass = 0; pass < 2; pass++) {
        view.begin(i * 2 + pass);
        const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
          target = new SceneTarget(
            gpu.device,
            gpu.device.createTexture({ size: [view.c.width, view.c.height], format: 'rgba16float', usage }),
            gpu.device.createTexture({ size: [view.c.width, view.c.height], format: 'depth32float', usage }),
            1,
          );
        target.begin(view.c);
        draw(view.c);
        target.dispose();
      }
    }
    fog.dispose();
  });
  assert.deepEqual(fog['offset'], [1.5, 0, -0.75]);
  assert.equal(fog.time, 0.75);
});
