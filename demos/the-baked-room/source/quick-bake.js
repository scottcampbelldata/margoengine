import {buildBVH} from '@margoengine/bvh';
import {width,height,sunlight,skylight,albedo,options} from './room.js';

const texelCount=width*height;
const clamp=(v,lo,hi)=>Math.min(hi,Math.max(lo,v));

function texelSamples(mesh,rectangles){
  const {uv1,indices,positions,normals}=mesh;
  const samples=new Float32Array(texelCount*8),triangle=new Int32Array(texelCount).fill(-1);
  for(let i=0;i<indices.length;i+=3){
    const a=indices[i],b=indices[i+1],c=indices[i+2];
    const u=[a,b,c].map(j=>uv1[j*2]*width),v=[a,b,c].map(j=>uv1[j*2+1]*height);
    const x1=u[1]-u[0],x2=u[2]-u[0],y1=v[1]-v[0],y2=v[2]-v[0],area=x1*y2-x2*y1;
    if(Math.abs(area)<1e-9)continue;
    const yMin=Math.max(0,Math.floor(Math.min(...v))),yMax=Math.min(height-1,Math.floor(Math.max(...v)));
    const xMin=Math.max(0,Math.floor(Math.min(...u))),xMax=Math.min(width-1,Math.floor(Math.max(...u)));
    for(let y=yMin;y<=yMax;y++)for(let x=xMin;x<=xMax;x++){
      const dx=x+.5-u[0],dy=y+.5-v[0];
      const wb=(dx*y2-dy*x2)/area,wc=(dy*x1-dx*y1)/area,wa=1-wb-wc;
      if(Math.min(wa,wb,wc)<-1e-6)continue;
      const p=y*width+x,k=p*8;
      for(let axis=0;axis<3;axis++){
        samples[k+axis]=positions[a*3+axis]*wa+positions[b*3+axis]*wb+positions[c*3+axis]*wc;
        samples[k+axis+4]=normals[a*3+axis]*wa+normals[b*3+axis]*wb+normals[c*3+axis]*wc;
      }
      samples[k+3]=1;
      triangle[p]=i/3;
    }
  }
  for(const {x,y,w,h} of rectangles){
    for(let row=y-2;row<y+h+2;row++)for(let col=x-2;col<x+w+2;col++){
      const to=(row*width+col)*8;
      if(samples[to+3])continue;
      const from=(clamp(row,y,y+h-1)*width+clamp(col,x,x+w-1))*8;
      samples.copyWithin(to,from,from+8);
    }
  }
  return {samples,triangle};
}

export function prepareQuick(room){
  const {positions,indices}=room.mesh;
  const source=buildBVH(positions,3,indices);
  const words=new Uint32Array(source.nodes),bounds=new Float32Array(source.nodes);
  const nodes=new ArrayBuffer(words.length*4),u32=new Uint32Array(nodes),f32=new Float32Array(nodes);
  const count=words.length/8;
  function thread(node,escape){
    const i=node*8,internal=(words[i+7]&0x80000000)!==0;
    f32.set(bounds.subarray(i,i+3),i);
    u32[i+3]=escape;
    f32.set(bounds.subarray(i+3,i+6),i+4);
    if(internal){
      const right=words[i+6];
      thread(node+1,right);
      thread(right,escape);
    }else{
      const first=words[i+6],size=words[i+7];
      if(size>255||first>0x00ffffff)throw new RangeError('The compact lightmap BVH leaf is too large.');
      u32[i+7]=(first<<8)|size;
    }
  }
  thread(0,count);
  const faces=new Float32Array(source.triangles.length*12);
  for(let i=0;i<source.triangles.length;i++){
    const out=i*12,a=source.index[i*3]*3,b=source.index[i*3+1]*3,c=source.index[i*3+2]*3;
    for(let d=0;d<3;d++){
      const p=positions[a+d];
      faces[out+d]=p;
      faces[out+4+d]=positions[b+d]-p;
      faces[out+8+d]=positions[c+d]-p;
    }
  }
  return {nodes,faces,...texelSamples(room.mesh,room.rectangles)};
}

