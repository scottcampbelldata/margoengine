import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {deflateSync} from 'node:zlib';
import {execFileSync} from 'node:child_process';
import {bakeInputs,modeNames} from './optics.js';
import {MAP_SIZE,packMap} from './package-map.js';

const engineRevision='0efd9cff8230507a32deb49907ecd499d46925f5';
const checkout=process.env.MARGO_ENGINE_CHECKOUT;
if(!checkout)throw new Error('Set MARGO_ENGINE_CHECKOUT to the built public engine checkout.');
if(execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==engineRevision){
  throw new Error('The Margo checkout does not match the exhibit pin.');
}
const {bakeRefractedLightmap}=await import(pathToFileURL(resolve(checkout,'packages/lightmap/dist/refracted.js')));

function chunk(type,payload){
  const length=Buffer.alloc(4),name=Buffer.from(type),crc=Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  let checksum=0xffffffff;
  for(const part of [name,payload])for(const byte of part){
    checksum^=byte;
    for(let i=0;i<8;i++)checksum=(checksum>>>1)^(checksum&1?0xedb88320:0);
  }
  crc.writeUInt32BE((checksum^0xffffffff)>>>0);
  return Buffer.concat([length,name,payload,crc]);
}
function png(rgba){
  const header=Buffer.alloc(13),rows=Buffer.alloc((MAP_SIZE*3+1)*MAP_SIZE);
  header.writeUInt32BE(MAP_SIZE,0);
  header.writeUInt32BE(MAP_SIZE,4);
  header[8]=8;
  header[9]=2;
  for(let y=0;y<MAP_SIZE;y++){
    let output=y*(MAP_SIZE*3+1);
    rows[output++]=1;
    let pixel=y*MAP_SIZE*4;
    for(let x=0;x<MAP_SIZE;x++,pixel+=4)for(let c=0;c<3;c++){
      rows[output++]=(rgba[pixel+c]-(x>0?rgba[pixel-4+c]:0)+256)&255;
    }
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),
    chunk('IDAT',deflateSync(rows,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
const stats={};
for(const key of modeNames){
  const start=performance.now();
  const packed=packMap(await bakeRefractedLightmap(...bakeInputs(key)));
  await writeFile(new URL('./bakes/'+key+'.png',import.meta.url),png(packed.rgba));
  stats[key]=packed.stats;
  console.log(key,Math.round(performance.now()-start),packed.stats);
}
await writeFile(new URL('./bakes/stats.json',import.meta.url),JSON.stringify(stats,null,2)+'\n');
