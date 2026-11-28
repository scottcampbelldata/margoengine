const shader=`
struct View {
  projection: mat4x4f,
  eye: vec4f,
  translate: vec4f,
  style: vec4f,
  mask: vec4f,
};
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var colorSampler: sampler;
@group(0) @binding(2) var albedo: texture_2d<f32>;

struct Sample {
  @builtin(position) clip: vec4f,
  @location(0) point: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
};
@vertex fn vertex(@location(0) point: vec3f,@location(1) normal: vec3f,@location(2) uv: vec2f) -> Sample {
  let local=point * view.style.x + view.translate.xyz;
  return Sample(view.projection * vec4f(local,1),local,normal,uv);
}
fn display(linear:vec3f) -> vec3f {
  let color=max(linear,vec3f(0));
  return select(color*12.92, 1.055*pow(color,vec3f(1.0/2.4))-0.055,color>vec3f(.0031308));
}
@fragment fn land(input:Sample) -> @location(0) vec4f {
  if(view.style.z>0.0&&all(input.uv>view.mask.xy)&&all(input.uv<view.mask.zw)){discard;}
  let normal=normalize(input.normal);
  let eye=normalize(view.eye.xyz-input.point);
  let sun=normalize(vec3f(-.60,.60,.56));
  let exposure=.30+.84*max(0.0,dot(normal,sun));
  let texel=textureSample(albedo,colorSampler,input.uv);
  if(texel.a<.40){discard;}
  let base=texel.rgb;
  let rim=pow(clamp(1.0-dot(eye,normal),0,1),4.0)*view.style.y;
  let air=vec3f(.035,.145,.37)*rim;
  return vec4f(display(base*exposure+air),1);
}
@fragment fn air(input:Sample) -> @location(0) vec4f {
  let face=clamp(dot(normalize(input.normal),normalize(view.eye.xyz-input.point)),0,1);
  let scatter=pow(1.0-face,8.0)*smoothstep(0,.10,face)*.82;
  return vec4f(.17,.51,.91,scatter);
}
`;

export async function readMap(url,signal){
  const response=await fetch(url,{signal});
  if(!response.ok)throw Error('A surface map could not be opened.');
  return createImageBitmap(await response.blob(),{colorSpaceConversion:'none'});
}

