import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
const rows=[];
for(const compat of [false,true]){
 const browser=await openBrowser({startPath:'/packages/staging/test/caustics-browser.html',port:'free',...(compat&&process.platform==='win32'?{args:['--use-angle=vulkan']}:{})});
 const errors=[];browser.page.on('pageerror',e=>errors.push(e.message));
 try{
  await browser.page.waitForFunction(()=>window.ready,null,{timeout:30000});const r=await browser.page.evaluate(c=>window.run(c),compat);
  const png=await decodePNG(await browser.page.locator('canvas').screenshot());r.catcherPixels=0;for(let i=0;i<png.data.length;i+=4)if(png.data[i]>10)r.catcherPixels++;
  console.log(JSON.stringify({compat,...r}));
  assert.deepEqual(errors,[]);assert.deepEqual(r.errors,[]);assert(r.waterError<1e-5);assert(r.glassError<1e-5);assert(r.catcherPixels>100);assert(r.held);assert(r.lensPeak>1);assert(r.flux>0&&r.flux<1);
  assert(r.cancelled);assert.equal(r.abortError,0);assert.equal(r.restoreError,0);assert(r.pointPower>0);assert(r.rejected);assert(r.liveHeightRejected);assert(r.recovery);rows.push({compat,hardware:browser.hardware,...r});
 }finally{await browser.page.evaluate(()=>window.cleanup?.());await browser.close();}
}
await writeFile('test-results/staging-caustics.json',JSON.stringify(rows,null,2)+'\n');
