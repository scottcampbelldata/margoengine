import {engineRuntime} from '@margoengine/core/extension';
import {chartGeometry,lensGeometry} from './art.js';
import {irradianceScale,table,wavelengthReference} from './optics.js';

const shader= /* wgsl */`
struct Setup {
  camera:mat4x4f,
  eye:vec4f,
  state:vec4f,
  bounds:vec4f,
}
@group(0) @binding(0) var<uniform> setup:Setup;
@group(0) @binding(1) var samplerLinear:sampler;
@group(0) @binding(2) var slate:texture_2d<f32>;
@group(0) @binding(3) var irradiance:texture_2d<f32>;
struct Vertex {
  @builtin(position) clip:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
}
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f)->Vertex {
  return Vertex(setup.camera*vec4f(p,1),p,n);
}
fn sRGB(v:vec3f)->vec3f {
  return mix(v*12.92,1.055*pow(max(v,vec3f(0)),vec3f(0.416666667))-0.055,step(vec3f(0.0031308),v));
}
fn display(input:vec3f)->vec3f {
  let x=min(input.r,min(input.g,input.b));
  let offset=select(0.04,x-6.25*x*x,x<0.08);
  var v=input-vec3f(offset);
  let peak=max(v.r,max(v.g,v.b));
  if(peak>0.76){
    let p=1.0-0.0576/(peak-0.52);
    v=mix(v*(p/peak),vec3f(p),1.0-1.0/(1.0+0.15*(peak-p)));
  }
  return sRGB(max(v,vec3f(0)));
}
fn tableUV(p:vec3f)->vec2f {
  return (p.xz-setup.bounds.xy)/setup.bounds.zw;
}
fn slateLight(uv:vec2f)->vec3f {
  let incident=textureSample(slate,samplerLinear,uv).rgb;
  let bake=textureSample(irradiance,samplerLinear,uv).rgb*setup.state.x;
  let key=vec3f(.97,.92,.87)*(.79*3.0/3.14159265);
  let ambient=vec3f(.96,1,1.09)*.63;
  return incident*(key+ambient+bake/3.14159265);
}
@fragment fn tableLight(input:Vertex)->@location(0) vec4f {
  return vec4f(display(slateLight(tableUV(input.world))),1);
}
fn studio(R:vec3f,rough:f32)->vec3f {
  let stretch=vec3f(.16+rough,.42+rough,.15+rough);
  let a=abs(R-vec3f(-.80,.50,.34))/stretch;
  let b=abs(R-vec3f(.68,.41,-.60))/stretch;
  let c=abs(R-vec3f(.07,.95,.28))/vec3f(.28+rough,.14+rough,.48+rough);
  let aa=max(a.x,max(a.y,a.z));
  let bb=max(b.x,max(b.y,b.z));
  let cc=max(c.x,max(c.y,c.z));
  return vec3f(.046,.070,.087)+vec3f(.40,.55,.70)*(1-smoothstep(.45,1.28,aa))+
    vec3f(.65,.76,.85)*(1-smoothstep(.45,1.28,bb))+vec3f(.82,.70,.52)*(1-smoothstep(.45,1.28,cc));
}
@fragment fn glassLight(input:Vertex)->@location(0) vec4f {
  let incoming=normalize(input.world-setup.eye.xyz);
  let N=normalize(input.normal);
  let c=clamp(-dot(incoming,N),0.0,1.0);
  let r=(setup.state.y-1)/(setup.state.y+1);
  let F=r*r+(1-r*r)*pow(1-c,5);
  let bounce=studio(reflect(incoming,N),setup.state.z);
  let ray=refract(incoming,N,1/setup.state.y);
  let intoTable=max(-ray.y,.00001);
  let sample=tableUV(input.world+ray*input.world.y/intoTable);
  let bounds=all(sample>=vec2f(0))&&all(sample<=vec2f(1))&&ray.y<-.07;
  let through=select(vec3f(.020,.039,.058),slateLight(sample),bounds);
  let color=display(through*.35+bounce*1.4);
  let alpha=clamp(.23+F*.60+max(0,setup.state.z-.055)*2.22,0.0,.94);
  return vec4f(color,alpha);
}
`;

