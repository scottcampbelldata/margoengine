import test from 'node:test';
import assert from 'node:assert/strict';
import { LensFlare, PostStack } from '../dist/index.js';
import { harness, modules, written } from './support.js';

const dispatches = (log) => log.filter((e) => e[0] === 'pass.dispatchWorkgroups').length;

for (const samples of [4, 1])
  test(`LensFlare follows the engine light by default, tests the stack depth and adds to the HDR frame (${samples}x)`, async () => {
    const h = harness({ samples }),
      flare = new LensFlare({ intensity: 0.5, occlusionRadius: 20 });
    const log = h.gpu.record(() => {
      h.engine.use(new PostStack([flare]));
      h.frame();
    });
    const v = written(log, 144),
      light = h.engine.lighting;
    // Camera matrix, eye and half the far distance, sun direction and strength (w times intensity), size, colour.
    assert.deepEqual([...v.subarray(20, 23)], [...light.direction.subarray(0, 3)]);
    assert.equal(v[23], light.direction[3] * 0.5);
    assert.equal(v[19], 250, 'half of the 500 far distance');
    assert.deepEqual([...v.subarray(24, 28)], [1280, 720, 20, 1]);
    assert.deepEqual([...v.subarray(28, 31)], [...light.radiance.subarray(0, 3)]);
    assert.equal(dispatches(log), 1, 'one occlusion dispatch');
    const occlusion = modules(log).find((c) => c.includes('var<storage,read_write> visible'));
    assert.match(occlusion, /textureLoad\(depth,q,0\)<=s\.depth/, 'nearer geometry hides the sun (reversed-Z)');
    const composite = modules(log).find((c) => c.includes('const GHOSTS'));
    assert.match(composite, /return vec4f\(toDisplay\(c\),s\.a\);/, 'last stage: display-encoded');
    // Strength 0 (a sun below the horizon) or disabled: no occlusion pass, the frame passes through.
    light.direction[3] = 0;
    assert.equal(dispatches(h.gpu.record(() => h.frame())), 0);
    light.direction[3] = 3;
    flare.enabled = false;
    assert.equal(dispatches(h.gpu.record(() => h.frame())), 0);
    h.engine.removePlugin('post:stack');
    await null;
    assert.deepEqual(h.live(), [], 'disposal releases every GPU resource');
  });

test('LensFlare takes the sun from a callback (sky.lights[0].direction) and validates', () => {
  const h = harness(),
    sun = new Float32Array([0, 1, -1, 2]),
    flare = new LensFlare({ sun: () => sun, color: [1, 0.5, 0.25] });
  h.engine.use(new PostStack([flare]));
  const v = written(
    h.gpu.record(() => h.frame()),
    144,
  );
  assert.deepEqual([...v.subarray(20, 24)], [0, 1, -1, Math.fround(2 * 0.1)]);
  assert.deepEqual([...v.subarray(28, 31)], [1, 0.5, 0.25]);
  sun.fill(0);
  assert.throws(() => h.frame(), { name: 'MargoError', code: 'state', message: /nonzero direction/ });
  for (const options of [{ intensity: -1 }, { intensity: 11 }, { occlusionRadius: 0 }, { color: [1, 1] }, { sun: 1 }])
    assert.throws(() => new LensFlare(options), RangeError);
  const alone = harness();
  assert.throws(() => alone.engine.use(new LensFlare()), { name: 'MargoError', code: 'state', message: /attach/ });
  const attached = LensFlare.attach(alone.engine);
  assert.ok(alone.engine.hasPlugin('post:stack') && alone.engine.hasPlugin('lens-flare'));
  attached.dispose();
  assert.ok(!alone.engine.hasPlugin('post:stack'));
});
