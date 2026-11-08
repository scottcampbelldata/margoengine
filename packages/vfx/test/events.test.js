import test from 'node:test';
import assert from 'node:assert/strict';
import { VFX } from '../dist/index.js';
import { VFX as Base } from '../dist/base.js';
import { events } from '../dist/events.js';
import { optionalGPU } from '../../../tests/support/optional-gpu.js';

const attach = (options, features) => {
  const h = optionalGPU();
  h.engine.stats = { drawCalls: 0 };
  const effect = features ? new Base(options, features) : new VFX(options);
  h.engine.use(effect);
  return { h, effect };
};
const code = (h) => h.pipelines.map((p) => (p.compute ?? p.vertex).module.code).join('\n');
const eventUniform = (h) => h.resources.findLast((r) => r.size === 64 && !r.destroyed && r.usage & 64);

test('death events patch the simulation, count free slots every frame and upload their settings', () => {
  const { h, effect } = attach({
    capacity: 600,
    rate: 0,
    events: {
      on: 'death',
      count: 5,
      lifetime: [0.2, 0.4],
      size: 0.3,
      velocity: [1, 2, 3],
      spread: 0.5,
      inherit: 0.25,
      color: [0.1, 0.2, 0.3, 0.4],
    },
  });
  h.frame();
  const wgsl = code(h);
  for (const name of ['fn eventScan', 'fn eventCompact', 'storeEvent(i,p)', 'events[4u+eventGroups()*257u+e]'])
    assert.ok(wgsl.includes(name), name);
  assert.ok(!wgsl.includes('-p.velocitySize.y>bitcast<f32>(ev.control.z)'), 'no collision test for death events');
  const list = h.resources.find((r) => r.size === (4 + 3 * 257 + 600) * 4);
  assert.ok(list, 'totals, workgroup counts, listed slots and the list');
  assert.ok(
    h.resources.find((r) => r.size === 600 * 64 && r !== effect.gpuState.particles),
    'event data, two halves',
  );
  const u = eventUniform(h),
    f = new Float32Array(u.data),
    i = new Uint32Array(u.data);
  assert.equal(i[0], 5);
  assert.deepEqual(
    [...f.subarray(4, 16)].map((v) => +v.toFixed(5)),
    [0.2, 0.4, 0.3, 0.25, 1, 2, 3, 0.5, 0.1, 0.2, 0.3, 0.4],
  );
  effect.options.events.count = 9;
  h.frame();
  assert.equal(new Uint32Array(eventUniform(h).data)[0], 9, 'read every frame');
  new Uint32Array(list.data)[1] = 7;
  effect.reset();
  assert.equal(new Uint32Array(list.data)[1], 0, "reset forgets last frame's events");
  effect.dispose();
  assert.ok(h.resources.every((r) => r.destroyed));
});

test('the deaths and births scan run in frames without emitter births only when events are on', () => {
  const dispatches = (options) => {
    const { h, effect } = attach({ capacity: 300, rate: 0, ...options });
    let n = 0;
    const begin = h.context.encoder.beginComputePass;
    h.context.encoder.beginComputePass = () => {
      const pass = begin();
      pass.dispatchWorkgroups = () => n++;
      return pass;
    };
    h.frame();
    effect.dispose();
    return n;
  };
  // Without events: main, scan, compact. With: deaths and births scan too, then the event scan and compact.
  assert.equal(dispatches({}), 3);
  assert.equal(dispatches({ events: { on: 'collision' } }), 7);
});

test('collision events test the impact speed; effects without events compile no event code', () => {
  const { h, effect } = attach({ capacity: 8, events: { on: 'collision', speed: 2.5 } }, { events });
  h.frame();
  assert.ok(code(h).includes('-p.velocitySize.y>bitcast<f32>(ev.control.z)'));
  assert.equal(new Float32Array(eventUniform(h).data)[2], 2.5);
  effect.dispose();
  const plain = attach({ capacity: 8 });
  plain.h.frame();
  assert.ok(!code(plain.h).includes('eventScan'));
  plain.effect.dispose();
});

test('events are validated, need the feature and keep `on` from attach', () => {
  assert.throws(() => new Base({ events: { on: 'death' } }), /VFX events needs events from @margoengine\/vfx\/events/);
  for (const bad of [{}, { on: 'birth' }, 3])
    assert.throws(() => new VFX({ events: bad }), TypeError, JSON.stringify(bad));
  for (const bad of [
    { count: 0 },
    { count: 65 },
    { count: 1.5 },
    { lifetime: [0, 1] },
    { lifetime: [2, 1] },
    { size: 0 },
    { spread: -1 },
    { inherit: 11 },
    { speed: -1 },
    { velocity: [0, NaN, 0] },
    { color: [1, 1, 2, 1] },
  ])
    assert.throws(() => new VFX({ events: { on: 'death', ...bad } }), RangeError, JSON.stringify(bad));
  const { h, effect } = attach({ capacity: 4, events: { on: 'death' } });
  h.frame();
  effect.options.events = { on: 'collision' };
  assert.throws(() => h.frame(), /fixed at attach/);
  effect.dispose();
});
