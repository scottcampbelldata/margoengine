const glass=String.raw`
struct View {matrix:mat4x4f, eye:vec4f}
@group(0) @binding(0) var<uniform> view:View;
struct Varying {@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) n:vec3f}
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f)->Varying {
  var o:Varying;o.clip=view.matrix*vec4f(p,1);o.p=p;o.n=n;return o;
}
@fragment fn fragment(i:Varying)->@location(0) vec4f {
  let normal=normalize(i.n);
  let toEye=normalize(view.eye.xyz-i.p);
  let reflecting=reflect(-toEye,normal);
  let facing=clamp(dot(toEye,normal),0.0,1.0);
  let fresnel=0.041+0.959*pow(1.0-facing,5.0);
  let tall=smoothstep(0.234,0.299,i.p.y)*(1.0-smoothstep(0.548,0.613,i.p.y));
  let left=exp(-84.0*pow(reflecting.x+0.64,2.0))*smoothstep(-0.32,0.14,reflecting.z);
  let right=exp(-110.0*pow(reflecting.x-0.72,2.0))*smoothstep(0.04,0.63,reflecting.z);
  let bottom=exp(-180.0*pow(i.p.y-0.228,2.0));
  let boxes=(0.66*left+0.42*right)*tall;
  let color=mix(vec3f(.25,.37,.46),vec3f(.87,.83,.91),clamp(fresnel*.52+boxes*.9,0.0,1.0));
  let tint=mix(color,vec3f(.99,.63,.39),bottom*.36);
  return vec4f(tint,min(.64,.022+.31*fresnel+.47*boxes+.037*bottom));
}
`;
const debug=String.raw`
struct View {matrix:mat4x4f, eye:vec4f}
@group(0) @binding(0) var<uniform> view:View;
@vertex fn vertex(@location(0) p:vec3f)->@builtin(position) vec4f {
  let q=view.matrix*vec4f(p,1);return vec4f(q.xy,q.z+0.00012*q.w,q.w);
}
@fragment fn fragment()->@location(0) vec4f {
  return vec4f(0.94,0.87,0.70,0.58);
}
`;
const dielectric=String.raw`
  var pigment=i.color;
  var lampLight=vec3f(0);
  if(i.color.r>.99&&i.color.g<.01&&i.color.b>.99){
    let hot=1.0-smoothstep(0.20,0.55,i.position.y);
    let rim=pow(1.0-abs(dot(n,v)),2.0);
    pigment=mix(vec3f(.52,.018,.065),vec3f(.90,.120,.036),hot);
    lampLight=pigment*(.37+.16*rim)+vec3f(.13,.037,.006)*hot;
  }
`;

function shadeWax(source){
  const fragment=source.indexOf('@fragment fn fragment');
  const start='let nl=clamp(dot(n,l),0.0,1.0);';
  const output='let linear=direct*frame.radiance.xyz*frame.light.w+i.color*(1.0-i.material.y)*frame.radiance.w*frame.ambient.rgb;';
  if(fragment<0||!source.includes(start)||!source.includes(output))throw Error('Pinned core shading hooks changed.');
  const surface=source.slice(fragment).replace(output,output.replace(';','+lampLight;')).replaceAll('i.color','pigment');
  return source.slice(0,fragment)+surface.replace(start,dielectric+start);
}

const blend={color:{srcFactor:'src-alpha',dstFactor:'one-minus-src-alpha'},
  alpha:{srcFactor:'one',dstFactor:'one-minus-src-alpha'}};
