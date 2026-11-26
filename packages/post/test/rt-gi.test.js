import test from 'node:test';
import assert from 'node:assert/strict';
import { tracedHarness, modules, floats } from './traced-harness.js';
import { SSGI } from '../dist/index.js';
import { RTGI } from '../dist/rt-gi.js';

test('RTGI validates its options', () => {
  const { scene } = tracedHarness();
  assert.throws(() => new RTGI({}), TypeError);
  assert.throws(() => new RTGI({ scene, shadows: 'yes' }), TypeError);
  assert.throws(() => new RTGI({ scene, bias: -1 }), RangeError);
  assert.throws(() => new RTGI({ scene, rays: 0 }), RangeError, "SSGI's own options are still checked");
  assert.ok(new RTGI({ scene }) instanceof SSGI);
});

for (const multiBounce of [false, true])
  test(`RTGI traces the rays the screen misses (${multiBounce ? 'multi-bounce' : 'one bounce'})`, async () => {
    const h = tracedHarness(),
      gi = new RTGI({ scene: h.scene, multiBounce });
    h.engine.use(h.stack([gi]));
    const log = h.gpu.record(() => h.frame());
    const traces = modules(log).filter((code) => code.includes('fn trace(p:vec3f,r:vec3f)'));
    assert.equal(traces.length, 1, 'one trace pipeline built');
    const [trace] = traces;
    assert.ok(trace, 'the trace');
    assert.match(trace, /@group\(1\) @binding\(5\) var<uniform> rt:RTLight;/);
    assert.match(
      trace,
      /if\(h\.w<0\.0\)\{let rh=sceneClosest\(start,r,0\.0,u\.b\.x\);if\(rh\.instance!=SCENE_MISS\)\{let rw=1\.0-smoothstep\(0\.8\*u\.b\.x,u\.b\.x,rh\.distance\);sum\+=vec4f\(rtShade\(rh,start\+r\*rh\.distance,r\)\*rw,rw\);\}continue;\}/,
    );
    if (multiBounce) assert.match(trace, /var lit:texture_2d<f32>/, 'the multi-bounce trace is the one patched');
    assert.equal(log.filter((e) => e[0] === 'pass.setBindGroup' && e[1] === 1).length, 1, 'the trace binds group 1');
    const light = floats(log.filter((e) => e[0] === 'writeBuffer' && e[3].length === 128).at(-1)[3]);
    assert.deepEqual([light[12], light[13]], [Math.fround(0.01), 1], 'default bias and shadows');
    await null;
    assert.equal(modules(h.gpu.record(() => h.frame())).length, 0, 'a steady frame builds no shader');
    h.scene.disposed = true;
    await null;
    const plain = h.gpu.record(() => h.frame());
    assert.ok(
      modules(plain).every((code) => !code.includes('sceneClosest(')),
      'a disposed scene rebuilds the plain trace',
    );
    assert.equal(plain.filter((e) => e[0] === 'pass.setBindGroup' && e[1] === 1).length, 0);
    gi.dispose();
    h.engine.removePlugin('post:stack');
    await null;
    assert.deepEqual(h.live(), []);
  });
