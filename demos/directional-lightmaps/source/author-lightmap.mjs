import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { pathToFileURL,fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const checkout=process.env.MARGO_ENGINE_CHECKOUT;
const revision=execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
assert.equal(revision,'0efd9cff8230507a32deb49907ecd499d46925f5');
const {bakeDirectionalLightmap,directionalIrradiance}=await import(pathToFileURL(resolve(checkout,'packages/lightmap/dist/directional.js')));
const folder=new URL('.',import.meta.url);
const bytes=await readFile(new URL('exhibit.json',folder),'utf8');
const exhibit=JSON.parse(bytes.replace(/^\uFEFF/,''));
const {width,height,centerY,light}=exhibit;
const x=width/2,y0=centerY-height/2,y1=centerY+height/2;
const geometry={
  positions:new Float32Array([-x,y0,0,x,y0,0,x,y1,0,-x,y1,0]),
  normals:new Float32Array([0,0,1,0,0,1,0,0,1,0,0,1]),
  uv1:new Float32Array([0,1,1,1,1,0,0,0]),
  indices:new Uint32Array([0,1,2,0,2,3]),
};
const result=await bakeDirectionalLightmap(geometry,{
  width:48,height:30,radiometry:'physical',aoRays:16,
  lights:[
    {type:'point', position:light, distance:4.2, color:[1,.81,.66], intensity:6.8},
    {type:'ambient', color:[.57,.77,1], intensity:.93},
  ],
});
const center=15*result.width+24;
const forward=directionalIrradiance(result,center,[0,0,1],[0,0,1]);
const slopes=[[-.65,.61,.454],[.65,-.61,.454]].map(n=>directionalIrradiance(result,center,n,[0,0,1]));
assert.equal(result.overlaps,0);
assert.equal(result.samples,result.width*result.height);
assert.ok(slopes[0][0]>forward[0]&&forward[0]>slopes[1][0]);
const metadata=Buffer.alloc(16);
metadata.write('DLM3',0,'ascii');
metadata.writeUInt16LE(result.width,4);
metadata.writeUInt16LE(result.height,6);
metadata.writeFloatLE(result.lightmapScale,8);
metadata.writeFloatLE(result.directionalScale,12);
const packed=Buffer.concat([metadata,result.lightmap,result.directionMap,result.directionalMap]);
await writeFile(fileURLToPath(new URL('tide-register.bin',folder)),gzipSync(packed,{level:9}));
console.log(JSON.stringify({
  bakeSize:[result.width,result.height], texels:result.samples,
  scale:result.lightmapScale,directionScale:result.directionalScale,
  centerForward:forward,centerSlopes:slopes,packed:packed.length,
}));
