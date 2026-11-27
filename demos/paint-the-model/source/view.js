const surface=/* wgsl */`
struct Camera {vp:mat4x4f,eye:vec4f}
@group(0) @binding(0) var<uniform> camera:Camera;
@group(0) @binding(1) var lacquer:texture_2d<f32>;
@group(0) @binding(2) var bilinear:sampler;

struct Layer {
  @builtin(position) clip:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) uv:vec2f,
  @location(3) @interpolate(flat) material:u32,
}
@vertex fn vertex(@location(0) point:vec3f,@location(1) normal:vec3f,@location(2) uv:vec2f,
  @location(3) material:f32)->Layer {
  return Layer(camera.vp*vec4f(point,1),point,normal,uv,u32(material));
}

fn neutral(color:vec3f)->vec3f {
  let rgb=max(vec3f(0.0),color);
  let minChannel=min(rgb.r,min(rgb.g,rgb.b));
  let black=select(0.04,minChannel-6.25*minChannel*minChannel,minChannel<0.08);
  var mapped=rgb-black;
  let peak=max(mapped.r,max(mapped.g,mapped.b));
  if(peak>0.76){
    let next=1.0-0.0576/(peak-0.52);
    let saturate=1.0/(1.0+0.15*(peak-next));
    mapped=mix(vec3f(next),mapped*(next/peak),saturate);
  }
  return select(12.92*mapped,1.055*pow(max(mapped,vec3f(0.0)),vec3f(1.0/2.4))-0.055,
    mapped>=vec3f(0.0031308));
}
fn panel(ray:vec3f,forward:vec3f,dimensions:vec2f,width:f32)->f32 {
  let x=normalize(cross(vec3f(0,1,0),forward));
  let y=cross(forward,x);
  let near=dot(ray,forward);
  let q=abs(vec2f(dot(ray,x),dot(ray,y)))/max(near,0.1);
  let area=1.0-smoothstep(dimensions-width,dimensions+width,q);
  return area.x*area.y*smoothstep(0.0,0.28,near);
}
fn grain(p:vec2f)->f32 {
  let x=fract(vec3f(p.x,p.y,p.x)*vec3f(0.1003,0.1030,0.0973));
  let t=x+dot(x,x.yzx+33.33);
  return fract((t.x+t.y)*t.z);
}

@fragment fn fragment(input:Layer)->@location(0) vec4f {
  let p=input.world;
  let mat=input.material;
  let n=normalize(input.normal);
  let v=normalize(camera.eye.xyz-p);
  let r=reflect(-v,n);
  let key=normalize(vec3f(-0.37,0.69,0.58));
  let rim=normalize(vec3f(0.23,0.54,-0.82));
  let side=normalize(vec3f(0.84,0.48,0.23));
  let shadow=clamp(dot(n,key)*0.64+0.46,0.12,1.05);
  let cool=clamp(dot(n,rim),0.0,1.0);
  let f=pow(1.0-clamp(dot(n,v),0.0,1.0),4.7);
  let speckle=grain(floor(p.xz*2300.0+p.y*2321.0));
  let grooves=length(p.xz)*1860.0;
  let visibleRings=1.0-smoothstep(0.29,1.95,fwidth(grooves));
  let hot=vec3f(1.0,0.827,0.688);
  let sky=vec3f(0.36,0.61,0.78);

  if(mat==7u){
    let haze=exp(-length((p.xz-vec2f(0.18,-0.78))*vec2f(0.89,1.36))*1.26);
    let shadow=1.0-0.72*exp(-pow(length(p.xz*vec2f(1.01,0.94))/0.282,4.1));
    let platform=vec3f(0.047,0.055,0.052)+haze*vec3f(0.093,0.074,0.053);
    return vec4f(neutral((platform+(speckle-0.5)*0.002)*shadow),1);
  }

  let rectangular=panel(r,key,vec2f(0.42,0.24),0.10);
  let strip=panel(r,rim,vec2f(0.43,0.092),0.075);
  let fill=panel(r,side,vec2f(0.15,0.38),0.14);
  var color=vec3f(0.0);
  if(mat==0u){
    let albedo=textureSampleLevel(lacquer,bilinear,input.uv,0.0).rgb;
    let enamel=albedo*(vec3f(0.35,0.345,0.344)+shadow*0.91+cool*vec3f(0.12,0.17,0.21));
    let coat=rectangular*hot*0.53+strip*sky*0.37+fill*hot*0.17;
    color=enamel+coat*(0.86+f*0.50)+sky*f*0.15;
  }else if(mat==1u){
    let edge=0.11+0.43*smoothstep(0.18,0.89,1.0-input.uv.y);
    let smoky=vec3f(0.019,0.037,0.045)+vec3f(0.025,0.062,0.072)*edge;
    let gloss=panel(r,key,vec2f(0.28,0.27),0.047)*hot*0.87
      +panel(r,rim,vec2f(0.36,0.105),0.041)*sky*0.79+fill*vec3f(0.53,0.66,0.81)*0.41;
    color=smoky+gloss*(0.88+1.8*f)+vec3f(0.29,0.45,0.59)*f*0.22;
  }else if(mat==3u){
    let brushing=0.88+0.12*sin(p.y*6712.0+p.z*1970.0+speckle);
    color=(vec3f(0.10,0.12,0.115)+hot*0.62*rectangular+sky*0.71*strip+hot*fill*0.43+shadow*0.11)*brushing;
  }else if(mat==5u){
    let rings=1.0+0.033*visibleRings*sin(grooves+speckle*0.46);
    let contact=1.0-0.33*exp(-length(p.xz*vec2f(1,1.02))*7.0);
    color=(vec3f(0.066,0.079,0.078)*shadow+rectangular*hot*0.065+sky*strip*0.085)*rings*contact;
  }else if(mat==6u){
    color=vec3f(0.236,0.109,0.060)*shadow+hot*0.28*rectangular+sky*0.17*strip+fill*0.07;
  }else{
    let rubber=select(0.035,0.024,mat==2u);
    color=vec3f(rubber*0.91,rubber,rubber)*(.42+shadow)*(0.90+speckle*0.236)+sky*(fill*.062+f*.052);
  }
  return vec4f(neutral(color),1.0);
}
`;

