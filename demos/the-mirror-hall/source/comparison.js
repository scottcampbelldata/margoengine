const shader=/* wgsl */`
@group(0) @binding(0) var sampling:sampler;
@group(0) @binding(1) var screenSpace:texture_2d<f32>;
@group(0) @binding(2) var rayTraced:texture_2d<f32>;
struct Vertex { @builtin(position) position:vec4f, @location(0) uv:vec2f };
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex {
  var v:Vertex;
  v.uv=vec2f(f32((index << 1u) & 2u),f32(index & 2u));
  v.position=vec4f(v.uv.x*2.0-1.0,1.0-v.uv.y*2.0,0.0,1.0);
  return v;
}
@fragment fn fragment(v:Vertex)->@location(0) vec4f {
  let screen=textureSample(screenSpace,sampling,vec2f(2.0*v.uv.x,v.uv.y));
  let traced=textureSample(rayTraced,sampling,vec2f(2.0*v.uv.x-1.0,v.uv.y));
  return select(screen,traced,v.uv.x>=0.5);
}
`;

export function comparison(sampleMirrorDepth=false){
  let device,format,pipeline,views,group,targets;
  const destroy=()=>{
    for(const target of targets??[]){target.color.destroy();target.depth?.destroy();}
    targets=views=group=undefined;
  };
  return {
    name:'reflection-comparison',
    setup(engine){device=engine.gpu;},
    onDeviceRestored(engine){destroy();device=engine.gpu;pipeline=undefined;},
    resize(width,height){
      if(targets?.[0].color.width!==width||targets[0].color.height!==height){
        destroy();
        targets=[0,1].map(()=>({color:device.createTexture({
          size:[width,height],format:'rgba8unorm',
          usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING,
        })}));
        if(sampleMirrorDepth){
          targets[1].depth=device.createTexture({
            size:[width,height],format:device.features.has('depth32float-stencil8')?'depth32float-stencil8':'depth32float',
            usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING,
          });
        }
        views=targets.map(target=>target.color.createView());
      }
      return targets;
    },
    dispose:destroy,
    registerPasses(graph){
      graph.add({
        name:'present-independent-reflection-views',order:1,joins:true,
        execute(context){
          if(!views)return;
          if(!pipeline||format!==context.format){
            format=context.format;
            const module=device.createShaderModule({code:shader});
            pipeline=device.createRenderPipeline({
              layout:'auto',vertex:{module,entryPoint:'vertex'},
              fragment:{module,entryPoint:'fragment',targets:[{format}]},
            });
            group=undefined;
          }
          if(!group)group=device.createBindGroup({
            layout:pipeline.getBindGroupLayout(0),
            entries:[{binding:0,resource:device.createSampler({magFilter:'nearest',minFilter:'nearest'})},
              {binding:1,resource:views[0]},{binding:2,resource:views[1]}],
          });
          const color={view:context.color,loadOp:'load',storeOp:'store'};
          const depth={view:context.depth,depthLoadOp:'load',depthStoreOp:'store'};
          context.attach?.(color,depth,context.last);
          const pass=context.encoder.beginRenderPass({colorAttachments:[color]});
          pass.setPipeline(pipeline);
          pass.setBindGroup(0,group);
          pass.draw(3);
          pass.end();
        },
      });
    },
  };
}
