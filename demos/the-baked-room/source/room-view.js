import {width,height} from './room.js';

const shader=/* wgsl */`
struct Camera { matrix:mat4x4f, settings:vec4f }
@group(0) @binding(0) var<uniform> camera:Camera;
@group(0) @binding(1) var lightmap:texture_2d<f32>;
@group(0) @binding(2) var linearFilter:sampler;
struct V { @builtin(position) p:vec4f, @location(0) uv:vec2f, @location(1) base:vec3f }
@vertex fn vertex(@location(0) p:vec3f,@location(1) uv:vec2f,@location(2) base:vec3f)->V{
  return V(camera.matrix*vec4f(p,1),uv,base);
}
fn display(colour:vec3f)->vec3f {
  let minimum=min(colour.r,min(colour.g,colour.b));
  let toe=select(0.04,minimum-minimum*minimum/0.16,minimum<=0.08);
  var value=colour-toe;
  let peak=max(value.r,max(value.g,value.b));
  if(peak>0.76){
    let shoulder=1.0-0.0576/(peak-0.52);
    let keep=1.0/(1.0+0.15*(peak-shoulder));
    value=mix(vec3f(shoulder),value*(shoulder/peak),keep);
  }
  return select(12.92*value,1.055*pow(value,vec3f(1.0/2.4))-0.055,value>=vec3f(0.0031308));
}
@fragment fn fragment(input:V)->@location(0) vec4f{
  let incident=textureSample(lightmap,linearFilter,input.uv).rgb*camera.settings.x;
  return vec4f(display(input.base*incident*(1.48*0.3183098862)),1);
}
`;

export function bakedSurfaces(room){
  let device,vertices,indices,atlas,lighting,uniform,sampler,pipeline,group,scale=1;
  let current=room.starter;
  const frame=new Float32Array(20);
  function bind(){
    if(!pipeline||!lighting)return;
    group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:uniform}},{binding:1,resource:lighting.createView()},
      {binding:2,resource:sampler},
    ]});
  }
  function setAtlas(map){
    current=map;
    if(map.texture){
      lighting=map.texture;
      scale=1;
    }else{
      device.queue.writeTexture({texture:atlas},map.lightmap,{bytesPerRow:width*4},[width,height]);
      lighting=atlas;
      scale=map.lightmapScale;
    }
    bind();
  }
  function release(){
    vertices?.destroy();indices?.destroy();atlas?.destroy();uniform?.destroy();
    vertices=indices=atlas=uniform=lighting=pipeline=group=undefined;
  }
  function setup(engine){
    device=engine.gpu;
    vertices=device.createBuffer({size:room.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
    indices=device.createBuffer({size:room.mesh.indices.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});
    uniform=device.createBuffer({size:frame.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    sampler=device.createSampler({magFilter:'linear',minFilter:'linear'});
    atlas=device.createTexture({size:[width,height],format:'rgba8unorm',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    device.queue.writeBuffer(vertices,0,room.vertices);
    device.queue.writeBuffer(indices,0,room.mesh.indices);
    setAtlas(current);
  }
  return {
    name:'the-baked-room-surfaces',
    setup,setAtlas,
    onDeviceRestored(engine){
      release();
      if(current.texture)current=room.starter;
      setup(engine);
    },
    dispose:release,
    registerPasses(graph){
      graph.add({
        name:'draw-baked-surfaces',order:1,joins:true,
        execute(context){
          if(!pipeline){
            const module=device.createShaderModule({code:shader});
            pipeline=device.createRenderPipeline({
              layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{
                arrayStride:32,attributes:[{shaderLocation:0,format:'float32x3',offset:0},
                  {shaderLocation:1,format:'float32x2',offset:12},{shaderLocation:2,format:'float32x3',offset:20}],
              }]},
              fragment:{module,entryPoint:'fragment',targets:[{format:context.format}]},
              depthStencil:{...context.descriptor.depthStencil},
            });
            bind();
          }
          frame.set(context.camera.matrix);
          frame[16]=scale;
          device.queue.writeBuffer(uniform,0,frame);
          const color={view:context.color,loadOp:'load',storeOp:'store'};
          const depth={view:context.depth,depthLoadOp:'load',depthStoreOp:'store'};
          context.attach?.(color,depth,context.last);
          const pass=context.encoder.beginRenderPass({colorAttachments:[color],depthStencilAttachment:depth});
          pass.setPipeline(pipeline);
          pass.setBindGroup(0,group);
          pass.setVertexBuffer(0,vertices);
          pass.setIndexBuffer(indices,'uint32');
          pass.drawIndexed(room.mesh.indices.length);
          pass.end();
        },
      });
    },
  };
}
