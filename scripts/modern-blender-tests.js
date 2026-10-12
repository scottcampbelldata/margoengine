import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {build} from 'vite';
import {openBrowser} from './browser.js';
import {decodePNG} from '../tests/support/png.js';
import {decodeMargo} from '../packages/blender/dist/index.js';
import {GLTFAsset} from '../packages/gltf-pro/dist/index.js';

await mkdir('test-results/blender',{recursive:true});
const fixtures=[await readFile('packages/blender/tests/fixtures/triangle.margo')];
if(process.env.MARGO_BLENDER){
  execFileSync('python',['tools/blender-addon/package_addon.py'],{stdio:'inherit'});
  execFileSync(process.env.MARGO_BLENDER,['--background','--factory-startup','--python-exit-code','1','--python','tools/blender-addon/tests/blender_install.py','--','dist/margo-blender-addon-v1.0.0.zip'],{stdio:'inherit',env:{...process.env,BLENDER_USER_RESOURCES:resolve('test-results/blender/install-profile')}});
  execFileSync(process.env.MARGO_BLENDER,['--background','--factory-startup','--python-exit-code','1','--python','tools/blender-addon/tests/blender_roundtrip.py','--','test-results/blender'],{stdio:'inherit'});
  const exported=await readFile('test-results/blender/blender.margo'),asset=decodeMargo(exported);
  assert.equal(asset.document.meshes.length,1,'Identical Blender meshes must share packed geometry');
  assert.equal(asset.document.nodes.length,2);
  const mirrored=asset.document.nodes.find(n=>n.name==='Mirrored');
  assert.ok(mirrored.scale.reduce((a,b)=>a*b,1)<0,'Mirrored transform lost its determinant');
  assert.equal(asset.document.nodes.find(n=>n.name==='Triangle').extras.margo.properties['margo:shadow_caster'],true);
  assert.deepEqual(asset.document.nodes.find(n=>n.name==='Triangle').extras.margo.properties['margo:lod_dist'],[15,45,90]);
  const png=await decodePNG(asset.images[0]),expected=await decodePNG(await readFile('test-results/blender/texture.png'));
  assert.deepEqual(png.data,expected.data,'Blender changed source texture color/alpha or orientation');
  const native=await readFile('test-results/blender/native.glb'),jsonLength=native.readUInt32LE(12),document=JSON.parse(native.subarray(20,20+jsonLength).toString()),binary=native.subarray(28+jsonLength);
  const gltf=new GLTFAsset(document,[binary]),attributes=document.meshes[0].primitives[0].attributes;
  const positions=gltf.accessor(attributes.POSITION,'VEC3'),normals=gltf.accessor(attributes.NORMAL,'VEC3'),tangents=gltf.accessor(attributes.TANGENT,'VEC4'),uv=gltf.accessor(attributes.TEXCOORD_0,'VEC2');
  const packed=asset.geometry[0][0].vertices;
  for(let i=0;i<packed.length/20;i++){
    const match=Array.from({length:positions.length/3},(_,j)=>j).find(j=>[0,1,2].every(c=>Math.abs(positions[j*3+c]-packed[i*20+c])<1e-5));
    assert.notEqual(match,undefined,'Position differs from Blender glTF export');
    for(let c=0;c<3;c++)assert.ok(Math.abs(normals[match*3+c]-packed[i*20+4+c])<1e-5,'Normal differs from Blender glTF export');
    for(let c=0;c<4;c++)assert.ok(Math.abs(tangents[match*4+c]-packed[i*20+8+c])<1e-5,'Tangent differs from Blender glTF export');
    for(let c=0;c<2;c++)assert.ok(Math.abs(uv[match*2+c]-packed[i*20+12+c])<1e-5,'UV differs from Blender glTF export');
  }
  const modified=decodeMargo(await readFile('test-results/blender/modifier.margo'));
  assert.ok(modified.geometry.some(parts=>parts[0].indices.length>3),'Export ignored evaluated modifiers');
  const instanced=decodeMargo(await readFile('test-results/blender/instances.margo'));
  assert.equal(instanced.document.nodes.length,3,'Collection prototype absent from scene was not exported');
  assert.deepEqual(instanced.document.nodes.find(n=>n.name==='Prototype').translation,[0,-2,0]);
  const centimeters=decodeMargo(await readFile('test-results/blender/centimeters.margo'));
  assert.ok(Math.abs(centimeters.geometry[0][0].vertices[0]+0.006)<1e-7,'Geometry units were not converted to meters');
  assert.ok(Math.abs(centimeters.document.nodes.find(n=>n.name==='Mirrored').translation[0]-0.02)<1e-7,'Transform units were not converted to meters');
  fixtures.push(exported);
}
const demo=await build({configFile:false,logLevel:'silent',build:{write:false,rollupOptions:{input:'examples/blender-loader/index.html'}}});
assert.ok(demo.output.some(c=>c.type==='chunk'&&c.isEntry),'Blender viewer build failed');
const browser=await openBrowser({startPath:'/tests/modern-extension.html'}),{page,hardware}=browser,errors=[];
page.on('pageerror',e=>errors.push(e.message));
page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
  for(let i=0;i<fixtures.length;i++)await page.route('**/fixture-'+i+'.margo',route=>route.fulfill({body:fixtures[i],contentType:'application/octet-stream'}));
  const results=await page.evaluate(async count=>{
    const {Engine}=await import('/packages/core/dist/index.js');
    const {createStage}=await import('/packages/margoengine/dist/index.js');
    const {decodeMargo,loadMargo,parseMargo}=await import('/packages/blender/dist/index.js');
    const {Shadows}=await import('/packages/shadows/dist/index.js');
    const {SSAO}=await import('/packages/post/dist/index.js');
    const assert=(ok,message)=>{if(!ok)throw new Error(message);};
    const results=[];
    for(let i=0;i<count;i++){
      const canvas=document.createElement('canvas');canvas.style.cssText='width:256px;height:256px';document.body.append(canvas);
      const engine=await Engine.create(canvas,{backend:'webgpu',capacity:16,camera:{position:[0,0,3],target:[0,0,0]}});
      const device=engine.gpu;device.pushErrorScope('validation');
      const model=await loadMargo(engine,'/fixture-'+i+'.margo');
      assert(model.nodes.length===2&&model.primitives.length===2,'Missing scene instances');
      assert(model.primitives[0].vertices===model.primitives[1].vertices,'Geometry was repacked per instance');
      assert(model.shadowPrimitives[0].vertex===model.shadowPrimitives[1].vertex,'Shared geometry was uploaded twice');
      const p=model.primitives[0],first=p.vertices[0];
      assert(first<-0.59&&first>-0.61,'Packed geometry changed');
      const shadows=Shadows.attach(engine,{resolution:64,distance:10});shadows.add(model);
      const ssao=SSAO.attach(engine,{samples:4});ssao.add(model);
      engine.render({culling:false});await device.queue.onSubmittedWorkDone();
      assert(engine.stats.drawCalls>=2,'Packed model did not draw');
      const validation=await device.popErrorScope();assert(!validation,validation?.message);
      window.margoCanvas=canvas;
      const screenshot=canvas.toDataURL();
      await engine.rebootDevice();
      engine.gpu.pushErrorScope('validation');engine.render({culling:false});await engine.gpu.queue.onSubmittedWorkDone();
      const restored=await engine.gpu.popErrorScope();assert(!restored,restored?.message);
      assert(p.vertices[0]===first,'Device restoration lost CPU geometry');
      model.destroy();assert(engine.meshes.size===0,'Model destruction leaked handles');
      shadows.destroy();ssao.destroy();engine.dispose();canvas.remove();
      results.push({instances:model.primitives.length,screenshot});
    }
    const canvas=document.createElement('canvas');canvas.style.cssText='width:256px;height:256px';document.body.append(canvas);
    const small=await Engine.create(canvas,{backend:'webgpu',capacity:1});
    const bytes=await (await fetch('/fixture-0.margo')).arrayBuffer();let failed=false;
    try{await parseMargo(small,bytes);}catch(error){failed=/capacity/.test(error.message);}
    assert(failed&&small.meshes.size===0,'Capacity failure did not roll back');small.dispose();canvas.remove();
    const container=document.createElement('div');container.style.cssText='width:256px;height:256px';document.body.append(container);
    const stage=await createStage(container,{backend:'webgpu',capacity:16,controls:false,autoStart:false});
    const device=stage.engine.gpu,createBuffer=device.createBuffer,allocated=[];
    device.createBuffer=function(descriptor){
      const buffer=createBuffer.call(this,descriptor),destroy=buffer.destroy,record={buffer,destroys:0};allocated.push(record);
      buffer.destroy=function(){record.destroys++;destroy.call(this);};return buffer;
    };
    let mounted;
    try{mounted=await loadMargo(stage.engine,'/fixture-0.margo');}finally{device.createBuffer=createBuffer;}
    assert(allocated.length===4,'Expected one shared vertex/index buffer and two instance uniforms');
    assert(allocated.every(record=>record.destroys===0),'Model buffers were destroyed before unmount');
    stage.dispose();stage.dispose();
    assert(allocated.every(record=>record.destroys===1),'Stage disposal did not destroy every model buffer exactly once');
    assert(stage.engine.meshes.size===0&&!container.querySelector('canvas'),'Stage disposal leaked handles or owned canvas');
    mounted.destroy();assert(allocated.every(record=>record.destroys===1),'Model cleanup after unmount destroyed buffers twice');
    container.remove();results[0].stageCleanupBuffers=allocated.length;
    const asset=decodeMargo(bytes);assert(asset.geometry[0][0].vertices.buffer===bytes,'Decoder copied geometry');
    return results;
  },fixtures.length);
  for(let i=0;i<results.length;i++){
    const screenshot=Buffer.from(results[i].screenshot.split(',')[1],'base64'),image=await decodePNG(screenshot);
    let colorful=0;for(let p=0;p<image.data.length;p+=4)if(Math.max(...image.data.subarray(p,p+3))-Math.min(...image.data.subarray(p,p+3))>30)colorful++;
    assert.ok(colorful>100,'Textured .margo produced no colored pixels');
    await writeFile('test-results/blender/render-'+i+'.png',screenshot);delete results[i].screenshot;results[i].colorfulPixels=colorful;
  }
  await page.goto('http://127.0.0.1:5193/examples/blender-loader/index.html');
  await page.waitForFunction(()=>!document.querySelector('#file').disabled&&document.querySelector('canvas').width>1);
  await page.locator('#file').setInputFiles({name:'fixture.margo',mimeType:'application/octet-stream',buffer:fixtures[0]});
  await page.waitForFunction(()=>document.querySelector('#status').textContent!=='Choose a .margo file exported from Blender.');
  assert.match(await page.locator('#status').innerText(),/2 objects/);
  await page.locator('#viewport').screenshot({path:'test-results/blender/viewer.png'});
  await page.locator('#file').setInputFiles({name:'invalid.margo',mimeType:'application/octet-stream',buffer:Buffer.from('invalid')});
  await page.waitForFunction(()=>document.querySelector('#status').textContent.includes('Invalid .margo size'));
  assert.deepEqual(errors,[]);
  await writeFile('test-results/modern-blender.json',JSON.stringify({hardware,results},null,2));
  console.log(JSON.stringify({hardware,results},null,2));
}finally{await browser.close();}
