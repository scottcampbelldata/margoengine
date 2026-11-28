import {cave,caveBoundary,elevation} from './ground-data.js';

const tau=2*Math.PI;
const normal=v=>{const m=Math.hypot(...v);return v.map(x=>x/m);};
const sub=(a,b)=>a.map((x,i)=>x-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
function art(){
  const values=[],indices=[];
  function face(points,color,tag,n){
    const index=values.length/10,dir=n??normal(cross(sub(points[1],points[0]),sub(points[2],points[0])));
    for(let j=0;j<points.length;j++){
      values.push(...points[j],...dir,...color,tag);
      if(j>1)indices.push(index,index+j-1,index+j);
    }
  }
  return {face,indexCount:()=>indices.length,build:()=>({vertices:Float32Array.from(values),indices:Uint32Array.from(indices)})};
}
function prism(model,cx,cz,base,height,rx,rz,sides,tint,tag,phase=0){
  const p=(i,top)=>{
    const a=i*tau/sides+phase,k=top?.84:1;
    return [cx+Math.cos(a)*rx*k+(top?.31*rx:0),base+(top?height*(.94+.072*Math.sin(a*2.19)):0),
      cz+Math.sin(a)*rz*k+(top?-.13*rz:0)];
  };
  for(let i=0;i<sides;i++){
    const c=tint.map(v=>v*(.89+.17*Math.sin(i*2.27+phase)));
    model.face([p(i+1,false),p(i,false),p(i,true),p(i+1,true)],c,tag);
    model.face([p(i+1,true),p(i,true),[cx+rx*.31,base+height*.97,cz-rz*.13]],tint,tag);
  }
}
function cone(model,center,profile,tint,tag,segments=26){
  const point=(r,h,a)=>[center[0]+r*Math.cos(a),center[1]+h,center[2]+r*Math.sin(a)];
  for(let j=1;j<profile.length;j++){
    const [r0,y0]=profile[j-1],[r1,y1]=profile[j];
    for(let i=0;i<segments;i++){
      const a=i*tau/segments,b=(i+1)*tau/segments;
      const p=[point(r0,y0,b),point(r0,y0,a),point(r1,y1,a),point(r1,y1,b)];
      if(r0===0)p.splice(0,1);
      if(r1===0)p.splice(2,1);
      model.face(p,tint,tag);
    }
  }
}
function chamber(model){
  const outline=caveBoundary(),count=outline.length,top=elevation(cave.x,cave.z);
  const levels=[
    [1.20,-.42,0],[1.08,-.64,0],[1.005,-.84,0],[.94,2.1,1],[.89,6.7,1],
    [.82,12.1,1],[.77,16.2,1],[.72,22.5,2],[.77,27.3,3],[.72,32.2,3],
  ];
  const tones=[[.342,.304,.269],[.299,.245,.216],[.155,.139,.189],[.080,.103,.147]];
  function at(i,j){
    const [ratio,depth]=levels[j],[x,z]=outline[i%count],ang=i*tau/count;
    const lean=Math.max(0,j-2)/(levels.length-3);
    const X=cave.x+(x-cave.x)*ratio+4*lean,Z=cave.z+(z-cave.z)*ratio-5.2*lean;
    const edgeHeight=elevation(X,Z);
    const y=top+(edgeHeight-top)*(1-lean)-depth+.48*lean*Math.sin(ang*6+j*.68);
    return [X,y,Z];
  }

  for(let i=0;i<count;i++){
    for(let j=0;j<levels.length-1;j++){
      const tone=tones[levels[j][2]].map(v=>v*(.80+.23*Math.sin(i*.84+j*.79)));
      const a=at(i,j),b=at(i+1,j),c=at(i+1,j+1),d=at(i,j+1);
      model.face([a,b,c],tone,2);
      model.face([a,c,d],tone.map(v=>v*(.95+.14*Math.sin(i*1.7))),2);
    }
  }
  const lowest=levels.length-1;
  const basin=[cave.x+6,top-33,cave.z-6.2];
  for(let i=0;i<count;i++){
    model.face([at(i+1,lowest),at(i,lowest),basin],[.048,.119,.128],3);
  }
  // Lanterns along the inner survey ledge remain inside the shaft until the cut is opened.
  for(const [i,layer] of [[3,7],[6,7],[11,5],[15,5],[18,4],[21,7],[24,7]]){
    const [x,y,z]=at(i,layer);
    const inward=normal([cave.x+4-x,0,cave.z-3-z]);
    const lamp=[x+inward[0]*2.1,y+.15,z+inward[2]*2.1];
    cone(model,lamp,[[0,-1.8],[.56,-1.8],[.69,-1.69],[.50,0],[.49,.32],[0,.34]],[.129,.131,.157],1,12);
    cone(model,lamp,[[0,.33],[.47,.33],[.68,.46],[.64,.82],[.44,.99],[0,.99]],
      i%2?[.903,.608,.251]:[.490,.779,.746],4,14);
  }
}
export function prepareArt(){
  const model=art();
  model.face([[-8800,-1500,-1770],[8800,-1500,-1770],[8800,4000,-1770],[-8800,4000,-1770]],
    [.504,.547,.596],0);
  const caveStart=model.indexCount();
  chamber(model);
  const caveEnd=model.indexCount();
  const rock=[.253,.271,.291];
  const sites=[[-66,-108,6,8.2,6.4],[-75,-120,13.2,7.6,8.1],[-85,-125,11,6.2,6.0],[-60,-112,8,4.3,5.6],
    [-116,-151,10,4.6,5],[61,-143,8.4,7,6.9],[74,-150,14.1,7.9,7.1],[76,-136,6.7,5.4,5.9],
    [101,-166,15,6.4,7.7],[98,-155,6.1,5.1,4.8],[31,9,2.3,2.5,2.1],[-22,8,3.1,3.4,2.5],
    [-35,6,2.7,2.8,3.0],[-52,-76,2.4,7.2,5.8],[44,-122,4.2,6.2,4.8],[-37,-51,3.8,5.4,4.9]];
  for(const [i,[x,z,h,rx,rz]] of sites.entries()){
    const base=Math.min(elevation(x-rx,z-rz),elevation(x+rx,z-rz),elevation(x-rx,z+rz),elevation(x+rx,z+rz),elevation(x,z))-1.9;
    prism(model,x,z,base,elevation(x,z)-base+h*.75,rx,rz,6,rock,1,i*.45);
  }
  // Brushed brass transits sit just outside the cut and mark the authored survey aperture.
  const outline=caveBoundary();
  for(const i of [1,7,14,22]){
    const [cx,cz]=outline[i],x=cave.x+(cx-cave.x)*1.12,z=cave.z+(cz-cave.z)*1.12;
    const ground=elevation(x,z),at=[x,ground-.49,z];
    cone(model,at,[[0,0],[2.36,0],[2.42,.28],[2.14,.64],[0,.64]],[.224,.247,.237],1,34);
    cone(model,at,[[0,.66],[.57,.66],[.66,.84],[.39,5.13],[.36,5.78],[0,5.78]],
      [.613,.497,.255],1,17);
    cone(model,at,[[0,5.79],[.63,5.79],[.72,6.04],[.62,6.45],[.38,6.59],[0,6.59]],i%2?[.875,.639,.314]:[.415,.722,.672],4,22);
  }
  return {...model.build(),caveStart,caveEnd};
}

const code=/* wgsl */`
struct Frame{camera:mat4x4f,eye:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
struct Out{
  @builtin(position) clip:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) color:vec3f,
  @location(3) @interpolate(flat) tag:u32,
}
@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) t:vec4f)->Out{
  return Out(frame.camera*vec4f(p,1.0),p,n,t.rgb,u32(t.w));
}
fn noise(p:vec2f)->f32{
  let a=sin(dot(p,vec2f(127.1,63.7)));
  return fract(a*43458.5453);
}
fn landCloud(p:vec2f)->f32{
  let c=floor(p);let e=fract(p);let f=e*e*(3.0-2.0*e);
  return mix(mix(noise(c),noise(c+vec2f(1,0)),f.x),mix(noise(c+vec2f(0,1)),noise(c+vec2f(1,1)),f.x),f.y);
}
@fragment fn fragment(input:Out)->@location(0) vec4f{
  let p=input.world;
  if(input.tag==0u){
    let x=p.x/1700.0;
    let y=max(0.0,p.y/1700.0);
    let gradient=smoothstep(0.0,.67,y);
    let gold=exp(-3.2*length((vec2f(x,y)-vec2f(-.590,.079))*vec2f(1.0,2.35)));
    let base=mix(vec3f(.722,.691,.645),vec3f(.219,.362,.430),gradient);
    let glow=mix(base,vec3f(.953,.695,.433),gold*.65);
    let puffs=landCloud(vec2f(x*5.3,y*24.4+.57*x))*0.76+landCloud(vec2f(x*15.9,y*57.1))*0.24;
    let mask=smoothstep(.52,.77,puffs)*smoothstep(.012,.034,y);
    let cloud=mix(vec3f(.376,.454,.510),vec3f(.977,.738,.515),gold*.65+gradient*.06);
    let disk=1.0-smoothstep(.023,.025,length(vec2f(x,y)-vec2f(-.586,.081)));
    return vec4f(mix(mix(glow,cloud,mask*.75),vec3f(1,.885,.681),disk*(1.0-mask*.54)),1);
  }
  let n=normalize(input.normal);
  let tex=landCloud(vec2f(p.z*.41+p.y*.21,p.x*.46+p.y*.41));
  let glint=max(0.0,dot(n,normalize(vec3f(-.780,.48,.43))));
  let strata=.89+.11*sin(p.y*1.96+p.x*.22+tex*3.02);
  var color=input.color*(.66+glint*.46)*(strata+(tex-.5)*.22);
  if(input.tag==2u){
    color=input.color*(.51+glint*.38)*(strata+(tex-.5)*.42);
  }
  if(input.tag==3u){
    let flow=.80+.20*sin(p.x*.69+p.z*.52+tex*2.9);
    color=input.color*flow+vec3f(.035,.070,.066)*tex;
  }
  if(input.tag==4u){color=input.color;}
  return vec4f(color,1);
}
`;

export function geology(assets,revealed){
  let device,vertices,index,uniform,pipeline,group,lastFormat;
  const frame=new Float32Array(20);
  function release(){
    vertices?.destroy();index?.destroy();uniform?.destroy();
    vertices=index=uniform=pipeline=group=lastFormat=undefined;
  }
  function setup(engine){
    device=engine.gpu;
    vertices=device.createBuffer({size:assets.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST});
    index=device.createBuffer({size:assets.indices.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});
    uniform=device.createBuffer({size:frame.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    device.queue.writeBuffer(vertices,0,assets.vertices);
    device.queue.writeBuffer(index,0,assets.indices);
  }
  function draw(c){
    if(!pipeline||lastFormat!==c.format){
      lastFormat=c.format;
      const module=device.createShaderModule({code});
      pipeline=device.createRenderPipeline({
        layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:40,attributes:[
          {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
          {shaderLocation:2,offset:24,format:'float32x4'},
        ]}]},fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},
        depthStencil:{...c.descriptor.depthStencil},
      });
      group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:uniform}},
      ]});
    }
    frame.set(c.camera.matrix);
    frame.set(c.camera.position,16);
    device.queue.writeBuffer(uniform,0,frame);
    const color={view:c.color,loadOp:'load',storeOp:'store'};
    const depth={view:c.depth,depthLoadOp:'load',depthStoreOp:'store',
      ...(c.descriptor.depthStencil.format.includes('stencil')&&{stencilReadOnly:true})};
    c.attach?.(color,depth,c.last);
    const pass=c.encoder.beginRenderPass({colorAttachments:[color],depthStencilAttachment:depth});
    pass.setPipeline(pipeline);pass.setBindGroup(0,group);
    pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(index,'uint32');
    if(revealed())pass.drawIndexed(assets.indices.length);
    else{
      pass.drawIndexed(assets.caveStart);
      pass.drawIndexed(assets.indices.length-assets.caveEnd,1,assets.caveEnd);
    }
    pass.end();
  }
  return {name:'basalt-tube-studio',setup,onDeviceRestored(engine){release();setup(engine);},dispose:release,
    registerPasses(graph){graph.add({name:'draw-basalt-studio',order:4,joins:true,execute:draw});}};
}
