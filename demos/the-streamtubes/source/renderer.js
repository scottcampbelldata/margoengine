import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {flowStart,flowEnd,paths,tube,speedRange} from './field.js';

function wingGeometry(){
  const positions=[],normals=[],indices=[];
  const rings=44,span=34;
  function profile(i,j){
    const z=3.05*j/span-1.525, taper=Math.abs(z)/1.525, theta=2*Math.PI*i/rings;
    const u=.5-.5*Math.cos(theta), chord=1.48-.49*taper*taper;
    const h=.67*chord*(.2969*Math.sqrt(u)-.1260*u-.3516*u*u+.2843*u**3-.1036*u**4);
    const lead=-3.96+.35*taper*taper+.09*taper;
    return [lead+chord*u,.58+.09*taper*taper+Math.sign(Math.sin(theta))*h,z];
  }
  const n0=(a,b)=>a.map((v,i)=>v-b[i]);
  for(let j=0;j<=span;j++)for(let i=0;i<rings;i++){
    const p=profile(i,j),a=n0(profile((i+1)%rings,j),profile((i+rings-1)%rings,j)),
      b=n0(profile(i,Math.min(span,j+1)),profile(i,Math.max(0,j-1)));
    const n=[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const d=Math.hypot(...n);
    positions.push(...p);
    normals.push(-n[0]/d,-n[1]/d,-n[2]/d);
    if(j){
      const next=(i+1)%rings,k=j*rings;
      indices.push(k-rings+i,k+next,k-rings+next,k-rings+i,k+i,k+next);
    }
  }
  for(let side of [0,span]){
    const loops=Array.from({length:rings},(_,i)=>profile(i,side));
    const center=loops.reduce((acc,p)=>acc.map((n,i)=>n+p[i]/rings),[0,0,0]), index=positions.length/3;
    const normal=[0,0,side===0?-1:1];
    positions.push(...center);normals.push(...normal);
    loops.forEach(p=>{positions.push(...p);normals.push(...normal);});
    for(let i=0;i<rings;i++){
      const here=index+1+i,next=index+1+(i+1)%rings;
      indices.push(...(side===0?[index,here,next]:[index,next,here]));
    }
  }
  return new Geometry(positions,normals,indices);
}
const material=(color,roughness,metalness)=>new PbrMaterial({color,roughness,metalness});
export function installBench(engine){
  const metal=material('#70888d',.32,.31),dark=material('#3a4a53',.54,.15);
  const deck=material('#384852',.88,.08),tape=material('#9bb5b6',.56,.12),prem=material('#be9969',.50,.28);
  const place=(geometry,mat,where)=>engine.createMesh().setGeometry(geometry).setMaterial(mat).setPosition(where);
  place(box(175,.12,175),deck,[0,-.97,0]);
  place(box(10.18,.36,5.28),dark,[.23,-.76,0]);
  place(box(10.02,.027,5.09),metal,[.23,-.566,0]);
  place(box(9.88,.032,4.96),dark,[.23,-.547,0]);
  place(wingGeometry(),metal,[0,0,0]);
  for(const side of [-1,1]){
    place(box(.15,1.1,.20),metal,[-3.33,.01,side*.46]);
    place(box(.75,.065,.65),dark,[-3.36,-.495,side*.46]);
    place(box(.50,.047,.43),metal,[-3.36,-.459,side*.46]);
    for(const x of [-3.62,-3.13])for(const z of [-.19,.19])place(box(.053,.025,.065),prem,[x,-.435,side*.46+z]);
    for(let station=0;station<16;station++){
      const x=-4.20+station*.55;
      place(box(station%2===0?.052:.027,.015,station%2===0?.17:.105),tape,[x,-.521,side*2.19]);
    }
  }
  for(let i=0;i<4;i++)place(box(.024,.009,3.84),tape,[flowStart+(flowEnd-flowStart)*i/3,-.521,0]);
}
function data(thickness,solo){
  const vertices=[],indices=[];
  for(const path of paths){
    if(solo&&path.side!==solo)continue;
    const mesh=tube(path,thickness),start=vertices.length/8;
    for(let i=0;i<mesh.values.length;i++){
      const k=i*3;
      vertices.push(mesh.positions[k],mesh.positions[k+1],mesh.positions[k+2],
        mesh.normals[k],mesh.normals[k+1],mesh.normals[k+2],mesh.values[i],path.side);
    }
    for(const value of mesh.indices)indices.push(start+value);
  }
  return {vertices:Float32Array.from(vertices),indices:Uint32Array.from(indices)};
}
const wgsl=`
struct Frame { matrix:mat4x4f, eye:vec4f, options:vec4f };
@group(0) @binding(0) var<uniform> frame:Frame;
struct Vertex { @builtin(position) loc:vec4f,@location(0) p:vec3f,@location(1) n:vec3f,@location(2) tag:vec2f };
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) tag:vec2f)->Vertex {
  return Vertex(frame.matrix*vec4f(p,1.),p,n,tag);
}
@fragment fn fragment(in:Vertex)->@location(0) vec4f {
  let n=normalize(in.n);
  let direction=normalize(frame.eye.xyz-in.p);
  let key=normalize(vec3f(-.52,.64,.57));
  let edge=normalize(vec3f(.44,.45,-.66));
  let intensity=clamp((in.tag.x-frame.options.x)/(frame.options.y-frame.options.x),0.,1.);
  let cool=mix(vec3f(.13,.42,.64),vec3f(.36,.89,.84),intensity);
  let warm=mix(vec3f(.65,.22,.23),vec3f(1.,.66,.30),intensity);
  let color=select(cool,warm,in.tag.y>0.);
  let shining=pow(max(0.,dot(n,normalize(key+direction))),35.);
  let grazing=pow(1.-max(0.,dot(n,direction)),3.);
  let l=.41+.57*max(0.,dot(key,n))+.25*max(0.,dot(edge,n));
  return vec4f(min(vec3f(1.),color*l+shining*vec3f(.40,.42,.41)+grazing*color*.20),1.);
}
`;
export function installTubeRenderer(engine){
  let mesh,graphics,changed=false;
  const values=new Float32Array(24);
  function release(){if(graphics)for(const b of [graphics.frame,graphics.vertex,graphics.index])b?.destroy();}
  const remove=engine.scene.frameGraph.add({name:'illuminated stream tubes',order:4,joins:true,execute(context){
    if(context.backend!=='webgpu'||!mesh)return;
    const {device,format,descriptor}=context;
    if(graphics?.device!==device){
      release();
      const module=device.createShaderModule({code:wgsl,label:'illuminated stream tubes'});
      const pipeline=device.createRenderPipeline({
        layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:32,attributes:[
          {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'},
        ]}]},
        fragment:{module,entryPoint:'fragment',targets:[{format}]},multisample:descriptor.multisample,
        depthStencil:{format:descriptor.depthStencil.format,depthCompare:'greater-equal',depthWriteEnabled:true},
      });
      const frame=device.createBuffer({size:values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}}]});
      graphics={device,pipeline,frame,group,capacity:0};
      changed=true;
    }
    if(changed){
      if(graphics.capacity<mesh.vertices.byteLength){
        const old=[graphics.vertex,graphics.index].filter(Boolean);
        if(old.length)device.queue.onSubmittedWorkDone().then(()=>old.forEach(b=>b.destroy()),()=>old.forEach(b=>b.destroy()));
        graphics.vertex=device.createBuffer({size:mesh.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
        graphics.index=device.createBuffer({size:mesh.indices.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});
        graphics.capacity=mesh.vertices.byteLength;
      }
      device.queue.writeBuffer(graphics.vertex,0,mesh.vertices);
      device.queue.writeBuffer(graphics.index,0,mesh.indices);
      changed=false;
    }
    values.set(context.camera.matrix);values.set(context.camera.position,16);values.set(speedRange,20);
    device.queue.writeBuffer(graphics.frame,0,values);
    const color={view:context.color,loadOp:'load',storeOp:'store'};
    const depth={view:context.depth,depthLoadOp:'load',depthStoreOp:'store',
      ...(descriptor.depthStencil.format.includes('stencil')?{stencilLoadOp:'load',stencilStoreOp:'store'}:{})};
    context.attach?.(color,depth,true);
    const pass=context.encoder.beginRenderPass({colorAttachments:[color],depthStencilAttachment:depth});
    pass.setPipeline(graphics.pipeline);pass.setBindGroup(0,graphics.group);
    pass.setVertexBuffer(0,graphics.vertex);pass.setIndexBuffer(graphics.index,'uint32');
    pass.drawIndexed(mesh.indices.length);pass.end();
  }});
  return {show(thickness,group){mesh=data(thickness,group);changed=true;
    return {faces:mesh.indices.length/3,vertices:mesh.vertices.length/8};},
    dispose(){remove();release();}};
}
