import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {gzipSync} from 'node:zlib';

const directory=process.argv[2];
if (!directory) throw new Error('Pass the folder with captures from the pinned Boulder controller.');
const output=(name,data)=>writeFile(new URL('./'+name,import.meta.url),gzipSync(data,{level:9}));

function posePacket(frames) {
  const count=frames.length;
  const row=frames[0].palette.length+9;
  const header=12;
  const samples=count*row;
  const buffer=Buffer.alloc(header+2*samples+2*count);
  buffer.write('BLD1');
  buffer.writeUInt16LE(count,4);
  buffer.writeUInt16LE(row,6);
  buffer.writeUInt16LE(20,8);
  for(const [i,frame] of frames.entries()) {
    const values=[...frame.palette,...frame.eye,...frame.look,frame.pose,frame.gap,frame.travel];
    for(const [column,value] of values.entries()) {
      const scale=column===row-2?100000:8192;
      const point=Math.round(value*scale);
      if(point>32767 || point< -32768) throw new RangeError('Opening sample does not fit its stored scale.');
      const previous=i?Math.round(frameValues(frames[i-1],column,row)*scale):0;
      const signed=(point-previous)<<16>>16;
      const encoded=(signed<<1)^(signed>>15);
      const at=column*count+i;
      buffer[header+at]=encoded&255;
      buffer[header+samples+at]=encoded>>>8;
    }
    buffer[header+2*samples+i]=frame.contacts;
    buffer[header+2*samples+count+i]=frame.moving+1;
  }
  return buffer;
}

function frameValues(frame,column,row) {
  if(column<row-9)return frame.palette[column];
  return [...frame.eye,...frame.look,frame.pose,frame.gap,frame.travel][column-(row-9)];
}

for(const name of ['red','blue','green']){
  const frames=JSON.parse(await readFile(resolve(directory,name+'-source.json'),'utf8'));
  await output('opening-'+name+'.pose',posePacket(frames));
}
const cell=JSON.parse(await readFile(resolve(directory,'cell-source.json'),'utf8'));
const round=(value,digits)=>Number(value.toFixed(digits));
for(const shape of cell.geometry) {
  shape.vertices=shape.vertices.map((value,i)=>round(value,i%6<3?5:4));
}
await output('opening-cell.mesh',JSON.stringify(cell));
