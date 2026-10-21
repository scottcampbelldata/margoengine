import test from 'node:test';
import assert from 'node:assert/strict';
import { Splats } from '../dist/index.js';
import { Camera } from '../../core/dist/index.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const linear = (byte) => Math.fround(((byte / 255 + 0.055) / 1.055) ** 2.4);

test('Splats.setFog fades each splat colour toward the fog colour in the projection pass', () => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  h.engine.gpu.limits = {
    ...h.engine.gpu.limits,
    maxComputeInvocationsPerWorkgroup: 256,
    maxComputeWorkgroupSizeX: 256,
    maxStorageBuffersPerShaderStage: 8,
  };
  const splats = new Splats({
    positions: new Float32Array([0, 0, 0]),
    covariances: new Float32Array([0.1, 0, 0, 0.1, 0, 0.1]),
    colors: new Float32Array([1, 0, 0, 1]),
  });
  h.engine.use(splats);
  const camera = new Camera({ position: [0, 1, 4], target: [0, 0, 0] });
  camera.update(4 / 3, true);
  Object.assign(h.context.camera, { matrix: camera.matrix, position: camera.position, target: camera.target });
  const code = (p) => p.compute?.module.code ?? '',
    projections = () => h.pipelines.filter((p) => code(p).includes('evaluated[index]='));
  h.engine.frameGraph.execute(h.context);
  assert.equal(projections().length, 1);
  assert.doesNotMatch(code(projections()[0]), /margoFog|fogAmount/);
  const fog = { color: '#336699', near: 1, far: 20 };
  splats.setFog(fog);
  h.engine.frameGraph.execute(h.context);
  const fogged = projections()[1];
  assert.match(
    code(fogged),
    /evaluated\[index\]=vec4f\(mix\(color\(index\),margoFog\.color\.rgb,fogAmount\(world\.xyz\)\),world\.w\);/,
    'opacity (w) is untouched',
  );
  const group = h.groups.findLast((g) => g.entries.length === 9),
    buffer = group.entries[8].resource.buffer;
  assert.equal(group.entries[8].binding, 8);
  assert.deepEqual(
    [...new Float32Array(buffer.data)],
    [linear(0x33), linear(0x66), linear(0x99), 0, 1, 20, 0, 0, 0, 1, 4, 0],
    'linear: the render pass clamps and encodes it with the splat',
  );
  h.engine.frameGraph.execute(h.context);
  assert.equal(projections().length, 2, 'compiled once');
  splats.setFog(null);
  assert.equal(splats.fog, null);
  assert.throws(() => splats.setFog([1, 2, 3]), TypeError);
  assert.throws(() => splats.setFog({ near: Number.NaN }), RangeError);
  splats.dispose();
  assert.ok(buffer.destroyed);
});
