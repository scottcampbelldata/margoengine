import test from 'node:test';
import assert from 'node:assert/strict';
import {PbrMaterial} from '@margoengine/core';
import {Engine, TransformStore} from '@margoengine/core/extension';
import {createIslandHeight, generateCabinMesh, generateGrassMesh, createHumanoid, poseHumanoid} from '../dist/index.js';
import {pbrVertexStream} from '@margoengine/geometry';

test('cabin samples its supplied world position and validates every foundation sample', () => {
  const flat = generateCabinMesh(()=>2), shifted = generateCabinMesh((x,z)=>2+(x-50)*0.02+(z+20)*0.01,[50,-20]);
  assert.ok(Math.abs(flat.floor-2.28)<1e-9); assert.ok(shifted.floor>flat.floor);
  for (const part of ['siding','roof','foundation','glass']) {
    assert.equal(pbrVertexStream(shifted[part]).byteLength,shifted[part].positions.length/3*80);
    assert.ok(shifted[part].positions.every(Number.isFinite));
  }
  assert.throws(()=>generateCabinMesh(()=>NaN),/terrain/);
  assert.throws(()=>generateCabinMesh(()=>0,[Infinity,0]),/position/);
  assert.throws(()=>generateCabinMesh((x,z)=>x===0.9&&z===6.15?NaN:0),/terrain/);
});

test('shared island preset is deterministic and grass supports all three scatter LODs', () => {
  const a = createIslandHeight(731), b = createIslandHeight(731), c = createIslandHeight(732);
  assert.ok(a(0,0)>1&&a(0,0)<5);
  assert.equal(a(-10,23),b(-10,23)); assert.notEqual(a(-10,23),c(-10,23)); assert.ok(a(80,80)<0);
  assert.throws(()=>a(NaN,0),/coordinates/);
  for (const blades of [1,2,3]) {
    const grass = generateGrassMesh(blades); assert.equal(grass.positions.length,blades*12); assert.equal(grass.indices.length,blades*6);
    assert.ok(pbrVertexStream(grass).every(Number.isFinite));
    for (let i = 0; i < grass.normals.length; i += 3) assert.ok(Math.abs(Math.hypot(...grass.normals.subarray(i,i+3))-1)<1e-6);
  }
  assert.throws(()=>generateGrassMesh(0),/blade/); assert.throws(()=>generateGrassMesh(1.5),/blade/);
});

test('shared humanoid exposes shadow parts and poses its existing transforms', async () => {
  const engine = new Engine({width:10,height:10},await TransformStore.create(64),{backend:'webgl2',add(){},remove(){},render(){},dispose(){}});
  try {
    const material = new PbrMaterial(), rig = createHumanoid(engine,[material,material,material]);
    assert.equal(rig.parts.length,14); assert.equal(rig.joints.length,4); assert.equal(rig.knees.length,4);
    const root = rig.root, joints = rig.joints, position = new Float32Array([3,4,5]);
    poseHumanoid(rig,position,0.7,Math.PI/2,3.4);
    assert.equal(rig.root,root); assert.equal(rig.joints,joints); assert.equal(root.position.x,3); assert.equal(root.position.z,5);
    assert.ok(Math.abs(root.rotation.y-0.7)<1e-6); assert.ok(rig.joints[0].rotation.x>0); assert.ok(rig.joints[1].rotation.x<0);
    poseHumanoid(rig,position,0,0,0); assert.equal(root.position.y,4); assert.equal(rig.joints[0].rotation.x,0);
    assert.throws(()=>poseHumanoid(rig,position,0,NaN,1),/pose/); assert.throws(()=>createHumanoid(engine,[]),/materials/);
  } finally {engine.dispose();}
});
