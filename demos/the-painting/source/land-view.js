const landscape=/* wgsl */`
struct Camera {
  matrix: mat4x4f,
  time: vec4f,
}
@group(0) @binding(0) var<uniform> camera:Camera;

struct Field {
  @builtin(position) clip:vec4f,
  @location(0) p:vec3f,
  @location(1) n:vec3f,
  @location(2) tint:vec3f,
  @location(3) @interpolate(flat) tag:u32,
}

fn strand(z:f32)->f32 {
  let a=(z-12.0)/15.0;
  let b=(z+25.0)/18.0;
  let c=(z+62.0)/23.0;
  let d=(z+100.0)/29.0;
  let e=(z+147.0)/34.0;
  return -7.0+12.0*exp(-a*a)-13.0*exp(-b*b)+23.0*exp(-c*c)-19.0*exp(-d*d)+17.0*exp(-e*e)
    +1.9*sin(z*0.118)+0.58*sin(z*0.407);
}

@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) colour:vec4f,
  @location(3) flex:f32)->Field {
  var point=p;
  let t=camera.time.x;
  let tag=u32(colour.w);
  if(tag==1u){
    let swell=sin(p.x*0.188+p.z*0.092-t*0.85)+0.42*sin(p.z*0.38-p.x*0.07+t*1.06);
    point.y+=swell*0.14;
  }
  if(flex>0.0){
    let sw=sin(t*1.42+p.z*0.23+p.x*0.13)+0.34*sin(t*3.17+p.x*0.48);
    point.x-=sw*flex*0.53;
    point.z+=0.25*sw*flex;
  }
  return Field(camera.matrix*vec4f(point,1),point,n,colour.xyz,tag);
}

fn hash(p:vec2f)->f32 {
  let a=fract(vec3f(p.x,p.y,p.x)*vec3f(0.1031,0.1030,0.0973));
  let b=a+dot(a,a.yzx+33.33);
  return fract((b.x+b.y)*b.z);
}
fn noise(p:vec2f)->f32 {
  let i=floor(p);
  let f=fract(p);
  let m=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2f(1,0)),m.x),mix(hash(i+vec2f(0,1)),hash(i+vec2f(1,1)),m.x),m.y);
}
fn pigment(p:vec2f)->f32 {
  return noise(p)*0.58+noise(p*2.03+3.12)*0.27+noise(p*4.17-4.51)*0.15;
}


fn brush(p:vec2f)->f32 {
  let jitter=noise(p*0.27)*0.76;
  let q=p+vec2f(jitter,jitter*0.4);
  let id=floor(q);
  let b=hash(id);
  let local=(fract(q)-vec2f(0.52,0.46))*vec2f(2.1,2.65);
  let mark=1.0-smoothstep(0.46,1.05,dot(local,local)+noise(p*vec2f(11.0,44.0))*0.25);
  return (b-0.49)*mark;
}
fn sky(position:vec3f,t:f32)->vec3f {
  let x=position.x/805.0;
  let y=max(0.0,position.y/805.0);
  let light=exp(-2.9*length((vec2f(x,y)-vec2f(0.25,0.092))*vec2f(0.92,1.77)));
  let gradient=pow(clamp(y*1.95,0.0,1.0),0.61);
  var base=mix(vec3f(0.803,0.667,0.602),vec3f(0.425,0.539,0.631),gradient);
  base=mix(base,vec3f(0.991,0.788,0.556),light*0.66);
  let p=vec2f(x*5.9-t*0.016,(y+x*0.041)*24.8);
  let streak=pigment(p+vec2f(2.4,1.3));
  let wisps=pigment(p*1.71+vec2f(6.0,-2.7));
  let mask=smoothstep(0.49,0.70,streak*0.82+wisps*0.18)*smoothstep(0.012,0.063,y)
    *(1.0-smoothstep(0.48,0.7,y));
  let cloud=mix(vec3f(0.471,0.473,0.590),vec3f(0.996,0.720,0.570),
    smoothstep(0.11,0.83,light*0.73+streak*0.62));
  base=mix(base,cloud,mask*0.91);
  base+=brush(p*vec2f(2.2,3.06)+t*0.031)*mask*vec3f(0.125,0.102,0.083);
  let sunDist=length(vec2f(x,y)-vec2f(0.249,0.091));
  let orb=1.0-smoothstep(0.0081,0.0097,sunDist);
  return mix(base,vec3f(1.0,0.880,0.679),orb*(1.0-mask*0.55));
}

fn water(p:vec3f,t:f32)->vec3f {
  let d=length(p.xz-vec2f(12.1,23.8));
  let coast=clamp(p.x-strand(p.z),0.0,900.0);
  let ripple=sin(p.z*1.32+p.x*0.095+t*1.38+noise(vec2f(p.x*0.17,p.z*0.243))*4.4);
  let swell=sin(p.z*0.56+p.x*0.11+t*0.90)+sin(p.x*0.23-p.z*0.46-t*0.64)*0.34;
  let streak=noise(vec2f(p.x*0.18+p.z*0.033,p.z*0.44+t*0.32));
  let reach=exp(-coast*0.058);
  let hue=mix(vec3f(0.266,0.402,0.479),vec3f(0.399,0.504,0.486),reach*0.84);
  var color=hue+(ripple*0.013+swell*0.014+(streak-0.5)*0.132)*vec3f(0.69,0.98,1.0);
  let direction=(p.x-12.1)/max(1.0,23.8-p.z);
  let spread=0.095+0.065*exp(-d*0.018);
  let glow=exp(-abs(direction-0.29)/spread)*smoothstep(22.0,94.0,d);
  let glitter=smoothstep(0.41,0.93,streak*0.8+ripple*0.21+swell*0.045);
  color=mix(color,vec3f(0.970,0.742,0.489),glow*(0.13+glitter*0.69));
  let shoreFlow=0.65*sin(p.z*0.079)+0.36*sin(p.z*0.38);
  let limit=1.0-smoothstep(3.0,10.5,coast);
  let edge=1.0-smoothstep(0.12,2.9,coast);
  let wrap=sin(coast*1.17+shoreFlow-t*1.32+(1.0-streak)*0.62);
  let surf=smoothstep(0.61,0.99,wrap)*(0.38+streak*0.63)*limit*0.87+edge*streak*0.34;

  color=mix(color,vec3f(0.823,0.805,0.692),clamp(surf,0.0,0.87));
  return mix(color,vec3f(0.692,0.620,0.614),1.0-exp(-d*0.00225));
}

@fragment fn fragment(input:Field)->@location(0) vec4f {
  let t=camera.time.x;
  let p=input.p;
  if(input.tag==0u){return vec4f(sky(p,t),1);}
  if(input.tag==1u){return vec4f(water(p,t),1);}
  let n=normalize(input.n);
  let key=normalize(vec3f(0.71,0.43,-0.57));
  let diffuse=max(0.0,dot(n,key));
  let shadows=vec3f(0.736,0.768,0.895);
  let sunlight=vec3f(1.32,1.17,0.90);
  var color=input.tint*mix(shadows,sunlight,diffuse);
  let texture=0.66*pigment(p.xz*vec2f(0.92,1.84)+p.y*0.73)
    +0.34*noise(vec2f(p.z*2.56,p.y*2.08+p.x*0.93));
  
  color+= (texture-0.47)*vec3f(0.198,0.155,0.106);
  if(input.tag==2u){
    let motion=vec2f(p.x*1.57+p.z*0.29,p.z*3.33+p.x*0.42);
    let marks=brush(motion)*0.75+brush(motion*1.77+vec2f(0.42,0.26))*0.25;
    let under= pigment(vec2f(p.x*0.38+p.z*0.073,p.z*0.52));
    color=mix(color,vec3f(0.66,0.40,0.29),smoothstep(0.49,0.85,under)*0.33);
    color+=marks*vec3f(0.202,0.186,0.092);
  }
  if(input.tag==3u){
    let layering=sin(p.y*4.76+p.z*0.053+0.45*sin(p.z*0.51));
    color*=0.96+0.093*layering;
    color=mix(color,vec3f(0.342,0.396,0.357),0.18*(1.0-smoothstep(0.0,1.4,p.y)));
  }
  if(input.tag==5u||input.tag==6u){
    let back=max(0.0,dot(-n,key));
    color+=back*vec3f(0.057,0.049,0.014);
  }
  let r=length(p.xz-vec2f(12.1,23.8));
  let aerial=1.0-exp(-r*0.00258);
  let haze=vec3f(0.588,0.580,0.648);
  color=mix(color,haze,aerial*0.89);
  return vec4f(clamp(color,vec3f(0.0),vec3f(1.0)),1);
}
`;

