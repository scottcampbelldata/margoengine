import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from './browser.js';
import {animatedTriangle} from '../tests/support/gltf-pro-fixture.js';
import {decodePNG} from '../tests/support/png.js';

const browser=await openBrowser({startPath:'/tests/modern-game.html'}),{page,hardware}=browser,errors=[];
page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
try{
  const fixture=animatedTriangle();
  const result=await page.evaluate(async({doc,buffers,stress})=>{
    const {EngineKernel}=await import('/packages/core/dist/index.js'),{box,engineRuntime}=await import('/packages/core/dist/extension.js');
    const {TAA}=await import('/packages/taa/dist/index.js'),{Splats}=await import('/packages/splats/dist/index.js');
    const {parseGLTF}=await import('/packages/gltf-pro/dist/index.js'),{Animation}=await import('/packages/animation/dist/index.js');
    const {PostProcessing}=await import('/packages/creative/dist/index.js');
    const {SSAO}=await import('/packages/post/dist/index.js');
    const {Clustered}=await import('/packages/clustered/dist/index.js'),{invert}=await import('/packages/shared/math.js');
    const assert=(ok,message)=>{if(!ok)throw new Error(message);},canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:128px';document.body.append(canvas);
    const instance=await EngineKernel.create(canvas,{backend:'webgpu',capacity:32,camera:{position:[0,0,6],target:[0,0,0],near:0.1,far:100}}),engine=engineRuntime(instance),device=engine.gpu,modules=[],create=device.createShaderModule.bind(device);
    device.createShaderModule=d=>{const m=create(d);modules.push(m);return m;};device.pushErrorScope('validation');
    const readBuffer=async(buffer,size=buffer.size,offset=0)=>{const read=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(buffer,offset,read,0,size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const bytes=read.getMappedRange().slice(0);read.unmap();read.destroy();return bytes;};
    const readTexture=async(texture,bytesPerPixel)=>{const row=Math.ceil(texture.width*bytesPerPixel/256)*256,size=row*texture.height,read=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:row},[texture.width,texture.height]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const bytes=read.getMappedRange().slice(0);read.unmap();read.destroy();return {bytes,row};};
    const half=n=>{const sign=n&32768?-1:1,exponent=n>>10&31,fraction=n&1023;return sign*(exponent?2**(exponent-15)*(1+fraction/1024):2**-14*fraction/1024);};
    const pixel=(read,x,y,channels)=>{const words=new Uint16Array(read.bytes),start=(y*read.row+x*channels*2)/2;return Array.from({length:channels},(_,i)=>half(words[start+i]));};
    const render=async()=>{instance.render({culling:false});await engine.gpu.queue.onSubmittedWorkDone();};
    const mesh=instance.createMesh().setGeometry(box()).setScale([10,10,0.1]);let taa=TAA.attach(instance,{historyWeight:0.9});
    await render();const normal=instance.camera.matrix.slice();await render();assert(instance.camera.matrix.every((v,i)=>v===normal[i]),'Jitter accumulated in the public camera matrix');
    const still=await readTexture(taa.gpuState.velocity,4);assert(Math.abs(pixel(still,64,64,2)[0])<0.01,'Stationary geometry has unexpected velocity');
    const pattern=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});let patternPipeline,patternGroup;
    const removePattern=engine.frameGraph.add({name:'temporal:test-pattern',order:5,execute:c=>{
      if(!patternPipeline){const module=device.createShaderModule({code:`@group(0) @binding(0) var<uniform> mode:vec4f;
        @vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);}
        @fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {if(mode.x<0.5){return vec4f(vec3f(0.1+0.8*p.x/128),1);}if(mode.x<1.5){return vec4f(vec3f(select(0.0,1.0,(u32(p.x)+u32(p.y))%2==0)),1);}return vec4f(0,1,0,1);}`});
        patternPipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]}});patternGroup=device.createBindGroup({layout:patternPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:pattern}}]});}
      const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}]});pass.setPipeline(patternPipeline);pass.setBindGroup(0,patternGroup);pass.draw(3);pass.end();
    }});
    device.queue.writeBuffer(pattern,0,new Float32Array([0,0,0,0]));taa.reset();await render();const old=await readTexture(taa.gpuState.history,8);
    device.queue.writeBuffer(pattern,0,new Float32Array([1,0,0,0]));mesh.position.x=0.5;await render();
    const moved=await readTexture(taa.gpuState.velocity,4),velocity=pixel(moved,64,64,2);assert(velocity[0]>0.05,'Moving mesh velocity missed its previous model transform: '+velocity);
    const uv=[(64.5/128-velocity[0])*128-0.5,(64.5/128-velocity[1])*128-0.5],base=uv.map(Math.floor),fraction=uv.map((v,i)=>v-base[i]);let expected=0;
    for(let y=0;y<2;y++)for(let x=0;x<2;x++)expected+=pixel(old,base[0]+x,base[1]+y,4)[0]*(x?fraction[0]:1-fraction[0])*(y?fraction[1]:1-fraction[1]);
    const accumulated=pixel(await readTexture(taa.gpuState.history,8),64,64,4)[0];assert(Math.abs(accumulated-(0.1+0.9*expected))<0.003,'History did not follow motion-vector reprojection: '+accumulated+' vs '+expected);
    assert(Math.abs(accumulated-(0.1+0.9*pixel(old,64,64,4)[0]))>0.01,'History stayed at the current screen pixel');
    device.queue.writeBuffer(pattern,0,new Float32Array([2,0,0,0]));await render();const clamped=pixel(await readTexture(taa.gpuState.history,8),64,64,4);assert(clamped[0]<0.002&&clamped[1]>0.998&&clamped[2]<0.002,'YCoCg clamping retained the old color: '+clamped);
    taa.reset();device.queue.writeBuffer(pattern,0,new Float32Array([1,0,0,0]));await render();assert(pixel(await readTexture(taa.gpuState.history,8),64,64,4)[0]>0.998,'Explicit history reset still blended');
    const front=instance.createMesh().setGeometry(box()).setScale([10,10,0.1]).setPosition([0,0,1]),id=front.id;taa.reset();device.queue.writeBuffer(pattern,0,new Float32Array([0,0,0,0]));await render();front.dispose();
    const replacement=instance.createMesh().setGeometry(box()).setScale([10,10,0.1]).setPosition([0,0,1]);assert(replacement.id===id,'Entity reuse fixture failed');device.queue.writeBuffer(pattern,0,new Float32Array([1,0,0,0]));await render();assert(pixel(await readTexture(taa.gpuState.history,8),64,64,4)[0]>0.998,'A reused mesh ID inherited the old motion/history');
    device.queue.writeBuffer(pattern,0,new Float32Array([0,0,0,0]));await render();replacement.visible=false;device.queue.writeBuffer(pattern,0,new Float32Array([1,0,0,0]));await render();assert(pixel(await readTexture(taa.gpuState.history,8),64,64,4)[0]>0.998,'Disoccluded geometry reused foreground depth history');replacement.dispose();
    removePattern();pattern.destroy();mesh.visible=false;
    const model=parseGLTF(instance,doc,buffers.map(b=>new Uint8Array(b))),animation=Animation.attach(model);animation.playing=false;taa.add(model);animation.seek(0);await render();animation.seek(0.5);animation.setMorph(0,0,0.5);await render();
    const deform=await readTexture(taa.gpuState.velocity,4);let movingPixels=0;for(let y=0;y<128;y++)for(let x=0;x<128;x++)if(pixel(deform,x,y,2)[0]>0.04)movingPixels++;assert(movingPixels>30,'Skinned/morphed vertices did not write motion: '+movingPixels);
    model.dispose();mesh.visible=true;mesh.position.x=0;
    const post=new PostProcessing({bloom:0.1});engine.use(post);taa.options.depth=()=>post.target?.depth;await render();engine.removePlugin(post.name);delete taa.options.depth;
    const ssao=SSAO.attach(instance,{samples:8});taa.options.depth=()=>ssao.depthTexture;await render();taa.dispose();await render();taa=TAA.attach(instance,{depth:()=>ssao.depthTexture});await render();ssao.dispose();delete taa.options.depth;
    canvas.style.width='96px';await render();assert(taa.gpuState.history.width===96,'History did not resize');canvas.style.width='128px';await render();
    taa.dispose();taa=TAA.attach(instance,{historyWeight:0});instance.camera.near=5.94;instance.camera.far=5.96;const edgeLight=Clustered.attach(instance,{grid:[3,1,1]}),radiance=engine.lighting.radiance.slice();engine.lighting.radiance.fill(0);
    const removeEdge=engine.frameGraph.add({name:'temporal:cluster-boundary',order:-4,execute:c=>{const inverse=new Float32Array(16),m=c.camera.matrix;invert(inverse,m);const depth=(m[10]*0.05+m[14])/(m[11]*0.05+m[15]),clip=[42.5/128*2-1,1-64.5/128*2,depth,1],world=[0,1,2,3].map(r=>clip.reduce((sum,v,k)=>sum+inverse[k*4+r]*v,0));edgeLight.setLights([{position:[world[0]/world[3],world[1]/world[3],0.055],range:0.008,color:[1,0,0],intensity:2}]);}});
    for(let frame=0;frame<4;frame++)await render();const edgeCounts=new Uint32Array(await readBuffer(edgeLight.lightLists.counts));assert(edgeCounts[0]===0&&edgeCounts[1]===1,'Fractional cluster-boundary fixture failed: '+edgeCounts);
    assert(pixel(await readTexture(taa.gpuState.history,8),42,64,4)[0]>0.5,'TAA jitter sent a fragment to the wrong clustered light list');removeEdge();edgeLight.dispose();engine.lighting.radiance.set(radiance);instance.camera.near=0.1;instance.camera.far=100;
    const firstValidation=await device.popErrorScope();assert(!firstValidation,'TAA validation failed: '+firstValidation?.message);
    const oldHistory=taa.gpuState.history;await instance.rebootDevice();engine.gpu.pushErrorScope('validation');await render();assert(taa.gpuState.history!==oldHistory,'TAA retained old-device history');const recovery=await engine.gpu.popErrorScope();assert(!recovery,'TAA recovery failed: '+recovery?.message);
    // Continue against the replacement device, capturing its shader diagnostics too.
    const gpu=engine.gpu,recoveredCreate=gpu.createShaderModule.bind(gpu);gpu.createShaderModule=d=>{const m=recoveredCreate(d);modules.push(m);return m;};gpu.pushErrorScope('validation');
    const readRecovered=async(buffer,size=buffer.size,offset=0)=>{const read=gpu.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=gpu.createCommandEncoder();encoder.copyBufferToBuffer(buffer,offset,read,0,size);gpu.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const bytes=read.getMappedRange().slice(0);read.unmap();read.destroy();return bytes;};
    taa.dispose();mesh.dispose();
    const count=66_049,positions=new Float32Array(count*3),covariances=new Float32Array(count*6),colors=new Float32Array(count*4);
    for(let i=0;i<count;i++){positions[i*3+2]=5.7-((i*37)%4093)/50;covariances.set([0.000001,0,0,0.000001,0,0.000001],i*6);colors.set([0.1,0.2,0.3,0.0001],i*4);}
    const large=Splats.attach(instance,{positions,covariances,colors});instance.render({culling:false});await gpu.queue.onSubmittedWorkDone();const sorted=new Uint32Array(await readRecovered(large.gpuState.sorted)),seen=new Uint8Array(count);
    for(let i=0;i<count;i++){const key=sorted[i*2],index=sorted[i*2+1];assert(index<count&&!seen[index],'Radix scatter lost/duplicated an index at '+i);seen[index]=1;if(i){assert(sorted[i*2-2]<=key,'Radix keys are out of order at '+i);if(sorted[i*2-2]===key)assert(sorted[i*2-1]<index,'Radix sort is unstable at '+i);}}
    assert(sorted[1]!==0,'Depth sorting did not reorder the input');large.dispose();
    const data={positions:new Float32Array([0,0,0,0,0,1]),covariances:new Float32Array([0.12,0.08,0,0.12,0,0.01,0.08,0,0,0.02,0,0.01]),colors:new Float32Array([1,0,0,0.7,0,0,1,0.7])};
    const cloud=Splats.attach(instance,data);instance.render({culling:false});await gpu.queue.onSubmittedWorkDone();const pair=new Uint32Array(await readRecovered(cloud.gpuState.sorted));assert(pair[1]===0&&pair[3]===1,'Back-to-front order is wrong');
    const ellipses=new Float32Array(await readRecovered(cloud.gpuState.ellipses)),major=Math.hypot(ellipses[4],ellipses[5]),minor=Math.hypot(ellipses[6],ellipses[7]);assert(major/minor>1.9&&Math.abs(ellipses[4]-ellipses[5])<0.001,'Covariance was not projected into a rotated anisotropic ellipse: '+ellipses);
    cloud.dispose();
    const sh=new Float32Array(12);sh[9]=0.5;const harmonics=Splats.attach(instance,{positions:new Float32Array([0,0,0]),covariances:new Float32Array([0.02,0,0,0.02,0,0.02]),colors:new Float32Array([0,0,0,0.5]),sphericalHarmonics:sh});instance.camera.position=[3,0,6];instance.render({culling:false});await gpu.queue.onSubmittedWorkDone();const left=new Float32Array(await readRecovered(harmonics.gpuState.colors));instance.camera.position=[-3,0,6];instance.render({culling:false});await gpu.queue.onSubmittedWorkDone();const right=new Float32Array(await readRecovered(harmonics.gpuState.colors));assert(Math.abs(left[0]-right[0])>0.1,'View-dependent spherical harmonics were not evaluated');harmonics.dispose();instance.camera.position=[0,0,6];
    let stressCount=0;
    if(stress){const n=3_000_000,p=new Float32Array(n*3),c=new Float32Array(n*6),rgb=new Float32Array(n*4);for(let i=0;i<n;i++){p[i*3+2]=10;c.set([1,0,0,1,0,1],i*6);rgb[i*4+3]=1;}const maximum=Splats.attach(instance,{positions:p,covariances:c,colors:rgb});instance.render({culling:false});await gpu.queue.onSubmittedWorkDone();const last=new Uint32Array(await readRecovered(maximum.gpuState.sorted,8,(n-1)*8));assert(last[0]===0xffffffff&&last[1]===n-1,'Three-million capacity/stable sorting failed');stressCount=n;maximum.dispose();}
    const visual=Splats.attach(instance,data);instance.render({culling:false});await gpu.queue.onSubmittedWorkDone();
    const validation=await gpu.popErrorScope(),compile=(await Promise.all(modules.map(m=>m.getCompilationInfo()))).flatMap(i=>i.messages.filter(m=>m.type==='error').map(m=>m.message));assert(!validation&&compile.length===0,JSON.stringify({validation:validation?.message,compile}));
    window.temporalScene={instance,engine,cloud:visual};return {movingPixels,meshVelocity:velocity,reprojectedColor:accumulated,sortedSplats:count,ellipseAxisRatio:major/minor,stressSplats:stressCount,shaderModules:modules.length};
  },{doc:fixture.doc,buffers:fixture.buffers.map(b=>[...new Uint8Array(b.buffer,b.byteOffset,b.byteLength)]),stress:process.env.SPLAT_STRESS==='1'});
  const splatted=await decodePNG(await page.locator('canvas').screenshot({path:'test-results/temporal-splats.png'})),center=(64*splatted.width+64)*4;
  assert.ok(splatted.data[center+2]>splatted.data[center]+20,'Near blue splat did not blend over the far red splat');
  await page.evaluate(async()=>{const s=window.temporalScene;s.cloud.dispose();s.instance.render({culling:false});await s.engine.gpu.queue.onSubmittedWorkDone();});
  const plain=await decodePNG(await page.locator('canvas').screenshot());let changed=0;for(let i=0;i<plain.data.length;i+=4)if(Math.abs(plain.data[i]-splatted.data[i])+Math.abs(plain.data[i+1]-splatted.data[i+1])+Math.abs(plain.data[i+2]-splatted.data[i+2])>5)changed++;
  assert.ok(changed>200,'Gaussian ellipses did not change rendered pixels');result.splatPixels=changed;
  await page.evaluate(()=>window.temporalScene.instance.dispose());assert.deepEqual(errors,[]);await writeFile('test-results/modern-temporal.json',JSON.stringify({hardware,...result},null,2));console.log(JSON.stringify({hardware,...result},null,2));
}finally{await browser.close();}
