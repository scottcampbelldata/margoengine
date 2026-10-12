import test from 'node:test';
import assert from 'node:assert/strict';
import {Cinematic} from '../dist/index.js';
test('orbit offsets update the retained camera arm without scene-side trigonometry', () => {
  const rig = new Cinematic(), offset = rig.offset;
  rig.setOrbitOffset(Math.PI/2,Math.PI/6,10,0.8);
  assert.equal(rig.offset,offset); assert.ok(Math.abs(offset[0]-Math.sqrt(75))<1e-9); assert.ok(Math.abs(offset[1]-5.8)<1e-9); assert.ok(Math.abs(offset[2])<1e-9);
  assert.throws(()=>rig.setOrbitOffset(0,0,0),/orbit/); assert.throws(()=>rig.setOrbitOffset(NaN,0,1),/orbit/);
});
test('critical springs are frame-rate independent and shake leaves the settled follow position intact', () => {
  const a = new Cinematic({offset: [0, 2, 4]}), b = new Cinematic({offset: [0, 2, 4]}); a.update(0); b.update(0); a.follow([10, 0, 0]); b.follow([10, 0, 0]);
  a.update(1); for (let i = 0; i < 60; i++) b.update(1 / 60);
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a.position[i] - b.position[i]) < 1e-10);
  assert.ok(a.position[0] > 9 && a.position[0] < 10); a.shake(1, 0.1); a.update(1); assert.ok(a.position.every(Number.isFinite));
  assert.throws(() => a.follow([NaN, 0, 0]), /finite/); assert.throws(() => a.shake(-1, 1), /Invalid/);
});

test('ground clearance covers the damped and shaken arm without changing the requested offset', () => {
  let ridge = 0;
  const ground = (_x,z) => z>1.8 && z<2.2 ? ridge : 0;
  const engine = {camera: {}, removePlugin() {}}, rig = new Cinematic({offset: [0,0.3,4], ground, clearance: 0.5});
  rig.setup(engine); rig.follow([0,1,0]); rig.update(0);
  const offset = rig.offset.slice(); ridge = 2; rig.shake(0.2,1); rig.update(1/60);
  const from = engine.camera.target, to = engine.camera.position;
  for (let i = 1; i <= 6; i++) {
    const t = i/6, x = from[0]+(to[0]-from[0])*t, z = from[2]+(to[2]-from[2])*t;
    assert.ok(from[1]+(to[1]-from[1])*t >= ground(x,z)+0.5-1e-6);
  }
  assert.deepEqual(rig.offset,offset);
  assert.throws(()=>new Cinematic({clearance:-1}),/clearance/);
  assert.throws(()=>new Cinematic({ground:()=>NaN}).update(0),/finite/);
});
