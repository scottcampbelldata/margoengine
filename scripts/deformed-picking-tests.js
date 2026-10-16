import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {openBrowser} from './browser.js';
import {animatedTriangle} from '../tests/support/gltf-pro-fixture.js';
import {textureQuad} from '../tests/support/texture-fixture.js';

const serialize=fixture=>({doc:fixture.doc,buffers:fixture.buffers.map(data=>[...new Uint8Array(data.buffer,data.byteOffset,data.byteLength)])});
function fixture(kind='combined',eight=false){
  const result=animatedTriangle(),{doc,buffers}=result,p=doc.meshes[0].primitives[0];
  buffers[doc.animations[0].samplers[0].output].set([0,0,0,2,0,0]);
  buffers[p.targets[0].POSITION].set([1.5,0,0,1.5,0,0,1.5,0,0]);
  if(kind==='skin'){delete p.targets;delete doc.meshes[0].weights;}
  if(kind==='morph'){delete doc.nodes[0].skin;delete p.attributes.JOINTS_0;delete p.attributes.WEIGHTS_0;delete doc.animations;delete doc.skins;}
  if(eight){
    const add=data=>{const i=buffers.length;buffers.push(data);doc.buffers.push({byteLength:data.byteLength});doc.bufferViews.push({buffer:i,byteLength:data.byteLength});doc.accessors.push({bufferView:i,componentType:data instanceof Uint16Array?5123:5126,count:3,type:'VEC4'});return i;};
    p.attributes.JOINTS_1=add(new Uint16Array([1,0,0,0,1,0,0,0,1,0,0,0]));
    p.attributes.WEIGHTS_1=add(new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0]));
    doc.nodes.push({name:'Second influence set',translation:[4,0,0]});doc.nodes[0].children.push(2);doc.skins[0].joints.push(2);
  }
  return result;
}
function alphaFixture(bake){
  const result=textureQuad('base',{offset:[0.23,0.17],rotation:0.51,scale:[0.77,0.81],texCoord:1},{bake,required:!bake}),{doc,buffers}=result;
  const values=new Float32Array([2,0,0,2,0,0,2,0,0,2,0,0]),index=buffers.length;
  buffers.push(values);doc.buffers.push({byteLength:values.byteLength});doc.bufferViews.push({buffer:index,byteLength:values.byteLength});doc.accessors.push({bufferView:index,componentType:5126,count:4,type:'VEC3'});
  doc.meshes[0].primitives[0].targets=[{POSITION:index}];doc.meshes[0].weights=[1];doc.materials[0].alphaMode='MASK';doc.materials[0].alphaCutoff=0.5;
  return result;
}

