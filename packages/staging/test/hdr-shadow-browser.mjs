import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
const context=await openBrowser({startPath:'/packages/staging/test/hdr-shadow-browser.html',port:'free'}),{page}=context,errors=[];
page.on('pageerror',e=>errors.push(e.message));
try{
 await page.waitForFunction(()=>window.ready,null,{timeout:60000});
 const info=await page.evaluate(()=>window.check.info());assert(info.triangles>1000);
 const rows=[];
 for(const product of ['FlightHelmet','raised box']){
  if(product==='raised box')await page.evaluate(()=>window.check.box());
  const off=async()=>{await page.evaluate(()=>window.check.render(0,0));return decodePNG(await page.locator('canvas').screenshot());};
  const base=await off();
  const first=await page.evaluate(()=>window.check.render(0));const on=await decodePNG(await page.locator('canvas').screenshot());
  assert(first.count>100,`${product} casts shadow pixels`);
  let darkened=0;for(let i=0;i<base.data.length;i+=4)if(on.data[i]+on.data[i+1]+on.data[i+2]<base.data[i]+base.data[i+1]+base.data[i+2])darkened++;
  assert(darkened>20,`${product} darkens the photographed HDR floor`);
  const rotated=await page.evaluate(()=>window.check.render(Math.PI));
  assert(rotated.count>100);
  const cosine=(first.x*rotated.x+first.z*rotated.z)/Math.hypot(first.x,first.z)/Math.hypot(rotated.x,rotated.z);
  assert(cosine<-.95,`${product} shadow rotates by PI: ${cosine}`);
  const sh=info.sh,l=k=>sh[k*3]*.2126+sh[k*3+1]*.7152+sh[k*3+2]*.0722;
  const alignment=-(first.x*l(3)+first.z*l(2))/Math.hypot(first.x,first.z)/Math.hypot(l(3),l(2));
  assert(alignment>.95,'shadow follows the actual HDR radiance moment');
  const repeated=await page.evaluate(()=>window.check.render(0));assert.deepEqual(repeated,first,'rotation restores identical shadow pixels');
  rows.push({product,first,rotated,cosine,alignment,darkened});
 }
 assert.equal((await page.evaluate(()=>window.check.remove())).count,0);
 assert.deepEqual(await page.evaluate(()=>window.check.dispose()),[]);assert.deepEqual(errors,[]);
 const result={hardware:context.hardware,triangles:info.triangles,rows};
 await writeFile(`test-results/56fix/hdr-shadow${process.argv.includes('--compat')?'-compat':''}.json`,JSON.stringify(result,null,2)+'\n');
 console.log('HDR shadow rotation passed',JSON.stringify(rows));
}finally{await context.close();}
