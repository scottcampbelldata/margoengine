import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {openBrowser} from './browser.js';
import {Sky} from '../packages/sky/dist/index.js';
import {optionalGPU} from '../tests/support/optional-gpu.js';

// Retain the actual 1x shader as the reference, without copying fog/sky math.
const fixture=optionalGPU(),sourceDepth=Object.assign(fixture.engine.gpu.createTexture({size:[128,96],format:'depth32float',usage:GPUTextureUsage.TEXTURE_BINDING}),{depthOrArrayLayers:1});
const sourceSky=new Sky({fog:{depth:()=>sourceDepth}});let singleShader;
try{fixture.engine.use(sourceSky);fixture.frame();singleShader=fixture.pipelines.find(p=>p.fragment?.entryPoint==='fogFragment').fragment.module.code;}
finally{sourceSky.dispose();sourceDepth.destroy();fixture.cleanup();}
assert.doesNotMatch(singleShader,/@builtin\(sample_index\)/);
const browser=await openBrowser({startPath:'/tests/modern-game.html',port:5198}),errors=[];
browser.page.on('pageerror',error=>errors.push(error.message));
browser.page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
try{
 const result=await browser.page.evaluate(async singleShader=>{
  const {Sky}=await import('/packages/sky/dist/index.js'),{Camera}=await import('/packages/core/dist/index.js');
  const assert=(condition,message)=>{if(!condition)throw new Error(message);};
  const adapter=await navigator.gpu.requestAdapter({powerPreference:'high-performance'});assert(adapter,'WebGPU adapter unavailable');
  const d=await adapter.requestDevice(),resources=[],modules=[],uncaptured=[];
  d.addEventListener('uncapturederror',event=>uncaptured.push(event.error.message));
  const texture=descriptor=>{const value=d.createTexture(descriptor);resources.push(value);return value;};
  const buffer=descriptor=>{const value=d.createBuffer(descriptor);resources.push(value);return value;};
  const shader=code=>{const value=d.createShaderModule({code});modules.push(value);return value;};
  const background=[0.125,0.25,0.5],depths=[[0,0,0,0],[0.01,0,0,0],[0,0.01,0,0],[0,0,0.01,0],[0,0,0,0.01],[0.01,0.01,0.01,0.01],[0.002,0,0.01,0],[0.25,0.002,0,0],[0.25,0.25,0.25,0.25],[0.002,0.01,0.004,0.008]],width=depths.length;
  const camera=new Camera({position:[0,1,0],target:[0,1,-1],near:1,far:1000});camera.update(1,true);
  let borrowedDepth,validationPending=true;d.pushErrorScope('validation');
  const sky=new Sky({model:'bruneton',hours:12,timeScale:0,fog:{depth:()=>borrowedDepth,density:0.008,start:45}}),passes={};
  try{
   sky.setup({gpu:d,removePlugin(){}});sky.registerPasses({add(pass){passes[pass.name]=pass;}});
   const vertex='@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}';
   const legacyModule=shader(singleShader.replace('sceneDepth:texture_depth_2d','sceneDepth:texture_depth_multisampled_2d').replace('fogFragment(i:Vertex)','fogFragment(i:Vertex,@builtin(sample_index) sample:u32)').replace('vec2i(i.position.xy),0','vec2i(i.position.xy),i32(sample)'));
   const blend={color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},alpha:{srcFactor:'zero',dstFactor:'one',operation:'add'}};
   const legacy=d.createRenderPipeline({layout:'auto',vertex:{module:legacyModule,entryPoint:'vertex'},fragment:{module:legacyModule,entryPoint:'fogFragment',targets:[{format:'rgba16float',blend}]},multisample:{count:4}});
   // The fog uniform is private to the fog feature since 3bab400; this is its packing for the options above (exp2, no colour).
   const fogValues=buffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});d.queue.writeBuffer(fogValues,0,new Float32Array([0.008,45,0,0,0,0,0,0]));
   const render=async(samples,{reference=false,legacyFog=false,singleDepth=false}={})=>{
    const depthSamples=singleDepth?1:samples,color=texture({size:[width,1],format:'rgba16float',sampleCount:samples,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
    borrowedDepth=texture({size:[width,1],format:'depth32float',sampleCount:depthSamples,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});
    const surfaceDepth=depthSamples===samples?borrowedDepth:texture({size:[width,1],format:'depth32float',sampleCount:samples,usage:GPUTextureUsage.RENDER_ATTACHMENT});
    const seeded=depths.map(values=>reference||singleDepth?[Math.max(...values)]:values);
    const seedModule=shader(vertex+`struct Seed { @location(0) color:vec4f,@builtin(frag_depth) depth:f32 }
@fragment fn fragment(@builtin(position) p:vec4f${depthSamples===4?',@builtin(sample_index) sample:u32':''})->Seed {
 let depths=array<${depthSamples===4?'vec4f':'f32'},${width}>(${seeded.map(values=>depthSamples===4?'vec4f('+values.join(',')+')':String(values[0])).join(',')});
 return Seed(vec4f(${background.join(',')},1),depths[u32(p.x)]${depthSamples===4?'[sample]':''});
}`);
    const seedPipeline=d.createRenderPipeline({layout:'auto',vertex:{module:seedModule,entryPoint:'vertex'},fragment:{module:seedModule,entryPoint:'fragment',targets:[{format:'rgba16float'}]},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'always'},multisample:{count:depthSamples}});
    const out=buffer({size:width*samples*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC}),read=buffer({size:out.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const probeModule=shader(`@group(0) @binding(0) var image:${samples===4?'texture_multisampled_2d':'texture_2d'}<f32>;
@group(0) @binding(1) var<storage,read_write> result:array<vec4f>;
@compute @workgroup_size(1) fn probe(@builtin(global_invocation_id) id:vec3u){result[id.x*${samples}u+id.y]=textureLoad(image,vec2i(i32(id.x),0),${samples===4?'i32(id.y)':'0'});}`);
    const probe=d.createComputePipeline({layout:'auto',compute:{module:probeModule,entryPoint:'probe'}}),probeGroup=d.createBindGroup({layout:probe.getBindGroupLayout(0),entries:[{binding:0,resource:color.createView()},{binding:1,resource:{buffer:out}}]});
    const encoder=d.createCommandEncoder(),clear=encoder.beginRenderPass({colorAttachments:[{view:color.createView(),loadOp:'clear',storeOp:'store',clearValue:[...background,1]}],depthStencilAttachment:{view:surfaceDepth.createView(),depthLoadOp:'clear',depthClearValue:0,depthStoreOp:'store'}});clear.end();
    const context={backend:'webgpu',device:d,encoder,width,height:1,format:'rgba16float',color:color.createView(),depth:surfaceDepth.createView(),camera,descriptor:{multisample:{count:samples},depthStencil:{format:'depth32float'}}};
    sky.onPreUpdate(0);passes['sky:atmosphere'].execute(context);
    const seedColor=depthSamples===samples?color:texture({size:[width,1],format:'rgba16float',usage:GPUTextureUsage.RENDER_ATTACHMENT});
    const seed=()=>{const pass=encoder.beginRenderPass({colorAttachments:[{view:seedColor.createView(),loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:borrowedDepth.createView(),depthLoadOp:'clear',depthClearValue:0,depthStoreOp:'store'}});pass.setPipeline(seedPipeline);pass.draw(3);pass.end();};
    seed();
    if(singleDepth){const pass=encoder.beginRenderPass({colorAttachments:[{view:color.createView(),loadOp:'clear',storeOp:'store',clearValue:[...background,1]}]});pass.end();}
    passes['sky:fog'].execute(context);
    if(legacyFog){
     seed();const group=d.createBindGroup({layout:legacy.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:sky.uniform}},{binding:1,resource:sky.tables.view},{binding:3,resource:borrowedDepth.createView({aspect:'depth-only'})},{binding:4,resource:{buffer:fogValues}}]});
     const pass=encoder.beginRenderPass({colorAttachments:[{view:color.createView(),loadOp:'load',storeOp:'store'}]});pass.setPipeline(legacy);pass.setBindGroup(0,group);pass.draw(3);pass.end();
    }
    const pass=encoder.beginComputePass();pass.setPipeline(probe);pass.setBindGroup(0,probeGroup);pass.dispatchWorkgroups(width,samples);pass.end();
    encoder.copyBufferToBuffer(out,0,read,0,out.size);d.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);try{return new Float32Array(read.getMappedRange()).slice();}finally{read.unmap();}
   };
   const checks=[];
   for(const [model,hours] of [['bruneton',12],['bruneton',0],['preetham',12]]){
    sky.options.model=model;sky.options.hours=hours;
    const reference=await render(1,{reference:true}),covered=await render(4),previous=await render(4,{legacyFog:true}),singleDepth=await render(4,{singleDepth:true});
    let maxCoverageError=0,maxUniformParityError=0,uncovered=0,coveredCount=0;
    for(let x=0;x<width;x++)for(let sample=0;sample<4;sample++){
     const offset=(x*4+sample)*4,masked=depths[x][sample]===0;masked?uncovered++:coveredCount++;
     for(let channel=0;channel<3;channel++){
      const expected=masked?background[channel]:previous[offset+channel],difference=Math.abs(covered[offset+channel]-expected);maxCoverageError=Math.max(maxCoverageError,difference);
      assert(difference<0.001,`${model}/${hours}: incorrect ${masked?'background':'covered'} sample ${x}/${sample}/${channel}: ${covered[offset+channel]} versus ${expected}`);
      assert(Math.abs(singleDepth[offset+channel]-reference[x*4+channel])<0.001,`${model}/${hours}: 1x depth on 4x target changed sample ${x}/${sample}`);
      {const difference=Math.abs(covered[offset+channel]-previous[offset+channel]);maxUniformParityError=Math.max(maxUniformParityError,difference);assert(difference===0,'Per-sample haze changed compared with the reference fog shader');}
     }
     assert(covered[offset+3]===1&&previous[offset+3]===1&&singleDepth[offset+3]===1,'Fog changed opaque alpha');
    }
    const crossingOffset=(7*4+1)*4,crossingDifference=Math.max(...background.map((value,channel)=>Math.abs(previous[crossingOffset+channel]-value)));
    assert(crossingDifference>0.01,'Fog-start fixture did not exercise distinct near/far layers');
    assert(background.every((value,channel)=>covered[crossingOffset+channel]===previous[crossingOffset+channel]),'Far subpixel layers lost their haze across fog.start');
    checks.push({model,hours,covered:coveredCount,uncovered,maxCoverageError,maxUniformParityError,crossingDifference});
   }
   sky.options.fog.density=0;const disabled=await render(4);assert(Array.from(disabled).every((value,index)=>value===(index%4===3?1:background[index%4])),'Zero density still changed the scene');
   const compilation=(await Promise.all(modules.map(module=>module.getCompilationInfo()))).flatMap(info=>info.messages.filter(message=>message.type==='error').map(message=>message.message));
   assert(compilation.length===0,JSON.stringify(compilation));
   validationPending=false;const validation=await d.popErrorScope();assert(!validation,validation?.message);assert(uncaptured.length===0,JSON.stringify(uncaptured));
   return {checks,disabled:true,shaderModules:modules.length,ownedResources:resources.length};
  }finally{
   try{if(validationPending)await d.popErrorScope();}finally{sky.dispose();for(const resource of resources)resource.destroy();d.destroy();}
  }
 },singleShader);
 assert.deepEqual(errors,[]);await writeFile('test-results/sky-fog.json',JSON.stringify({hardware:browser.hardware,...result},null,2));console.log(JSON.stringify({hardware:browser.hardware,...result},null,2));
}finally{await browser.close();}
