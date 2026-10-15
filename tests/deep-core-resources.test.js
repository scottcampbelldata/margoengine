import test from 'node:test';
import assert from 'node:assert/strict';
import {GPURenderer} from '../packages/core/dist/renderer.js';
import {Camera,FrameGraph} from '../packages/core/dist/extension.js';

test('Core picking releases partial allocations and permits retries after setup failures',async t=>{
  const flags={GPUBufferUsage:{UNIFORM:1,COPY_DST:2,MAP_READ:4},GPUTextureUsage:{RENDER_ATTACHMENT:1,COPY_SRC:2},GPUMapMode:{READ:1}};
  for(const [key,value] of Object.entries(flags)){const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key]);}
  const resources=[],failure=new Error('Pick setup failed');let attempt,point=0;
  const resource=()=>{const value={destroyed:0,destroy(){this.destroyed++;},createView(){return {};},mapAsync:async()=>{},getMappedRange:()=>new Uint32Array([0xffffffff]).buffer,unmap(){}};resources.push(value);return value;};
  const device={createBuffer(){if(++point===attempt)throw failure;return resource();},createTexture(){if(++point===attempt)throw failure;return resource();},createBindGroup:()=>({}),lost:new Promise(()=>{}),addEventListener(){},destroy(){},
    queue:{writeBuffer(){if(++point===attempt)throw failure;},submit(){}},createShaderModule:()=>({}),createRenderPipeline:()=>({getBindGroupLayout:()=>({})}),
    createCommandEncoder:()=>({copyTextureToBuffer(){},finish:()=>({}),beginRenderPass:()=>({setPipeline(){},setBindGroup(){},end(){}})})};
  const renderer=new GPURenderer({width:4,height:4},device,{configure(){},unconfigure(){}},'bgra8unorm',{getBindGroupLayout:()=>({})},{multisample:{count:4},depthStencil:{format:'depth32float'}},{getBindGroupLayout:()=>({})});
  const camera=new Camera();camera.update(1,true);const light={direction:new Float32Array(4),radiance:new Float32Array(4)},graph=new FrameGraph();
  try{
    for(attempt=1;attempt<=5;attempt++){
      point=0;const start=resources.length;
      await assert.rejects(renderer.pick(camera,light,[],graph,0,0),error=>error===failure);
      assert.ok(resources.slice(start).every(r=>r.destroyed===1),'Partially allocated picking resources leaked');
      const saved=attempt;attempt=undefined;point=0;
      assert.equal(await renderer.pick(camera,light,[],graph,0,0),null);
      attempt=saved;
    }
  }finally{renderer.dispose();}
});

