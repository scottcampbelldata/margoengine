import source from './assets/velocity.webp?url';

const code=`
struct Vertex{@builtin(position) position:vec4f,@location(0) uv:vec2f};
@vertex fn vertex(@builtin(vertex_index) i:u32)->Vertex {
  var point=vec2f(0.,0.);
  if(i==1u){point.x=2.;}
  if(i==2u){point.y=2.;}
  return Vertex(vec4f(point*2.-1.,0.,1.),vec2f(point.x,1.-point.y));
}
@group(0) @binding(0) var visual:texture_2d<f32>;
@group(0) @binding(1) var filtering:sampler;
@fragment fn fragment(in:Vertex)->@location(0) vec4f {
  return textureSample(visual,filtering,in.uv);
}`;
export async function fetchTexture(signal){
  const image=new Image();
  image.decoding='async';
  image.src=source;
  await image.decode();
  signal.throwIfAborted();
  const canvas=document.createElement('canvas');
  canvas.width=image.naturalWidth;
  canvas.height=image.naturalHeight;
  const context=canvas.getContext('2d');
  context.drawImage(image,0,0);
  return context.getImageData(0,0,canvas.width,canvas.height);
}

export function installTexture(engine,pixels){
  let visible=true,active;
  const remove=engine.scene.frameGraph.add({name:'recorded velocity texture',order:2,execute(context){
    if(!visible||context.backend!=='webgpu')return;
    const {device,format}=context;
    if(active?.device!==device){
      active?.texture.destroy();
      const module=device.createShaderModule({code,label:'recorded velocity texture'});
      const pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},
        fragment:{module,entryPoint:'fragment',targets:[{format}]}});
      const texture=device.createTexture({size:[pixels.width,pixels.height],format:'rgba8unorm',
        usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING});
      device.queue.writeTexture({texture},pixels.data,{bytesPerRow:pixels.width*4,rowsPerImage:pixels.height},
        [pixels.width,pixels.height]);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:texture.createView()},{binding:1,resource:sampler},
      ]});
      active={device,texture,pipeline,group};
    }
    const pass=context.encoder.beginRenderPass({colorAttachments:[{view:context.color,loadOp:'load',storeOp:'store'}]});
    pass.setPipeline(active.pipeline);
    pass.setBindGroup(0,active.group);
    pass.draw(3);
    pass.end();
  }});
  return {show(value){visible=value;},dispose(){remove();active?.texture.destroy();}};
}
