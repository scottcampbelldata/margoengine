import test from 'node:test';
import assert from 'node:assert/strict';
import { tracedHarness, modules } from './traced-harness.js';
import { RTReflections } from '../dist/rt-reflections.js';
import { RTGI } from '../dist/rt-gi.js';

// FG-17 piece 6d: a device at WebGPU's compatibility feature level may allow fewer storage buffers in a fragment shader
// than a traced pass binds (the scene's four, plus SSGI's rays). Such a device warns once and runs the plain effect;
// one with enough runs traced. A core device, and the WebGL2 layer, report no such limit and trace.
for (const [name, Effect, need, options] of [
  ['RTReflections', RTReflections, 4, { stochastic: true }],
  ['RTGI', RTGI, 5, {}],
]) {
  test(`${name} below ${need} fragment storage buffers warns once and runs as the plain effect`, async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (warning) => warnings.push(warning));
    const h = tracedHarness();
    h.gpu.device.limits = { ...h.gpu.device.limits, maxStorageBuffersInFragmentStage: need - 1 };
    const effect = new Effect({ scene: h.scene, ...options });
    h.engine.use(h.stack([effect]));
    const log = [...h.gpu.record(() => h.frame()), ...h.gpu.record(() => h.frame())];
    assert.ok(modules(log).length > 0, 'the plain pipelines are built');
    assert.ok(
      modules(log).every((code) => !code.includes('sceneClosest(') && !code.includes('RTLight')),
      'no shader traces',
    );
    assert.equal(log.filter((e) => e[0] === 'pass.setBindGroup' && e[1] === 1).length, 0, 'no scene group');
    assert.equal(log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 128).length, 0, 'no light uniform');
    assert.equal(warnings.length, 1, 'one warning over two frames');
    assert.equal(warnings[0].code, 'unsupported');
    assert.match(
      warnings[0].message,
      new RegExp(
        `^${name} needs ${need} storage buffers in a fragment shader and this device allows ${need - 1}; it runs as ${name === 'RTGI' ? 'SSGI' : 'SSR'}.*https://`,
      ),
    );
    effect.dispose();
    h.engine.removePlugin('post:stack');
    await null;
    assert.deepEqual(h.live(), []);
  });

  test(`${name} with exactly ${need} fragment storage buffers, or no such limit, traces and does not warn`, async (t) => {
    const warnings = [];
    t.mock.method(console, 'warn', (warning) => warnings.push(warning));
    for (const limit of [need, undefined]) {
      const h = tracedHarness();
      if (limit !== undefined)
        h.gpu.device.limits = { ...h.gpu.device.limits, maxStorageBuffersInFragmentStage: limit };
      const effect = new Effect({ scene: h.scene, ...options });
      h.engine.use(h.stack([effect]));
      const log = h.gpu.record(() => h.frame());
      assert.ok(
        modules(log).some((code) => code.includes('sceneClosest(')),
        `limit ${limit}: a traced shader`,
      );
      assert.ok(
        log.some((e) => e[0] === 'pass.setBindGroup' && e[1] === 1),
        `limit ${limit}: the scene group`,
      );
      effect.dispose();
      h.engine.removePlugin('post:stack');
      await null;
      assert.deepEqual(h.live(), []);
    }
    assert.deepEqual(warnings, []);
  });
}

test('a device restore warns again on the new device when it too is short', async (t) => {
  const warnings = [];
  t.mock.method(console, 'warn', (warning) => warnings.push(warning));
  const h = tracedHarness();
  h.gpu.device.limits = { ...h.gpu.device.limits, maxStorageBuffersInFragmentStage: 0 };
  const effect = new RTReflections({ scene: h.scene });
  h.engine.use(h.stack([effect]));
  h.frame();
  h.frame();
  assert.equal(warnings.length, 1);
  effect.onDeviceRestored(h.engine);
  h.frame();
  assert.equal(warnings.length, 2, 'once per device life');
  effect.dispose();
  h.engine.removePlugin('post:stack');
  await null;
});
