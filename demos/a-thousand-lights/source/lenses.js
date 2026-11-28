const wgsl = `
struct LampView { projection: mat4x4f, options: vec4f }
@group(0) @binding(0) var<uniform> frame: LampView;
struct Pixel {
  @builtin(position) clip: vec4f,
  @location(0) colour: vec3f,
  @location(1) lens: vec2f,
}
@vertex fn vertex(@builtin(vertex_index) n:u32,@location(0) point:vec3f,
  @location(1) colour:vec3f,@location(2) radius:f32) -> Pixel {
  let uv = vec2f(f32(n&1u),f32(n>>1u))*2.0-1.0;
  var clip=frame.projection*vec4f(point,1.0);
  let shift=uv*radius*vec2f(frame.options.x,frame.options.y);
  clip.x=clip.x+shift.x;
  clip.y=clip.y+shift.y;
  return Pixel(clip,colour,uv);
}
@fragment fn fragment(p:Pixel) -> @location(0) vec4f {
  let radius=length(p.lens);
  let lens=(1.0-smoothstep(.59,1.0,radius))*(.49+.51*exp(-4.0*radius*radius));
  let inner=1.0-smoothstep(.02,.49,radius);
  let colour=mix(p.colour,vec3f(.72,.77,.85),inner*.65);
  let intensity=mix(1.05,3.9,frame.options.z);
  return vec4f(colour*intensity,lens);
}
`;

export function lightLenses(instances, canvas) {
  let resources;
  const values = new Float32Array(20);
  function dispose() {
    resources?.instance.destroy();
    resources?.uniform.destroy();
    resources=undefined;
  }
  function buffers(device){
    if(resources?.device===device)return resources;
    dispose();
    resources={
      device, module:device.createShaderModule({code:wgsl,label:'Luminaire lens'}),
      instance:device.createBuffer({size:instances.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),
      uniform:device.createBuffer({size:values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),
      variants:new Map(),
    };
    return resources;
  }
  function descriptor(module,format,depthFormat,samples){
    return {
      label:'Luminaire lens',
      layout:'auto',
      vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:28,stepMode:'instance',attributes:[
        {shaderLocation:0,offset:0,format:'float32x3'},
        {shaderLocation:1,offset:12,format:'float32x3'},
        {shaderLocation:2,offset:24,format:'float32'},
      ]}]},
      fragment:{module,entryPoint:'fragment',targets:[{format,blend:{
        color:{srcFactor:'src-alpha',dstFactor:'one',operation:'add'},
        alpha:{srcFactor:'zero',dstFactor:'one',operation:'add'},
      }}]},
      primitive:{topology:'triangle-strip'},
      multisample:{count:samples},
      depthStencil:{format:depthFormat,depthWriteEnabled:false,depthCompare:'greater-equal'},
    };
  }
  function bind({device,uniform,variants},key,pipeline) {
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),
      entries:[{binding:0,resource:{buffer:uniform}}]});
    const program={pipeline,group};
    variants.set(key,program);
    return program;
  }
  const keyOf=(format,depth,samples)=>[format,depth,samples].join('/');
  function draw(context) {
    if(context.backend!=='webgpu')return;
    const {device,camera,format,encoder}=context;
    const depthFormat=context.descriptor.depthStencil.format;
    const samples=context.descriptor.multisample?.count??4;
    const state=buffers(device),key=keyOf(format,depthFormat,samples);
    const program=state.variants.get(key)??bind(state,key,
      device.createRenderPipeline(descriptor(state.module,format,depthFormat,samples)));
    values.set(camera.matrix);
    values[17]=1/Math.tan(camera.fov*Math.PI/360);
    values[16]=values[17]*canvas.height/canvas.width;
    values[18]=format.endsWith('float')?1:0;
    device.queue.writeBuffer(state.instance,0,instances);
    device.queue.writeBuffer(state.uniform,0,values);
    const depth={view:context.depth,depthLoadOp:'load',depthStoreOp:'store'};
    if(depthFormat.includes('stencil'))Object.assign(depth,{stencilLoadOp:'load',stencilStoreOp:'store'});
    const pass=encoder.beginRenderPass({label:'Moving luminaires',
      colorAttachments:[{view:context.color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:depth});
    pass.setPipeline(program.pipeline);
    pass.setBindGroup(0,program.group);
    pass.setVertexBuffer(0,state.instance);
    pass.draw(4,instances.length/7);
    pass.end();
  }
  return {
    name:'moving-luminaires',
    setup(){},
    registerPasses(graph){graph.add({name:'moving-luminaires',order:4,execute:draw});},
    async prepare(engine){
      const {format,depthFormat,samples}=engine.renderTarget;
      const state=buffers(engine.gpu);
      const pipeline=await engine.gpu.createRenderPipelineAsync(descriptor(state.module,format,depthFormat,samples));
      if(resources===state)bind(state,keyOf(format,depthFormat,samples),pipeline);
    },
    dispose,
  };
}
