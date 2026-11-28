const shader=/* wgsl */`
struct Frame { vp:mat4x4f, eye:vec4f, mood:vec4f }
@group(0) @binding(0) var<uniform> frame:Frame;

struct Field {
  @builtin(position) clip:vec4f,
  @location(0) p:vec3f,
  @location(1) n:vec3f,
  @location(2) tint:vec3f,
  @location(3) @interpolate(flat) group:u32,
}

@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) pigment:vec4f)->Field {
  return Field(frame.vp*vec4f(p,1),p,n,pigment.xyz,u32(pigment.w));
}
fn hash(p:vec2f)->f32 {
  let a=fract(vec3f(p.x,p.y,p.x)*vec3f(0.1031,0.1030,0.0973));
  let b=a+dot(a,a.yzx+33.33);
  return fract((b.x+b.y)*b.z);
}
fn noise(p:vec2f)->f32 {
  let cell=floor(p);
  let u=fract(p);
  let t=u*u*(3.0-2.0*u);
  return mix(mix(hash(cell),hash(cell+vec2f(1,0)),t.x),
    mix(hash(cell+vec2f(0,1)),hash(cell+vec2f(1,1)),t.x),t.y);
}
fn canopy(p:vec2f)->f32 {
  return noise(p)*0.63+noise(p*2.16+7.9)*0.26+noise(p*4.42-11.3)*0.11;
}
fn sky(p:vec3f,cold:bool,t:f32)->vec3f {
  let world=p.xy/460.0;
  let skyHeight=clamp(world.y+0.033,0.0,1.0);
  if(cold){
    let first=mix(vec3f(0.40,0.55,0.66),vec3f(0.058,0.106,0.203),smoothstep(0.0,0.48,skyHeight));
    let path=0.192+0.095*sin(world.x*3.2+0.47+t*0.071)+0.034*sin(world.x*9.4-t*0.078);
    let fold=world.y-path;
    let vertical=(0.42+0.58*canopy(vec2f(world.x*35.1-t*.027,world.y*2.12)));
    let curtain=exp(-abs(fold)*13.3)*vertical*(0.62+0.38*sin(world.x*4.8+0.31));
    let lower=exp(-abs(fold+0.021)*52.0)*vertical*0.72;
    let contrast=canopy(vec2f(world.x*5.6+t*.018,world.y*21.0)+3.9);
    var tint=first+curtain*vec3f(0.030,0.204,0.178)+lower*vec3f(0.06,0.31,0.255);
    tint+=contrast*curtain*vec3f(0.064,0.10,0.129);
    let grid=world*vec2f(197,153);
    let cell=floor(grid);
    let spark=step(0.994,hash(cell))*max(0.0,1.0-length(fract(grid)-0.5)*2.5);
    let moonDistance=length(world-vec2f(0.18,0.284));
    let moon=1.0-smoothstep(0.0252,0.0260,moonDistance);
    let crescent=moon*smoothstep(0.023,0.024,length(world-vec2f(0.187,0.290)));
    tint+=vec3f(0.41,0.56,0.72)*spark*smoothstep(.08,.27,skyHeight);
    return mix(tint,vec3f(0.716,0.846,0.90),crescent);
  }

  let off=world-vec2f(-0.517,0.079);
  let distance=length(off);
  let glow=exp(-3.3*length(off*vec2f(1.0,2.4)));
  let base=mix(vec3f(0.776,0.482,0.301),vec3f(0.291,0.432,0.517),smoothstep(0.001,0.42,skyHeight));
  let layer=canopy(vec2f(world.x*7.4-t*.028,world.y*46.0+world.x*1.8));
  let amber=vec3f(1.0,0.669,0.382);
  let wisps=smoothstep(0.535,0.728,layer)*smoothstep(0.012,0.092,skyHeight)*(1.0-smoothstep(.29,.69,skyHeight));
  let warm=mix(base,amber,glow*0.77);
  let shining=mix(warm,mix(vec3f(0.667,0.423,0.396),amber,glow*0.67),wisps*.75);
  let orb=1.0-smoothstep(0.0353,0.0367,distance);
  return mix(shining,vec3f(.993,.867,.635),orb);
}
fn paint(color:vec3f)->vec3f {
  return clamp(color,vec3f(0.0),vec3f(1.0));
}

@fragment fn fragment(input:Field)->@location(0) vec4f {
  let p=input.p;
  let v=normalize(frame.eye.xyz-p);
  let n=normalize(input.n);
  let category=input.group;
  let cold=frame.mood.y>0.5;
  let t=frame.mood.x;
  if(category==0u){
    return vec4f(paint(sky(p,cold,t)),1.0);
  }
  let key=normalize(select(vec3f(-0.74,.41,.33),vec3f(-.42,.62,.54),cold));
  let direct=max(0.0,dot(n,key));
  let far=length(p.xz-frame.eye.xz);
  let haze=1.0-exp(-far*select(.0049,.0054,cold));
  let air=select(vec3f(.617,.431,.353),vec3f(.392,.503,.634),cold);
  let movement=t*.023;
  let texture=canopy(vec2f(p.x*.82+p.y*.35,p.z*.72-p.y*.17));
  let micro=canopy(vec2f(p.x*2.03+p.z*.20,p.z*2.89+p.y));
  var base=input.tint;
  if(category==1u){
    let dune=sin(p.z*1.79+p.x*.57+texture*4.6);
    let lit=vec3f(1.16,1.03,.89)*(.65+direct*.42);
    let contact=1.0-.52*exp(-abs(p.x)*.18-abs(p.z+13.5)*.095);
    base=base*lit*contact+(texture-.45)*vec3f(.086,.060,.044)+(dune*.5+.5)*micro*.026;
    let dust=noise(vec2f(p.x*.073-movement,p.z*.102))*exp(-max(0.0,p.y)*.14);
    base=mix(base,vec3f(.744,.543,.371),smoothstep(.67,.94,dust)*.24);
  }else if(category==2u){
    let ledge=sin(p.y*2.19+p.z*.099+texture*4.8);
    base=base*(.67+direct*.56+(ledge*.081)+(texture-.5)*.16);
    base+=vec3f(.09,.047,.041)*max(0.0,n.y)*micro;
  }else if(category==4u){
    let lane=abs(p.x-(.057*p.z+1.7*sin(p.z*.046)));
    let clear=(1.0-smoothstep(3.0,13.0,lane))*(1.0-smoothstep(-.53,.42,p.y));
    let crack=sin(p.x*1.26-p.z*.65+texture*4.7)*sin(p.z*.39+p.x*.73+micro*3.0);
    let edge=1.0-smoothstep(0.04,.20,abs(crack));
    let blendIce=mix(base*.96,vec3f(.131,.227,.393),clear*.73);
    let sparkle=smoothstep(.61,.91,texture)*clear*max(0.0,n.y);
    let flux=vec3f(.073,.217,.207)*(sin(t*.38+p.z*.044)*.25+.67);
    let crystal=vec3f(.114,.19,.23)*edge*(.11+.89*micro)*(.65-clear*.54);
    base=blendIce*(.77+direct*.41)+sparkle*flux+crystal;
  }else if(category==5u){
    let layers=sin(p.y*1.76-p.x*.21+p.z*.44+micro*4.8);
    let bleed=exp(-abs(p.y-.13)*.31);
    let color=mix(input.tint,vec3f(.36,.684,.769),max(0.0,n.y)*.29);
    base=color*(.64+direct*.61)+vec3f(.037,.096,.119)*bleed+(layers*.38+micro-.55)*.052;
  }else if(category==6u||category==7u){
    let flare=.87+.13*sin(t*2.48+dot(p,vec3f(.14,.29,.037)));
    return vec4f(paint(mix(base,vec3f(1.0,.985,.95),.22+flare*.19)),1.0);
  }else{
    let reflection=reflect(-v,n);
    let angle=clamp(abs(dot(v,n)),0.0,1.0);
    let hot=pow(max(0.0,dot(reflection,key)),7.4);
    let fill=abs(dot(reflection,normalize(vec3f(.31,.45,-.832))));
    let shiny=.11*pow(fill,9.0)+.24*hot+.09*pow(1.0-angle,4.3);
    let edgeLight=select(vec3f(.94,.588,.345),vec3f(.543,.819,.902),cold);
    let lighting=(.58+direct*.48)*(0.955+micro*.069);
    base=base*lighting+edgeLight*shiny;
  }
  return vec4f(paint(mix(base,air,haze*(select(.80,.90,cold)))),1.0);
}
`;

