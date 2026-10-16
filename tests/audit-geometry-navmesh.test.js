import test from 'node:test';
import assert from 'node:assert/strict';
import {circleGeometry,ringGeometry,cylinderGeometry,capsuleGeometry,torusKnotGeometry,latheGeometry,tubeGeometry,LineCurve3} from '../packages/geometry/dist/index.js';
import {NavMesh} from '../packages/navmesh/dist/index.js';
function finite(data){for(const field of ['positions','normals','uvs'])assert.ok(data[field].every(Number.isFinite),field+' must be finite');const count=data.positions.length/3;assert.equal(data.normals.length,count*3);assert.equal(data.uvs.length,count*2);assert.ok(data.indices.every(i=>i<count));}
const path=new LineCurve3([0,0,0],[0,1,0]),profile=[[0,-0.5],[0.5,0],[0,0.5]];
for(const count of [0,-2,0.5])test(`tube, lathe and torus-knot clamp segment count ${count} to their supported minimum`,()=>{
  for(const [make,min] of [[n=>torusKnotGeometry(1,0.2,n,n),1],[n=>latheGeometry(profile,n),1],[n=>tubeGeometry(path,n,0.2,n),1]]){const actual=make(count);finite(actual);assert.deepEqual(actual,make(min));}
});
test('zero-radius and zero-height primitives retain finite positions, normals, UVs and indices',()=>{
  for(const geometry of [circleGeometry(0),ringGeometry(0,0),ringGeometry(0.5,0),cylinderGeometry(1,1,0),cylinderGeometry(0,1,0),capsuleGeometry(0,0),torusKnotGeometry(0)])finite(geometry);
  const flat=cylinderGeometry(0,1,0,8,1,true);for(let i=0;i<flat.normals.length;i+=3)assert.ok(flat.normals[i]===0&&flat.normals[i+1]===1&&flat.normals[i+2]===0);
});
test('positive supplied segment counts retain exact vertex and index layout',()=>{
  const knot=torusKnotGeometry(1,0.2,7,5);assert.equal(knot.positions.length/3,8*6);assert.equal(knot.indices.length,7*5*6);
  const lathe=latheGeometry(profile,7);assert.equal(lathe.positions.length/3,8*3);assert.equal(lathe.indices.length,7*2*6);
  const tube=tubeGeometry(path,7,0.2,5);assert.equal(tube.positions.length/3,8*6);assert.equal(tube.indices.length,7*5*6);for(const geometry of [knot,lathe,tube])finite(geometry);
});
test('skewed portals choose the nearest corner regardless of polygon winding or starting index',()=>{
  const vertices=[[0,0,0],[0,0,1],[-1,0,10],[1,0,10]],start=[-0.3,0,3.4],end=[0.3,0,3.4];
  for(const polygons of [[[0,1,2],[1,0,3]],[[2,1,0],[3,0,1]],[[1,2,0],[0,3,1]],[[0,1,2],[3,0,1]]]){
    const mesh=new NavMesh(vertices,polygons),forward=mesh.path(start,end),backward=mesh.path(end,start);
    assert.deepEqual(forward,[start,vertices[1],end]);assert.deepEqual(backward,[end,vertices[1],start]);
    for(let i=1;i<forward.length;i++)for(let t=0;t<=1;t+=0.05)assert.ok(mesh.locate(forward[i].map((v,j)=>v*t+forward[i-1][j]*(1-t)))>=0);
  }
});
