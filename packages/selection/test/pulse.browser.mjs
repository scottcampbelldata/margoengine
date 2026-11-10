import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {openBrowser} from '../../../scripts/browser.js';
import {decodePNG} from '../../../tests/support/png.js';
process.chdir(fileURLToPath(new URL('../../../',import.meta.url)));
const browser=await openBrowser({port:'free'}),{page}=browser,errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
try{
 await page.waitForFunction(()=>window.modern);
 await page.evaluate(async()=>{
  const {Engine,box}=await import('/packages/core/dist/extension.js');
  const {loadGLTF}=await import('/packages/gltf-pro/dist/index.js');
  const {XRaySelection}=await import('/packages/selection/dist/xray.js');
  const {waitForPipelines}=await import('/scripts/support/gpu-ready.js');
  const canvas=document.createElement('canvas');canvas.style.cssText='width:240px;height:160px;display:block';document.body.prepend(canvas);
  const e=await Engine.create(canvas,{backend:'webgpu',camera:{position:[0,0,5],target:[0,0,0],fov:50}});
  e.gpu.addEventListener('uncapturederror',ev=>{throw ev.error});
  const model=await loadGLTF(e,'/packages/exporters/tests/fixtures/Box.glb');model.root.setScale([2,2,2]);
  e.createMesh().setGeometry(box()).setScale([1.4,3,0.2]).setPosition([0.8,0,2]);
  const effect=XRaySelection.attach(e,{color:[1,0,1],width:5,pulse:{period:2,minimum:0.1},xray:{dash:0,opacity:1}});effect.set([model]);
  window.frame=async(time,xray=true,algorithm='jfa')=>{effect.time=time;effect.options.xray=xray;effect.options.algorithm=algorithm;await waitForPipelines(async()=>{e.render();await e.gpu.queue.onSubmittedWorkDone()})};
  window.finish=()=>{effect.set([]);e.render();effect.dispose();model.dispose();e.dispose()};
 });
 const measure=async()=>{const image=await decodePNG(await page.locator('canvas').screenshot());let sum=0;for(let i=0;i<image.data.length;i+=4)sum+=Math.max(0,Math.min(image.data[i],image.data[i+2])-image.data[i+1]);return sum};
 const report=[];
 for(const algorithm of ['jfa','morphological']){
  await page.evaluate(a=>window.frame(0,true,a),algorithm);const bright=await measure();
  await page.evaluate(a=>window.frame(1,true,a),algorithm);const dim=await measure();
  await page.evaluate(a=>window.frame(0,false,a),algorithm);const visible=await measure();
  assert.ok(bright>dim*1.5,`pulse missing ${algorithm}: ${bright}/${dim}`);assert.ok(bright>visible*1.1,`hidden outline missing ${bright}/${visible}`);report.push({algorithm,bright,dim,visible});
 }
 await page.evaluate(()=>window.finish());assert.deepEqual(errors,[]);console.log('pulse pixels',report);
}finally{await browser.close()}
