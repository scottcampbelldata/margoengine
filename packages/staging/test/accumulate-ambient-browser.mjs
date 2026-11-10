import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
const rows=[];
for(const compat of [false,true]){
 const browser=await openBrowser({startPath:'/packages/staging/test/accumulate-ambient-browser.html',port:'free',...(compat&&process.platform==='win32'?{args:['--use-angle=vulkan']}:{})});
 const errors=[];browser.page.on('pageerror',e=>errors.push(e.message));
 try{
  await browser.page.waitForFunction(()=>window.ready,null,{timeout:30000});
  const result=await browser.page.evaluate(c=>window.run(c),compat);console.log(JSON.stringify({compat,...result}));
  assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);assert(result.mae<.01,'hemisphere closes most of the 0.048 contact-reference loss');
  assert(result.skyHold);assert(result.reset);assert(result.repeat);assert(result.restored);assert(result.empty);
  assert(result.columns.every(v=>v>0));assert(Math.max(...result.columns)/Math.min(...result.columns)>2,'distinct weighted light shadows');
  rows.push({compat,hardware:browser.hardware,...result});
 }finally{await browser.close();}
}
await writeFile('test-results/staging-accumulate-ambient.json',JSON.stringify(rows,null,2)+'\n');