export function connectSurface(engine,origin){
  const device=engine.gpu;
  const module=device.createShaderModule({label:'Globe Flight surface and atmosphere',code:shader});
  const pipelines=new Map(),drawables=new Set();
  const sampler=device.createSampler({addressModeU:'clamp-to-edge',minFilter:'linear',magFilter:'linear'});
  const layout=device.createBindGroupLayout({entries:[
    {binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{}},
    {binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{}},
    {binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:'float'}}
  ]});
  const pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
  function pipeline(context,air){
    const depth=context.descriptor.depthStencil.format;
    const samples=context.descriptor.multisample?.count??1;
    const key=[context.format,depth,samples,air].join('/');
    if(!pipelines.has(key)){
      const blend=air?{color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}}:undefined;
      pipelines.set(key,device.createRenderPipeline({
        layout:pipelineLayout,
        vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:32,attributes:[
          {shaderLocation:0,format:'float32x3',offset:0},
          {shaderLocation:1,format:'float32x3',offset:12},
          {shaderLocation:2,format:'float32x2',offset:24}
        ]}]},
        fragment:{module,entryPoint:air?'air':'land',targets:[{format:context.format,blend}]},
        primitive:{topology:'triangle-list',cullMode:'back'},
        depthStencil:{format:depth,depthWriteEnabled:!air,depthCompare:'greater-equal'},
        multisample:{count:samples}
      }));
    }
    return pipelines.get(key);
  }
  function upload(bytes,usage){
    const buffer=device.createBuffer({size:bytes.byteLength,usage:usage|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(buffer,0,bytes);
    return buffer;
  }
  function makeMap(image){
    const size=[image.width,image.height];
    const texture=device.createTexture({size,format:'rgba8unorm-srgb',usage:
      GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    try{
      device.queue.copyExternalImageToTexture({source:image},{texture},size);
      return texture;
    }catch(error){texture.destroy();throw error;}
    finally{image.close();}
  }
  function mesh(geometry,anchor,image,{globe=false}={}){
    const {positions,normals,uvs,indices}=geometry;
    const vertices=new Float32Array(positions.length/3*8);
    for(let i=0,j=0;i<positions.length/3;i++,j+=8){
      vertices[j]=positions[i*3];
      vertices[j+1]=positions[i*3+1];
      vertices[j+2]=positions[i*3+2];
      vertices[j+3]=normals[i*3];
      vertices[j+4]=normals[i*3+1];
      vertices[j+5]=normals[i*3+2];
      vertices[j+6]=uvs[i*2];
      vertices[j+7]=uvs[i*2+1];
    }
    const frames=Array.from({length:globe?2:1},()=>new Float32Array(32));
    const uniforms=frames.map(frame=>upload(frame,GPUBufferUsage.UNIFORM));
    const vertex=upload(vertices,GPUBufferUsage.VERTEX);
    const index=upload(indices,GPUBufferUsage.INDEX);
    const item={
      anchor,frames,uniforms,vertex,index,count:indices.length,globe,enabled:true,
      maps:new Map(),map:'surface',mask:null
    };
    drawables.add(item);
    function supply(name,bitmap){
      const texture=makeMap(bitmap);
      const groups=uniforms.map(uniform=>device.createBindGroup({layout,entries:[
        {binding:0,resource:{buffer:uniform}},{binding:1,resource:sampler},{binding:2,resource:texture.createView()}
      ]}));
      const previous=item.maps.get(name);
      item.maps.set(name,{texture,groups});
      previous?.texture.destroy();
    }
    supply('surface',image);
    return {
      supply,
      show(name){if(item.maps.has(name))item.map=name;},
      visible(value){item.enabled=value;},
      hole(value){item.mask=value;}
    };
  }
  let haze=1;
  function output(context){
    if(context.backend!=='webgpu')return;
    const depthFormat=context.descriptor.depthStencil.format;
    const color={view:context.color,loadOp:'load',storeOp:'store'};
    const depth={view:context.depth,depthLoadOp:'load',depthStoreOp:'store'};
    if(depthFormat.includes('stencil'))depth.stencilReadOnly=true;
    context.attach?.(color,depth,true);
    const render=context.encoder.beginRenderPass({colorAttachments:[color],depthStencilAttachment:depth});
    function draw(item,air){
      const slot=Number(air),frame=item.frames[slot];
      frame.set(context.camera.matrix,0);
      frame.set(context.camera.position,16);
      frame.set(origin.toLocal(item.anchor),20);
      frame[24]=air?1.011:1;
      frame[25]=item.globe?haze:.025;
      frame[26]=Number(!!item.mask);
      if(item.mask)frame.set(item.mask,28);
      device.queue.writeBuffer(item.uniforms[slot],0,frame);
      render.setPipeline(pipeline(context,air));
      render.setVertexBuffer(0,item.vertex);
      render.setIndexBuffer(item.index,'uint32');
      render.setBindGroup(0,item.maps.get(item.map).groups[slot]);
      render.drawIndexed(item.count);
    }
    for(const item of drawables)if(item.enabled)draw(item,false);
    if(haze>.6)for(const item of drawables)if(item.enabled&&item.globe)draw(item,true);
    render.end();
  }
  engine.use({
    name:'Globe Flight surfaces',
    setup(){},
    registerPasses(graph){graph.add({name:'Globe Flight surfaces',order:3,joins:true,execute:output});},
    dispose(){
      for(const item of drawables){
        item.vertex.destroy();
        item.index.destroy();
        for(const uniform of item.uniforms)uniform.destroy();
        for(const {texture} of item.maps.values())texture.destroy();
      }
      drawables.clear();
      pipelines.clear();
    }
  });
  return {mesh,atmosphere(value){haze=value;}};
}
