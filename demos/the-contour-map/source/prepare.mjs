import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
const checkout=process.env.MARGO_ENGINE_CHECKOUT;
const {contour2D}=await import(pathToFileURL(resolve(checkout,'packages/sciviz/dist/contour2d.js')));
const root=new URL('./assets/',import.meta.url);
const metadata=JSON.parse(await readFile(new URL('record.json',root),'utf8'));
const raw=gunzipSync(await readFile(new URL('dem-helens.dat',root)));
const n=metadata.resolution;
assert.equal(raw.byteLength,n*n*2);
const values=Float32Array.from({length:n*n},(_,i)=>raw.readUInt16LE(i*2)/4);
const axis=Float64Array.from({length:n},(_,i)=>(i+.5)*metadata.metersPerCell);
const specs={};
for(const interval of [100,200,400]){
  const levels=[500];
  for(let alt=600;alt<metadata.max;alt+=interval)levels.push(alt);
  levels.push(2600);
  const result=await contour2D({x:axis,y:axis,values},{levels});
  const chunks=[Buffer.alloc(2)];
  chunks[0].writeUInt16LE(result.lines.length);
  for(const line of result.lines){
    assert.ok(line.points.length>=2&&line.points.length<65536);
    const out=Buffer.alloc(line.points.length*4+5);
    out.writeUInt16LE(line.level,0);
    out.writeUInt16LE(line.points.length,2);
    out[4]=line.closed?1:0;
    line.points.forEach(([x,y],i)=>{
      out.writeUInt16LE(Math.round(x*4),5+i*4);
      out.writeUInt16LE(Math.round(y*4),7+i*4);
    });
    chunks.push(out);
  }
  const key='contour-'+interval+'.paths', bytes=gzipSync(Buffer.concat(chunks),{level:9});
  await writeFile(new URL(key,root),bytes);
  specs[interval]={key,levels,lines:result.lines.length,bands:result.bands.length,bytes:bytes.length};
}
await writeFile(new URL('intervals.json',root),JSON.stringify(specs)+'\n');
console.log(specs);
