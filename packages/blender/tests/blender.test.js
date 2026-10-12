import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decodeMargo,parseMargo,loadMargo} from '../dist/index.js';
import {Engine,TransformStore} from '../../core/dist/extension.js';

const source=await readFile(new URL('./fixtures/triangle.margo',import.meta.url));
const bytes=()=>Uint8Array.from(source);
const mutate=(offset,value)=>{const data=bytes();new DataView(data.buffer).setUint32(offset,value,true);return data;};
async function headless(capacity=16){
  const store=await TransformStore.create(capacity);
  return new Engine({width:256,height:256,clientWidth:256,clientHeight:256},store,{backend:'webgl2',add(){},remove(){},render(){},dispose(){}});
}

test('Python fixture retains geometry buffer views, shared meshes, PBR and PNG sections',()=>{
  const input=bytes(),asset=decodeMargo(input),p=asset.geometry[0][0];
  assert.equal(p.vertices.buffer,input.buffer);assert.equal(p.indices.buffer,input.buffer);
  assert.equal(p.vertices.length,60);assert.deepEqual([...p.indices],[0,1,2]);
  assert.equal(asset.document.nodes[1].mesh,asset.document.nodes[0].mesh);
  assert.deepEqual(asset.document.nodes[1].scale,[-1,1,1]);
  assert.equal(asset.document.materials[0].pbrMetallicRoughness.roughnessFactor,0.6);
  assert.equal(new DataView(asset.images[0].buffer,asset.images[0].byteOffset).getUint32(16),2);
  const padded=new Uint8Array(input.length+8);padded.set(input,4);
  assert.equal(decodeMargo(padded.subarray(4,4+input.length)).geometry[0][0].vertices.buffer,padded.buffer);
});

test('container rejects malformed headers, section references, overlaps and PNG bombs',()=>{
  for(const [offset,value] of [[0,0],[4,2],[8,source.length+4],[12,4097],[16,60],[20,1],[24,48],[64,5],[68,0],[76,1],[84,64],[88,1]])assert.throws(()=>decodeMargo(mutate(offset,value)),/margo/);
  assert.throws(()=>decodeMargo(bytes().subarray(1)),/aligned/);
  assert.throws(()=>decodeMargo(bytes().subarray(0,63)),/size/);
  const corrupted=bytes(),asset=decodeMargo(corrupted);
  new DataView(corrupted.buffer).setUint32(asset.images[0].byteOffset+16,5000);
  assert.throws(()=>decodeMargo(corrupted),/decoded size/);
});

test('packed geometry rejects invalid indices, padding, normals, tangents and colors before image decoding',()=>{
  for(const [field,value] of [[0,NaN],[3,0],[4,5],[11,0.5],[16,2]]){
    const data=bytes(),asset=decodeMargo(data);asset.geometry[0][0].vertices[field]=value;
    assert.throws(()=>decodeMargo(data),/prepared PBR/);
  }
  const data=bytes(),asset=decodeMargo(data);asset.geometry[0][0].indices[0]=0xffffffff;
  assert.throws(()=>decodeMargo(data),/prepared PBR geometry/);
});

test('image decoding, failed attachment and aborts release images and mesh handles',async()=>{
  const original=globalThis.createImageBitmap,engine=await headless();let closed=0;
  globalThis.createImageBitmap=async()=>({width:2,height:2,close(){closed++;}});
  try{
    await assert.rejects(parseMargo(engine,bytes()),/WebGPU/);
    assert.equal(engine.meshes.size,0);assert.ok(closed>=1);
    const invalid=bytes(),asset=decodeMargo(invalid);asset.geometry[0][0].vertices[0]=NaN;
    await assert.rejects(parseMargo(engine,invalid),/Non-finite/);assert.equal(engine.meshes.size,0);
    const signal=AbortSignal.abort(new Error('cancelled'));
    await assert.rejects(parseMargo(engine,bytes(),{signal}),/cancelled/);
    await assert.rejects(loadMargo(engine,'file:///asset.margo'),/HTTP/);
    globalThis.createImageBitmap=async()=>({width:999,height:2,close(){closed++;}});
    await assert.rejects(parseMargo(engine,bytes()),/size mismatch/);assert.equal(engine.meshes.size,0);
  }finally{globalThis.createImageBitmap=original;engine.dispose();}
});

test('HTTP loader applies status, byte budget and cancellation checks',async()=>{
  const original=globalThis.fetch,engine=await headless();
  try{
    globalThis.fetch=async()=>new Response('missing',{status:404});
    await assert.rejects(loadMargo(engine,'https://example.test/asset.margo'),/404/);
    globalThis.fetch=async()=>new Response(bytes(),{headers:{'content-length':String(65*1024*1024)}});
    await assert.rejects(loadMargo(engine,'https://example.test/asset.margo'),/byte budget/);
    await assert.rejects(loadMargo(engine,'https://example.test/asset.margo',{signal:AbortSignal.abort(new Error('cancelled'))}),/cancelled/);
  }finally{globalThis.fetch=original;engine.dispose();}
});
