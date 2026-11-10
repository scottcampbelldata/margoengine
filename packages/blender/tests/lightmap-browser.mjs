import assert from 'node:assert/strict';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { pbrNeutral } from '../../shared/display.js';
const browser = await openBrowser({ port: 'free', startPath: '/tests/modern-extension.html' });
const errors = [];
browser.page.on('pageerror', e => errors.push(e.message));
try {
  const result = await browser.page.evaluate(async()=>{
    const { Engine }=await import('/packages/core/dist/index.js');
    const { loadMargoLightmap }=await import('/packages/blender/dist/lightmap.js');
    const { waitForPipelines }=await import('/scripts/support/gpu-ready.js');
    const canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:128px';document.body.append(canvas);
    const engine=await Engine.create(canvas,{backend:'webgpu',capacity:16,camera:{position:[0,4,0.001],target:[0,0,0]}});
    engine.camera.up=[0,0,-1];
    engine.gpu.pushErrorScope('validation');
    const model=await loadMargoLightmap(engine,'/packages/blender/tests/fixtures/lightmap.margo');
    const render=async()=>{await waitForPipelines(async()=>{engine.render({culling:false});await engine.gpu.queue.onSubmittedWorkDone();});return canvas.toDataURL();};
    const image=await render();
    engine.lighting.direction=[0,1,0,100];
    engine.lighting.ambient=[100,100,100];
    const relit=await render();
    const validation=(await engine.gpu.popErrorScope())?.message??null;
    model.dispose();const remaining=engine.meshes.size;engine.dispose();canvas.remove();
    return {image,relit,remaining,validation};
  });
  const images=await Promise.all([result.image,result.relit].map(u=>decodePNG(Buffer.from(u.split(',')[1],'base64'))));
  const center=images.map(image=>Array.from(image.data.subarray((64*128+64)*4,(64*128+64)*4+3)));
  console.log(JSON.stringify({center,validation:result.validation,remaining:result.remaining}));
  const radiance=0.25/Math.PI;
  const neutral=pbrNeutral([radiance,radiance,radiance])[0];
  const expected=Math.round(255*(neutral<=0.0031308?12.92*neutral:1.055*neutral**(1/2.4)-0.055));
  for(const value of center[0]) assert.ok(Math.abs(value-expected)<=1,`analytic diffuse colour with neutral display ${expected}, got ${center[0]}`);
  assert.ok(Math.max(...center[0])-Math.min(...center[0])<=2,'albedo cancels the coloured irradiance');
  assert.deepEqual(center[1],center[0],'baked direct+indirect illumination must not be counted twice');
  assert.equal(result.validation,null);assert.equal(result.remaining,0);assert.deepEqual(errors,[]);
} finally { await browser.close(); }
