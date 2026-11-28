export const plateWidth=1680, plateHeight=1080, plateFov=64;

const code=`struct Frame {
  // Convert the live camera's screen ray into the wider capture camera's UV.
  window: vec2f,
  flare: f32,
  padding: f32,
}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
struct Sample {
  @builtin(position) p: vec4f,
  @location(0) xy: vec2f,
}
@vertex fn vertex(@builtin(vertex_index) id:u32)->Sample {
  let verts = array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  let p=verts[id];
  var a:Sample;
  a.p=vec4f(p,0,1);
  a.xy=p;
  return a;
}
@fragment fn fragment(sample:Sample)->@location(0) vec4f {
  let normalized=vec2f(.5)+sample.xy*vec2f(.5,-.5)*frame.window;
  let dark=textureSample(atlas,linearSampler,vec2f(normalized.x,.5*normalized.y)).rgb;
  let lit=textureSample(atlas,linearSampler,vec2f(normalized.x,.5+.5*normalized.y)).rgb;
  let linear=mix(dark*dark,lit*lit,frame.flare);
  return vec4f(sqrt(linear),1);
}
`;

export async function loadPlates(signal){
  signal.throwIfAborted();
  const image=new Image();
  image.src=new URL('./storm-plates.webp',import.meta.url);
  await image.decode();
  signal.throwIfAborted();
  return createImageBitmap(image);
}
export function attachProjection(engine,bitmap){
  if(bitmap.width!==plateWidth||bitmap.height!==2*plateHeight){
    bitmap.close();
    throw new Error('The storm layers do not match the authored camera projection.');
  }
  const values=new Float32Array(4);
  const name='storm-field-projection';
  let texture,uniform,sampler,group,pipeline,key,flare=0;
  const getResources=device=>{
    texture=device.createTexture({
      size:[bitmap.width,bitmap.height],format:'rgba8unorm',
      usage:GPUTextureUsage.COPY_DST|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.copyExternalImageToTexture({source:bitmap},{texture},[bitmap.width,bitmap.height]);
    uniform=device.createBuffer({size:16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.UNIFORM});
    sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
  };
  engine.use({
    name,
    setup(value){getResources(value.gpu);},
    registerPasses(graph){
      graph.add({name,order:3,execute(c){
        if(c.backend!=='webgpu')return;
        const format=c.descriptor.depthStencil.format;
        const style=c.format+'/'+format;
        if(key!==style){
          const module=c.device.createShaderModule({code});
          pipeline=c.device.createRenderPipeline({
            layout:'auto',vertex:{module,entryPoint:'vertex'},
            fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},
            depthStencil:{format,depthCompare:'greater-equal',depthWriteEnabled:false},
            multisample:c.descriptor.multisample,
          });
          group=c.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
            {binding:0,resource:{buffer:uniform}},{binding:1,resource:texture.createView()},{binding:2,resource:sampler},
          ]});
          key=style;
        }
        const window=Math.tan(c.camera.fov*Math.PI/360)/Math.tan(plateFov*Math.PI/360);
        values.set([window*(c.width/c.height)/(plateWidth/plateHeight),window,flare,0]);
        c.device.queue.writeBuffer(uniform,0,values);
        const pass=c.encoder.beginRenderPass({
          colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}],
          depthStencilAttachment:{view:c.depth,depthReadOnly:true,stencilReadOnly:true},
        });
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
      }});
    },
    onDeviceRestored(value){
      key=undefined;
      getResources(value.gpu);
    },
    dispose(){
      texture?.destroy();
      uniform?.destroy();
      bitmap.close();
    },
  });
  return value=>{flare=value;};
}