/** Hits must come from the current GPU pose, beyond the bind-pose bounds. */
export async function deformedPickingBrowserChecks(page){
  const minified=alphaFixture(false);minified.doc.materials[0].pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform={offset:[0.23,0.17],scale:[128,128],texCoord:1};minified.doc.samplers[0].minFilter=9987;
  const payload={fixtures:['skin','morph','combined'].map(kind=>({kind,data:serialize(fixture(kind))})),eight:serialize(fixture('skin',true)),alpha:serialize(alphaFixture(false)),baked:serialize(alphaFixture(true)),minified:serialize(minified)};
  return page.evaluate(async payload=>{
    const {EngineKernel}=await import('/packages/core/dist/index.js'),{engineRuntime,box,PbrMaterial}=await import('/packages/core/dist/extension.js');
    const {parseGLTF}=await import('/packages/gltf-pro/dist/index.js'),{Animation}=await import('/packages/animation/dist/index.js');
    const {Picking,Selection}=await import('/packages/selection/dist/index.js'),{Raycaster}=await import('/packages/bvh/dist/index.js');
    const assert=(value,message)=>{if(!value)throw new Error(message);},canvas=document.createElement('canvas');canvas.style.cssText='width:320px;height:320px';document.body.append(canvas);
    const instance=await EngineKernel.create(canvas,{backend:'webgpu',capacity:64,camera:{position:[1.8,0,10],target:[1.8,0,0],fov:50,near:0.1,far:40}}),engine=engineRuntime(instance);
    const resources=[],modules=[],validation=[],labels=[],poses=[],report={};let picker,selection,currentLabel='setup';
    const track=device=>{
      device.addEventListener('uncapturederror',event=>validation.push(event.error.message));
      for(const name of ['createTexture','createBuffer']){const create=device[name].bind(device);device[name]=descriptor=>{const resource=create(descriptor),record={resource,descriptor,destroyed:false},destroy=resource.destroy.bind(resource);resources.push(record);resource.destroy=()=>{record.destroyed=true;destroy();};return resource;};}
      const create=device.createShaderModule.bind(device);device.createShaderModule=descriptor=>{const module=create(descriptor);modules.push({module,code:descriptor.code});return module;};
    };
    track(engine.gpu);engine.lighting.direction.set([0,0,1,1]);engine.lighting.radiance.set([1,1,1,0.2]);
    const load=(fixture,images=[])=>parseGLTF(instance,structuredClone(fixture.doc),fixture.buffers.map(buffer=>new Uint8Array(buffer)),images);
    const project=(position)=>{engine.camera.update(canvas.width/canvas.height,true);const m=engine.camera.matrix,v=[0,0,0,0],p=[...position,1];for(let r=0;r<4;r++)for(let c=0;c<4;c++)v[r]+=m[c*4+r]*p[c];return [(v[0]/v[3]*0.5+0.5)*canvas.clientWidth,(0.5-v[1]/v[3]*0.5)*canvas.clientHeight];};
    const hit=async(position,expected,label)=>{currentLabel=label;const point=project(position),actual=await instance.pick(...point);assert(actual===expected,`${label}: expected ${expected?.name??expected?.id??null}, received ${actual?.name??actual?.id??null} at ${point}`);return actual;};
    const difference=(a,b)=>{let changed=0,max=0,x=0,y=0;for(let i=0;i<a.length;i+=4){let delta=0;for(let c=0;c<3;c++){const d=Math.abs(a[i+c]-b[i+c]);max=Math.max(max,d);delta+=d;}if(delta){changed++;x+=(i/4)%320;y+=Math.floor(i/4/320);}}return {changed,max,centroid:changed?[x/changed,y/changed]:[0,0]};};
    const exact=(a,b,label)=>{const delta=difference(a,b);assert(delta.max===0,label+': '+JSON.stringify(delta));return delta;};
    const render=async label=>{
      labels.push(currentLabel=label);const device=engine.gpu,context=canvas.getContext('webgpu'),format=navigator.gpu.getPreferredCanvasFormat();let texture,read;
      context.configure({device,format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});const original=context.getCurrentTexture.bind(context);context.getCurrentTexture=()=>texture=original();
      try{instance.render({culling:false});read=device.createBuffer({size:1280*320,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});const encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:1280},[320,320]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(read.getMappedRange()).slice();read.unmap();assert(validation.length===0,label+': '+validation.join('\n'));return bytes;}
      finally{context.getCurrentTexture=original;read?.destroy();}
    };
    const readPositions=async primitive=>{
      const device=engine.gpu,source=primitive.deformed,read=device.createBuffer({size:primitive.vertices.byteLength,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try{const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(source,0,read,0,primitive.vertices.byteLength);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const data=new Float32Array(read.getMappedRange()).slice();read.unmap();return Array.from({length:data.length/20},(_,i)=>[...data.subarray(i*20,i*20+3)]);}
      finally{read.destroy();}
    };
    const bvh=async(model,x,label)=>{
      const ray=new Raycaster([x,-0.2,3],[0,0,-1]),hits=await ray.intersectModel(model);assert(hits.length===1&&hits[0].mesh===model.primitives[0].node&&Math.abs(hits[0].distance-3)<1e-5,label+': BVH missed or used stale vertices '+JSON.stringify(hits.map(hit=>({distance:hit.distance,point:hit.point}))));
      assert(Math.abs(hits[0].point[0]-x)<1e-6&&Math.abs(hits[0].point[1]+0.2)<1e-6&&Math.abs(hits[0].point[2])<1e-6,label+': BVH changed the analytic triangle hit');
      const miss=await new Raycaster([x+0.9,-0.2,3],[0,0,-1]).intersectModel(model);assert(miss.length===0,label+': BVH falsely hit beyond the triangle');return {distance:hits[0].distance,point:Array.from(hits[0].point),barycoord:Array.from(hits[0].barycoord)};
    };
    try{
      const baseline=load(payload.fixtures[0].data),animation=Animation.attach(baseline,{loop:false});animation.playing=false;animation.seek(0);
      const before=await render('beauty:baseline'),shaderCount=modules.length;picker=Picking.attach(instance,{capture:false});let remove=picker.add(baseline);
      report.beautyParity=exact(before,await render('beauty:picker-attached'),'Attaching micro picking changed beauty pixels');assert(modules.length===shaderCount,'Idle picking compiled or replaced a beauty shader');
      await hit([0,-0.2,0],baseline.primitives[0].node,'skin:bind');animation.seek(1);
      await hit([2,-0.2,0],baseline.primitives[0].node,'skin:seek-without-render');await hit([0,-0.2,0],null,'skin:old-position-misses');
      const expected=[[-0.6+2,-0.6,0],[0.6+2,-0.6,0],[2,0.6,0]],actual=await readPositions(baseline.primitives[0]);assert(actual.every((p,i)=>p.every((value,c)=>Math.abs(value-expected[i][c])<2e-6)),'Skin GPU positions disagree with independent translation');
      poses.push({kind:'skin',translation:2,gpu:actual,bvh:await bvh(baseline,2,'skin')});
      const withoutCapture=await render('capture:disabled');remove();picker.dispose();picker=Picking.attach(instance);remove=picker.add(baseline);report.defaultCaptureParity=exact(withoutCapture,await render('capture:enabled'),'Default ID capture changed PBR beauty');await hit([2,-0.2,0],baseline.primitives[0].node,'capture:current-pose');animation.seek(0);await hit([0,-0.2,0],baseline.primitives[0].node,'capture:stale-frame-after-seek');await hit([2,-0.2,0],null,'capture:stale-pose-misses');remove();baseline.destroy();picker.dispose();picker=Picking.attach(instance,{capture:false});
      for(const entry of payload.fixtures.slice(1)){
        const model=load(entry.data),animation=Animation.attach(model,{loop:false});animation.playing=false;remove=picker.add(model);
        if(entry.kind==='combined')animation.seek(1);animation.setMorph(0,0,1);const x=entry.kind==='combined'?3.5:1.5;
        // BVH runs first, proving the readback path itself refreshes deformation.
        const reference=await bvh(model,x,entry.kind);await hit([x,-0.2,0],model.primitives[0].node,entry.kind+':fresh');await hit([0,-0.2,0],null,entry.kind+':bind-position-misses');
        const positions=await readPositions(model.primitives[0]);assert(positions.every((p,i)=>Math.abs(p[0]-([-0.6,0.6,0][i]+x))<2e-6),'Morph/skin GPU output is not the independently expected position');
        poses.push({kind:entry.kind,translation:x,gpu:positions,bvh:reference});
        // Direct public weight edits must invalidate both paths without a render.
        model.primitives[0].weights[0]=0;const next=entry.kind==='combined'?2:0;await hit([next,-0.2,0],model.primitives[0].node,entry.kind+':direct-weight-edit');await hit([x,-0.2,0],null,entry.kind+':old-morph-misses');
        remove();model.destroy();
      }
      const eight=load(payload.eight),eightAnimation=Animation.attach(eight,{loop:false});eightAnimation.playing=false;eightAnimation.seek(1);remove=picker.add(eight);
      await hit([3,-0.2,0],eight.primitives[0].node,'eight-influences:fresh');await hit([2,-0.2,0],null,'eight-influences:four-only-position');poses.push({kind:'eight-influences',translation:3,bvh:await bvh(eight,3,'eight-influences')});remove();eight.destroy();report.poses=poses;

      const model=load(payload.fixtures[2].data),anim=Animation.attach(model,{loop:false});anim.playing=false;anim.seek(1);anim.setMorph(0,0,1);remove=picker.add(model);const node=model.primitives[0].node;
      const modelMaterial=model.primitives[0].material;modelMaterial.settings[2]=0;model.root.setScale([-1,1,1]).setPosition([7,0,0]);await hit([3.5,-0.2,0],node,'mirrored:single-sided-front');await bvh(model,3.5,'mirrored:single-sided-front');
      model.root.setScale([1,1,-1]).setPosition([0,0,0]);await hit([3.5,-0.2,0],null,'mirrored:single-sided-back');assert((await new Raycaster([3.5,-0.2,3],[0,0,-1]).intersectModel(model)).length===0,'BVH ignored mirrored material back-face culling');model.root.setScale([1,1,1]);modelMaterial.settings[2]=1;report.mirroredBackface=true;
      model.root.visible=false;await hit([3.5,-0.2,0],null,'visibility:hidden-ancestor');assert((await new Raycaster([3.5,-0.2,3],[0,0,-1]).intersectModel(model)).length===0,'BVH hit a primitive under a hidden ancestor');model.root.visible=true;await hit([3.5,-0.2,0],node,'visibility:restored');
      const geometry=box(),material=new PbrMaterial({color:[0.1,0.4,0.7],doubleSided:true}),occluder=instance.createMesh().setGeometry(geometry).setMaterial(material).setPosition([3.5,0,1]).setScale([2,2,0.3]);
      await hit([3.5,-0.2,0],occluder,'shared-depth:core-in-front');occluder.setPosition([3.5,0,-1]);await hit([3.5,-0.2,0],node,'shared-depth:pbr-in-front');occluder.visible=false;
      const rear=load(payload.fixtures[0].data),rearAnim=Animation.attach(rear,{loop:false});rearAnim.playing=false;rearAnim.seek(1);rear.root.setPosition([1.5,0,-1]);const removeRear=picker.add(rear);
      await hit([3.5,-0.2,0],node,'shared-depth:nearest-pbr');rear.root.setPosition([1.5,0,1]);await hit([3.5,-0.2,0],rear.primitives[0].node,'shared-depth:second-pbr-in-front');removeRear();rear.destroy();report.sharedDepth=true;
      const outlines=[];
      for(const algorithm of ['jfa','morphological']){
        selection=Selection.attach(instance,{algorithm,width:4,color:[0,1,0]});const removeSelection=selection.add(model);selection.set([]);const plain=await render('selection:'+algorithm+':plain');selection.set([node]);const outlined=await render('selection:'+algorithm+':deformed'),delta=difference(plain,outlined),expected=project([3.5,-0.2,0]);
        assert(delta.changed>60&&Math.abs(delta.centroid[0]-expected[0])<12,'Selection outline did not follow the deformed triangle: '+JSON.stringify({algorithm,delta,expected}));
        occluder.visible=true;occluder.setPosition([3.5,0,1]);selection.set([]);const covered=await render('selection:'+algorithm+':occluded-plain');selection.set([node]);exact(covered,await render('selection:'+algorithm+':occluded-outline'),'Selection outlined an occluded PBR primitive');occluder.visible=false;
        model.root.visible=false;selection.set([]);const hidden=await render('selection:'+algorithm+':hidden-plain');selection.set([node]);exact(hidden,await render('selection:'+algorithm+':hidden-outline'),'Selection outlined a hidden ancestor');model.root.visible=true;
        outlines.push({algorithm,...delta});removeSelection();selection.dispose();selection=undefined;
      }
      report.outlines=outlines;occluder.dispose();

      // Alpha coverage uses transformed UV1. An independent CPU-baked UV fixture
      // must produce the same hit mask and selection image after GPU morphing.
      model.root.visible=false;const image=document.createElement('canvas');image.width=image.height=4;const pixels=new Uint8ClampedArray(64);for(let i=0;i<16;i++)pixels.set([255,255,255,(i%4===1||Math.floor(i/4)===2)?255:0],i*4);image.getContext('2d').putImageData(new ImageData(pixels,4,4),0,0);
      const actualAlpha=load(payload.alpha,[await createImageBitmap(image)]),bakedAlpha=load(payload.baked,[await createImageBitmap(image)]);bakedAlpha.root.visible=false;
      for(const candidate of [actualAlpha,bakedAlpha]){const animation=Animation.attach(candidate);animation.playing=false;}
      const mask=async(candidate,label)=>{const release=picker.add(candidate),values=[];try{for(let y=-0.8;y<=0.81;y+=0.4)for(let x=1.2;x<=2.81;x+=0.4){const result=await instance.pick(...project([x,y,0]));assert(result===null||result===candidate.primitives[0].node,label+': foreign alpha hit');values.push(+(result!==null));}return values;}finally{release();}};
      const actualMask=await mask(actualAlpha,'alpha:transformed');actualAlpha.root.visible=false;bakedAlpha.root.visible=true;const bakedMask=await mask(bakedAlpha,'alpha:baked');
      // Independently invert this camera's perspective and evaluate the authored
      // nearest-filtered 4×4 alpha image at all nine micro-pick pixel centers.
      // Comparing only two GPU draws would let an implementation ignore UV1 in both.
      const cpuMask=transformed=>{const values=[],span=10*Math.tan(25*Math.PI/180),c=Math.cos(0.51),s=Math.sin(0.51);for(let y=-0.8;y<=0.81;y+=0.4)for(let x=1.2;x<=2.81;x+=0.4){const css=project([x,y,0]),px=Math.floor(css[0]),py=Math.floor(css[1]);let visible=false;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const wx=1.8+(2*(px+dx+0.5)/320-1)*span,wy=(1-2*(py+dy+0.5)/320)*span;let u=(wx-1)/2,v=(1-wy)/2;if(transformed){u=(3-wx)/2;const previousU=u;u=Math.fround(c*0.77)*u+Math.fround(s*0.81)*v+0.23;v=Math.fround(-s*0.77)*previousU+Math.fround(c*0.81)*v+0.17;}const column=Math.floor((u-Math.floor(u))*4),row=Math.floor((v-Math.floor(v))*4);visible||=column===1||row===2;}values.push(+visible);}return values;};
      const expectedMask=cpuMask(true),ignoredCoordinatesMask=cpuMask(false);assert(expectedMask.filter((value,i)=>value!==ignoredCoordinatesMask[i]).length>=5,'Alpha fixture does not distinguish baseline UV0 from transformed UV1');
      assert(actualMask.every((value,i)=>value===bakedMask[i]&&value===expectedMask[i])&&actualMask.includes(0)&&actualMask.includes(1),'Transformed UV1 alpha picking disagrees with baked UVs or independent CPU texture sampling: '+JSON.stringify({actualMask,bakedMask,expectedMask,ignoredCoordinatesMask}));report.alphaUV1={samples:actualMask.length,mask:actualMask,expectedMask,ignoredCoordinatesMask};
      selection=Selection.attach(instance,{width:4,color:[0,1,0]});const releaseActual=selection.add(actualAlpha),releaseBaked=selection.add(bakedAlpha);selection.set([bakedAlpha.primitives[0].node]);const bakedOutline=await render('alpha:selection:baked');bakedAlpha.root.visible=false;actualAlpha.root.visible=true;selection.set([actualAlpha.primitives[0].node]);report.alphaUV1.selection=exact(bakedOutline,await render('alpha:selection:transformed'),'Transformed UV1 alpha selection disagrees with baked UVs');releaseActual();releaseBaked();selection.dispose();selection=undefined;actualAlpha.destroy();bakedAlpha.destroy();
      const minified=load(payload.minified,[await createImageBitmap(image)]),mipAnimation=Animation.attach(minified);mipAnimation.playing=false;minified.root.visible=false;const noMipMesh=await render('alpha:minification:absent');minified.root.visible=true;report.minification={beauty:exact(noMipMesh,await render('alpha:minification:beauty'),'A fully minified alpha mask did not resolve to its independently known 7/16 coverage')};
      const mipMask=await mask(minified,'alpha:minification:implicit');assert(mipMask.every(value=>value===0),'GPU picking used level 0 instead of the fully transparent minified mip: '+JSON.stringify(mipMask));
      const mip0Sampler=engine.gpu.createSampler({magFilter:'nearest',minFilter:'nearest',addressModeU:'repeat',addressModeV:'repeat',lodMaxClamp:0}),mip0Source={root:minified.root,get pickingPrimitives(){return minified.pickingPrimitives.map(primitive=>({...primitive,alphaSampler:mip0Sampler}));},prepareDeformation:context=>minified.prepareDeformation(context)},releaseMip0=picker.add(mip0Source);let levelZeroHits=0;
      try{for(let y=-0.8;y<=0.81;y+=0.4)for(let x=1.2;x<=2.81;x+=0.4)levelZeroHits+=+(await instance.pick(...project([x,y,0]))===minified.primitives[0].node);}finally{releaseMip0();}assert(levelZeroHits>10,'Minification fixture does not detect a forced level-0 alpha sampler');report.minification.levelZeroHits=levelZeroHits;
      selection=Selection.attach(instance,{width:4,color:[0,1,0]});const releaseMipSelection=selection.add(minified);selection.set([minified.primitives[0].node]);report.minification.selection=exact(noMipMesh,await render('alpha:minification:selection'),'Selection used unfiltered alpha instead of the beauty mip');releaseMipSelection();selection.dispose();selection=undefined;minified.destroy();model.root.visible=true;

      const prior=await render('restore:before');await hit([3.5,-0.2,0],node,'restore:pick-before');const oldDevice=engine.gpu,oldRecords=resources.slice();
      // Device creation itself is asynchronous. Hold the mapped-read continuation
      // until the swap completes so the query is provably still pending at restore.
      const pickingRead=resources.findLast(record=>!record.destroyed&&record.descriptor.size===768&&(record.descriptor.usage&GPUBufferUsage.MAP_READ)).resource,originalMap=pickingRead.mapAsync.bind(pickingRead);let resumeRead;const readGate=new Promise(resolve=>resumeRead=resolve);pickingRead.mapAsync=(...args)=>originalMap(...args).then(()=>readGate);
      const pendingRestore=instance.pick(...project([3.5,-0.2,0]));try{await instance.rebootDevice();}finally{resumeRead();}assert(await pendingRestore===null,'A pick pending during restoration retained an old device result');assert(engine.gpu!==oldDevice,'Device restoration kept the old GPU device');track(engine.gpu);await hit([3.5,-0.2,0],node,'restore:pick-without-beauty');report.restore=exact(prior,await render('restore:after'),'Device restoration changed deformed beauty');assert(oldRecords.every(record=>record.destroyed),'Device restoration leaked an old GPU resource');
      const pending=instance.pick(...project([3.5,-0.2,0])),pendingBVH=new Raycaster([3.5,-0.2,3],[0,0,-1]).intersectModel(model);remove();model.destroy();const replacement=load(payload.fixtures[0].data);const replacementAnimation=Animation.attach(replacement,{loop:false});replacementAnimation.playing=false;replacementAnimation.seek(1);replacement.root.setPosition([1.5,0,0]);const removeReplacement=picker.add(replacement);assert(await pending===null,'Pending pick returned a deleted/reused mesh slot');assert((await pendingBVH).length===0,'Pending BVH query hit a deleted/reused mesh slot');await hit([3.5,-0.2,0],replacement.primitives[0].node,'lifecycle:replacement');
      const pendingDispose=instance.pick(...project([3.5,-0.2,0]));picker.dispose();assert(await pendingDispose===null,'Disposing a pending picker returned stale geometry');picker=undefined;removeReplacement();replacement.destroy();report.pendingLifecycle=true;
      const shaderErrors=(await Promise.all(modules.map(({module})=>module.getCompilationInfo()))).flatMap(info=>info.messages.filter(message=>message.type==='error').map(message=>message.message));assert(shaderErrors.length===0,shaderErrors.join('\n'));assert(validation.length===0,validation.join('\n'));
      instance.dispose();assert(resources.every(record=>record.destroyed),'Deformed picking leaked GPU buffers or textures');report.resourcesDestroyed=resources.length;report.shaderModules=modules.length;report.compilationErrors=shaderErrors;report.validationErrors=validation;report.captures=labels.length;report.labels=labels;return report;
    }catch(error){throw new Error(currentLabel+': '+error.message+'\n'+validation.join('\n'));}
    finally{selection?.dispose();picker?.dispose();if(!instance.disposed)instance.dispose();canvas.remove();}
  },payload);
}

export async function runDeformedPickingTests(){
  await mkdir('test-results',{recursive:true});const browser=await openBrowser({startPath:'/tests/modern-extension.html',port:5208}),errors=[];
  const listen=page=>{page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error'||/Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))errors.push(message.text());});};listen(browser.page);
  try{
    const msaa=await deformedPickingBrowserChecks(browser.page),context=await browser.page.context().browser().newContext({viewport:{width:1440,height:1100},deviceScaleFactor:1,userAgent:browser.hardware.userAgent+' Mobi'});let singleSample;
    try{const page=await context.newPage();listen(page);await page.goto(browser.page.url());singleSample=await deformedPickingBrowserChecks(page);}finally{await context.close();}
    assert.deepEqual(errors,[]);const report={hardware:browser.hardware,sampleCounts:[4,1],msaa,singleSample,errors};await writeFile('test-results/deformed-picking-webgpu.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }
  finally{await browser.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await runDeformedPickingTests();
