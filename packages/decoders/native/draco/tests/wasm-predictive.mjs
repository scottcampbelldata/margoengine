// All expected bytes come from crafted-input public black-box runs.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const {instance:{exports:m}}=await WebAssembly.instantiate(readFileSync(new URL('../target/wasm32-unknown-unknown/release/margoengine_draco.wasm',import.meta.url)));
const data=readFileSync(new URL('./fixtures/predictive.bin',import.meta.url));let at=0;
const num=()=>{const n=data.readUInt32LE(at);at+=4;return n;},blob=()=>{const n=num(),b=data.subarray(at,at+n);at+=n;return b;};
function decode(input,flavor=0){
 const p=m.draco_alloc(input.length);assert.ok(p);let out=0,size=0;
 try{new Uint8Array(m.memory.buffer,p,input.length).set(input);out=m.draco_decode(p,input.length,8192,24576,2097152,flavor);assert.ok(out);size=new DataView(m.memory.buffer).getUint32(out,true);return Buffer.from(new Uint8Array(m.memory.buffer,out,size));}
 finally{if(out)m.draco_free(out,size);m.draco_free(p,input.length);}
}
const count=num(),seeds=[];let prefixes=0;assert.equal(count,2160);
for(let i=0;i<count;i++){
 const name=blob().toString(),input=blob(),expected=blob();
 for(const flavor of [0,1])assert.deepEqual(decode(input,flavor),expected,name+' flavor'+flavor);
 for(let end=1;end<input.length;end++){assert.ok(decode(input.subarray(0,end)).readUInt32LE(4)>0,`${name}/${end}`);prefixes++;}
 if(i%31===0)seeds.push(input);
}
assert.equal(at,data.length);
let random=0x13321;
for(let i=0;i<8192;i++){
 const input=Buffer.from(seeds[i%seeds.length]);random^=random<<13;random^=random>>>17;random^=random<<5;input[(random>>>0)%input.length]^=random>>>24;
 const a=decode(input,i%2);assert.ok(a.readUInt32LE(4)<=6);assert.deepEqual(a,decode(input,i%2));
}
const memory=m.memory.buffer.byteLength;for(let i=0;i<2000;i++)decode(seeds[i%seeds.length],i%2);assert.equal(m.memory.buffer.byteLength,memory);
console.log(JSON.stringify({exactCases:count,flavors:2,prefixes,mutations:8192,repeatedDecodeFree:2000,peakWasmLinearBytes:memory}));
