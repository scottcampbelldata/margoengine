import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';

const engine=process.env.MARGO_ENGINE_CHECKOUT;
const api=(area,name)=>pathToFileURL(resolve(engine,'packages',area,'dist',name));
const {splitGLB}=await import(api('exporters','glb.js'));
const {sceneOfParts}=await import(api('exporters','glb-scene.js'));
const {collect,drawables,toWorld}=await import(api('exporters','scene.js'));
const {meshoptDecodeGltfBuffer}=await import(api('decoders','meshopt.js'));
const {Quaternion}=await import(api('math','index.js'));
const parts=splitGLB(gunzipSync(await readFile(new URL('./visitor.mesh',import.meta.url))));
const input=parts.bin, doc=parts.json;
const spans=[];
let length=0;
for (const view of doc.bufferViews) {
  const packed=view.extensions?.EXT_meshopt_compression;
  const start=view.byteOffset??0;
  const bytes=packed ? meshoptDecodeGltfBuffer(input.subarray(packed.byteOffset,packed.byteOffset+packed.byteLength),
    packed.count,packed.byteStride,packed.mode,packed.filter) : input.subarray(start,start+view.byteLength);
  spans.push(bytes);
  view.buffer=0;
  view.byteOffset=length;
  view.byteLength=bytes.length;
  delete view.extensions;
  length+=bytes.length;
  const padding=Buffer.alloc((4-length%4)%4);
  spans.push(padding);
  length+=padding.length;
}
doc.extensionsRequired=doc.extensionsRequired.filter(name=>!name.includes('meshopt'));
parts.bin=Buffer.concat(spans);
doc.buffers=[{byteLength:parts.bin.length}];
const {scene}=sceneOfParts(parts);
for (const channel of scene.animations[0].channels) {
  assert.ok(['rotation','translation','scale'].includes(channel.path));
  channel.node[channel.path]=Array.from(channel.values).slice(0,channel.path==='rotation'?4:3);
}

const control=new Map([
  ['LeftArm',-.26],['RightArm',.26],['LeftForeArm',-.086],['RightForeArm',.086],
  ['LeftUpLeg',.31],['RightUpLeg',-.31],['LeftLeg',.34],['RightLeg',-.34],
  ['LeftFoot',-.12],['RightFoot',.12],
]);
const joints=[];
function find(node,parent) {
  const name=node.name?.split(':').at(-1), amplitude=control.get(name);
  if (amplitude!==undefined) {
    const m=parent.world;
    const axis=[0,4,8].map(i=>m[i]/Math.hypot(m[i],m[i+1],m[i+2]));
    joints.push({node:node.source,start:node.r,axis,amplitude,name});
  }
  for (const child of node.children) find(child,node);
}
for (const root of collect(scene)) find(root);
assert.equal(joints.length,control.size);

const frames=[];
for (const cycle of [0,1,-1]) {
  for (const {node,start,axis:[x,y,z],amplitude,name} of joints) {
    let angle=amplitude*cycle;
    if (name.endsWith('Leg') && !name.endsWith('UpLeg')) angle=Math.max(0,angle);
    const bend=new Quaternion().setFromAxisAngle({x,y,z},angle);
    bend.multiply(new Quaternion(...start));
    node.rotation=bend.toArray();
  }
  frames.push(drawables(collect(scene)).map(drawable=>toWorld(drawable,true)));
}
assert.equal(frames[0].length,doc.materials.length);
const shaped=frames[0].map(({positions,normals,indices},index)=>{
  const count=positions.length/3;
  const header=Buffer.alloc(8);
  header.writeUInt32LE(count,0);
  header.writeUInt32LE(indices.length,4);
  const packet=[header];
  for (const [frame,meshes] of frames.entries()) {
    const mesh=meshes[index];
    assert.equal(mesh.positions.length,positions.length);
    const low=Buffer.alloc(positions.length), high=Buffer.alloc(positions.length);
    const n=Buffer.alloc(normals.length);
    const prior=[0,0,0], priorNormal=[0,0,0];
    for(let i=0;i<positions.length;i++) {
      const axis=i%3;
      const reference=frame>0?positions[i]:0;
      const point=Math.round((mesh.positions[i]-reference)*12000);
      const difference=point-prior[axis];
      low[i]=difference&255;
      high[i]=(difference>>8)&255;
      prior[axis]=point;
      const normal=Math.round(mesh.normals[i]*120);
      n[i]=(normal-priorNormal[axis])&255;
      priorNormal[axis]=normal;
    }
    packet.push(low,high,n);
  }
  const connectivity=Buffer.alloc(indices.length*2);
  for (const [offset,item] of indices.entries()) connectivity.writeUInt16LE(item,offset*2);
  return Buffer.concat([...packet,connectivity]);
});
const header=Buffer.from([2,frames.length,shaped.length,0]);
const archive=gzipSync(Buffer.concat([header,...shaped]),{level:9});
await writeFile(new URL('./opening-actors.mesh',import.meta.url),archive);
console.log({packed:archive.length,poses:frames.length,pieces:shaped.length,
  y:[Math.min(...frames[0].flatMap(mesh=>Array.from(mesh.positions).filter((_,i)=>i%3===1))),
     Math.max(...frames[0].flatMap(mesh=>Array.from(mesh.positions).filter((_,i)=>i%3===1)))],
  names:drawables(collect(scene)).map(mesh=>mesh.material.name)});