export function landscape(world,cold,clock,compiler){
  let device,positions,elements,uniform,pipeline,materialGroup;
  const params=new Float32Array(24);
  function release(){
    positions?.destroy();elements?.destroy();uniform?.destroy();
    positions=elements=uniform=pipeline=materialGroup=undefined;
  }
  function setup(engine){
    device=engine.gpu;
    positions=device.createBuffer({size:world.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
    elements=device.createBuffer({size:world.indices.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});
    uniform=device.createBuffer({size:params.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(positions,0,world.vertices);
    device.queue.writeBuffer(elements,0,world.indices);
  }
  function compile(c){
    let formats=compiler.get(device);
    if(!formats){formats=new Map();compiler.set(device,formats);}
    const key=c.format+':'+c.descriptor.depthStencil.format+':'+(c.descriptor.multisample?.count??1);
    let shared=formats.get(key);
    if(!shared){
      const module=device.createShaderModule({code:shader});
      shared=device.createRenderPipeline({
        layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:40,attributes:[
          {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
          {shaderLocation:2,offset:24,format:'float32x4'},
        ]}]},
        fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},
        depthStencil:{...c.descriptor.depthStencil},multisample:c.descriptor.multisample,
      });
      formats.set(key,shared);
    }
    return shared;
  }
  function draw(c){
    const shared=compile(c);
    if(shared!==pipeline){
      pipeline=shared;
      materialGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:uniform}},
      ]});
    }

    params.set(c.camera.matrix);
    params.set(c.camera.position,16);
    params[20]=clock();
    params[21]=Number(cold);
    device.queue.writeBuffer(uniform,0,params);
    const color={view:c.color,loadOp:'load',storeOp:'store'};
    const depth={view:c.depth,depthLoadOp:'load',depthStoreOp:'store'};
    c.attach?.(color,depth,c.last);
    const pass=c.encoder.beginRenderPass({colorAttachments:[color],depthStencilAttachment:depth});
    pass.setPipeline(pipeline);
    pass.setBindGroup(0,materialGroup);
    pass.setVertexBuffer(0,positions);
    pass.setIndexBuffer(elements,'uint32');
    pass.drawIndexed(world.indices.length);
    pass.end();
  }
  return {
    name:'signal-world',setup,
    onDeviceRestored(engine){release();setup(engine);},dispose:release,
    registerPasses(graph){graph.add({name:'draw-signal-world',order:1,joins:true,execute:draw});},
  };
}
