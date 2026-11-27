import { readFileSync, writeFileSync } from 'node:fs';

const [sourcePath, packedPath, destination] = process.argv.slice(2);
function readGLB(path) {
  const bytes = readFileSync(path);
  const length = bytes.readUInt32LE(12);
  return { doc: JSON.parse(bytes.subarray(20, 20 + length)), bin: bytes.subarray(28 + length) };
}
const source=readGLB(sourcePath), packed=readGLB(packedPath);
const {doc}=packed;
const pieces=[packed.bin];
let byteOffset=packed.bin.length;
const copied=new Map();

// Keep geometry compression and use the authored floating point animation tracks.
function copyAccessor(index) {
  if(copied.has(index))return copied.get(index);
  const accessor=source.doc.accessors[index];
  const view=source.doc.bufferViews[accessor.bufferView];
  if(accessor.componentType!==5126||accessor.sparse||view.buffer!==0)throw Error('Expected authored Float32 animation tracks.');
  const at=view.byteOffset??0;
  const data=source.bin.subarray(at,at+view.byteLength);
  const viewIndex=doc.bufferViews.push({...view,byteOffset})-1;
  pieces.push(data);
  byteOffset+=data.length;
  const result=doc.accessors.push({...accessor,bufferView:viewIndex})-1;
  copied.set(index,result);
  return result;
}
const nodeByName=new Map(doc.nodes.map((node,index)=>[node.name,index]));
doc.animations=source.doc.animations.map((clip)=>({
  ...clip,
  channels:clip.channels.map((channel)=>{
    const node=nodeByName.get(source.doc.nodes[channel.target.node].name);
    if(node===undefined)throw Error('Packed model dropped an animated joint.');
    return {...channel,target:{...channel.target,node}};
  }),
  samplers:clip.samplers.map((sampler)=>({...sampler,input:copyAccessor(sampler.input),output:copyAccessor(sampler.output)})),
}));
const binary=Buffer.concat(pieces);
doc.buffers[0].byteLength=binary.length;
const json=Buffer.from(JSON.stringify(doc));
const padded=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,0x20)]);
const header=Buffer.alloc(20), binHeader=Buffer.alloc(8);
header.writeUInt32LE(0x46546c67,0);
header.writeUInt32LE(2,4);
header.writeUInt32LE(28+padded.length+binary.length,8);
header.writeUInt32LE(padded.length,12);
header.writeUInt32LE(0x4e4f534a,16);
binHeader.writeUInt32LE(binary.length,0);
binHeader.writeUInt32LE(0x004e4942,4);
writeFileSync(destination,Buffer.concat([header,padded,binHeader,binary]));
