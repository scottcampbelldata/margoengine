import test from 'node:test';
import assert from 'node:assert/strict';
import { Engine, TransformStore, box } from '../../core/dist/extension.js';
import { LODSystem, Imposter, ImposterFrames, imposterShader } from '@margoengine/lod';
import { LODFade, fadeTest } from '@margoengine/lod/fade';

const fixture = async () => {
  const engine = new Engine(
    { width: 64, height: 64 },
    await TransformStore.create(64),
    { backend: 'webgpu', gpu: {}, add() {}, remove() {}, render() {}, dispose() {} },
    { position: [0, 0, 2], target: [0, 0, 0] },
  );
  const system = LODSystem.attach(engine),
    fade = LODFade.attach(engine, system, { duration: 1 }),
    anchor = engine.createMesh();
  const imp = Object.assign(Object.create(Imposter.prototype), { radius: 1, center: new Float32Array(3), ready() {} });
  const frames = new ImposterFrames([imp, imp], 2);
  const lod = system.add(anchor, [
    { object: box() },
    { object: imp, distance: 5 },
    { object: frames, distance: 10 },
    { object: null, distance: 20 },
  ]);
  system.update();
  return { engine, system, fade, lod };
};
test('mesh, imposter frames and empty levels share one fade lifecycle in both directions', async () => {
  const { engine, system, fade, lod } = await fixture();
  try {
    assert.equal(system.imposterFade(lod, 0), false);
    assert.equal(system.imposterFade(lod, 1), true);
    system.bias = 3;
    system.update();
    assert.equal(lod.level, 1);
    assert.equal(fade.active, 1);
    fade.onPreUpdate(0.5);
    assert.equal(fade.active, 1);
    fade.finish();
    assert.equal(fade.active, 0);
    system.bias = 6;
    system.update();
    assert.equal(lod.level, 2);
    assert.equal(fade.active, 1);
    // Interrupting a fade settles its previous target before starting a new transition.
    system.bias = 1;
    system.update();
    assert.equal(lod.level, 0);
    assert.equal(fade.active, 1);
    assert.equal(system.pickProxies().length, 1, 'the outgoing animated imposter remains pickable');
    fade.finish();
    assert.equal(system.pickProxies().length, 0);
    system.bias = 3;
    system.update();
    fade.finish();
    system.bias = 20;
    system.update();
    assert.equal(lod.level, 3);
    assert.equal(fade.active, 1);
    assert.equal(system.pickProxies().length, 1);
    fade.finish();
    assert.equal(system.pickProxies().length, 0);
    assert.throws(() => system.imposterFade(lod, 1, NaN), RangeError);
    assert.equal(system.imposterFade(lod, 1.5, 0.5), false);
    lod.remove();
    assert.equal(system.imposterFade(lod, 1, 0), false);
  } finally {
    engine.dispose();
  }
});
test('imposter fragments share the mesh threshold without changing the 24-float instance layout', () => {
  assert.ok(imposterShader.includes(fadeTest));
  assert.ok(imposterShader.includes('lod_fade_keep(i.clip.xy,instances[i.id].color.w)'));
  assert.ok(
    imposterShader.indexOf('let coverage=') < imposterShader.indexOf('if(!lod_fade_keep('),
    'derivatives remain before the fade discard',
  );
  assert.ok(imposterShader.includes('struct Instance {m:mat4x4f,color:vec4f,emissive:vec4f}'));
});