const source=/* wgsl */`
struct Frame {
  light:vec4f, sun:vec4f, ambient:vec4f, albedo:vec4f,
  grid:vec4u,
}
struct Point { position:vec4f, normal:vec4f }
struct Node { low:vec3f, escape:u32, high:vec3f, leaf:u32 }
struct Face { origin:vec4f, e1:vec4f, e2:vec4f }
struct Hit { distance:f32, face:u32 }
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var<storage,read> points:array<Point>;
@group(0) @binding(2) var<storage,read> nodes:array<Node>;
@group(0) @binding(3) var<storage,read> faces:array<Face>;
@group(0) @binding(4) var previous:texture_2d<f32>;

@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  return vec4f(2.0*f32((i<<1u)&2u)-1.0,1.0-2.0*f32(i&2u),0,1);
}

fn intersection(f:Face,p:vec3f,d:vec3f,limit:f32)->f32{
  let u=cross(d,f.e2.xyz);
  let det=dot(f.e1.xyz,u);
  if(abs(det)<1e-8){return limit;}
  let offset=p-f.origin.xyz;
  let v=cross(offset,f.e1.xyz);
  let uv=vec2f(dot(offset,u),dot(d,v))/det;
  if(min(uv.x,uv.y)<0.0||uv.x+uv.y>1.0){return limit;}
  let t=dot(f.e2.xyz,v)/det;
  return select(limit,t,t>0.0&&t<limit);
}

fn trace(p:vec3f,d:vec3f,stopAtFirst:bool)->Hit{
  let parallel=abs(d)<vec3f(1e-8);
  let inverse=1.0/select(d,vec3f(1),parallel);
  var hit=Hit(28.0,0xffffffffu);
  var i=0u;
  loop{
    if(i>=frame.grid.z){break;}
    let box=nodes[i];
    let a=(box.low-p)*inverse;
    let b=(box.high-p)*inverse;
    let enter=select(min(a,b),vec3f(-1e8),parallel);
    let exit=select(max(a,b),vec3f(1e8),parallel);
    let outside=any(select(vec3<bool>(false),p<box.low,parallel))
      ||any(select(vec3<bool>(false),p>box.high,parallel));
    if(outside||max(max(enter.x,max(enter.y,enter.z)),0.0)>min(min(exit.x,min(exit.y,exit.z)),hit.distance)){
      i=box.escape;
      continue;
    }
    if(box.leaf==0u){i+=1u;continue;}
    let start=box.leaf>>8u;
    let end=start+(box.leaf&255u);
    for(var k=start;k<end;k+=1u){
      let t=intersection(faces[k],p,d,hit.distance);
      if(t<hit.distance){
        hit=Hit(t,k);
        if(stopAtFirst){return hit;}
      }
    }
    i=box.escape;
  }
  return hit;
}

fn random(key:u32)->f32{
  var h=key*747796405u+2891336453u;
  h=((h>>((h>>28u)+4u))^h)*277803737u;
  return f32(((h>>22u)^h)>>8u)/16777216.0;
}

fn hemisphere(n:vec3f,key:u32)->vec3f{
  let u=random(key);
  let angle=random(key+1u)*6.2831853;
  let axis=select(vec3f(0,1,0),vec3f(1,0,0),abs(n.y)>0.91);
  let a=normalize(cross(n,axis));
  let b=cross(n,a);
  return n*sqrt(1.0-u)+sqrt(u)*(a*cos(angle)+b*sin(angle));
}

@fragment fn fragment(@builtin(position) pixel:vec4f)->@location(0) vec4f{
  let xy=vec2u(pixel.xy);
  let index=xy.y*frame.grid.x+xy.x;
  let sample=points[index];
  if(sample.position.w<0.5){return vec4f(0);}
  var origin=sample.position.xyz;
  var n=normalize(sample.normal.xyz);
  var gain=vec3f(1.0);
  var light=frame.ambient.xyz;
  let key=(index+1u)*50331653u+(frame.grid.w+1u)*131071u;
  // Direct light, bounce, bounce direct light, bounce, then its direct light.
  for(var state=0u;state<5u;state+=1u){
    let bounce=(state&1u)==1u;
    let cosine=dot(n,frame.light.xyz);
    if(!bounce&&cosine<=0.0){continue;}
    let d=select(frame.light.xyz,hemisphere(n,key+state*7u),bounce);
    let rayOrigin=origin+n*frame.light.w;
    let hit=trace(rayOrigin,d,!bounce);
    let found=hit.face!=0xffffffffu;
    if(bounce){
      if(!found){break;}
      let face=faces[hit.face];
      let faceNormal=normalize(cross(face.e1.xyz,face.e2.xyz));
      n=select(-faceNormal,faceNormal,dot(faceNormal,d)<0.0);
      origin=rayOrigin+hit.distance*d;
      gain*=frame.albedo.xyz;
      light+=gain*frame.ambient.xyz;
    }else if(!found){
      light+=gain*frame.sun.xyz*cosine;
    }
  }
  let done=f32(frame.grid.w);
  let prior=textureLoad(previous,vec2i(xy),0).rgb;
  return vec4f((light+prior*done)/(done+1.0),1);
}
`;

