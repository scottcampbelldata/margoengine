import test from 'node:test';
import assert from 'node:assert/strict';
import {Cinematic} from '../dist/index.js';
test('upward orbit survives terrain clearance without putting the camera underground',()=>{
 const engine={camera:{},removePlugin(){}},rig=new Cinematic({ground:()=>0,clearance:0.65});
 rig.setup(engine);rig.follow([0,1.6,0]);rig.setOrbitOffset(0,-0.7,14,0.8);rig.update(0);
 assert.ok(engine.camera.position[1]>=0.65-1e-6);
 assert.ok(engine.camera.target[1]>engine.camera.position[1]+7);
 assert.ok(Math.abs(engine.camera.target[1]-engine.camera.position[1]+rig.offset[1])<1e-6);
 const requested=rig.offset.slice();rig.shake(0.2,1);rig.update(1/60);
 assert.ok(engine.camera.position[1]>=0.65-1e-6);assert.ok(engine.camera.target[1]>engine.camera.position[1]);assert.deepEqual(rig.offset,requested);
});
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

test('collide pulls the camera in front of a wall at once and eases it back out when the arm is clear', () => {
  let wall = 3;
  // A wall plane at z = wall facing the target at the origin; the camera sits 6 behind on +Z.
  const collide = (o, d, max) => {if (!(d[2] > 0)) return null; const t = (wall - o[2]) / d[2]; return t >= 0 && t <= max ? t : null;};
  const engine = {camera: {}, removePlugin() {}}, rig = new Cinematic({offset: [0, 0, 6], collide, clearance: 0.5});
  rig.setup(engine); rig.follow([0, 0, 0]); rig.update(0);
  assert.ok(Math.abs(engine.camera.position[2] - 2.5) < 1e-6, `pulled in to ${engine.camera.position[2]}`);
  assert.deepEqual([...rig.position], [0, 0, 6], 'the spring state keeps the requested arm');
  wall = 100; rig.update(1 / 60);
  const out = engine.camera.position[2];
  assert.ok(out > 2.5 && out < 3, `eases out (${out})`);
  for (let i = 0; i < 240; i++) rig.update(1 / 60);
  assert.equal(engine.camera.position[2], 6, 'fully out once clear');
  wall = 4; rig.update(1 / 60);
  assert.ok(Math.abs(engine.camera.position[2] - 3.5) < 1e-6, 'a new wall applies at once');
  assert.throws(() => new Cinematic({collide: () => NaN}).update(0), /collision distance/);
  assert.throws(() => new Cinematic({collide: 1}), /collide/);
});

test('camera springs reuse each decay across all three axes and resample mutable damping each tick',()=>{
  const options={damping:5,lookDamping:7},rig=new Cinematic(options),exp=Math.exp,calls=[];
  rig.update(0);rig.follow([10,2,-5]);
  Math.exp=value=>{calls.push(value);return exp(value);};
  try {
    rig.update(0.125);assert.deepEqual(calls,[-0.625,-0.875]);
    options.damping=9;options.lookDamping=13;calls.length=0;
    rig.update(0.25);assert.deepEqual(calls,[-2.25,-3.25]);
    assert.ok(rig.position.every(Number.isFinite));assert.ok(rig.lookAt.every(Number.isFinite));
  } finally {Math.exp=exp;}
});
