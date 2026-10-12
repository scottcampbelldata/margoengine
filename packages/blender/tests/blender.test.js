import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {decodeMargo,parseMargo,loadMargo} from '../dist/index.js';
import {Engine,TransformStore} from '../../core/dist/extension.js';
import {readModel,readMeshes} from '../../../examples/conveyor-simulator/src/glb.js';

const source=await readFile(new URL('./fixtures/triangle.margo',import.meta.url));
const cadSource=await readFile(new URL('./fixtures/cad-triangle.margo',import.meta.url));
const mixedSource=await readFile(new URL('./fixtures/mixed-triangle.margo',import.meta.url));
const uint16Source=await readFile(new URL('./fixtures/triangle-uint16.margo',import.meta.url));
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

test('CAD sections expand positions/normals with PBR defaults and retain shared indices',()=>{
  const input=Uint8Array.from(cadSource),asset=decodeMargo(input),p=asset.geometry[0][0],expected=decodeMargo(bytes()).geometry[0][0];
  assert.notEqual(p.vertices.buffer,input.buffer);assert.notEqual(p.indices.buffer,input.buffer);
  for(let i=0;i<3;i++){
    assert.deepEqual(p.vertices.slice(i*20,i*20+8),expected.vertices.slice(i*20,i*20+8));
    assert.deepEqual([...p.vertices.slice(i*20+8,i*20+16)],Array(8).fill(0));
    assert.deepEqual([...p.vertices.slice(i*20+16,i*20+20)],[1,1,1,1]);
  }
  assert.equal(asset.document.nodes[0].mesh,asset.document.nodes[1].mesh);
  const mixed=decodeMargo(Uint8Array.from(mixedSource));
  assert.equal(mixed.geometry[0][0].vertices.buffer,mixed.images[0].buffer);
  assert.deepEqual(mixed.geometry[1][0].vertices,p.vertices);
  assert.equal(mixed.geometry[1][0],mixed.geometry[2][0],'Shared CAD sections must expand once');
  assert.deepEqual(mixed.geometry[0][0].indices,mixed.geometry[1][0].indices);
  const padded=new Uint8Array(input.length+8);padded.set(input,4);
  assert.deepEqual(decodeMargo(padded.subarray(4,4+input.length)).geometry[0][0].vertices,p.vertices);
});

test('CAD flags, lengths, indices and normals are validated before rendering',()=>{
  const vertexEntry=80,indexEntry=96;
  for(const [offset,value] of [[vertexEntry+12,2],[indexEntry+12,3],[indexEntry+12,2],[vertexEntry+8,71]]){
    const data=Uint8Array.from(cadSource);new DataView(data.buffer).setUint32(offset,value,true);
    assert.throws(()=>decodeMargo(data),/margo/);
  }
  for(const [field,value] of [[0,NaN],[3,5],[5,0]]){
    const data=Uint8Array.from(cadSource),view=new DataView(data.buffer),offset=view.getUint32(vertexEntry+4,true);
    view.setFloat32(offset+field*4,value,true);assert.throws(()=>decodeMargo(data),/prepared PBR/);
  }
  const data=Uint8Array.from(cadSource),view=new DataView(data.buffer);view.setUint16(view.getUint32(indexEntry+4,true),3,true);
  assert.throws(()=>decodeMargo(data),/prepared PBR geometry/);
});

test('uint16 indices expand to uint32 while legacy and flagged uint32 retain input views',()=>{
  const input=Uint8Array.from(uint16Source),asset=decodeMargo(input),expected=decodeMargo(bytes());
  assert.deepEqual(asset.geometry[0][0].indices,expected.geometry[0][0].indices);
  assert.ok(asset.geometry[0][0].indices instanceof Uint32Array);assert.notEqual(asset.geometry[0][0].indices.buffer,input.buffer);
  assert.equal(asset.geometry[0][0].vertices.buffer,input.buffer);
  const flagged=bytes(),view=new DataView(flagged.buffer);view.setUint32(108,2,true);
  assert.equal(decodeMargo(flagged).geometry[0][0].indices.buffer,flagged.buffer);
});

test('conveyor adapter reads compact meshes through its existing geometry and selection path',()=>{
  const model=readModel(Uint8Array.from(cadSource).buffer),[mesh]=readMeshes(model);
  assert.equal(model.doc.nodes.length,2);
  assert.deepEqual([...mesh.positions],[-Math.fround(0.6),-Math.fround(0.6),0,Math.fround(0.6),-Math.fround(0.6),0,0,Math.fround(0.6),0]);
  assert.deepEqual([...mesh.normals],[0,0,1,0,0,1,0,0,1]);
  assert.deepEqual([...mesh.indices],[0,1,2]);assert.equal(mesh.material,0);
  assert.deepEqual(mesh.min,[-Math.fround(0.6),-Math.fround(0.6),0]);assert.deepEqual(mesh.max,[Math.fround(0.6),Math.fround(0.6),0]);
  assert.throws(()=>readModel(new ArrayBuffer(4)),/GLB/);
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
    globalThis.fetch=async()=>new Response(bytes(),{headers:{'content-length':String(257*1024*1024)}});
    await assert.rejects(loadMargo(engine,'https://example.test/asset.margo'),/byte budget/);
    await assert.rejects(loadMargo(engine,'https://example.test/asset.margo',{signal:AbortSignal.abort(new Error('cancelled'))}),/cancelled/);
  }finally{globalThis.fetch=original;engine.dispose();}
});
