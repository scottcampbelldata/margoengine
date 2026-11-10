import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const rows=[];
for(const compat of [false,true]){
 const browser=await openBrowser({startPath:'/packages/staging/test/pathtrace-materials-browser.html',port:'free',...(compat&&process.platform==='win32'?{args:['--use-angle=vulkan']}:{})});
 const errors=[];browser.page.on('pageerror',e=>errors.push(e.message));
 try{
  await browser.page.waitForFunction(()=>window.ready,null,{timeout:30000});
  const result=await browser.page.evaluate(c=>window.run(c),compat);
  assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);
  assert(result.waiting);assert(result.idle);assert(result.maps>0);assert(result.hits>0);assert(result.difference>.01);
  assert.equal(result.restoreError,0);assert(result.aborted);assert.equal(result.png,'image/png');
  for(const row of result.rows){assert(row.finite);assert(row.error<1e-5,`${row.name}: ${row.error}`);}
  rows.push({compat,hardware:browser.hardware,...result});console.log(JSON.stringify(rows.at(-1)));
 }finally{await browser.close();}
}
await writeFile('test-results/staging-pathtrace-materials.json',JSON.stringify(rows,null,2)+'\n');
