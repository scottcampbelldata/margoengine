// DepthTexture over the recording mock GPU: a depth32float texture and an r32float distance target from one pass, released
// on dispose. Pixels are checked on a real GPU by the visual check (demos/depth-texture.html).
import test from 'node:test';
import assert from 'node:assert/strict';
import { harness } from './support.js';
import { DepthTexture } from '../dist/depth.js';

test('DepthTexture is a depth and a distance target', async () => {
  const h = harness({ samples: 4 }),
    depth = DepthTexture.attach(h.engine);
  assert.equal(depth.texture, undefined);
  const log = h.gpu.record(() => h.frame());
  assert.equal(depth.texture.format, 'depth32float');
  assert.equal(depth.distance.format, 'r32float');
  const pipeline = log.find((e) => e[0] === 'renderPipeline' && e[2].fragment?.targets?.length === 1)[2];
  assert.deepEqual(
    pipeline.fragment.targets.map((t) => t.format),
    ['r32float'],
  );
  depth.dispose();
  await null;
  assert.deepEqual(
    h.live().filter((r) => r.format),
    [],
  );
});
