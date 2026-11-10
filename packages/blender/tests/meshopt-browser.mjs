import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openBrowser } from '../../../scripts/browser.js';
import { decodePNG } from '../../../tests/support/png.js';
import { compressMargoMeshopt } from '../dist/meshopt.js';
const browser=await openBrowser({port:'free',startPath:'/tests/modern-extension.html'}),errors=[];
browser.page.on('pageerror',e=>errors.push(e.message));
try{
  for(const name of ['triangle','lightmap','anim']){
    const raw=await readFile(new URL(`./fixtures/${name}.margo`,import.meta.url));
    const compressed=await compressMargoMeshopt(raw);
    await browser.page.route(`**/compressed-${name}.margo`,r=>r.fulfill({body:Buffer.from(compressed),contentType:'application/octet-stream'}));
    const result=await browser.page.evaluate(async name=>{
      const {Engine}=await import('/packages/core/dist/index.js');
      const {loadMargo}=await import('/packages/blender/dist/index.js');
      const {loadAnimatedMargo,parseAnimatedMargo}=await import('/packages/blender/dist/anim.js');
      const {loadMargoMeshopt}=await import('/packages/blender/dist/meshopt.js');
      const {Animation}=await import('/packages/animation/dist/index.js');
      const {waitForPipelines}=await import('/scripts/support/gpu-ready.js');
      const shots=[];
      for(const compressed of [false,true]){
        const canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:128px';document.body.append(canvas);
        const engine=await Engine.create(canvas,{backend:'webgpu',capacity:128});engine.gpu.pushErrorScope('validation');
        const url=compressed?`/compressed-${name}.margo`:`/packages/blender/tests/fixtures/${name}.margo`;
        const model=compressed?await loadMargoMeshopt(engine,url,name==='anim'?{parse:parseAnimatedMargo}:{}):await(name==='anim'?loadAnimatedMargo:loadMargo)(engine,url);
        const b=model.bounds;engine.camera.fitToBoundingBox([b[0],b[1],b[2]],[b[3],b[4],b[5]],{duration:0});
        const animation=name==='anim'?Animation.attach(model):undefined;animation?.play('Bend').seek(0.2);
        await waitForPipelines(async()=>{engine.render({culling:false});await engine.gpu.queue.onSubmittedWorkDone();});
        const image=canvas.toDataURL(),validation=(await engine.gpu.popErrorScope())?.message??null;
        animation?.dispose();model.dispose();const remaining=engine.meshes.size;engine.dispose();canvas.remove();shots.push({image,validation,remaining});
      }
      return shots;
    },name);
    const images=await Promise.all(result.map(x=>decodePNG(Buffer.from(x.image.split(',')[1],'base64'))));
    assert.deepEqual(images[1].data,images[0].data,`${name}: every rendered byte is identical`);
    for(const s of result){assert.equal(s.validation,null);assert.equal(s.remaining,0);}
    console.log(JSON.stringify({name,original:raw.length,compressed:compressed.length,pixelBytes:images[0].data.length}));
  }
  assert.deepEqual(errors,[]);
}finally{await browser.close();}
