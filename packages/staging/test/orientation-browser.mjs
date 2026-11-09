import assert from 'node:assert/strict';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
import {writeFileSync} from 'node:fs';
const frames=[
  {u:[1,0,0],n:[0,1,0],v:[0,0,1]},
  {u:[1,0,0],n:[0,0,1],v:[0,-1,0]},
  {u:[0,0,1],n:[1,0,0],v:[0,1,0]},
  {u:[1,0,0],n:[0,-1,0],v:[0,0,-1]},
  {u:[1,0,0],n:[0,0,-1],v:[0,1,0]},
  {u:[0,0,1],n:[-1,0,0],v:[0,-1,0]},
  {u:[1,0,0],n:[0,.6,.8],v:[0,-.8,.6]},
  {u:[.8,-.6,0],n:[.6,.8,0],v:[0,0,1]},
];
const context=await openBrowser({startPath:'/packages/staging/test/orientation-browser.html',port:'free'});
const {page}=context,errors=[];page.on('pageerror',e=>errors.push(e.message));
const screenshot=async()=>decodePNG(await page.locator('canvas').screenshot());
const center=image=>image.data[(120*320+160)*4];
const rows=[];
try{
  await page.waitForFunction(()=>window.ready,null,{timeout:30000});
  for(const kind of ['contact','accumulated']){
    let baseline;
    for(const frame of frames){
      const result=await page.evaluate(o=>window.check.scene(o),{...frame,kind});
      assert.deepEqual(result.errors,[]);
      assert(result.values.some(v=>v>0),'caster produces coverage');
      baseline??=result.values;
      assert.deepEqual(result.values,baseline,`${kind} whole texture is invariant under rigid rotation and translation`);
      await page.evaluate(()=>window.check.opacity(0));const off=await screenshot();
      await page.evaluate(()=>window.check.opacity(.8));const on=await screenshot();
      assert(center(on)<center(off)-20,`${kind} up ${frame.n} draws the rotated receiver under the raised product: ${center(off)} -> ${center(on)}, image ${on.width}x${on.height}`);
      rows.push({kind,up:frame.n,off:center(off),on:center(on)});
      await page.evaluate(()=>window.check.below());const below=await screenshot();
      await page.evaluate(()=>window.check.opacity(0));const belowOff=await screenshot();
      assert.deepEqual(below.data,belowOff.data,'receiver does not draw from its back side');
    }
    const restored=await page.evaluate(()=>window.check.restore());
    assert(restored.changed);assert.deepEqual(restored.values,baseline);assert.deepEqual(restored.errors,[]);
  }
  assert.equal(await page.evaluate(()=>window.check.turn()),1,'changing up resets accumulated history');
  const empty=await page.evaluate(()=>window.check.empty());assert.equal(empty.samples,1);assert(empty.values.every(v=>v===0));
  assert.deepEqual(empty.errors,[]);
  const product=await page.evaluate(()=>window.check.product());assert.deepEqual(product.errors,[]);
  await page.evaluate(()=>window.check.opacity(0));const productOff=await screenshot();
  await page.evaluate(()=>window.check.opacity(.8));const productOn=await screenshot();
  let darkened=0;for(let i=0;i<productOff.data.length;i+=4){assert(productOn.data[i]<=productOff.data[i]);if(productOn.data[i]<productOff.data[i]-5)darkened++;}
  assert(darkened>100,'real FlightHelmet casts a visible Z-up fitted contact shadow');
  const native=await page.evaluate(()=>window.check.native());assert.equal(native.code,'unsupported');assert.match(native.message,/https:\/\/margoengine.com\/errors#unsupported/);
  assert.deepEqual(await page.evaluate(()=>window.check.dispose()),[]);assert.deepEqual(errors,[]);
  const report={backend:process.argv.includes('--compat')?'WebGL2 compatibility':'WebGPU',orientations:frames.length,texelsPerCase:4096,rows,deviceReplacement:true,empty:true,disposal:true,realProduct:{asset:'FlightHelmet mobile glb',up:'Z',darkenedPixels:darkened,bounds:product.bounds},native};
  if(process.argv.includes('--record'))writeFileSync(`examples/package-benchmarks/results/batch-56-axis${process.argv.includes('--compat')?'-compat':''}.json`,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));console.log('arbitrary-up receiver GPU oracle passed');
}finally{await context.close();}