function vertices(part){
  const data=new Float32Array(part.indices.length*6);
  part.indices.forEach((vertex,i)=>{
    const off=vertex*3;
    data.set(part.positions.slice(off,off+3),i*6);
    data.set(part.normals.slice(off,off+3),i*6+3);
  });
  return data;
}
function buffer(device,contents){
  const result=device.createBuffer({size:contents.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
  device.queue.writeBuffer(result,0,contents);
  return result;
}
const depth=(format)=>({format,depthWriteEnabled:true,depthCompare:'greater-equal'});
function source(device,image){
  const {width,height}=image;
  const texture=device.createTexture({size:[width,height],format:'rgba8unorm-srgb',
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture},image.data,{bytesPerRow:width*4,rowsPerImage:height},[width,height]);
  return {texture,view:texture.createView()};
}

export function leanBench(engine,slate,maps,start){
  const runtime=engineRuntime(engine),name='caustic-glass:opening',chart=vertices(chartGeometry()),lens=vertices(lensGeometry());
  const params=new Float32Array(28);
  params.set([table.minX,table.minZ,table.maxX-table.minX,table.maxZ-table.minZ],24);
  const modeRoughness={spectrum:.055,clear:.055,ground:.30};
  let choice=start,resources;
  const textureData=new Map();
  function release(){
    if(!resources)return;
    resources.chart.destroy();
    resources.lens.destroy();
    resources.uniform.destroy();
    resources.slate.texture.destroy();
    for(const slot of textureData.values())slot.texture.destroy();
    textureData.clear();
    resources=undefined;
  }
  function prepare(c){
    const device=c.device;
    const layout=device.createBindGroupLayout({entries:[
      {binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:'uniform'}},
      {binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:'filtering'}},
      {binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
      {binding:3,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}},
    ]});
    const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
    const module=device.createShaderModule({code:shader,label:'Caustic glass receiver and dielectric'});
    const geometry={module,entryPoint:'vertex',buffers:[{arrayStride:24,attributes:[
      {shaderLocation:0,format:'float32x3',offset:0},{shaderLocation:1,format:'float32x3',offset:12}
    ]}]};
    const pipeline=(entryPoint,blend)=>device.createRenderPipeline({
      label:'Caustic glass '+entryPoint,layout:pipelineLayout,vertex:geometry,primitive:{cullMode:'back'},
      depthStencil:depth(c.descriptor.depthStencil.format),
      fragment:{module,entryPoint,targets:[{format:c.format,...(blend?{blend}: {})}]},
    });
    return {
      device,layout,
      tableDraw:pipeline('tableLight'),glassDraw:pipeline('glassLight',{
        color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha',operation:'add'},
        alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha',operation:'add'},
      }),
      chart:buffer(device,chart),lens:buffer(device,lens),slate:source(device,slate),
      sampler:device.createSampler({magFilter:'linear',minFilter:'linear'}),
      uniform:device.createBuffer({size:params.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),
    };
  }
  runtime.use({
    name,setup(){},dispose:release,onDeviceRestored:release,
    registerPasses(graph){
      graph.add({name: name+':draw',order:1,execute(c){
        if(c.backend!=='webgpu')return;
        const r=resources??=prepare(c);
        let selected=textureData.get(choice);
        if(selected?.raw!==maps[choice]||!selected){
          selected?.texture.destroy();
          selected={raw:maps[choice],...source(r.device,maps[choice])};
          textureData.set(choice,selected);
        }
        params.set(c.camera.matrix,0);
        params.set(c.camera.position,16);
        params.set([irradianceScale,wavelengthReference,modeRoughness[choice],0],20);
        r.device.queue.writeBuffer(r.uniform,0,params);
        const bind=r.device.createBindGroup({layout:r.layout,entries:[
          {binding:0,resource:{buffer:r.uniform}},{binding:1,resource:r.sampler},
          {binding:2,resource:r.slate.view},{binding:3,resource:selected.view},
        ]});
        const pass=c.encoder.beginRenderPass({
          colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}],
          depthStencilAttachment:{view:c.depth,depthLoadOp:'load',depthStoreOp:'store',
            ...(c.descriptor.depthStencil.format.includes('stencil')?{stencilLoadOp:'load',stencilStoreOp:'store'}:{})},
        });
        pass.setBindGroup(0,bind);
        pass.setPipeline(r.tableDraw);pass.setVertexBuffer(0,r.chart);pass.draw(chart.length/6);
        pass.setPipeline(r.glassDraw);pass.setVertexBuffer(0,r.lens);pass.draw(lens.length/6);
        pass.end();
      }});
    },
  });
  return {update(key){choice=key;},dispose(){runtime.removePlugin(name);}};
}
