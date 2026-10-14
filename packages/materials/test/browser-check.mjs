// Real-adapter check (run from the repository root after building packages): node packages/materials/test/browser-check.mjs
import assert from 'node:assert/strict';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
const context=await openBrowser({startPath:'/packages/materials/test/browser-check.html',port:5207}),{page,hardware}=context,pageErrors=[];
page.on('pageerror',e=>pageErrors.push(e.message));page.on('console',m=>{if(m.type()==='error'||m.type()==='warning')pageErrors.push(m.text());});
const pixel=async(y=0.5)=>{const image=await decodePNG(await page.locator('canvas').screenshot()),o=(Math.floor(image.height*y)*image.width+Math.floor(image.width/2))*4;return [...image.data.slice(o,o+3)];};
const near=(actual,expected,label,tolerance=3)=>assert.ok(actual.every((v,i)=>Math.abs(v-expected[i])<=tolerance),`${label}: ${actual} != ${expected}`);
const expected={loaded:[255,128,0],basic:[0,0,255],canvas:[0,255,0],normal:[128,128,255],matcap:[255,128,0],transparent:[130,3,4],additive:[5,194,9],mask:[5,6,9],video:[255,0,255]};
try {
  console.log('adapter',JSON.stringify(hardware.webgpu));
  await page.waitForFunction(()=>window.ready,null,{timeout:30000});
  for(const name of ['loaded','basic','canvas','flipTop','normal','standard','matcap','transparent','additive','mask','effects','video']){
    if(name==='video')await page.evaluate(()=>window.videoStep('#ff00ff'));
    const result=await page.evaluate(n=>window.check.run(n),name),center=await pixel();
    assert.equal(result.error,null,name);assert.deepEqual(result.errors,[],name);
    if(expected[name])near(center,expected[name],name);
    if(name==='flipTop'){near(await pixel(0.3),[255,0,0],'image top at UV v=1');near(await pixel(0.7),[0,0,255],'image bottom at UV v=0');}
    if(name==='standard'||name==='effects')assert.ok(center.some((v,i)=>Math.abs(v-[5,6,9][i])>20),name+' drew nothing');
    if(name==='canvas'){assert.deepEqual(await page.evaluate(()=>window.check.greenToYellow()),[]);near(await pixel(),[255,255,0],'canvas update');}
    if(name==='video')for(const [color,rgb] of [['#00ffff',[0,255,255]],['#ffffff',[255,255,255]]]){const step=await page.evaluate(c=>window.videoStep(c),color);assert.deepEqual(step.errors,[]);near(await pixel(),rgb,'video frame '+color);}
    console.log('ok',name,center);
    await page.evaluate(()=>window.check.clear());
  }
  assert.deepEqual(pageErrors,[]);console.log('materials browser check passed');
} finally {await context.close();}