export function animateLand(land,clock){
  let device,vertices,indices,uniform,group,pipeline,outputFormat;
  const frame=new Float32Array(20);
  function release(){
    vertices?.destroy();indices?.destroy();uniform?.destroy();
    vertices=indices=uniform=group=pipeline=outputFormat=undefined;
  }

  function setup(engine){
    device=engine.gpu;
    vertices=device.createBuffer({size:land.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
    indices=device.createBuffer({size:land.indices.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});
    uniform=device.createBuffer({size:frame.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(vertices,0,land.vertices);
    device.queue.writeBuffer(indices,0,land.indices);
  }

  return {
    name:'painted-headland',
    setup,
    onDeviceRestored(engine){release();setup(engine);},
    dispose:release,
    registerPasses(graph){
      graph.add({
        name:'draw-headland',order:1,joins:true,
        execute(context){
          if(!pipeline||outputFormat!==context.format){
            const module=device.createShaderModule({code:landscape});
            outputFormat=context.format;
            pipeline=device.createRenderPipeline({
              layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{
                arrayStride:44,attributes:[{shaderLocation:0,format:'float32x3',offset:0},
                  {shaderLocation:1,format:'float32x3',offset:12},{shaderLocation:2,format:'float32x4',offset:24},
                  {shaderLocation:3,format:'float32',offset:40}],
              }]},
              fragment:{module,entryPoint:'fragment',targets:[{format:outputFormat}]},
              depthStencil:{...context.descriptor.depthStencil},
            });
            group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
              {binding:0,resource:{buffer:uniform}},
            ]});
          }
          frame.set(context.camera.matrix);
          frame[16]=clock();
          device.queue.writeBuffer(uniform,0,frame);
          const color={view:context.color,loadOp:'load',storeOp:'store'};
          const depth={view:context.depth,depthLoadOp:'load',depthStoreOp:'store'};
          context.attach?.(color,depth,context.last);
          const pass=context.encoder.beginRenderPass({colorAttachments:[color],depthStencilAttachment:depth});
          pass.setPipeline(pipeline);
          pass.setBindGroup(0,group);
          pass.setVertexBuffer(0,vertices);
          pass.setIndexBuffer(indices,'uint32');
          pass.drawIndexed(land.indices.length);
          pass.end();
        },
      });
    },
  };
}
