const wgsl=`
struct Frame { matrix:mat4x4f, right:vec4f, flames:array<vec4f,5>, shimmer:vec4f };
@group(0) @binding(0) var<uniform> frame:Frame;
struct Stage { @builtin(position) out:vec4f, @location(0) p:vec2f,@location(1) power:f32,@location(2) seed:f32 };
@vertex fn vertex(@builtin(vertex_index) index:u32,@builtin(instance_index) i:u32)->Stage {
  let corners=array(vec2f(-1.,-1.),vec2f(1.,-1.),vec2f(-1.,1.),vec2f(-1.,1.),vec2f(1.,-1.),vec2f(1.,1.));
  let local=corners[index];let flame=frame.flames[i];
  let point=flame.xyz+frame.right.xyz*local.x*.022+vec3f(0.,local.y*.035,0.);
  return Stage(frame.matrix*vec4f(point,1.),local,flame.w,f32(i));
}
@fragment fn fragment(in:Stage)->@location(0) vec4f {
  let t=clamp(.5+.5*in.p.y,0.,1.);
  let spin=.079*sin(12.2*frame.shimmer.x+1.91*in.seed)*t*t+.087*sin(7.1*frame.shimmer.x+.67*in.seed)*t;
  let width=pow(max(.001,sin(t*3.1415926)),.81)*(1.01-.65*t);
  let x=abs(in.p.x-spin);
  let amount=smoothstep(.03,.17,t)*(1.-smoothstep(.81,.995,t))*(1.-smoothstep(width*.70,width,x));
  let halo=.078*pow(max(0.,1.-length(vec2f(in.p.x*.8,(t-.52)*1.6))),2.8);
  if(amount+halo<.004){discard;}
  let kernel=1.-smoothstep(width*.04,width*.78,x);
  let power=in.power*amount;
  let envelope=mix(vec3f(2.8,.68,.085),vec3f(8.7,4.64,.97),kernel*kernel);
  let base=mix(vec3f(.19,.39,1.71),envelope,smoothstep(.03,.28,t));
  return vec4f(base*power+vec3f(1.0,.37,.09)*halo,amount*.92+halo);
}
`;
export function installFlames(engine){
  const values=new Float32Array(44);
  let state,frame;
  const remove=engine.scene.frameGraph.add({name:'candle flame emission',order:1.72,joins:true,execute(context){
    if(context.backend!=='webgpu'||!frame)return;
    const {device,format,descriptor}=context;
    if(!state||state.device!==device||state.color!==format){
      state?.uniform.destroy();
      const shader=device.createShaderModule({code:wgsl,label:'archive candle flames'});
      const pipeline=device.createRenderPipeline({layout:'auto',vertex:{module:shader,entryPoint:'vertex'},
        fragment:{module:shader,entryPoint:'fragment',targets:[{format,blend:{
          color:{operation:'add',srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},
          alpha:{operation:'add',srcFactor:'one',dstFactor:'one-minus-src-alpha'},
        }}]},multisample:descriptor.multisample,
        depthStencil:{format:descriptor.depthStencil.format,depthWriteEnabled:false,depthCompare:'greater-equal'}});
      const uniform=device.createBuffer({size:values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:uniform}}]});
      state={device,color:format,uniform,group,pipeline};
    }
    const eye=context.camera.position,target=context.camera.target,dx=eye[0]-target[0],dz=eye[2]-target[2],d=Math.hypot(dx,dz)||1;
    values.set(context.camera.matrix);values.set([dz/d,0,-dx/d,0],16);
    for(const [i,light] of frame.lights.entries())values.set([light.position[0],light.position[1]+.011,light.position[2],frame.power[i]],20+i*4);
    values[40]=frame.seconds;
    device.queue.writeBuffer(state.uniform,0,values);
    const out={view:context.color,loadOp:'load',storeOp:'store'};
    const depth={view:context.depth,depthLoadOp:'load',depthStoreOp:'store',
      ...(descriptor.depthStencil.format.includes('stencil')?{stencilLoadOp:'load',stencilStoreOp:'store'}:{})};
    context.attach?.(out,depth,true);
    const pass=context.encoder.beginRenderPass({colorAttachments:[out],depthStencilAttachment:depth});
    pass.setPipeline(state.pipeline);pass.setBindGroup(0,state.group);pass.draw(6,5);pass.end();
  }});
  return {set(lights,power,seconds){frame={lights,power,seconds};},dispose(){remove();state?.uniform.destroy();}};
}
