import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {instance:{exports:m}}=await WebAssembly.instantiate(readFileSync(new URL('../target/wasm32-unknown-unknown/release/margoengine_draco.wasm',import.meta.url)));
const data=readFileSync(new URL('./fixtures/flavor.bin',import.meta.url));let at=0;
const num=()=>{const n=data.readUInt32LE(at);at+=4;return n;},blob=()=>{const n=num(),b=data.subarray(at,at+n);at+=n;return b;};
function decode(input,flavor){
 const p=m.draco_alloc(input.length);assert.ok(p);let out=0,size=0;
 try{new Uint8Array(m.memory.buffer,p,input.length).set(input);out=m.draco_decode(p,input.length,8192,24576,2097152,flavor);assert.ok(out);size=new DataView(m.memory.buffer).getUint32(out,true);return Buffer.from(new Uint8Array(m.memory.buffer,out,size));}
 finally{if(out)m.draco_free(out,size);m.draco_free(p,input.length);}
}
const count=num(),seeds=[];let prefixes=0,distinct=0;assert.equal(count,214);
for(let i=0;i<count;i++){
 const name=blob().toString(),input=blob(),full=blob(),gltf=blob();
 assert.deepEqual(decode(input,0),full,name+' full');assert.deepEqual(decode(input,1),gltf,name+' glTF');
 if(!full.equals(gltf))distinct++;
 assert.equal(decode(input,2).readUInt32LE(4),4,'uncoded invalid flavor');
 for(let end=1;end<input.length;end++){assert.ok(decode(input.subarray(0,end),1).readUInt32LE(4)>0,`${name}/${end}`);prefixes++;}
 if(i%29===0)seeds.push(input);
}
assert.equal(at,data.length);assert.ok(distinct>=128);
let random=0x2043e19b;
for(let i=0;i<4096;i++){
 const input=Buffer.from(seeds[i%seeds.length]);random^=random<<13;random^=random>>>17;random^=random<<5;input[(random>>>0)%input.length]^=random>>>24;
 for(const flavor of [0,1]){const a=decode(input,flavor);assert.ok(a.readUInt32LE(4)<=6);assert.deepEqual(a,decode(input,flavor));}
}
const memory=m.memory.buffer.byteLength;for(let i=0;i<2000;i++)decode(seeds[i%seeds.length],i%2);assert.equal(m.memory.buffer.byteLength,memory);
console.log(JSON.stringify({exactCases:count,distinct,prefixes,mutations:4096,repeatedDecodeFree:2000,peakWasmLinearBytes:memory}));
