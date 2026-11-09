import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {openBrowser} from '../../../scripts/browser.js';
const results=[];
for(const compat of [false,true]){
 const context=await openBrowser({startPath:'/packages/voxel-pathtracer/tests/restir.html',port:'free',...(compat&&process.platform==='win32'?{args:['--use-angle=vulkan']}:{})});
 const errors=[];context.page.on('pageerror',error=>errors.push(error.message));
 try{
  await context.page.waitForFunction(()=>window.ready,null,{timeout:120000});
  const result=await context.page.evaluate(compat=>window.run(compat),compat);
  console.log(JSON.stringify({compat,hardware:context.hardware,result}));
  assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);
  assert.equal(result.maxBaselineDelta,0,'one proposal must be pixel-identical to the baseline');
  assert.equal(result.refusal?.code,'unsupported');
  assert.match(result.refusal.message,/https:\/\/margoengine.com\/errors#voxel-pathtracer/);
  assert.ok(result.risError<result.baseError/2,`RIS squared error ${result.risError} must beat baseline ${result.baseError} by 2x`);
  assert.ok(Math.abs(result.risMean-result.referenceMean)<0.02,'converged mean must be preserved within sampling uncertainty');
  for(const scene of result.coverage){
   assert.equal(scene.finite,true,scene.name);
   for(let channel=0;channel<3;channel++)
    assert.ok(Math.abs(scene.actual[channel]-scene.reference[channel])<0.02,`${scene.name} channel ${channel}: ${scene.actual[channel]} vs ${scene.reference[channel]}`);
   if(scene.expected!==undefined){
    for(const value of [...scene.reference,...scene.actual])
     assert.ok(Math.abs(value-scene.expected)<0.02,`${scene.name}: ${value} vs independent integral ${scene.expected}`);
   }
  }
  results.push({compat,hardware:context.hardware,result});
 }finally{await context.close();}
}
const lifecycle=await openBrowser({startPath:'/packages/voxel-pathtracer/tests/browser-check.html?restir=1',port:'free'});
try{
 await lifecycle.page.waitForFunction(()=>window.ready,null,{timeout:120000});
 const result=await lifecycle.page.evaluate(()=>window.check.viewport());
 assert.deepEqual(result.errors,[]);assert.deepEqual(result.messages,[]);
 assert.equal(result.disabled.differing,0);assert.equal(result.afterDispose.differing,0);
 assert.equal(result.restored.differing,0);assert.equal(result.newDevice,true);
 assert.ok(result.traced.differing>1000);assert.equal(result.statsAfter.converged,true);
 results.push({lifecycle:result});
}finally{await lifecycle.close();}
await mkdir('test-results',{recursive:true});
await writeFile('test-results/voxel-pathtracer-restir.json',JSON.stringify(results,null,2));
