import {FrameGraph} from '../../packages/core/dist/extension.js';
export function gpuHarness() {
  globalThis.GPUBufferUsage={UNIFORM:64,COPY_DST:8};
  globalThis.GPUTextureUsage={COPY_SRC:1,COPY_DST:2,TEXTURE_BINDING:4,STORAGE_BINDING:8,RENDER_ATTACHMENT:16};
  const resources=[],pipelines=[],groups=[],writes=new Float32Array(64),counts={buffers:0,textures:0,views:0,groups:0,compute:0,render:0,uploads:0};
  const pass={setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},draw(){},end(){}};
  const device={
    createBuffer(descriptor){counts.buffers++;const r={...descriptor,destroyed:false,destroy(){this.destroyed=true;}};resources.push(r);return r;},
    createTexture(descriptor){counts.textures++;const r={...descriptor,width:descriptor.size[0],height:descriptor.size[1],dimension:descriptor.dimension??'2d',sampleCount:1,destroyed:false,
      createView(){counts.views++;return {texture:r};},destroy(){this.destroyed=true;}};resources.push(r);return r;},
    createShaderModule(descriptor){return descriptor;},
    createComputePipeline(descriptor){const p={...descriptor,getBindGroupLayout(){return {};}};pipelines.push(p);return p;},
    createRenderPipeline(descriptor){const p={...descriptor,getBindGroupLayout(){return {};}};pipelines.push(p);return p;},
    createBindGroup(descriptor){counts.groups++;groups.push(descriptor);return descriptor;},
    queue:{writeBuffer(_buffer,_offset,values){writes.fill(0);writes.set(values);},writeTexture(){counts.uploads++;}}
  };
  const graph=new FrameGraph(),plugins=new Map(),engine={gpu:device,frameGraph:graph,hasPlugin(name){return plugins.has(name);},
    use(plugin){try{graph.withOwner(plugin.name,()=>{plugin.setup(engine);plugin.registerPasses(graph);});plugins.set(plugin.name,plugin);}catch(error){graph.removeOwner(plugin.name);plugin.dispose();throw error;}},
    removePlugin(name){const p=plugins.get(name);if(p){graph.removeOwner(name);plugins.delete(name);p.dispose();}}};
  const originalColor={},originalDepth={},shader='let linear=vec3f(1);\nlet mapped=linear/(1.0+linear); return vec4f(mapped,1);';
  const context={backend:'webgpu',device,encoder:{beginComputePass(){counts.compute++;return pass;},beginRenderPass(descriptor){counts.render++;context.presentation=descriptor;return pass;}},
    color:originalColor,depth:originalDepth,format:'bgra8unorm',width:128,height:96,camera:{near:0.1,far:100,fov:60},shader,bindings:[],descriptor:{depthStencil:{format:'depth32float'}},draw(){},delta:0};
  function frame(){context.color=originalColor;context.depth=originalDepth;context.format='bgra8unorm';context.shader=shader;graph.execute(context);}
  return {engine,context,frame,counts,resources,pipelines,groups,writes,originalColor,originalDepth};
}
