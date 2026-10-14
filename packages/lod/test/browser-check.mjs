// Real-adapter check and benchmark (run from the repository root after building packages): node packages/lod/test/browser-check.mjs
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
const context=await openBrowser({startPath:'/packages/lod/test/browser-check.html',port:5219}),{page,hardware}=context,pageErrors=[];
page.on('pageerror',e=>pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')pageErrors.push(m.text());});
const shot=async name=>{const png=await page.locator('canvas').screenshot({path:`test-results/lod-${name}.png`});return decodePNG(png);};
try {
  console.log('adapter',JSON.stringify(hardware.webgpu));
  await page.waitForFunction(()=>window.ready,null,{timeout:60000});
  const results={adapter:hardware.webgpu,browser:hardware.browserVersion};
  // LOD before full detail: 30 s at 230 ms/frame heats a laptop GPU and slows whatever runs next.
  for(const mode of ['empty','lod','full']){
    const r=await page.evaluate(m=>window.check.mode(m),mode);assert.equal(r.error,null,mode);assert.deepEqual(r.errors,[],mode);
    results[mode]=await page.evaluate(()=>window.check.measure(120));assert.deepEqual(results[mode].errors,[],mode);delete results[mode].errors;
    if(mode!=='empty')results[mode].image=await shot(mode);console.log(mode,JSON.stringify({...results[mode],image:undefined}));
  }
  results.scene=await page.evaluate(()=>window.check.info());assert.deepEqual(results.scene.errors,[]);delete results.scene.errors;
  const a=results.full.image,b=results.lod.image;let diff=0,lit=0,litBoth=0;
  for(let i=0;i<a.data.length;i+=4){const on=x=>x.data[i]+x.data[i+1]+x.data[i+2]>60;diff+=Math.abs(a.data[i]-b.data[i])+Math.abs(a.data[i+1]-b.data[i+1])+Math.abs(a.data[i+2]-b.data[i+2]);if(on(a))lit++;if(on(a)&&on(b))litBoth++;}
  results.image={meanAbsDiff:+(diff/(a.width*a.height*3)).toFixed(2),coverage:+(litBoth/lit).toFixed(3)};delete results.full.image;delete results.lod.image;
  console.log('image',JSON.stringify(results.image),'scene',JSON.stringify(results.scene));
  assert.ok(results.lod.levels[3]>1000,'most instances are imposters');assert.ok(results.image.coverage>0.9,'imposters cover what the meshes cover');assert.ok(results.image.meanAbsDiff<12,'LOD frame looks like the full-detail frame');
  assert.deepEqual(pageErrors,[]);await writeFile('test-results/lod-benchmark.json',JSON.stringify(results,null,1));console.log('lod browser check passed');
} finally {await context.close();}