export function lampOptics(engine,vessel){
  const constants=new Float32Array(20);
  let device,frame,glassVertex,glassIndex,wireVertices,wireIndices,wireData;
  let glassModule,debugModule,shader,patched;
  const programs=new Map();
  const upload=(data,kind)=>{
    const buffer=device.createBuffer({size:data.byteLength,usage:kind|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(buffer,0,data);
    return buffer;
  };
  const make=owner=>{
    device=owner.gpu;
    programs.clear();
    frame=device.createBuffer({size:constants.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    glassVertex=upload(vessel.vertices,GPUBufferUsage.VERTEX);
    glassIndex=upload(vessel.indices,GPUBufferUsage.INDEX);
    glassModule=device.createShaderModule({code:glass,label:'Lumen double-wall glass'});
    debugModule=undefined;
    wireVertices=undefined;wireIndices=undefined;
    if(wireData)setWire(wireData);
  };
  function enlarge(old,data,kind){
    if(old?.size>=data.byteLength){device.queue.writeBuffer(old,0,data);return old;}
    if(old){
      const after=device.queue.onSubmittedWorkDone();
      after.then(()=>old.destroy(),()=>old.destroy());
    }
    return upload(data,kind);
  }
  function setWire(data){
    wireData=data;
    if(!data?.segments.length)return;
    wireVertices=enlarge(wireVertices,data.positions,GPUBufferUsage.VERTEX);
    wireIndices=enlarge(wireIndices,data.segments,GPUBufferUsage.INDEX);
  }
  function pipeline(c,lines){
    const format=c.descriptor.depthStencil?.format??'depth24plus';
    const samples=c.descriptor.multisample?.count??1;
    const key=[c.format,format,samples,lines].join(':');
    if(programs.has(key))return programs.get(key);
    const module=lines?(debugModule??=device.createShaderModule({code:debug,label:'Lumen extracted edges'})):glassModule;
    const buffers=[{arrayStride:lines?12:24,attributes:lines?[{shaderLocation:0,offset:0,format:'float32x3'}]:[
      {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
    ]}];
    const pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex',buffers},
      fragment:{module,entryPoint:'fragment',targets:[{format:c.format,blend}]},
      primitive:{topology:lines?'line-list':'triangle-list',cullMode:lines?'none':'back'},
      depthStencil:{format,depthCompare:'greater-equal',depthWriteEnabled:false},multisample:{count:samples}});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}}]});
    const pair={pipeline,group};
    programs.set(key,pair);
    return pair;
  }
  function draw(c){
    const opaque={view:c.color,loadOp:'load',storeOp:'store'},depth={view:c.depth,depthLoadOp:'load',depthStoreOp:'store'};
    if(c.descriptor.depthStencil?.format.includes('stencil'))Object.assign(depth,{stencilLoadOp:'load',stencilStoreOp:'store'});
    c.attach?.(opaque,depth,!!c.last);
    constants.set(c.camera.matrix);constants.set(c.camera.position,16);
    device.queue.writeBuffer(frame,0,constants);
    const surface=pipeline(c,false),lines=wireData?.segments.length?pipeline(c,true):null;
    const pass=c.encoder.beginRenderPass({colorAttachments:[opaque],depthStencilAttachment:depth,label:'Lumen inspection optics'});
    pass.setPipeline(surface.pipeline);pass.setBindGroup(0,surface.group);
    pass.setVertexBuffer(0,glassVertex);pass.setIndexBuffer(glassIndex,'uint32');pass.drawIndexed(vessel.indices.length);
    if(lines){
      pass.setPipeline(lines.pipeline);pass.setBindGroup(0,lines.group);
      pass.setVertexBuffer(0,wireVertices);pass.setIndexBuffer(wireIndices,'uint32');pass.drawIndexed(wireData.segments.length);
    }
    pass.end();
  }
  function free(){
    for(const buffer of [frame,glassVertex,glassIndex,wireVertices,wireIndices])buffer?.destroy();
    programs.clear();
  }
  const plugin={
    name:'lumen:optics',
    setup:make,
    onDeviceRestored(owner){free();make(owner);},
    registerPasses(graph){
      graph.add({name:'lumen:wax-light',order:-1,execute(c){
        if(c.backend!=='webgpu')return;
        if(c.shader!==shader){shader=c.shader;patched=shadeWax(shader);}
        c.shader=patched;
      }});
      graph.add({name:'lumen:glass-and-wire',order:2,joins:true,execute(c){if(c.backend==='webgpu')draw(c);}});
    },
    dispose:free,
    setWire,
  };
  engine.use(plugin);
  return plugin;
}
