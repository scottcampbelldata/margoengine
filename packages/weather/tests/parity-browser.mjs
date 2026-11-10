import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const name=process.argv.find(a=>['gltf','cover','lens'].includes(a))??'gltf';
const browser=await openBrowser({startPath:`/packages/weather/tests/${name}-check.html`,port:'free'});
const errors=[];browser.page.on('pageerror',e=>errors.push(e.message));
try {
  await browser.page.waitForFunction(()=>window.ready,null,{timeout:60000});
  const result=await browser.page.evaluate(()=>window.run());
  assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);assert.equal(result.validation,null);
  if(name==='gltf'){
    assert.equal(result.unchanged,0);assert.equal(result.restored,0);
    for(const key of ['wet','puddles','rings','snow'])assert.ok(result[key]>20,`${key}: ${result[key]}`);
  }
  console.log(name,JSON.stringify(result));
} finally {await browser.close();}
