import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const checkout=process.env.MARGO_ENGINE_CHECKOUT;
const buildFile=await readFile('build.mjs','utf8');
const revision=buildFile.match(/const engineRevision = '([a-f0-9]+)'/)[1];
assert.equal(execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),revision);
execFileSync('git',['-C',checkout,'merge-base','--is-ancestor','HEAD','origin/main']);
const {build,preview}=await import(pathToFileURL(resolve(checkout,'node_modules/vite/dist/node/index.js')));
const {chromium}=await import(pathToFileURL(resolve(checkout,'node_modules/playwright/index.mjs')));
const {closeAll}=await import(pathToFileURL(resolve(checkout,'scripts/support/shutdown.mjs')));
const root=resolve('src/the-simplifier/tools'), outDir=resolve('qa-output/simplifier/bake-dist');
const packages={name:'verified-engine',enforce:'pre',async resolveId(id) {
  if(!id.startsWith('@margoengine/'))return;
  const [,pkg,...sub]=id.split('/');
  const folder=resolve(checkout,'packages',pkg);
  const spec=JSON.parse(await readFile(resolve(folder,'package.json'),'utf8')).exports[sub.length?'./'+sub.join('/'):'.'];
  return resolve(folder,typeof spec==='string'?spec:spec.import??spec.default);
}};
await build({root,base:'./',configFile:false,publicDir:false,plugins:[packages],
  build:{outDir,emptyOutDir:true,rollupOptions:{input:resolve(root,'bake.html')},target:'es2022'}});
const server=await preview({root,configFile:false,build:{outDir},preview:{host:'127.0.0.1',port:5416}});
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--enable-unsafe-webgpu']});
try {
  const page=await browser.newPage();
  await page.goto(new URL('bake.html',server.resolvedUrls.local[0]).href);
  await page.waitForFunction(()=>!!globalThis.result,null,{timeout:45000});
  const {levels,carved,error}=await page.evaluate(()=>globalThis.result);
  assert.equal(error,undefined);
  function encode(level) {
    const {positions,indices}=level;
    const count=positions.length/3;
    assert.ok(count<65536&&indices.length%3===0);
    const header=Buffer.alloc(8);
    header.writeUInt32LE(count,0);
    header.writeUInt32LE(indices.length,4);
    const pos=Buffer.alloc(positions.length*2), conn=Buffer.alloc(indices.length*2);
    const previous=[0,0,0];
    for(let i=0;i<positions.length;i++) {
      const axis=i%3,value=Math.round(positions[i]*10000);
      const step=value-previous[axis];
      pos[i]=step&255;
      pos[i+positions.length]=(step>>8)&255;
      previous[axis]=value;
    }
    let last=0;
    for(let i=0;i<indices.length;i++) {
      assert.ok(indices[i]>=0&&indices[i]<count);
      const step=indices[i]-last;
      conn[i]=step&255;
      conn[i+indices.length]=(step>>8)&255;
      last=indices[i];
    }
    return Buffer.concat([header,pos,conn]);
  }
  const counts=levels.map(level=>level.indices.length/3);
  assert.ok(counts[0]>10000&&counts.at(-1)<=counts[0]/16,JSON.stringify(counts));
  assert.ok(counts.every((count,index)=>index===0||count<counts[index-1]),JSON.stringify(counts));
  const bytes=gzipSync(Buffer.concat([Buffer.from([1,levels.length,0,0]),...levels.map(encode)]),{level:9});
  await writeFile(resolve(root,'../assets/statue.bin'),bytes);
  console.log({carved,counts,bytes:bytes.length,lowest:Math.min(...levels[0].positions.filter((_,i)=>i%3===1))});
}finally{
  await closeAll({browser,servers:[server]});
}
