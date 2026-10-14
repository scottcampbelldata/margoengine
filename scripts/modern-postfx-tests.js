import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {openBrowser} from './browser.js';

const browser=await openBrowser({startPath:'/tests/modern-game.html',aliases:{margoengine:resolve('packages/margoengine/dist/index.js')}}),{page,hardware}=browser,errors=[];
page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
try {
  const pixels=await page.evaluate(async()=>{
    const {cocShader,bokehShader}=await import('/packages/dof/src/shaders.ts');
    const {tonemapShader}=await import('/packages/tonemap/src/shaders.ts');
    const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();device.pushErrorScope('validation');
    const check=(condition,message)=>{if(!condition)throw new Error(message);};
    const module=async code=>{const m=device.createShaderModule({code}),info=await m.getCompilationInfo();check(!info.messages.some(x=>x.type==='error'),info.messages.map(x=>x.message).join('\n'));return m;};
    const compute=async code=>device.createComputePipeline({layout:'auto',compute:{module:await module(code),entryPoint:'main'}});
    const cocPipeline=await compute(cocShader),bokehPipeline=await compute(bokehShader),toneModule=await module(tonemapShader);
    const tonePipeline=device.createRenderPipeline({layout:'auto',vertex:{module:toneModule,entryPoint:'vertex'},fragment:{module:toneModule,entryPoint:'fragment',targets:[{format:'rgba32float'}]}});
    const owned=[];
    const texture=(width,height,format,usage,depth=1)=>{const t=device.createTexture({size:[width,height,depth],dimension:depth>1?'3d':'2d',format,usage});owned.push(t);return t;};
    const buffer=size=>{const b=device.createBuffer({size,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});owned.push(b);return b;};
    const group=(pipeline,resources)=>device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
    const dispatch=(encoder,pipeline,bindings,w,h)=>{const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,bindings);pass.dispatchWorkgroups(Math.ceil(w/8),Math.ceil(h/8));pass.end();};
    async function read(texture,bytesPerPixel,half=false){
      const row=Math.ceil(texture.width*bytesPerPixel/256)*256,size=row*texture.height;
      const b=device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();
      encoder.copyTextureToBuffer({texture},{buffer:b,bytesPerRow:row},[texture.width,texture.height]);device.queue.submit([encoder.finish()]);await b.mapAsync(GPUMapMode.READ);
      const mapped=b.getMappedRange(),words=new Uint32Array(mapped),floats=new Float32Array(mapped),channels=half?4:bytesPerPixel/4,out=new Float32Array(texture.width*texture.height*channels);
      const halfFloat=v=>{const sign=v&0x8000?-1:1,exponent=(v>>10)&31,mantissa=v&1023;return sign*(exponent===0?mantissa*2**-24:exponent===31?Infinity:(1+mantissa/1024)*2**(exponent-15));};
      for(let y=0;y<texture.height;y++)for(let x=0;x<texture.width;x++)for(let c=0;c<channels;c++){
        const offset=y*row/4+x*bytesPerPixel/4;out[(y*texture.width+x)*channels+c]=half?halfFloat((words[offset+(c>>1)]>>((c&1)*16))&65535):floats[offset+c];
      }
      b.unmap();b.destroy();return out;
    }
    const w=64,h=32,T=GPUTextureUsage;
    const scene=texture(w,h,'rgba32float',T.TEXTURE_BINDING|T.COPY_DST),depth=texture(w,h,'depth32float',T.TEXTURE_BINDING|T.RENDER_ATTACHMENT),coc=texture(w,h,'rg32float',T.TEXTURE_BINDING|T.STORAGE_BINDING|T.COPY_SRC),output=texture(w,h,'rgba16float',T.STORAGE_BINDING|T.COPY_SRC);
    const color=new Float32Array(w*h*4);for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;color[i+(x<16?0:x<32?1:2)]=1;color[i+3]=1;}
    color.set([20,20,20,1],(16*w+46)*4);device.queue.writeTexture({texture:scene},color,{bytesPerRow:w*16},[w,h]);
    const depthModule=await module(`@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{let xy=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(xy[i],0,1);}
      @fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32{var z=12.0;if(p.x<16.0){z=2.0;}else if(p.x<32.0){z=5.0;}return 0.1*(100.0-z)/(z*(100.0-0.1));}`);
    const depthPipeline=device.createRenderPipeline({layout:'auto',vertex:{module:depthModule,entryPoint:'vertex'},fragment:{module:depthModule,entryPoint:'fragment',targets:[]},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'always'}});
    // Params is {lens,frame,ortho} (48 bytes) since 5cf148e; ortho.x=0 is perspective.
    const uniform=buffer(48),params=new Float32Array([5,0.05,2.8,8,0.1,100,12,1,0,0,0,0]);device.queue.writeBuffer(uniform,0,params);
    const cocGroup=group(cocPipeline,[{buffer:uniform},depth.createView(),coc.createView()]),bokehGroup=group(bokehPipeline,[{buffer:uniform},scene.createView(),coc.createView(),output.createView()]);
    let encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:depth.createView(),depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'}});
    pass.setPipeline(depthPipeline);pass.draw(3);pass.end();dispatch(encoder,cocPipeline,cocGroup,w,h);dispatch(encoder,bokehPipeline,bokehGroup,w,h);device.queue.submit([encoder.finish()]);
    const co=await read(coc,8),blur=await read(output,8,true),at=(x,y,c)=>blur[(y*w+x)*4+c];
    check(Math.abs(co[8*2]+8)<0.001,'Near CoC sign/clamp');check(Math.abs(co[24*2])<0.001,'Focus CoC');check(Math.abs(co[40*2]-7)<0.001,'Far CoC/depth reconstruction');
    check(at(24,16,1)>0.999&&at(24,16,0)<0.001&&at(24,16,2)<0.001,'Focused color changed');
    check(at(8,16,0)>0.999&&at(8,16,2)<0.001,'Background leaked onto foreground');
    check(at(18,16,0)>0&&at(18,16,2)<0.001,'Near-field spread missing or contaminated');
    let litNeighbors=0;for(let y=9;y<24;y++)for(let x=39;x<54;x++)if((x!==46||y!==16)&&at(x,y,0)>0)litNeighbors++;
    check(at(46,16,0)<10&&at(46,16,0)>0&&litNeighbors>20,`Bokeh did not spread HDR highlight: ${at(46,16,0)}, ${litNeighbors}`);
    encoder=device.createCommandEncoder();dispatch(encoder,bokehPipeline,bokehGroup,w,h);device.queue.submit([encoder.finish()]);const again=await read(output,8,true);
    check(again.every((v,i)=>v===blur[i]),'Static bokeh varies over time');
    params[7]=0;device.queue.writeBuffer(uniform,0,params);encoder=device.createCommandEncoder();dispatch(encoder,cocPipeline,cocGroup,w,h);dispatch(encoder,bokehPipeline,bokehGroup,w,h);device.queue.submit([encoder.finish()]);
    const sharp=await read(output,8,true);check(sharp.every((v,i)=>v===color[i]),'Disabled DOF did not preserve input');

    const hdr=texture(1,1,'rgba32float',T.TEXTURE_BINDING|T.COPY_DST),display=texture(1,1,'rgba32float',T.RENDER_ATTACHMENT|T.COPY_SRC),lut=texture(33,33,'rgba32float',T.TEXTURE_BINDING|T.COPY_DST,33),gradeUniform=buffer(64);
    const lutData=new Float32Array(33**3*4);for(let b=0;b<33;b++)for(let g=0;g<33;g++)for(let r=0;r<33;r++)lutData.set([r/64+b/320,g/32*0.75,1-b/64,1],((b*33+g)*33+r)*4);
    device.queue.writeTexture({texture:lut},lutData,{bytesPerRow:33*16,rowsPerImage:33},[33,33,33]);
    const toneGroup=group(tonePipeline,[{buffer:gradeUniform},hdr.createView(),lut.createView()]),grade=new Float32Array(16);grade[1]=1;grade[8]=grade[9]=grade[10]=1;
    const srgb=v=>v<0.0031308?v*12.92:1.055*v**(1/2.4)-0.055;
    const neutral=input=>{const x=Math.min(...input),offset=x<0.08?x-6.25*x*x:0.04,c=input.map(v=>v-offset),peak=Math.max(...c);if(peak<0.76)return c;
      const newPeak=1-0.24**2/(peak+0.24-0.76),g=1-1/(0.15*(peak-newPeak)+1);return c.map(v=>v*newPeak/peak*(1-g)+newPeak*g);};
    async function tone(rgb){device.queue.writeTexture({texture:hdr},new Float32Array([...rgb,1]),{bytesPerRow:16},[1,1]);device.queue.writeBuffer(gradeUniform,0,grade);
      const e=device.createCommandEncoder(),p=e.beginRenderPass({colorAttachments:[{view:display.createView(),loadOp:'clear',storeOp:'store'}]});p.setPipeline(tonePipeline);p.setBindGroup(0,toneGroup);p.draw(3);p.end();device.queue.submit([e.finish()]);return read(display,16);}
    const curves=[];for(let curve=0;curve<3;curve++){grade[2]=curve;const black=await tone([0,0,0]),gray=await tone([0.18,0.18,0.18]),white=await tone([10000,10000,10000]),saturated=await tone([100,0.1,0.01]);
      check(black[0]<0.001&&gray[0]>0.1&&gray[0]<0.8&&white[0]>0.99,'Curve black/gray/highlight bounds');check(saturated.every(Number.isFinite)&&saturated.every(v=>v>=0&&v<=1.00001),'Extreme color invalid');curves.push([...gray]);}
    check(Math.abs(curves[0][0]-curves[1][0])>0.01&&Math.abs(curves[1][0]-curves[2][0])>0.01,'Curves are indistinguishable');
    grade[2]=2;for(const rgb of [[0.001,0.01,0.02],[0.2,0.4,0.6],[1,0.1,0.2],[20,2,0.5]]){const actual=await tone(rgb),expected=neutral(rgb).map(srgb);check(expected.every((v,i)=>Math.abs(v-actual[i])<0.00002),'Khronos reference mismatch');}
    grade[0]=1;const exposed=await tone([0.1,0.2,0.3]),expected=neutral([0.2,0.4,0.6]).map(srgb);check(expected.every((v,i)=>Math.abs(v-exposed[i])<0.00002),'Exposure is not in stops');
    grade[0]=0;grade[1]=0;const flat=await tone([2,0.1,0.01]);check(flat.slice(0,3).every(v=>Math.abs(v-srgb(0.18))<0.00002),'Contrast pivot');
    grade[1]=1;grade[3]=1;const graded=await tone([0.2,0.4,0.6]),lutExpected=[0.16/2+0.56/10,0.36*0.75,1-0.56/2].map(srgb);check(lutExpected.every((v,i)=>Math.abs(v-graded[i])<0.00002),'3D LUT axes/interpolation');
    grade[3]=0;grade[12]=1;const ap1gray=await tone([0.18,0.18,0.18]);check(ap1gray.slice(0,3).every(v=>Math.abs(v-srgb(0.14))<0.00002),'ACEScg white-point conversion');
    await device.queue.onSubmittedWorkDone();const validation=await device.popErrorScope();check(!validation,validation?.message);for(const resource of owned)resource.destroy();device.destroy();
    return {coC:[co[16],co[48],co[80]],curves,lut:[...graded],deterministic:true};
  });
  const integration=await page.evaluate(async()=>{
    const {Engine,box,PbrMaterial}=await import('/packages/core/dist/index.js'),{engineRuntime}=await import('/packages/core/dist/extension.js');
    const {DOF}=await import('/packages/dof/dist/index.js'),{Tonemap}=await import('/packages/tonemap/dist/index.js'),{TAA}=await import('/packages/taa/dist/index.js');
    const canvas=document.createElement('canvas');canvas.width=128;canvas.height=96;canvas.style.width='128px';canvas.style.height='96px';document.body.append(canvas);
    const engine=await Engine.create(canvas,{backend:'webgpu'}),device=engineRuntime(engine).gpu;device.pushErrorScope('validation');
    const mesh=engine.createMesh().setGeometry(box()).setMaterial(new PbrMaterial({color:[1,0.2,0.1]}));
    let dof=DOF.attach(engine),tone=Tonemap.attach(engine,{source:()=>dof.outputTexture}),taa=TAA.attach(engine,{depth:()=>dof.depthTexture});
    for(let i=0;i<3;i++)engine.render();await device.queue.onSubmittedWorkDone();const output=dof.outputTexture;
    canvas.style.width='160px';canvas.style.height='104px';engine.render();if(dof.outputTexture===output||dof.outputTexture.width!==160)throw new Error('DOF resize did not rebuild');
    taa.destroy();tone.destroy();dof.destroy();tone=Tonemap.attach(engine);engine.render();tone.options.curve='acescg';engine.render();tone.destroy();
    dof=DOF.attach(engine);tone=Tonemap.attach(engine,{source:()=>dof.outputTexture});engine.render();await device.queue.onSubmittedWorkDone();const error=await device.popErrorScope();if(error)throw new Error(error.message);
    await engine.rebootDevice();const restored=engineRuntime(engine).gpu;restored.pushErrorScope('validation');engine.render();await restored.queue.onSubmittedWorkDone();const restoreError=await restored.popErrorScope();if(restoreError)throw new Error(restoreError.message);
    tone.destroy();dof.destroy();mesh.dispose();engine.dispose();return {taa:true,resized:true,restored:true};
  });
  for(const name of ['dof','tonemap']){
    await page.goto(`http://127.0.0.1:5193/packages/${name}/examples/index.html`);
    await page.waitForFunction(()=>document.querySelector('#status')?.textContent?.startsWith('WebGPU ready'));
    if(name==='dof'){await page.locator('#focus').fill('4');await page.locator('#focus').dispatchEvent('input');assert.equal(await page.locator('#focus-value').textContent(),'4 m');await page.locator('#enabled').uncheck();
      await page.locator('#focus').fill('8.1');await page.locator('#focus').dispatchEvent('input');await page.locator('#enabled').check();}
    else {await page.locator('#curve').selectOption('neutral');await page.locator('#exposure').fill('2');await page.locator('#exposure').dispatchEvent('input');assert.equal(await page.locator('#exposure-value').textContent(),'2 stops');
      await page.locator('#lut').setInputFiles({name:'invalid.cube',mimeType:'text/plain',buffer:Buffer.from('LUT_3D_SIZE 2\n')});await page.waitForFunction(()=>document.querySelector('#status').textContent.startsWith('LUT rejected'));
      await page.locator('#clear-lut').click();await page.locator('#curve').selectOption('agx');await page.locator('#exposure').fill('0');await page.locator('#exposure').dispatchEvent('input');}
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await page.screenshot({path:`test-results/${name}-demo.png`});
  }
  const phone=await page.context().browser().newPage({viewport:{width:390,height:664},deviceScaleFactor:3,isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1'});
  let mobile;
  try{
    phone.on('pageerror',error=>errors.push(error.message));phone.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
    await phone.addInitScript(()=>{
      const audit=window.msaaAudit={textures:0,pipelines:0,resolves:0};
      for(const name of ['createTexture','createRenderPipeline','createRenderPipelineAsync']){const create=GPUDevice.prototype[name];GPUDevice.prototype[name]=function(d){if((d.sampleCount??d.multisample?.count??1)>1)audit[name==='createTexture'?'textures':'pipelines']++;return create.call(this,d);};}
      const begin=GPUCommandEncoder.prototype.beginRenderPass;GPUCommandEncoder.prototype.beginRenderPass=function(d){for(const a of d.colorAttachments)if(a?.resolveTarget)audit.resolves++;return begin.call(this,d);};
    });
    await phone.goto('http://127.0.0.1:5193/tests/modern-game.html');
    mobile=await phone.evaluate(async()=>{
      const {Engine,box,PbrMaterial}=await import('/packages/core/dist/index.js');
      const {DOF}=await import('/packages/dof/dist/index.js'),{Tonemap}=await import('/packages/tonemap/dist/index.js'),{TAA}=await import('/packages/taa/dist/index.js');
      const {SSAO,Bloom}=await import('/packages/post/dist/index.js'),{PostProcessing}=await import('/packages/creative/dist/index.js');
      const checked=[];
      for(const name of ['dof-tone-taa','ssao-taa','creative-taa','tonemap','bloom']){
        const canvas=document.createElement('canvas');canvas.style.cssText='width:128px;height:96px';document.body.append(canvas);
        const engine=await Engine.create(canvas,{backend:'webgpu'}),device=engine.gpu;device.pushErrorScope('validation');
        try{
          engine.createMesh().setGeometry(box()).setRotation([0.2,0.4,0]).setMaterial(new PbrMaterial({color:[1,0.2,0.1]}));
          if(name==='dof-tone-taa'){const dof=DOF.attach(engine);Tonemap.attach(engine,{source:()=>dof.outputTexture});TAA.attach(engine,{depth:()=>dof.depthTexture});}
          if(name==='ssao-taa'){const ssao=SSAO.attach(engine);TAA.attach(engine,{depth:()=>ssao.depthTexture});}
          if(name==='creative-taa'){const post=new PostProcessing({grain:0.01});engine.use(post);TAA.attach(engine,{depth:()=>post.target?.depth});}
          if(name==='tonemap')Tonemap.attach(engine);if(name==='bloom')engine.use(new Bloom());
          for(let i=0;i<3;i++)engine.render();canvas.style.width='96px';engine.render();await device.queue.onSubmittedWorkDone();
          const error=await device.popErrorScope();if(error)throw new Error(name+': '+error.message);
          if(canvas.width!==canvas.clientWidth*2||canvas.height!==canvas.clientHeight*2)throw new Error(name+': incorrect phone DPR');
          checked.push(name);
        }finally{engine.dispose();canvas.remove();}
      }
      return {...window.msaaAudit,checked};
    });
    assert.equal(mobile.textures,0);assert.equal(mobile.pipelines,0);assert.equal(mobile.resolves,0);
  }finally{await phone.close();}
  assert.deepEqual(errors,[]);await writeFile('test-results/modern-postfx.json',JSON.stringify({hardware,pixels,integration,mobile},null,2));console.log(JSON.stringify({hardware,pixels,integration,mobile},null,2));
} finally {await browser.close();}
