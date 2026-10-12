import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from './browser.js';
import {build} from 'vite';

await build({configFile:false,logLevel:'silent',build:{write:false,target:'es2022',rollupOptions:{input:'examples/windy-meadow.html'}}});

const browser=await openBrowser(),errors=[];
browser.page.on('pageerror',error=>errors.push(error.message));
browser.page.on('console',message=>{if(message.type()==='error'||/Error while parsing|Invalid .*Pipeline|ValidationError/.test(message.text()))errors.push(message.text());});
try {
  const result=await browser.page.evaluate(async()=>{
    const {GrassField,PostProcessing}=await import('/packages/creative/dist/index.js');
    const {Stage}=await import('/packages/margoengine/dist/index.js');
    const assert=(condition,message)=>{if(!condition)throw new Error(message);};
    await window.modern.core('webgpu');
    const engine=window.modern.state.core,device=engine.gpu;
    const modules=[],createModule=device.createShaderModule.bind(device);
    device.createShaderModule=descriptor=>{const module=createModule(descriptor);modules.push({module,code:descriptor.code,label:descriptor.label});return module;};
    const uncaptured=[];device.addEventListener('uncapturederror',event=>uncaptured.push(event.error.message));
    device.pushErrorScope('validation');
    const stage=new Stage(engine),field=new GrassField(stage,{blades:100_003,area:[50,50],drawDistance:60,spores:true});
    assert(!('grass' in stage),'Grass leaked into the Stage facade');
    engine.camera.position=[0,6,18];engine.camera.target=[0,0.5,0];
    const read=device.createBuffer({size:32,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const counts=async(target=field)=>{
      const encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(target.indirect,0,read,0,32);device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();return values;
    };
    engine.render({delta:0.1});await device.queue.onSubmittedWorkDone();
    const visible=await counts();assert(visible[1]>0 && visible[5]>0 && visible[1]+visible[5]<field.blades,'Frustum culling or LOD failed');
    assert(visible[0]===7 && visible[2]===0 && visible[3]===0 && visible[4]===3 && visible[6]===7 && visible[7]===0,'Invalid indirect command layout');
    const listRead=device.createBuffer({size:field.blades*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const listEncoder=device.createCommandEncoder();listEncoder.copyBufferToBuffer(field.visible,0,listRead,0,field.blades*8);device.queue.submit([listEncoder.finish()]);
    await listRead.mapAsync(GPUMapMode.READ);const lists=new Uint32Array(listRead.getMappedRange()),seen=new Set();
    for(const [offset,count] of [[0,visible[1]],[field.blades,visible[5]]])for(let i=0;i<count;i++){const id=lists[offset+i];assert(id<field.blades&&!seen.has(id),'Invalid or duplicate compacted blade');seen.add(id);}
    listRead.unmap();
    device.queue.writeBuffer(field.indirect,4,new Uint32Array([field.blades]));
    device.queue.writeBuffer(field.indirect,20,new Uint32Array([field.blades]));
    engine.render();const repeated=await counts();assert(repeated[1]===visible[1]&&repeated[5]===visible[5],'Poisoned indirect counters were not reset before culling');
    engine.camera.position=[0,6,200];engine.camera.target=[0,0,250];engine.render();
    const outside=await counts();assert(outside[1]===0&&outside[5]===0,'Out-of-view blades survived culling');
    engine.camera.position=[0,6,18];engine.camera.target=[0,0.5,0];engine.render();

    const names=['createBuffer','createBindGroup','createBindGroupLayout','createPipelineLayout','createShaderModule','createComputePipeline','createRenderPipeline'],originals=names.map(name=>device[name]);
    let allocations=0;const begin=GPUCommandEncoder.prototype.beginRenderPass,descriptors=[];
    for(let i=0;i<names.length;i++)device[names[i]]=function(...args){allocations++;return originals[i].apply(this,args);};
    GPUCommandEncoder.prototype.beginRenderPass=function(descriptor){descriptors.push(descriptor);return begin.call(this,descriptor);};
    try {for(let i=0;i<5;i++){field.windSpeed=i*0.3;engine.render({delta:0.1});await device.queue.onSubmittedWorkDone();}}
    finally {for(let i=0;i<names.length;i++)device[names[i]]=originals[i];GPUCommandEncoder.prototype.beginRenderPass=begin;}
    const grassDescriptors=descriptors.filter(d=>d===field.pass||d===field.sporePass);
    assert(allocations===0&&grassDescriptors.length===10,'Steady grass frames created resources or replaced their pass descriptors');
    const picked=await engine.pick(160,120);assert(picked!==null,'Grass broke core mesh picking');

    const renderSource=modules.find(record=>record.label==='grass:render').code;
    const probe=device.createShaderModule({code:renderSource+`
      @group(0) @binding(4) var<storage,read_write> result:array<vec4f>;
      @compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id:vec3u){
        let v=bladeVertex(vec3f(0),vec2f(0.5,f32(id.x)/3.0),0u);
        result[id.x]=vec4f(v.world,length(v.normal));
      }`});
    const probePipeline=device.createComputePipeline({layout:'auto',compute:{module:probe,entryPoint:'probe'}});
    const points=device.createBuffer({size:64,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    const pointRead=device.createBuffer({size:64,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const probeGroup=device.createBindGroup({layout:probePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:field.uniform}},{binding:1,resource:{buffer:field.instances}},{binding:4,resource:{buffer:points}}]});
    const probeEncoder=device.createCommandEncoder(),probePass=probeEncoder.beginComputePass();probePass.setPipeline(probePipeline);probePass.setBindGroup(0,probeGroup);probePass.dispatchWorkgroups(4);probePass.end();
    probeEncoder.copyBufferToBuffer(points,0,pointRead,0,64);device.queue.submit([probeEncoder.finish()]);await pointRead.mapAsync(GPUMapMode.READ);
    const bent=Array.from(new Float32Array(pointRead.getMappedRange()));pointRead.unmap();
    assert(bent[1]===0&&bent.every(Number.isFinite),'Root moved or curved normal became invalid');
    const lengths=[];for(let i=1;i<4;i++)lengths.push(Math.hypot(bent[i*4]-bent[(i-1)*4],bent[i*4+1]-bent[(i-1)*4+1],bent[i*4+2]-bent[(i-1)*4+2]));
    assert(Math.max(...lengths)-Math.min(...lengths)<1e-5,'Wind changed segment lengths');
    for(let i=0;i<4;i++)assert(Math.abs(bent[i*4+3]-1)<1e-5,'Curved blade normal is not unit length');

    const size=256,format=navigator.gpu.getPreferredCanvasFormat(),depthFormat=device.features.has('depth32float-stencil8')?'depth32float-stencil8':'depth32float';
    const color=device.createTexture({size:[size,size],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});
    const depth=device.createTexture({size:[size,size],format:depthFormat,usage:GPUTextureUsage.RENDER_ATTACHMENT});
    const pixels=device.createBuffer({size:size*size*4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const drawImage=async(time,clearDepth=0,spores=false)=>{
      field.windTime=time;engine.camera.update(1,true);
      const encoder=device.createCommandEncoder(),colorView=color.createView(),depthView=depth.createView();
      const clear=encoder.beginRenderPass({colorAttachments:[{view:colorView,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,1]}],depthStencilAttachment:{view:depthView,depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:clearDepth,stencilReadOnly:true}});clear.end();
      const context={backend:'webgpu',device,encoder,camera:engine.camera,delta:0,format,color:colorView,depth:depthView,descriptor:{multisample:{count:1}}};
      field.update(context);field.draw(context);if(spores)field.drawSpores(context);
      encoder.copyTextureToBuffer({texture:color},{buffer:pixels,bytesPerRow:size*4},[size,size]);device.queue.submit([encoder.finish()]);await pixels.mapAsync(GPUMapMode.READ);
      const data=new Uint8Array(pixels.getMappedRange()).slice();pixels.unmap();return data;
    };
    const difference=(a,b)=>{let changed=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>3)changed++;return changed;};
    const still=await drawImage(0),wind=await drawImage(8),spores=await drawImage(8,0,true),occluded=await drawImage(8,1);
    let green=0;for(let i=0;i<still.length;i+=4)if(still[i+1]>still[i]&&still[i+1]>still[i+2])green++;
    const windChanged=difference(still,wind),sporeChanged=difference(wind,spores);
    assert(green>1000&&windChanged>100&&sporeChanged>0,'Grass colors, animated wind or floating spores missing');
    assert(occluded.every((value,i)=>i%4===3?value===255:value===0),'Grass ignored scene depth');
    for(const resource of [points,pointRead,color,depth,pixels])resource.destroy();

    field.dispose();
    // Captured frame whose slightly negative blade UV poisoned the bloom texture.
    engine.canvas.style.width='661px';engine.canvas.style.height='884px';
    engine.camera.position=[12.977123260498047,13.3236722946167,22.119840621948242];
    engine.camera.target=[12.530253112316132,12.867994844913483,21.34999316930771];
    const bloomField=new GrassField(stage,{blades:100_000,area:[60,60],drawDistance:90,spores:true});
    const bloomPost=new PostProcessing({bloom:0.12,threshold:1.2,atmosphere:{sky:true,density:0.007,heightFalloff:0.08,color:[0.58,0.69,0.75],sun:[0.6,0.5,-0.5]}});
    engine.use(bloomPost);bloomField.windTime=196.35499572753906;engine.render();
    const hdr=bloomPost.target.color,hdrRow=Math.ceil(hdr.width*8/256)*256;
    const hdrRead=device.createBuffer({size:hdrRow*hdr.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const hdrEncoder=device.createCommandEncoder();hdrEncoder.copyTextureToBuffer({texture:hdr},{buffer:hdrRead,bytesPerRow:hdrRow},[hdr.width,hdr.height]);device.queue.submit([hdrEncoder.finish()]);await hdrRead.mapAsync(GPUMapMode.READ);
    const hdrPixels=new Uint16Array(hdrRead.getMappedRange());let nonFiniteHDRPixels=0;
    for(let y=0;y<hdr.height;y++)for(let x=0;x<hdr.width;x++){const i=y*hdrRow/2+x*4;if((hdrPixels[i]&0x7c00)===0x7c00||(hdrPixels[i+1]&0x7c00)===0x7c00||(hdrPixels[i+2]&0x7c00)===0x7c00||(hdrPixels[i+3]&0x7c00)===0x7c00)nonFiniteHDRPixels++;}
    hdrRead.unmap();hdrRead.destroy();bloomField.destroy();engine.removePlugin(bloomPost.name);
    assert(nonFiniteHDRPixels===0,'Captured grass/bloom regression frame contains non-finite HDR pixels');
    engine.canvas.style.width='1280px';engine.canvas.style.height='720px';engine.camera.position=[0,55,0.01];engine.camera.target=[0,0,0];
    const performance=[];
    for(const blades of [100_000,500_000]) {
      const meadow=new GrassField(stage,{blades,area:[50,50],drawDistance:200,spores:true});
      for(let i=0;i<10;i++)engine.render({delta:1/60});await device.queue.onSubmittedWorkDone();
      const visible=await counts(meadow);assert(visible[1]===blades&&visible[5]===0,'Benchmark did not draw every full-detail blade');
      const durations=[];
      for(let i=0;i<90;i++) {const start=window.performance.now();engine.render({delta:1/60});await device.queue.onSubmittedWorkDone();durations.push(window.performance.now()-start);}
      durations.sort((a,b)=>a-b);performance.push({blades,fullDetailVisible:visible[1],resolution:[1280,720],medianFrameMs:durations[45],p95FrameMs:durations[85]});meadow.dispose();
    }
    engine.camera.position=[0,6,18];engine.camera.target=[0,0.5,0];
    const restored=new GrassField(stage,{blades:100_000,area:[50,50],spores:true});
    engine.use(new PostProcessing({bloom:0.1,atmosphere:{sky:true,density:0.01}}));engine.render();await device.queue.onSubmittedWorkDone();
    engine.canvas.style.width='400px';engine.canvas.style.height='300px';engine.render();await device.queue.onSubmittedWorkDone();
    const diagnostics=(await Promise.all(modules.map(record=>record.module.getCompilationInfo()))).flatMap(info=>info.messages.map(m=>({type:m.type,message:m.message})));
    const validation=await device.popErrorScope();assert(!validation&&!uncaptured.length&&!diagnostics.some(m=>m.type==='error'),'WGSL/GPU validation failed: '+(validation?.message??uncaptured.join('; '))+JSON.stringify(diagnostics));
    read.destroy();listRead.destroy();
    const time=restored.windTime;await engine.rebootDevice();engine.gpu.pushErrorScope('validation');engine.render({delta:0.1});await engine.gpu.queue.onSubmittedWorkDone();
    assert(engine.gpu!==device&&engine.hasPlugin(restored.name)&&restored.windTime>=time,'Grass device restoration failed');
    const grassPipeline=restored.compute,setPipeline=GPUComputePassEncoder.prototype.setPipeline;
    let postDestroyGrassDispatches=0;
    GPUComputePassEncoder.prototype.setPipeline=function(pipeline){if(pipeline===grassPipeline)postDestroyGrassDispatches++;return setPipeline.call(this,pipeline);};
    try {
      restored.destroy();restored.destroy();const stoppedTime=restored.windTime;
      engine.render();await engine.gpu.queue.onSubmittedWorkDone();assert(!engine.hasPlugin(restored.name),'Field destruction failed');
      await new Promise(resolve=>{let frames=0;const unsubscribe=engine.onFrame(()=>{if(++frames===3){engine.stop();unsubscribe();resolve();}});engine.start();});
      await engine.gpu.queue.onSubmittedWorkDone();
      assert(postDestroyGrassDispatches===0&&restored.windTime===stoppedTime,'Destroyed grass still dispatched compute or advanced on animation ticks');
    } finally {engine.stop();GPUComputePassEncoder.prototype.setPipeline=setPipeline;}
    const teardownValidation=await engine.gpu.popErrorScope();assert(!teardownValidation,'GPU teardown validation failed: '+teardownValidation?.message);engine.dispose();
    return {potential:field.blades,near:visible[1],far:visible[5],outside:[outside[1],outside[5]],greenPixels:green,windChangedPixels:windChanged,sporeChangedPixels:sporeChanged,nonFiniteHDRPixels,performance,diagnostics,steadyFrameResourceAllocations:allocations,postDestroyGrassDispatches,checks:['non-workgroup-multiple blade count','six-plane and distance culling','two LOD lists without duplicates','poisoned GPU counter reset','portable indirect commands','pinned roots, retained segment lengths and unit curved normals','grass, wind, spore and depth pixel readback','captured grass/bloom regression frame','Stage integration and mesh picking','HDR, resize, device restoration and destruction during ongoing animation']};
  });
  const instrument=()=>{
    window.meadowAudit={live:new Set(),textures:[],samples:[],boundSamples:new Set(),created:0,frames:0,grass:[]};
    const pipelines=new WeakMap();
    for(const name of ['createBuffer','createTexture','createRenderPipeline','createBindGroup']){
      const original=GPUDevice.prototype[name];
      GPUDevice.prototype[name]=function(desc){
        const audit=window.meadowAudit,result=original.call(this,desc);audit.created++;
        if(name==='createRenderPipeline'){const samples=desc.multisample?.count??1;pipelines.set(result,samples);audit.samples.push(samples);}
        if(name==='createTexture')audit.textures.push(desc.sampleCount??1);
        if(name==='createBuffer'||name==='createTexture'){audit.live.add(result);const destroy=result.destroy.bind(result);result.destroy=()=>{audit.live.delete(result);destroy();};}
        return result;
      };
    }
    const set=GPURenderPassEncoder.prototype.setPipeline;
    GPURenderPassEncoder.prototype.setPipeline=function(pipeline){window.meadowAudit.boundSamples.add(pipelines.get(pipeline));return set.call(this,pipeline);};
    const write=GPUQueue.prototype.writeBuffer;
    GPUQueue.prototype.writeBuffer=function(buffer,offset,data,...rest){if(buffer.label==='grass:frame'){window.meadowAudit.grass=Array.from(data);window.meadowAudit.frames++;}return write.call(this,buffer,offset,data,...rest);};
  };
  const {page}=browser;
  await page.addInitScript(instrument);await page.setViewportSize({width:1280,height:800});
  await page.goto('http://127.0.0.1:5193/examples/windy-meadow.html');
  await page.locator('#viewport[data-ready=true]').waitFor();
  await page.waitForFunction(()=>meadowAudit.frames>5);
  assert(await page.evaluate(()=>meadowAudit.textures.includes(4)&&meadowAudit.boundSamples.has(4)),'Desktop did not draw with 4× MSAA');
  assert.equal(await page.locator('#density').inputValue(),'100000');
  await page.getByRole('button',{name:'Pause motion'}).click();
  const initial=await page.evaluate(()=>({time:meadowAudit.grass[59],camera:meadowAudit.grass.slice(40,43),live:meadowAudit.live.size}));
  await page.locator('#speed').fill('2.1');await page.locator('#strength').fill('0.6');
  assert.equal(await page.locator('#speed-value').textContent(),'2.1');
  const image=()=>page.evaluate(()=>document.querySelector('canvas').toDataURL());
  const day=await image();await page.locator('#hours').fill('22');
  assert.notDeepEqual(day,await image(),'Day/night lighting did not change');
  await page.locator('#hours').fill('17.5');assert.equal(await page.locator('#hours-value').textContent(),'17:30');
  await page.locator('#hours').fill('16');
  for(const [id,value] of [['clouds','0'],['bloom','1'],['exposure','1']]){
    const previous=await page.locator('#'+id).inputValue(),before=await image();
    await page.locator('#'+id).fill(value);assert.notDeepEqual(before,await image(),id+' did not change the rendered scene');
    await page.locator('#'+id).fill(previous);
  }
  const withSeeds=await image();await page.locator('#seeds').uncheck();
  assert.notDeepEqual(withSeeds,await image(),'Seed toggle did not change the rendered scene');
  assert(!(await page.locator('#status').textContent()).includes('240 seeds'));
  for(const count of ['35000','200000','100000']){
    await page.locator('#density').selectOption(count);
    assert.equal(await page.evaluate(()=>meadowAudit.grass[61]),Number(count));
    assert.equal(await page.evaluate(()=>meadowAudit.live.size),initial.live,'Density changes leaked GPU resources');
  }
  await page.locator('#seeds').check();
  const settings=await page.evaluate(()=>meadowAudit.grass);
  assert(Math.abs(settings[54]-2.1)<1e-6&&Math.abs(settings[55]-0.6)<1e-6&&settings[59]===initial.time&&settings[62]===1,'Density/seed changes lost wind settings, paused time or linear HDR');
  const before=await image();await page.locator('canvas').focus();await page.keyboard.press('ArrowLeft');await page.keyboard.press('+');
  assert.notDeepEqual(before,await image(),'Keyboard navigation did not render while motion was paused');
  await page.locator('#reset-view').click();
  assert.deepEqual(await page.evaluate(()=>meadowAudit.grass.slice(40,43)),initial.camera);
  const paused=await page.evaluate(()=>({frames:meadowAudit.frames,created:meadowAudit.created}));
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>meadowAudit.frames),paused.frames,'Paused meadow kept rendering');
  await page.locator('#pause').click();await page.waitForFunction(time=>meadowAudit.grass[59]>time,initial.time);
  await page.locator('#pause').click();
  assert.equal(await page.evaluate(()=>meadowAudit.created),paused.created,'Steady frames allocated GPU resources');
  await page.locator('#speed').fill('1.2');await page.locator('#strength').fill('0.45');
  await page.evaluate(()=>{document.getElementById('settings').scrollTop=0;});
  await page.screenshot({path:'test-results/modern-windy-meadow.png'});
  await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await page.locator('#viewport[data-ready=true]').waitFor();
  assert.equal(await page.getByRole('button',{name:'Resume motion'}).getAttribute('aria-pressed'),'true');
  assert.equal(await page.evaluate(()=>meadowAudit.grass[59]),0);
  await page.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));
  assert.equal(await page.evaluate(()=>meadowAudit.live.size),0,'Desktop teardown leaked GPU resources');

  const mobileContext=await page.context().browser().newContext({viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',reducedMotion:'reduce'});
  try{
    await mobileContext.addInitScript(instrument);const mobile=await mobileContext.newPage();
    mobile.on('pageerror',e=>errors.push(e.message));mobile.on('console',m=>{if(m.type()==='error'||/ValidationError|Invalid .*Pipeline/.test(m.text()))errors.push(m.text());});
    await mobile.goto('http://127.0.0.1:5193/examples/windy-meadow.html');await mobile.locator('#viewport[data-ready=true]').waitFor();
    const quality=await mobile.evaluate(()=>({textures:meadowAudit.textures,samples:meadowAudit.samples,blades:meadowAudit.grass[61],open:document.getElementById('settings').open,dpr:document.querySelector('canvas').width/innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,panel:document.querySelector('aside').getBoundingClientRect().height}));
    assert.equal(quality.blades,35000);assert(!quality.open&&!quality.overflow&&quality.panel<844/2);
    assert(!quality.textures.includes(4)&&!quality.samples.includes(4));assert.equal(quality.dpr,2);
    await mobile.getByText('Shape the meadow',{exact:true}).click();await mobile.locator('#density').selectOption('100000');
    assert.equal(await mobile.evaluate(()=>meadowAudit.grass[61]),100000);
    await mobile.locator('#density').selectOption('35000');
    await mobile.getByText('Shape the meadow',{exact:true}).click();await mobile.screenshot({path:'test-results/modern-windy-meadow-mobile.png'});
    const before=await mobile.evaluate(()=>document.querySelector('canvas').toDataURL()),cdp=await mobileContext.newCDPSession(mobile);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:125,y:600},{x:255,y:600}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:95,y:600},{x:285,y:600}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.notEqual(before,await mobile.evaluate(()=>document.querySelector('canvas').toDataURL()),'Pinch did not render while paused');
    await mobile.evaluate(()=>dispatchEvent(new PageTransitionEvent('pagehide')));assert.equal(await mobile.evaluate(()=>meadowAudit.live.size),0);
    result.demo={desktopSamples:4,mobile:quality,checks:['day/night, clouds, bloom, exposure and seeds change pixels','wind settings and time survive density changes','paused keyboard/pinch and reset','reduced motion stops animation','zero steady GPU allocations and clean teardown']};
  }finally{await mobileContext.close();}
  assert.equal(await page.locator('#error').textContent(),'');
  assert.deepEqual(errors,[]);
  const output={hardware:browser.hardware,...result};
  await writeFile('test-results/modern-grass.json',JSON.stringify(output,null,2));console.log(JSON.stringify(output,null,2));
} finally {await browser.close();}
