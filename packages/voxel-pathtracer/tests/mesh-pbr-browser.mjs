import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from '../../../scripts/browser.js';
import {legDevice} from '../../../scripts/support/compat-shim.js';
const rows=[];
for(const compat of [false,true]){
 const context=await openBrowser({startPath:'/packages/voxel-pathtracer/tests/mesh-pbr.html',port:'free',...(compat&&process.platform==='win32'?{args:['--use-angle=vulkan']}:{})});
 const errors=[];context.page.on('pageerror',e=>errors.push(e.message));
 try{
  await context.page.waitForFunction(()=>window.ready,null,{timeout:120000});
  const result=await context.page.evaluate(c=>window.run(c),compat);
  console.log(JSON.stringify({compat,device:legDevice(compat,context.hardware),hardware:context.hardware,result}));
  assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);assert.deepEqual(result.messages,[]);assert.equal(result.rows.length,10);
  for(const row of result.rows){assert.equal(row.finite,true,row.name);if(row.moved!==undefined){assert.ok(row.moved>1e-3,`${row.name}: the skin moved ${row.moved}`);assert.equal(row.snapshotError,0,row.name);assert.ok(row.differs>1e-3,`${row.name}: poses drew alike (${row.differs})`);assert.equal(row.repeat,0,`${row.name}: the first pose drew ${row.repeat} apart the second time`);assert.equal(row.drawn,true,row.name);}else if(row.ratioError!==undefined)assert.ok(row.ratioError<.05,`${row.name}: ratio ${row.ratio}`);else if(row.maximumError!==undefined)assert.ok(row.maximumError<1e-5,`${row.name}: ${row.maximumError}`);else{assert.ok(row.triangles>0);assert.equal(row.drawn,true);}}
  rows.push({compat,device:legDevice(compat,context.hardware),hardware:context.hardware,result});
 }finally{await context.close();}
}
await writeFile('test-results/voxel-pathtracer-mesh-pbr.json',JSON.stringify(rows,null,2));