test('Core draw bindings observe mutable buffer ranges and shader variants observe depth format',t=>{
  for(const [key,value] of Object.entries({GPUBufferUsage:{UNIFORM:1,COPY_DST:2},GPUTextureUsage:{RENDER_ATTACHMENT:1}})){
    const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key]);
  }
  const groups=[],pipelines=[],attachments=[],pipeline={getBindGroupLayout:()=>({})},resource={buffer:{},offset:0,size:16},bindings=[{binding:1,resource}],extra={view:{},loadOp:'load',storeOp:'store'};
  const pass={setPipeline(){},setBindGroup(){},end(){}};
  const device={createBuffer:()=>({destroy(){}}),createBindGroup(descriptor){groups.push(descriptor);return descriptor;},createTexture:()=>({createView:()=>({}),destroy(){}}),
    createShaderModule:()=>({}),createRenderPipeline(descriptor){pipelines.push(descriptor);return {...descriptor,getBindGroupLayout:()=>({})};},lost:new Promise(()=>{}),addEventListener(){},destroy(){},
    queue:{writeBuffer(){},submit(){}},createCommandEncoder:()=>({finish:()=>({}),beginRenderPass(descriptor){if(descriptor.colorAttachments[0].clearValue)attachments.push(descriptor.colorAttachments);return pass;}})};
  const renderer=new GPURenderer({width:4,height:4},device,{configure(){},unconfigure(){},getCurrentTexture:()=>({createView:()=>({})})},'bgra8unorm',pipeline,{multisample:{count:4},depthStencil:{format:'depth32float'}},pipeline);
  const camera=new Camera();camera.update(1,true);const light={direction:new Float32Array(4),radiance:new Float32Array(4)},graph=new FrameGraph();
  let format='depth32float',explicit=true,extras;
  graph.add({name:'mutable bindings',order:-1,execute(c){
    c.descriptor={...c.descriptor,depthStencil:{format}};
    const draw=c.draw;c.draw=()=>draw(explicit?{pipeline,bindings,colorAttachments:extras}:{});
  }});
  try{
    renderer.render(camera,light,[],graph,0);const start=groups.length;
    for(let i=0;i<120;i++)renderer.render(camera,light,[],graph,0);
    assert.equal(groups.length,start);
    assert.ok(attachments.every(value=>value===attachments[0]),'Stable frames allocate attachment arrays');
    extras=[extra];renderer.render(camera,light,[],graph,0);assert.equal(attachments.at(-1)[1],extra);
    extras=undefined;renderer.render(camera,light,[],graph,0);assert.equal(attachments.at(-1).length,1);
    resource.offset=16;renderer.render(camera,light,[],graph,0);assert.equal(groups.length,start+1,'Buffer offset was ignored');
    resource.size=32;renderer.render(camera,light,[],graph,0);assert.equal(groups.length,start+2,'Buffer size was ignored');
    resource.buffer={};renderer.render(camera,light,[],graph,0);assert.equal(groups.length,start+3,'Buffer identity was ignored');
    bindings[0].resource={};renderer.render(camera,light,[],graph,0);assert.equal(groups.length,start+4,'Buffer to texture replacement was ignored');
    renderer.render(camera,light,[],graph,0);assert.equal(groups.length,start+4);
    bindings[0].resource={};renderer.render(camera,light,[],graph,0);assert.equal(groups.length,start+5,'Texture identity was ignored');
    bindings[0].resource=resource;renderer.render(camera,light,[],graph,0);assert.equal(groups.length,start+6,'Texture to buffer replacement was ignored');
    bindings[0].binding=2;renderer.render(camera,light,[],graph,0);assert.equal(groups.length,start+7,'Binding number was ignored');
    explicit=false;renderer.render(camera,light,[],graph,0);const variants=pipelines.length;
    format='depth24plus';renderer.render(camera,light,[],graph,0);assert.equal(pipelines.length,variants+1,'Depth format was ignored');
    assert.equal(pipelines.at(-1).depthStencil.format,'depth24plus');
  }finally{renderer.dispose();}
});


test('Core draw stencil operations follow the current depth target and clear cached state',t=>{
  for(const [key,value] of Object.entries({GPUBufferUsage:{UNIFORM:1,COPY_DST:2},GPUTextureUsage:{RENDER_ATTACHMENT:1}})){
    const old=Object.getOwnPropertyDescriptor(globalThis,key);Object.defineProperty(globalThis,key,{value,configurable:true});t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key]);
  }
  for(const baseFormat of ['depth32float','depth32float-stencil8']){
    const records=[],pipeline={getBindGroupLayout:()=>({})},pass={setPipeline(){},setBindGroup(){},end(){}};
    const device={createBuffer:()=>({destroy(){}}),createBindGroup:()=>({}),createTexture:()=>({createView:()=>({}),destroy(){}}),createShaderModule:()=>({}),createRenderPipeline:()=>pipeline,lost:new Promise(()=>{}),addEventListener(){},destroy(){},queue:{writeBuffer(){},submit(){}},createCommandEncoder:()=>({finish:()=>({}),beginRenderPass(descriptor){if(descriptor.colorAttachments[0].clearValue)records.push({...descriptor.depthStencilAttachment});return pass;}})};
    const renderer=new GPURenderer({width:4,height:4},device,{configure(){},unconfigure(){},getCurrentTexture:()=>({createView:()=>({})})},'bgra8unorm',pipeline,{multisample:{count:4},depthStencil:{format:baseFormat}},pipeline);
    const camera=new Camera();camera.update(1,true);const light={direction:new Float32Array(4),radiance:new Float32Array(4)},graph=new FrameGraph();let format=baseFormat;
    graph.add({name:'depth target',order:-1,execute(c){c.descriptor={...c.descriptor,depthStencil:{format}};c.depth={format};const draw=c.draw;c.draw=()=>draw({clear:false,stencilClear:3});}});
    try{
      for(format of ['depth32float-stencil8','depth32float','depth24plus-stencil8','depth24plus','depth32float-stencil8']){
        renderer.render(camera,light,[],graph,0);const record=records.at(-1),stencil=format.includes('stencil');
        assert.equal(record.stencilLoadOp,stencil?'clear':undefined,format);
        assert.equal(record.stencilStoreOp,stencil?'store':undefined,format);
        assert.equal(record.stencilClearValue,stencil?3:undefined,format);
        assert.equal(record.view.format,format);
      }
    }finally{renderer.dispose();}
  }
});
