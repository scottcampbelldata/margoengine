import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
const name=process.argv.find(a=>['gltf','cover','lens'].includes(a))??'gltf';
const browser=await openBrowser({startPath:`/packages/weather/tests/${name}-check.html`,port:'free'});
const errors=[];browser.page.on('pageerror',e=>errors.push(e.message));
try {
  await browser.page.waitForFunction(()=>window.ready,null,{timeout:60000});
  const result=await browser.page.evaluate(()=>window.run());
  console.log(name,JSON.stringify(result));
  assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);assert.equal(result.validation,null);
  if(name==='gltf'){
    assert.equal(result.unchanged,0);assert.equal(result.restored,0);
    for(const key of ['wet','puddles','rings','snow'])assert.ok(result[key]>20,`${key}: ${result[key]}`);
  }
  if(name==='lens'){
    assert.ok(result.math.cases>=2000&&result.math.worst<1e-4&&result.math.wet>100,JSON.stringify(result.math));
    assert.equal(result.repeat,0);assert.equal(result.disabled,0);
    for(const key of ['wet','moved','streaks','seeded'])assert.ok(result[key]>100,`${key}: ${result[key]}`);
  }
} finally {await browser.close();}
