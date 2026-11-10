import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
const rows=[];
for(const compat of [false,true]){
 const browser=await openBrowser({startPath:'/packages/staging/test/backdrop-browser.html',port:'free',...(compat&&process.platform==='win32'?{args:['--use-angle=vulkan']}:{})});
 const errors=[];browser.page.on('pageerror',e=>errors.push(e.message));
 try{
  await browser.page.waitForFunction(()=>window.ready,null,{timeout:30000});assert(await browser.page.evaluate(c=>window.check.init(c),compat)>0);
  const images=[],snap=async()=>decodePNG(await browser.page.locator('canvas').screenshot());
  for(const name of ['portrait','rembrandt','upfront','soft']){await browser.page.evaluate(n=>window.check.preset(n),name);images.push(await snap());}
  const diff=(a,b)=>a.data.reduce((s,v,i)=>s+(v!==b.data[i]),0),differences=images.slice(1).map(x=>diff(x,images[0]));
  assert(differences.every(n=>n>100));assert(images.every(im=>im.data.some((v,i)=>i%4!==3&&v>20)));
  assert(await browser.page.evaluate(()=>window.check.restore()));const restored=await snap();assert.equal(diff(restored,images[3]),0);
  await browser.page.evaluate(()=>window.check.hideBackdrop());const removed=await snap(),backdropPixels=diff(restored,removed);assert(backdropPixels>1000);
  const finish=await browser.page.evaluate(()=>window.check.dispose());assert.deepEqual(errors,[]);assert.deepEqual(finish.errors,[]);assert(finish.detached);
  rows.push({compat,hardware:browser.hardware,differences,backdropPixels,restoreError:0});console.log(JSON.stringify(rows.at(-1)));
 }finally{await browser.close();}
}
await writeFile('test-results/staging-backdrop.json',JSON.stringify(rows,null,2)+'\n');