export function productView(kit,paint){
  let device,vertices,indices,uniform,group,pipeline,format;
  const frame=new Float32Array(20);
  function release(){
    vertices?.destroy();indices?.destroy();uniform?.destroy();
    vertices=indices=uniform=group=pipeline=format=undefined;
  }
  function setup(engine){
    device=engine.gpu;
    vertices=device.createBuffer({size:kit.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
    indices=device.createBuffer({size:kit.indices.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});
    uniform=device.createBuffer({size:frame.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(vertices,0,kit.vertices);
    device.queue.writeBuffer(indices,0,kit.indices);
  }
  function draw(c){
    const bound=paint.texture.bind(device,true);
    if(!bound)throw new Error('The paint texture could not be bound.');
    if(!pipeline||format!==c.format){
      const module=device.createShaderModule({code:surface});
      format=c.format;
      pipeline=device.createRenderPipeline({
        layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:36,attributes:[
          {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
          {shaderLocation:2,offset:24,format:'float32x2'},{shaderLocation:3,offset:32,format:'float32'},
        ]}]},
        fragment:{module,entryPoint:'fragment',targets:[{format}]},depthStencil:{...c.descriptor.depthStencil},
      });
      group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:uniform}},{binding:1,resource:bound[0]},{binding:2,resource:bound[1]},
      ]});
    }
    frame.set(c.camera.matrix);
    frame.set(c.camera.position,16);
    device.queue.writeBuffer(uniform,0,frame);
    const color={view:c.color,loadOp:'load',storeOp:'store'};
    const depth={view:c.depth,depthLoadOp:'load',depthStoreOp:'store'};
    c.attach?.(color,depth,c.last);
    const pass=c.encoder.beginRenderPass({colorAttachments:[color],depthStencilAttachment:depth});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0,group);
    pass.setVertexBuffer(0,vertices);
    pass.setIndexBuffer(indices,'uint32');
    pass.drawIndexed(kit.indices.length);
    pass.end();
  }
  return {
    name:'kestrel-coat',setup,
    onDeviceRestored(engine){release();setup(engine);},
    dispose:release,
    registerPasses(graph){graph.add({name:'draw-kestrel',order:1,joins:true,execute:draw});},
  };
}