export function readyQuick(device,model){
  const buffers=[];
  const values=new ArrayBuffer(80),f=new Float32Array(values),u=new Uint32Array(values);
  const size=width*height;
  const formats={size:[width,height],format:'rgba16float',
    usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC};
  const textures=[device.createTexture(formats),device.createTexture(formats)];
  const views=textures.map(texture=>texture.createView());
  const uniform=device.createBuffer({size:values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
  for(const typed of [model.samples,model.nodes,model.faces]){
    const buffer=device.createBuffer({size:typed.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(buffer,0,typed);
    buffers.push(buffer);
  }
  const length=Math.hypot(...sunlight.direction);
  f.set(sunlight.direction.map(v=>v/length),0);
  f[3]=options.bias;
  f.set(sunlight.color.map(v=>v*sunlight.intensity),4);
  f.set(skylight.color.map(v=>v*skylight.intensity),8);
  f.set(albedo,12);
  u.set([width,height,model.nodes.byteLength/32],16);
  let steps=0,groups;
  const module=device.createShaderModule({code:source});
  const pipeline=device.createRenderPipelineAsync({
    layout:'auto',vertex:{module,entryPoint:'vertex'},
    fragment:{module,entryPoint:'fragment',targets:[{format:'rgba16float'}]},
  }).then(program=>{
    groups=views.map(view=>device.createBindGroup({layout:program.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:uniform}},...buffers.map((buffer,i)=>({binding:i+1,resource:{buffer}})),
      {binding:4,resource:view},
    ]}));
    // A real zero initial sum keeps the first running-mean draw independent of texture init behavior.
    const encoder=device.createCommandEncoder();
    for(const view of views){
      encoder.beginRenderPass({colorAttachments:[{view,loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]}).end();
    }
    device.queue.submit([encoder.finish()]);
    return program;
  });
  return {
    ready:pipeline,
    get passes(){return steps;},
    reset(){steps=0;},
    get texture(){return textures[steps%2];},
    async step(count=1){
      const program=await pipeline;
      for(let n=0;n<count;n++){
        const passIndex=steps+n;
        u[19]=passIndex;
        device.queue.writeBuffer(uniform,0,values);
        const encoder=device.createCommandEncoder();
        const pass=encoder.beginRenderPass({colorAttachments:[{
          view:views[(passIndex+1)%2],loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0],
        }]});
        pass.setPipeline(program);
        pass.setBindGroup(0,groups[passIndex%2]);
        pass.draw(3);
        pass.end();
        device.queue.submit([encoder.finish()]);
      }
      await device.queue.onSubmittedWorkDone();
      steps+=count;
    },
    async read(){
      if(!steps)throw new Error('Start a live pass before reading this atlas.');
      const driver=256*Math.ceil(width*8/256);
      const buffer=device.createBuffer({size:driver*height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try{
        const encoder=device.createCommandEncoder();
        encoder.copyTextureToBuffer({texture:textures[steps%2]}, {buffer,bytesPerRow:driver},[width,height]);
        device.queue.submit([encoder.finish()]);
        await buffer.mapAsync(GPUMapMode.READ);
        const bits=new Uint16Array(buffer.getMappedRange()),light=new Float32Array(size*3),used=new Uint8Array(size);
        for(let row=0;row<height;row++)for(let col=0;col<width;col++){
          const at=row*driver/2+col*4,index=row*width+col;
          used[index]=bits[at+3]?255:0;
          for(let ch=0;ch<3;ch++){
            const half=bits[at+ch],exponent=(half>>10)&31,mantissa=half&1023;
            light[index*3+ch]=exponent?2**(exponent-15)*(1+mantissa/1024):mantissa*2**-24;
          }
        }
        return packet(light,model.triangle,used,steps);
      }finally{buffer.destroy();}
    },
    dispose(){
      uniform.destroy();
      for(const buffer of buffers)buffer.destroy();
      for(const texture of textures)texture.destroy();
    },
  };
}

function packet(irradiance,triangle,used,passes){
  let lightmapScale=1;
  for(const value of irradiance)lightmapScale=Math.max(lightmapScale,value);
  const lightmap=new Uint8Array(texelCount*4);
  for(let i=0;i<texelCount;i++){
    for(let channel=0;channel<3;channel++){
      lightmap[i*4+channel]=Math.round(irradiance[i*3+channel]/lightmapScale*255);
    }
    lightmap[i*4+3]=used[i];
  }
  return {width,height,irradiance,triangle,lightmap,lightmapScale,passes,radiometry:'physical'};
}
