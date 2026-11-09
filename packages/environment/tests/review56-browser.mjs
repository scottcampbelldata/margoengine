import assert from 'node:assert/strict';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
const context=await openBrowser({startPath:'/packages/environment/tests/review56-browser.html',port:'free'}),{page}=context,errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.waitForFunction(()=>window.ready,null,{timeout:30000});
 const shot=async()=>decodePNG(await page.locator('canvas').screenshot());
 for(const kind of ['floor','color','image'])for(const scissor of [false,true]){
  await page.evaluate(()=>window.check.init());const before=await shot();
  assert.deepEqual(await page.evaluate(({kind,scissor})=>window.check.draw(kind,scissor),{kind,scissor}),[]);
  const after=await shot();let inside=0,outside=0;
  for(let y=0;y<64;y++)for(let x=0;x<128;x++)for(let c=0;c<3;c++){
   const i=(y*128+x)*4+c;if(before.data[i]!==after.data[i]){if(x<(scissor?32:64))inside++;else outside++;}
  }
  assert(inside>100,`${kind} draws within its view`);assert.equal(outside,0,`${kind} preserves every component outside viewport/scissor`);
 }
 assert.deepEqual(await page.evaluate(()=>window.check.dispose()),[]);assert.deepEqual(errors,[]);
 console.log('environment half-canvas and independent scissor: 6 exact pixel cases passed');
}finally{await context.close();}
