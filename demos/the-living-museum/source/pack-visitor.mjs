import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

// Resize the existing licensed glTF atlas for the gallery's distant camera and repack its binary.
const [source,destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Provide a packed GLB and a destination.');
const original = readFileSync(source);
const jsonLength = original.readUInt32LE(12);
const doc = JSON.parse(original.subarray(20,20+jsonLength));
const bin = original.subarray(28+jsonLength);
const imageViews = new Set(doc.images.map(image=>image.bufferView));
const pieces=[];
let cursor=0;

function append(data) {
  const padding=Buffer.alloc((4-data.length%4)%4);
  pieces.push(data,padding);
  const at=cursor;
  cursor+=data.length+padding.length;
  return at;
}

for (const [index,view] of doc.bufferViews.entries()) {
  const packed = view.extensions?.EXT_meshopt_compression;
  if(packed?.buffer===0) {
    const at=packed.byteOffset??0;
    packed.byteOffset=append(bin.subarray(at,at+packed.byteLength));
  }
  if(view.buffer!==0)continue;
  const at=view.byteOffset??0;
  let data=bin.subarray(at,at+view.byteLength);
  if(imageViews.has(index)){
    const result=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-f','webp_pipe','-i','pipe:0',
      '-vf','scale=128:128:force_original_aspect_ratio=decrease','-frames:v','1','-c:v','libwebp',
      '-quality','82','-f','webp','pipe:1'],{input:data});
    if(result.status!==0 || !result.stdout?.length)throw new Error(String(result.stderr??result.error));
    data=result.stdout;
  }
  view.byteOffset=append(data);
  view.byteLength=data.length;
}

doc.buffers[0].byteLength=cursor;
const json=Buffer.from(JSON.stringify(doc));
const aligned=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);
const header=Buffer.alloc(20), binaryHeader=Buffer.alloc(8);
header.writeUInt32LE(0x46546c67,0);
header.writeUInt32LE(2,4);
header.writeUInt32LE(28+aligned.length+cursor,8);
header.writeUInt32LE(aligned.length,12);
header.writeUInt32LE(0x4e4f534a,16);
binaryHeader.writeUInt32LE(cursor,0);
binaryHeader.writeUInt32LE(0x004e4942,4);
writeFileSync(destination,gzipSync(Buffer.concat([header,aligned,binaryHeader,...pieces]),{level:9}));
