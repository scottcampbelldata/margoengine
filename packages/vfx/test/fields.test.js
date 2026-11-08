import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { fields } from '../dist/fields.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect };
};
const code = (h) => h.pipelines.map((p) => (p.compute ?? p.vertex).module.code).join('\n');
const field = (more = {}) => ({ size: [2, 2, 2], data: new Float32Array(24).fill(1), halfSize: [1, 1, 1], ...more });

test('attractors are written every frame (count, position, strength, radius) and the force joins the sum', () => {
  const attractors = [{ position: [1, 2, 3], strength: 4 }];
  const { h, effect } = attach({ capacity: 8, initialCount: 8, fields: { attractors } }, { fields });
  h.frame();
  const uniform = h.resources.find((r) => r.size === 48 + 16 * 32 && !r.destroyed);
  assert.ok(uniform, 'the fields uniform');
  const f = () => new Float32Array(uniform.data),
    u = () => new Uint32Array(uniform.data);
  assert.deepEqual([...u().subarray(0, 4)], [1, 0, 0, 0]);
  assert.deepEqual([...f().subarray(12, 17)], [1, 2, 3, 4, 0.5]);
  attractors.push({ position: [0, 0, 0], strength: -1, radius: 2 });
  attractors[0].strength = 5;
  h.frame();
  assert.equal(u()[0], 2);
  assert.deepEqual([...f().subarray(12, 25)], [1, 2, 3, 5, 0.5, 0, 0, 0, 0, 0, 0, -1, 2]);
  const shaders = code(h);
  assert.ok(shaders.includes('f.gravityDelta.xyz+curlNoise(p.positionLife.xyz)+fieldForce(p.positionLife.xyz)'));
  assert.ok(!shaders.includes('fieldCells'), 'no field: no field buffer in the shader');
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('a field uploads its cells padded to 16 bytes, writes its grid, box and strength, and is fixed at attach', () => {
  const data = new Float32Array(24).map((_, i) => i);
  const { h, effect } = attach(
    { capacity: 8, initialCount: 8, fields: { field: field({ data, center: [1, 2, 3], strength: 2 }) } },
    { fields },
  );
  h.frame();
  const cells = h.resources.find((r) => r.size === 8 * 16);
  assert.ok(cells, 'the cell buffer');
  assert.deepEqual([...new Float32Array(cells.data).subarray(0, 8)], [0, 1, 2, 0, 3, 4, 5, 0]);
  const uniform = h.resources.find((r) => r.size === 48 + 16 * 32);
  assert.deepEqual([...new Uint32Array(uniform.data).subarray(1, 4)], [2, 2, 2]);
  assert.deepEqual([...new Float32Array(uniform.data).subarray(4, 12)], [1, 2, 3, 0, 1, 1, 1, 2]);
  assert.ok(code(h).includes('var<storage,read> fieldCells'));
  effect.options.fields.field = field();
  assert.throws(() => h.frame(), /fixed at attach/);
  effect.dispose();
});

test('fields work with obstacles: the force is added before the flow bends around them', () => {
  const { h, effect } = attach({
    capacity: 8,
    initialCount: 8,
    obstacles: [{ kind: 'sphere', center: [0, 0, 0], radius: 1 }],
    fields: { attractors: [{ position: [0, 1, 0], strength: 1 }] },
  });
  h.frame();
  assert.ok(
    code(h).includes('var force=f.gravityDelta.xyz+curlNoise(p.positionLife.xyz)+fieldForce(p.positionLife.xyz);'),
  );
  effect.dispose();
});

test('fields are validated; effects without them compile no field code', () => {
  assert.throws(() => new Base({ fields: {} }, {}), /needs fields from @margoengine\/vfx\/fields/);
  assert.throws(() => new VFX({ fields: null }), TypeError);
  assert.throws(
    () => new VFX({ fields: { attractors: Array(17).fill({ position: [0, 0, 0], strength: 1 }) } }),
    RangeError,
  );
  assert.throws(() => new VFX({ fields: { attractors: [{ position: [0, 0], strength: 1 }] } }), TypeError);
  assert.throws(() => new VFX({ fields: { attractors: [{ position: [0, 0, 0], strength: NaN }] } }), TypeError);
  assert.throws(
    () => new VFX({ fields: { attractors: [{ position: [0, 0, 0], strength: 1, radius: 0 }] } }),
    RangeError,
  );
  assert.throws(() => new VFX({ fields: { field: field({ size: [2, 2, 1.5] }) } }), RangeError);
  assert.throws(() => new VFX({ fields: { field: field({ data: new Float32Array(23) }) } }), RangeError);
  assert.throws(() => new VFX({ fields: { field: field({ data: [1] }) } }), RangeError);
  assert.throws(() => new VFX({ fields: { field: field({ halfSize: [1, 0, 1] }) } }), RangeError);
  const { h, effect } = attach({ capacity: 8, initialCount: 8 });
  h.frame();
  assert.ok(!code(h).includes('fieldForce'));
  effect.dispose();
});
