import test from 'node:test';
import assert from 'node:assert/strict';
import { Clustered } from '../dist/index.js';
import { DirectionalLights, MAX_DIRECTIONAL_LIGHTS } from '../dist/directional.js';
import { AreaLights } from '../dist/area.js';
import { wgsl } from '../../core/src/shaders.ts';
import { clusterBrdf } from '../../shared/light-terms.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const packed = (d) => Array.from(d['data'].subarray(4, 4 + d.list.length * 8));

test('directional lights pack the unit vector toward the light and colour x intensity; bad input changes nothing', () => {
  const d = new DirectionalLights({ lights: { setLights() {} } });
  d.setLights([{ direction: [0, -2, 0], color: [1, 0.5, 0.25], intensity: 4 }, { direction: [3, 0, 4] }]);
  assert.deepEqual(packed(d), [-0, 1, -0, 0, 4, 2, 1, 0, -0.6000000238418579, -0, -0.800000011920929, 0, 1, 1, 1, 0]);
  assert.equal(d.list.length, 2);
  assert.ok(Object.isFrozen(d.list));
  const before = d['data'].slice();
  for (const bad of [
    { direction: [0, 0, 0] },
    { direction: [0, NaN, 1] },
    { direction: [0, -1, 0], intensity: -1 },
    { direction: [0, -1, 0], intensity: Infinity },
    { direction: [0, -1, 0], color: [1, 1] },
  ])
    assert.throws(() => d.setLights([{ direction: [0, -1, 0] }, bad]), /Directional light/);
  assert.throws(() => d.setLights(Array(MAX_DIRECTIONAL_LIGHTS + 1).fill({ direction: [0, -1, 0] })), RangeError);
  assert.deepEqual(d['data'], before);
  assert.throws(() => new DirectionalLights({}), TypeError);
});

test('directional lights add their loop, binding 141 and one buffer only while there are lights', () => {
  const h = optionalGPU(),
    lights = new Clustered({ grid: [2, 2, 2] });
  lights.setLights([{ position: [0, 2, 1], range: 6 }]);
  h.engine.use(lights);
  const frame = () => {
    h.context.shader = wgsl;
    h.context.bindings.length = 0;
    h.engine.frameGraph.execute(h.context);
    return { shader: h.context.shader, bindings: h.context.bindings.map((b) => b.binding) };
  };
  try {
    const plain = frame(),
      buffers = h.counts.buffers,
      pbr = lights.pbr(2).declarations;
    const sun = new DirectionalLights({ lights });
    h.engine.use(sun);
    assert.deepEqual(frame(), plain, 'attached without lights');
    assert.equal(h.counts.buffers, buffers);
    assert.equal(lights.directional, undefined);
    sun.setLights([{ direction: [0.3, -1, 0.2], intensity: 3 }]);
    const lit = frame();
    assert.match(lit.shader, /@binding\(141\) var<storage,read> clusterDirectional/);
    // The point loop's BRDF text twice: materials' Lambert and Phong swap both for their own.
    assert.equal(lit.shader.split('result+=' + clusterBrdf + '*nl*').length, 3);
    assert.deepEqual(lit.bindings, [...plain.bindings, 141]);
    assert.equal(h.counts.buffers, buffers + 1);
    assert.match(lights.pbr(2).declarations, /@group\(2\) @binding\(141\)/);
    const buffer = sun.bindings()[0].resource.buffer;
    assert.equal(new Uint32Array(buffer.data)[0], 1);
    // With area lights too, both hooks' bindings join the clustered entries.
    const area = new AreaLights({ lights });
    h.engine.use(area);
    area.setLights([{ position: [0, 2, 0], direction: [0, -1, 0], width: 1, height: 1 }]);
    assert.deepEqual(frame().bindings, [...plain.bindings, 17, 141]);
    area.dispose();
    sun.setLights([]);
    assert.deepEqual(frame(), plain, 'emptied');
    assert.equal(lights.pbr(2).declarations, pbr);
    sun.setLights([{ direction: [0, -1, 0] }]);
    frame();
    assert.equal(h.counts.buffers, buffers + 2, 'buffer kept (and the area lights buffer)');
    sun.onDeviceRestored(h.engine);
    assert.ok(buffer.destroyed);
    sun.dispose();
    assert.deepEqual(frame(), plain, 'disposed');
    assert.equal(lights.directional, undefined);
  } finally {
    lights.dispose();
  }
  assert.ok(h.resources.every((resource) => resource.destroyed));
});

test('Clustered.list is a frozen copy of the last setLights list', () => {
  const lights = new Clustered({ grid: [2, 2, 2] }),
    point = { position: [0, 2, 1], range: 6 },
    list = [point];
  assert.deepEqual(lights.list, []);
  lights.setLights(list);
  assert.ok(Object.isFrozen(lights.list));
  assert.notEqual(lights.list, list);
  assert.equal(lights.list[0], point);
  list.push({ position: [1, 1, 1], range: 2 });
  assert.equal(lights.list.length, 1);
  assert.throws(() => lights.setLights([{ position: [0, 0, 0], range: -1 }]), RangeError);
  assert.equal(lights.list[0], point, 'a rejected list leaves the last one');
});
