import assert from 'node:assert/strict';
import test from 'node:test';
import { ChainAvoidanceSolver, createLimbAvoidance } from '../dist/chain.js';
import { CapsuleVolume, ConvexHullVolume, SphereVolume } from '../dist/index.js';
import { SDFVolume } from '../dist/sdf.js';

const gap = (a,b) => Math.hypot(...a.map((v,i)=>v-b[i]));
const initial = [[0,0,0],[1,1,0],[2,0,0],[3,1,0],[4,0,0]];
const sphere = new SphereVolume({center:[1,1,0],radius:0.25});
for (const algorithm of ['ccd','fabrik']) {
  test(`${algorithm}: every N-link capsule clears obstacles with lengths and endpoints held`,()=>{
    const input=structuredClone(initial);
    const solver=new ChainAvoidanceSolver([sphere],{algorithm,radius:0.05,minClearance:0.03,candidates:64,iterations:256});
    const r=solver.solve(initial,initial.at(-1));
    assert.equal(r.resolved,true);
    assert.ok(r.candidates>1);
    assert.ok(r.clearance>=0.03);
    assert.deepEqual(initial,input);
    for(let i=0;i<initial.length-1;i++) {
      assert.ok(Math.abs(gap(r.joints[i],r.joints[i+1])-gap(initial[i],initial[i+1]))<1e-5);
      assert.ok(sphere.segmentClearance(r.joints[i],r.joints[i+1],0.05)>=0.03);
    }
    assert.deepEqual(r.joints[0],initial[0]);
    assert.ok(gap(r.joints.at(-1),initial.at(-1))<1e-5);
  });
  test(`${algorithm}: follows moved targets and escapes a straight folded fixed point`,()=>{
    const solver=new ChainAvoidanceSolver([],{algorithm,iterations:512,candidates:64});
    for(const target of [[2,1,0.5],[1,0,0],[0,0,0]]) {
      const r=solver.solve([[0,0,0],[1,0,0],[2,0,0],[3,0,0]],target);
      assert.equal(r.resolved,true,JSON.stringify({algorithm,target,r}));
      assert.ok(r.distance<=1e-5);
    }
  });
}

test('capsule, hull and SDF queries participate in the same full-chain search',()=>{
  const shapes=[
    new CapsuleVolume({start:[1,0.9,-0.2],end:[1,1.1,0.2],radius:0.2}),
    new ConvexHullVolume({points:[0.8,0.8,-0.2,1.2,0.8,-0.2,1,1.2,-0.2,1,1,0.2]}),
    new SDFVolume({field:{distance:p=>Math.hypot(p[0]-1,p[1]-1,p[2])-0.25}}),
  ];
  for(const obstacle of shapes) {
    const result=new ChainAvoidanceSolver([obstacle],{radius:0.04,minClearance:0.01}).solve(initial,initial.at(-1));
    assert.equal(result.resolved,true,obstacle.constructor.name);
    for(let i=0;i<initial.length-1;i++) assert.ok(obstacle.segmentClearance(result.joints[i],result.joints[i+1],0.04)>=0.01);
  }
});
test('occlusion, unreachable goals and nonfinite custom queries fail without modifying caller state',()=>{
  const original=structuredClone(initial);
  for(const volumes of [[new SphereVolume({center:[0,0,0],radius:1})],[{segmentClearance:()=>NaN}]]) {
    const r=new ChainAvoidanceSolver(volumes).solve(initial,initial.at(-1));
    assert.equal(r.resolved,false);
    assert.equal(r.clearance,-Infinity);
    assert.deepEqual(r.joints,original);
  }
  assert.equal(new ChainAvoidanceSolver().solve(initial,[50,0,0]).resolved,false);
  assert.deepEqual(initial,original);
});
test('pose predicates reject clear illegal candidates and cannot mutate returned geometry',()=>{
  const r=new ChainAvoidanceSolver([],{acceptPose:p=>{p[0][0]=123;return true;}}).solve(initial,initial.at(-1));
  assert.equal(r.joints[0][0],0);
  assert.equal(new ChainAvoidanceSolver([],{acceptPose:()=>false}).solve(initial,initial.at(-1)).resolved,false);
});
test('full-body adapter returns the accepted knee or null',()=>{
  const limb=initial.slice(0,3);
  assert.ok(createLimbAvoidance(new ChainAvoidanceSolver([sphere]))(limb));
  assert.equal(createLimbAvoidance(new ChainAvoidanceSolver([new SphereVolume({center:[0,0,0],radius:5})]))(limb),null);
  assert.throws(()=>createLimbAvoidance(new ChainAvoidanceSolver())(initial),/three/);
});
test('malformed settings, radii, joint inputs and zero lengths reject',()=>{
  for(const options of [{algorithm:'bad'},{candidates:0},{iterations:Infinity},{tolerance:0}]) assert.throws(()=>new ChainAvoidanceSolver([],options));
  for(const options of [{radius:[1]},{radius:NaN},{radius:-1}]) assert.throws(()=>new ChainAvoidanceSolver([],options).solve(initial,[4,0,0]));
  assert.throws(()=>new ChainAvoidanceSolver().solve([[0,0,0],[0,0,0]],[0,0,0]));
  assert.throws(()=>new ChainAvoidanceSolver().solve(initial,[NaN,0,0]));
});
