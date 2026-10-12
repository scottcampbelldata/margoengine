import test from 'node:test';
import assert from 'node:assert/strict';
import {boxGeometry,computeTangents,pbrVertexStream,footprintRadius,wireframe,wireframePositions} from '../dist/index.js';

test('line positions expand shared wireframe indices and apply the supplied lift',()=>{
 const data=boxGeometry(2,4,6), edges=wireframe(data), positions=wireframePositions(data,0.035);
 assert.equal(positions.length,edges.length*3);
 for(let i=0;i<edges.length;i++) for(let k=0;k<3;k++) assert.equal(positions[i*3+k],Math.fround(data.positions[edges[i]*3+k]+(k===1?0.035:0)));
 assert.throws(()=>wireframePositions(data,NaN),/offset/);
});

test('PBR streams preserve tangent and UV attributes and pack bounded baked occlusion',()=>{
 const data=computeTangents(boxGeometry(2,4,6)), stream=pbrVertexStream(data,(_x,y)=>y>0?1:0.2);
 assert.equal(stream.byteLength/(data.positions.length/3),80);
 assert.deepEqual(stream.slice(0,3),data.positions.slice(0,3));assert.equal(stream[3],1);
 assert.deepEqual(stream.slice(8,12),data.tangents.slice(0,4));
 assert.deepEqual(stream.slice(12,14),data.uvs.slice(0,2));assert.deepEqual(stream.slice(14,16),data.uvs.slice(0,2));
 assert.ok(stream.every((v,i)=>i%20<16||i%20===19||v===1));
 assert.ok(stream.some((v,i)=>i%20===19&&Math.abs(v-0.2)<1e-6));
 assert.equal(footprintRadius(data),Math.hypot(1,3));
 for(const ao of [NaN,-1,2])assert.throws(()=>pbrVertexStream(data,()=>ao),/occlusion/);
 assert.throws(()=>pbrVertexStream({...data,tangents:undefined}),/attributes/);
 assert.throws(()=>footprintRadius({...data,positions:new Float32Array([NaN,0,0])}),/positions/);
});
