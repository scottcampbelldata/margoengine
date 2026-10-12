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

test('cabin plank seams are closed and roof/corner surfaces do not share depth planes',()=>{
 const cabin=generateCabinMesh(()=>0),p=cabin.siding.positions;
 const frontDepths=(x,y,side=1)=>{
  const depths=[];
  for(let t=0;t<cabin.siding.indices.length;t+=3){
   const [a,b,c]=cabin.siding.indices.subarray(t,t+3).map(v=>v*3);
   if(cabin.siding.normals[a+2]*side<0.99)continue;
   const determinant=(p[b+1]-p[c+1])*(p[a]-p[c])+(p[c]-p[b])*(p[a+1]-p[c+1]);
   if(Math.abs(determinant)<1e-10)continue;
   const u=((p[b+1]-p[c+1])*(x-p[c])+(p[c]-p[b])*(y-p[c+1]))/determinant;
   const v=((p[c+1]-p[a+1])*(x-p[c])+(p[a]-p[c])*(y-p[c+1]))/determinant;
   if(u>=-1e-6&&v>=-1e-6&&u+v<=1+1e-6)depths.push(u*p[a+2]+v*p[b+2]+(1-u-v)*p[c+2]);
  }
  return depths;
 };
 for(let row=1;row<15;row++)for(const y of [row*0.2-0.0015,row*0.2])assert.ok(frontDepths(-2.2,y).some(z=>Math.abs(z-4.11)<1e-5),'Light must not leak through plank seams');
 assert.ok(!frontDepths(-1.5,1.85).some(z=>z>4.1),'Window opening stays recessed');
 assert.ok(Math.abs(Math.max(...frontDepths(0.345,1.1))-4.11)<1e-5,'Flush door trim overlaps the opening edge without thin protruding caps');
 for(const side of [-1,1])for(const x of [-3.05,-2.98,-1.5,0,1.5,2.98,3.05]){
  const roofLine=3+3*Math.tan(35*Math.PI/180)-Math.abs(x)*Math.tan(35*Math.PI/180);
  for(const y of [2.99,3,3.005,roofLine+0.015])if(y<=roofLine+0.015)assert.ok(frontDepths(x,y,side).some(z=>Math.abs(z-side*4.11)<1e-5),'Both gables must close the outer siding-to-roof joint');
 }
 const corner=frontDepths(-2.92,1.1);assert.ok(Math.max(...corner)>4.13,'Corner trim stands clear of the siding');
 for(let t=0;t<cabin.siding.indices.length;t+=3){
  const ids=cabin.siding.indices.subarray(t,t+3),x=ids.reduce((sum,v)=>sum+p[v*3]/3,0),y=ids.reduce((sum,v)=>sum+p[v*3+1]/3,0),z=ids.reduce((sum,v)=>sum+p[v*3+2]/3,0);
  if(x>-2.8&&x<-2.1&&y>0.1&&y<2.9&&z>3.88&&z<4.12)assert.ok(Math.abs(cabin.siding.normals[ids[0]*3+1])<0.99,'Internal plank caps must not rasterize through the wall');
 }
 const planes=new Set(),roof=cabin.roof;
 for(let v=0;v<roof.positions.length/3;v++)if(roof.normals[v*3]>0.5&&roof.normals[v*3+1]>0.8)planes.add(Math.round((roof.normals[v*3]*roof.positions[v*3]+roof.normals[v*3+1]*roof.positions[v*3+1])*10000));
 assert.equal(planes.size,12,'Overlapping roof courses must have distinct planes');
});

test('porch beam follows the roof underside and both posts stay below it on sloping ground',()=>{
 for(const height of [()=>0,(x,z)=>2+x*0.02+z*0.01]){
  const cabin=generateCabinMesh(height,[30,-20]),roof=cabin.roof,siding=cabin.siding;
  const v=Array.from({length:roof.positions.length/3},(_,i)=>i).find(i=>roof.normals[i*3+1]<-0.95&&roof.positions[i*3+1]>2&&roof.positions[i*3+1]<3);
  assert.notEqual(v,undefined);const n=roof.normals.subarray(v*3,v*3+3),p=roof.positions.subarray(v*3,v*3+3),plane=n.reduce((sum,a,i)=>sum+a*p[i],0);
  let beamVertices=0;const posts=[false,false];
  for(let i=0;i<siding.positions.length;i+=3){
   const [x,y,z]=siding.positions.subarray(i,i+3);if(z<5.7||z>6.1||y<2)continue;
   const underside=(plane-n[0]*x-n[2]*z)/n[1];assert.ok(y<=underside+0.003,'Porch supports must not protrude through the canopy');
   if(Math.abs(y-underside)<0.003)beamVertices++;
   if(y<underside-0.1)for(let post=0;post<2;post++)if(Math.abs(x-[-0.15,1.95][post])<0.14)posts[post]=true;
  }
  assert.ok(beamVertices>=4,'Beam top follows the actual sloped underside');assert.deepEqual(posts,[true,true]);
 }
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
