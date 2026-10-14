import test from 'node:test';
import assert from 'node:assert/strict';
import {usdzCRCSources,importUSDZCRCSource} from '../scripts/support/usdz-crc-candidate.js';
import {parseUSDZ} from '../packages/loaders/dist/index.js';

const sources=await usdzCRCSources(),original=await importUSDZCRCSource(sources.original),candidate=await importUSDZCRCSource(sources.candidate);
const geometry={positions:new Float32Array([0,0,0,1,0,0,0,1,0]),normals:new Float32Array([0,0,1,0,0,1,0,0,1]),indices:new Uint32Array([0,1,2])};

test('branchless CRC matches standard vectors and deterministic payloads',()=>{
  for(const implementation of [original,candidate]){assert.equal(implementation.crc32(new Uint8Array()),0);assert.equal(implementation.crc32(new TextEncoder().encode('123456789')),0xcbf43926);}
  let seed=28573;
  for(const length of [1,2,7,31,64,129,1024,16384,65535]){
    const bytes=Uint8Array.from({length},()=>{seed=Math.imul(seed,1664525)+1013904223|0;return seed>>>24;});
    assert.equal(candidate.crc32(bytes),original.crc32(bytes));
  }
});

test('branchless archives preserve every byte, transforms, parsed meshes and ZIP header layout',async()=>{
  const scenes=[{nodes:[{geometry}]},{nodes:[{name:'Parent "quoted"\nUnicode Ω',translation:[1.3,-0.2,0.7],children:[
    {name:'Mirrored',geometry,rotation:[0.2,-0.1,0.3,0.9],scale:[-1,2,0.5]},
    {name:'Blend',geometry,material:{color:[0.25,0.6,0.9,0.4],alphaMode:'BLEND',emissive:[0.3,0.2,0.1],metalness:0.3}}
  ]}]},{nodes:[{geometry,visible:false},{geometry,scale:[0.3,0.3,0.3]}]}];
  for(const scene of scenes){
    const a=original.exportUSDZ(scene),b=candidate.exportUSDZ(scene);assert.deepEqual(b,a);
    assert.deepEqual(await parseUSDZ(b),await parseUSDZ(a));
    const header=new DataView(b.buffer,b.byteOffset,b.byteLength),start=30+header.getUint16(26,true)+header.getUint16(28,true),length=header.getUint32(18,true),central=start+length;
    assert.equal(start%64,0);assert.equal(header.getUint16(8,true),0);assert.equal(header.getUint32(22,true),length);
    assert.equal(header.getUint32(central,true),0x02014b50);
    assert.equal(header.getUint32(14,true),header.getUint32(central+16,true));
    assert.equal(header.getUint32(14,true),candidate.crc32(b.subarray(start,start+length)));
    assert.notEqual(candidate.exportUSDZ(scene).buffer,b.buffer);
  }
});

test('branchless serializer retains validation and unsupported-feature error outcomes',()=>{
  const result=operation=>{try{operation();return null;}catch(error){return {type:error.constructor.name,message:error.message};}};
  for(const scene of [{nodes:[]},{nodes:[{geometry,material:{alphaMode:'MASK'}}]},
    {nodes:[{geometry:{...geometry,colors:new Float32Array(9).fill(0.5)}}]},
    {nodes:[{geometry:{...geometry,positions:new Float32Array([NaN,0,0,1,0,0,0,1,0])}}]},
    {nodes:[{geometry,scale:[0,1,1]}]}]){
    const expected=result(()=>original.exportUSDZ(scene));assert.ok(expected);assert.deepEqual(result(()=>candidate.exportUSDZ(scene)),expected);
  }
});
