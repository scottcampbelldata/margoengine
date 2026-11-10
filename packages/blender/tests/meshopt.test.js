import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compressMargoMeshopt, expandMargoMeshopt, decodeMargoMeshopt, parseMargoMeshopt, loadMargoMeshopt } from '../dist/meshopt.js';
import { decodeMargo } from '../dist/index.js';

function readContainer(bytes) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const sections=Array.from({length:view.getUint32(12,true)},(_,i)=>{
    const at=64+i*16,offset=view.getUint32(at+4,true),size=view.getUint32(at+8,true);
    return {type:view.getUint32(at,true),flags:view.getUint32(at+12,true),offset,bytes:new Uint8Array(bytes.buffer,bytes.byteOffset+offset,size)};
  });
  return {sections,manifest:JSON.parse(new TextDecoder().decode(sections[0].bytes))};
}

const files=['triangle.margo','triangle-uint16.margo','compact-triangle.margo','anim.margo','objects.margo','curves.margo','lightmap.margo'];
const fixtures=await Promise.all(files.map(f=>readFile(new URL(`./fixtures/${f}`,import.meta.url))));
const flag=bytes=>new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(20,true);
test('meshopt preserves every geometry byte, vertex attribute, triangle order, section and scene variant',async()=>{
  let saved=0;
  for(const [i,bytes]of fixtures.entries()){
    const encoded=await compressMargoMeshopt(bytes);
    const expanded=expandMargoMeshopt(encoded);
    const before=readContainer(bytes,flag(bytes)),after=readContainer(expanded,flag(expanded));
    assert.deepEqual(after.manifest,before.manifest,files[i]);
    assert.equal(after.sections.length,before.sections.length);
    after.sections.slice(1).forEach((s,k)=>{
      assert.equal(s.type,before.sections[k+1].type);
      assert.equal(s.flags,before.sections[k+1].flags);
      assert.deepEqual(s.bytes,before.sections[k+1].bytes,`${files[i]} section ${k+1}`);
    });
    assert.ok(encoded.length<=bytes.length);
    saved+=bytes.length-encoded.length;
    if(flag(bytes)===0){
      const a=decodeMargo(bytes),b=decodeMargoMeshopt(encoded);
      assert.deepEqual(b.geometry,a.geometry);
    }
  }
  assert.ok(saved>0,'real Blender fixtures shrink without dropping work or precision');
});
test('compressed files name their entry and corrupt streams/expansion bombs fail before upload',async()=>{
  const encoded=await compressMargoMeshopt(fixtures[3]);
  assert.equal(flag(encoded),4);
  assert.throws(()=>decodeMargo(encoded),/Meshopt.*blender\/meshopt/);
  const container=readContainer(encoded,4),section=container.sections.find(s=>s.type===9);
  assert.ok(section);
  const corrupt=encoded.slice();corrupt[section.offset+16]=0;
  assert.throws(()=>expandMargoMeshopt(corrupt),/meshopt|vertex stream/i);
  const bomb=encoded.slice();new DataView(bomb.buffer).setUint32(section.offset+12,0xfffffffc,true);
  assert.throws(()=>expandMargoMeshopt(bomb),/Invalid .margo meshopt/);
  const signal=AbortSignal.abort(new Error('cancel meshopt'));
  assert.throws(()=>expandMargoMeshopt(encoded,{signal}),/cancel meshopt/);
  await assert.rejects(compressMargoMeshopt(encoded,{signal}),/cancel meshopt/);
  await assert.rejects(parseMargoMeshopt({},encoded,{signal}),/cancel meshopt/);
  await assert.rejects(loadMargoMeshopt({},'file:///scene.margo'),/HTTP\(S\)/);
});
