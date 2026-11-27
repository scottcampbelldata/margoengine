import{a as e}from"./mat4-DF0tFTLv.js";import{t}from"./errors-BKCKUvox-y5KNvLD6.js";import{a as n,i as r,n as i,r as a}from"./scene-BHmKJ7Hk.js";var o=(e,t)=>[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]],s=(e,t)=>e.reduce((e,n,r)=>e+n*t[r],0);function c(e,n=`point`,r,i=!1){let a=Float64Array.from(e.points),c=Uint32Array.from(e.connectivity),l=e.types.length,u=a.length/3;if(!l||!Number.isInteger(u)||u<4||!a.every(Number.isFinite)||l>8388607||e.offsets.length!==l||c.length!==l*4||Array.from(e.connectivity).some(e=>!Number.isInteger(e)||e<0||e>=u)||Array.from(e.types).some(e=>e!==10)||Array.from(e.offsets).some((e,t)=>e!==(t+1)*4))throw t(`Tetrahedral volume needs finite xyz, VTK type 10 cells, four distinct valid node indices per cell and end offsets 4,8,...`,`sciviz`);let d=n===`point`?e.pointData:e.cellData;if(!i&&(!d||d.length!==(n===`point`?u:l)||Array.from(d).some(e=>!Number.isFinite(e)&&!Number.isNaN(e))))throw t(`Tetrahedral volume needs one finite scalar or NaN mask per associated point/cell`,`sciviz`);let f=1/0,p=-1/0;if(d)for(let e=0;e<d.length;e++)Number.isFinite(d[e])&&(f=Math.min(f,d[e]),p=Math.max(p,d[e]));if(i&&(f=0,p=1),!Number.isFinite(f)||!Number.isFinite(p))throw t(`Tetrahedral volume needs at least one finite scalar`,`sciviz`);let m=r??[f,p];if(m.length!==2||!m.every(Number.isFinite)||m[0]>m[1])throw t(`Tetrahedral classifier range must be finite and increasing`,`sciviz`);m[0]===m[1]&&(m=[m[0]-.5,m[1]+.5]);let h=[1/0,-1/0,1/0,-1/0,1/0,-1/0];for(let e=0;e<a.length;e++){let t=e%3;h[t*2]=Math.min(h[t*2],a[e]),h[t*2+1]=Math.max(h[t*2+1],a[e])}let g=[0,1,2].map(e=>h[e*2+1]-h[e*2]);if(g.some(e=>!(e>0)||!Number.isFinite(e)))throw t(`Tetrahedral volume must span three physical axes`,`sciviz`);let _=new Int32Array(l*4).fill(-1),v=new Map,y=new Set,b=new Float32Array(l*24),x=[],S=1/0;for(let e=0;e<l;e++){let r=Array.from(c.subarray(e*4,e*4+4));if(new Set(r).size!==4)throw t(`Tetrahedral cells need four distinct node IDs`,`sciviz`);let l=r.map(e=>[a[e*3],a[e*3+1],a[e*3+2]]),u=l.map(e=>e.map((e,t)=>(e-h[t*2])/g[t])),f=[1,2,3].map(e=>u[e].map((e,t)=>e-u[0][t])),p=s(f[0],o(f[1],f[2])),C=f.reduce((e,t)=>e*Math.hypot(...t),1);if(!Number.isFinite(p)||Math.abs(p)<=C*1e-10||!C)throw t(`Tetrahedral cells must have nonzero well-conditioned volume`,`sciviz`);let w=[o(f[1],f[2]),o(f[2],f[0]),o(f[0],f[1])].map(e=>e.map(e=>e/p));for(let t=0;t<3;t++)b.set([...w[t],-s(w[t],u[0])],e*24+t*4);let T=!0;for(let t=0;t<4;t++){let a=i?0:d[n===`point`?r[t]:e];T&&=Number.isFinite(a),b[e*24+12+t]=Number.isFinite(a)?Math.max(-65504,Math.min(65504,(a-m[0])/(m[1]-m[0]))):0}let E=Array.from(b.subarray(e*24+12,e*24+16)),D=[0,1,2].map(e=>(w[0][e]*(E[1]-E[0])+w[1][e]*(E[2]-E[0])+w[2][e]*(E[3]-E[0]))/g[e]);b.set([...D,+!!T],e*24+20);let O=[0,1,2].map(e=>Math.min(...u.map(t=>t[e]))),k=[0,1,2].map(e=>Math.max(...u.map(t=>t[e])));x.push({id:e,low:O,high:k});for(let e=0;e<4;e++)for(let t=e+1;t<4;t++)S=Math.min(S,Math.hypot(...l[e].map((e,n)=>e-l[t][n])));for(let n=0;n<4;n++){let i=r.filter((e,t)=>t!==n).sort((e,t)=>e-t),c=i.join(`,`);if(y.has(c))throw t(`Tetrahedral volume has a nonmanifold face shared by more than two cells`,`sciviz`);let u=v.get(c);if(u){let r=i.map(e=>[a[e*3],a[e*3+1],a[e*3+2]]),d=o(r[1].map((e,t)=>e-r[0][t]),r[2].map((e,t)=>e-r[0][t]));if(s(d,l[n].map((e,t)=>e-r[0][t]))*s(d,[a[u.opposite*3],a[u.opposite*3+1],a[u.opposite*3+2]].map((e,t)=>e-r[0][t]))>=0)throw t(`Adjacent tetrahedral cells must lie on opposite sides of their shared face`,`sciviz`);_[e*4+n]=u.cell,_[u.cell*4+u.face]=e,v.delete(c),y.add(c)}else v.set(c,{cell:e,face:n,opposite:r[n]})}}for(let e=0;e<l;e++)b.set(_.subarray(e*4,e*4+4),e*24+16);let C=[];function w(e){let t=C.length,n=[1/0,1/0,1/0],r=[-1/0,-1/0,-1/0];for(let t of e)for(let e=0;e<3;e++)n[e]=Math.min(n[e],t.low[e]),r[e]=Math.max(r[e],t.high[e]);if(C.push(...n,0,...r,e.length===1?e[0].id+1:0),e.length>1){let t=r.map((e,t)=>e-n[t]),i=t.indexOf(Math.max(...t));e.sort((e,t)=>e.low[i]+e.high[i]-t.low[i]-t.high[i]);let a=e.length>>1;w(e.slice(0,a)),w(e.slice(a))}C[t+3]=C.length/8}return w(x),{bounds:h,cells:b,nodes:Float32Array.from(C),adjacency:_,count:l,range:m,reference:S}}function l(e){return c(e,`point`,void 0,!0).adjacency}var u=`
fn transferAt(value:f32,y:f32)->vec4f {
 let n=vec2f(textureDimensions(transfer));let uv=select(vec2f(value,y),(vec2f(value,y)*(n-1.0)+0.5)/n,u.classification.x>0.5);
 return textureSampleLevel(transfer,linearSampler,uv,0.0);
}`,d=`${n}
fn transferAt(value:f32,y:f32)->vec4f {
 if(u.classification.x<0.5){return colourLookup(transfer,value);}
 let n=vec2f(textureDimensions(transfer));let p=clamp(vec2f(value,y),vec2f(0.0),vec2f(1.0))*(n-1.0);
 let i=vec2i(floor(p));let j=min(i+vec2i(1),vec2i(n)-vec2i(1));let f=fract(p);
 return mix(mix(textureLoad(transfer,i,0),textureLoad(transfer,vec2i(j.x,i.y),0),f.x),mix(textureLoad(transfer,vec2i(i.x,j.y),0),textureLoad(transfer,j,0),f.x),f.y);
}`,f=e=>`
struct TetVolume { model:mat4x4f,inverse:mat4x4f,options:vec4f,classification:vec4f,low:vec4f,span:vec4f,size:vec4f,planes:array<vec4f,4> }
@group(1) @binding(0) var<uniform> u:TetVolume;
@group(1) @binding(1) var cells:texture_2d<f32>;
@group(1) @binding(2) var transfer:texture_2d<f32>;
@group(1) @binding(3) var linearSampler:sampler;
@group(1) @binding(4) var nodes:texture_2d<f32>;
fn load(t:texture_2d<f32>,i:u32)->vec4f {let w=textureDimensions(t).x;return textureLoad(t,vec2i(i32(i%w),i32(i/w)),0);}
fn weights(cell:u32,p:vec3f)->vec4f {let v=vec4f(p,1.0);let q=vec3f(dot(load(cells,cell*6u),v),dot(load(cells,cell*6u+1u),v),dot(load(cells,cell*6u+2u),v));return vec4f(1.0-q.x-q.y-q.z,q);}
struct Interval { low:f32,high:f32,face:i32,valid:bool }
fn interval(cell:u32,origin:vec3f,d:vec3f,limit:f32)->Interval {
 let a=weights(cell,origin);let q=vec3f(dot(load(cells,cell*6u).xyz,d),dot(load(cells,cell*6u+1u).xyz,d),dot(load(cells,cell*6u+2u).xyz,d));let b=vec4f(-q.x-q.y-q.z,q);
 var lo=0.0;var hi=limit;var face=-1;
 for(var f=0u;f<4u;f++) {
  if(abs(b[f])<1e-20){if(a[f]<0.0){return Interval(0.0,0.0,-1,false);}}
  else {let t=-a[f]/b[f];if(b[f]>0.0){lo=max(lo,t);}else if(t<hi){hi=t;face=i32(f);}}
 }
 return Interval(lo,hi,face,hi>lo);
}
fn boxHit(origin:vec3f,d:vec3f,lo:vec3f,hi:vec3f,start:f32,limit:f32)->bool {
 var a=start;var b=limit;
 for(var axis=0u;axis<3u;axis++) {
  if(abs(d[axis])<1e-20){if(origin[axis]<lo[axis] || origin[axis]>hi[axis]){return false;}}
  else {let x=(lo[axis]-origin[axis])/d[axis];let y=(hi[axis]-origin[axis])/d[axis];a=max(a,min(x,y));b=min(b,max(x,y));}
 }return b>=a;
}
fn closest(origin:vec3f,d:vec3f,start:f32,limit:f32)->i32 {
 var best=limit;var result=-1;var index=0u;let count=u32(u.low.w);
 for(var n=0u;n<count && index<count;n++) {
  let a=load(nodes,index*2u);let b=load(nodes,index*2u+1u);
  if(!boxHit(origin,d,a.xyz,b.xyz,start,best)){index=u32(a.w);continue;}
  index++;if(b.w<0.5){continue;}
  let cell=u32(b.w)-1u;let hit=interval(cell,origin,d,limit);let enter=max(start,hit.low);
  if(hit.valid && hit.high>enter && (enter<best || (enter==best && (result<0 || i32(cell)<result)))){best=enter;result=i32(cell);}
 }return result;
}
fn scalar(cell:u32,p:vec3f)->f32 {var w=clamp(weights(cell,p),vec4f(0.0),vec4f(1.0));w/=dot(w,vec4f(1.0));return dot(w,load(cells,cell*6u+3u));}
${e?d:u}
fn classify(cell:u32,p:vec3f,next:vec3f)->vec4f {
 let value=scalar(cell,p);var y=0.5;
 if(u.classification.x==1.0){y=length(load(cells,cell*6u+5u).xyz)*u.classification.y;}
 if(u.classification.x==2.0){y=scalar(cell,next);}
 return transferAt(value,y);
}
struct Out { @builtin(position) position:vec4f,@location(0) ndc:vec2f }
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {let p=array<vec2f,3>(vec2f(-1.0,-1.0),vec2f(3.0,-1.0),vec2f(-1.0,3.0));var o:Out;o.position=vec4f(p[i],0.0,1.0);o.ndc=p[i];return o;}
@fragment fn fragment(in:Out)->@location(0) vec4f {
 let a=frame.inverse*vec4f(in.ndc,1.0,1.0);let b=frame.inverse*vec4f(in.ndc,0.000001,1.0);
 let world=a.xyz/a.w;let worldDir=normalize(b.xyz/b.w-world);let origin=(u.inverse*vec4f(world,1.0)).xyz;let raw=(u.inverse*vec4f(worldDir,0.0)).xyz;let speed=length(raw);let d=raw/speed;
 var start=0.0;var limit=1e30;let opaque=opaquePoint(in.position.xy,in.ndc);if(opaque.w>0.0){limit=dot(opaque.xyz-world,worldDir)*speed;}
 // Clip in physical-bounds box coordinates before locating cells.
 for(var k=0u;k<u32(u.size.y);k++){let plane=u.planes[k];let f=dot(plane.xyz,origin)+plane.w;let slope=dot(plane.xyz,d);if(abs(slope)<1e-20){if(f<0.0){discard;}}else if(slope>0.0){start=max(start,-f/slope);}else{limit=min(limit,-f/slope);}}
 if(limit<=start){discard;}
 let physicalSpeed=length(d*u.span.xyz);var cursor=start;var cell=-1;var total=vec4f(0.0);var peak=-1.0;var found=false;var peakCell=0u;var peakPoint=vec3f(0.0);
 // A convex tetrahedron is crossed at most once. Re-entry uses the tree; ordinary faces use adjacency.
 for(var visit=0u;visit<u32(u.size.x)+1u && cursor<limit;visit++) {
  if(cell<0){cell=closest(origin,d,cursor,limit);if(cell<0){break;}}
  let id=u32(cell);let hit=interval(id,origin,d,limit);let enter=max(cursor,hit.low);
  if(!hit.valid || hit.high<=enter){cell=-1;continue;}
  if(load(cells,id*6u+5u).w>0.5){
   if(u.options.w>0.5){
    let p0=origin+d*enter;let p1=origin+d*hit.high;let v0=scalar(id,p0);let v1=scalar(id,p1);
    let low=u.options.w>1.5;let e=select(max(v0,v1),min(v0,v1),low);if(!found||select((e>peak),(e<peak),low)){peak=e;found=true;peakCell=id;peakPoint=select(select(p0,p1,v1>v0),select(p0,p1,(v1<v0)),low);}
   }else {
    let distance=(hit.high-enter)*physicalSpeed;let count=max(1u,min(2048u,u32(ceil(distance/u.options.x*u.options.y))));let ds=(hit.high-enter)/f32(count);
    for(var i=0u;i<count;i++) {
     let p=origin+d*(enter+(f32(i)+0.5)*ds);let next=origin+d*min(hit.high,enter+(f32(i)+1.5)*ds);let tf=classify(id,p,next);
     var alpha=1.0-pow(1.0-clamp(tf.a*u.options.z,0.0,1.0),ds*physicalSpeed/u.options.x);
     if(u.classification.x==2.0){alpha=1.0-pow(max(1.0-tf.a,0.0),ds*physicalSpeed/u.options.x/u.classification.z*u.options.z/u.classification.w);}
     var rgb=tf.rgb;let g=load(cells,id*6u+5u).xyz*u.span.xyz;
     if(u.span.w>0.5 && dot(g,g)>1e-14){let n=vec3f(dot(u.inverse[0].xyz,g),dot(u.inverse[1].xyz,g),dot(u.inverse[2].xyz,g));rgb=shade(rgb,normalize(n),-worldDir);}
     total+=vec4f(rgb*alpha,alpha)*(1.0-total.a);if(total.a>0.999){break;}
    }
   }
  }
  cursor=hit.high;if(total.a>0.999){break;}
  cell=-1;if(hit.face>=0){let neighbour=i32(load(cells,id*6u+4u)[u32(hit.face)]);if(neighbour>=0){let h=interval(u32(neighbour),origin,d,limit);if(h.valid && h.high>max(cursor,h.low)){cell=neighbour;}}}
 }
 if(u.options.w>0.5){if(!found){discard;}let tf=classify(peakCell,peakPoint,peakPoint);return vec4f(toOutput(tf.rgb),clamp(tf.a*u.options.z,0.0,1.0));}
 if(total.a<1e-8){discard;}return vec4f(toOutput(total.rgb/total.a),total.a);
}
`,p=class{get bounds(){return this.source.bounds}get cellCount(){return this.#t.count}#e;#t;#n;#r;#i;#a;#o;#s;#c;#l;#u;constructor(e,n,r={}){if(this.visible=!0,this.transparent=!0,this.needsSceneDepth=!0,this.#r=!1,this.#o=[],this.#u=new Float32Array(68),r.signal?.throwIfAborted(),a(e.renderer),this.#e=e,r.association!==void 0&&![`point`,`cell`].includes(r.association))throw t(`Tetrahedral association must be point or cell`,`sciviz`);this.#t=c(n,r.association??`point`,r.range);let i=this.#t.bounds,o=Math.max(i[1]-i[0],i[3]-i[2],i[5]-i[4]);if(this.#n=(r.referenceStep??this.#t.reference)/o,!(this.#n>0)||!Number.isFinite(this.#n))throw t(`Tetrahedral referenceStep must be finite and positive`,`sciviz`);let s=e.renderer.device.limits.maxTextureDimension2D**2;if(Math.max(this.#t.cells.length/4,this.#t.nodes.length/4)>s)throw t(`Tetrahedral cells exceed this GPU texture capacity; partition the mesh`,`sciviz`);r.signal?.throwIfAborted(),this.source=e.volume(new Float32Array(8).fill(this.#t.range[0]),{...r,dims:[2,2,2],bounds:this.#t.bounds,range:this.#t.range}),this.source.visible=!1,this.#f()}#d(e){let t=this.#e.renderer.device,n=e.length/4,r=Math.min(n,t.limits.maxTextureDimension2D),i=Math.ceil(n/r),a=new Float32Array(r*i*4);a.set(e);let o=t.createTexture({size:[r,i],format:`rgba32float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});return t.queue.writeTexture({texture:o},a,{bytesPerRow:r*16},[r,i]),o}#f(){let e=this.#e.renderer.device;this.#i=e.createBuffer({size:272,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.#a=e.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:`uniform`}},{binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:`unfilterable-float`}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:this.source.colormap.encoding?`unfilterable-float`:`float`}},{binding:3,visibility:GPUShaderStage.FRAGMENT,sampler:{}},{binding:4,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:`unfilterable-float`}}]}),this.#o=[this.#d(this.#t.cells),this.#d(this.#t.nodes)],this.#s=void 0,this.#c=void 0,this.#l=void 0}center(){return this.source.center()}prepare(){if(this.#r||!this.source.valid)return;let n=this.#e.renderer.device,r=this.source.resources(),i=this.#u,a=this.bounds;if(!Number.isFinite(this.source.quality)||!(this.source.quality>0)||!Number.isFinite(this.source.density)||!(this.source.density>0))throw t(`Tetrahedral quality and density must be finite and positive`,`sciviz`);i.set(this.source.model),e(this.source.model,i.subarray(16,32)),i.set([this.#n,this.source.quality*(this.#e.renderer.samplingScale??1),this.source.density,this.source.mode===`mip`?1:this.source.mode===`minip`?2:0],32),i.set(this.source.classificationUniforms().slice(0,4),36),i.set([a[0],a[2],a[4],this.#t.nodes.length/8],40);let o=Math.max(a[1]-a[0],a[3]-a[2],a[5]-a[4]);i.set([(a[1]-a[0])/o,(a[3]-a[2])/o,(a[5]-a[4])/o,+!!this.source.shading],44),i.set([this.#t.count,this.source.clip.length,0,0],48),i.fill(0,52),this.source.clip.forEach((e,t)=>i.set([...e.normal,e.offset],52+t*4)),n.queue.writeBuffer(this.#i,0,i),(this.#c!==r.data||this.#l!==r.transfer)&&(this.#s=n.createBindGroup({layout:this.#a,entries:[{binding:0,resource:{buffer:this.#i}},{binding:1,resource:this.#o[0].createView()},{binding:2,resource:r.transfer.createView()},{binding:3,resource:r.sampler},{binding:4,resource:this.#o[1].createView()}]}),this.#c=r.data,this.#l=r.transfer)}draw(e,t,n){if(this.#r||!this.source.valid||!this.#s)return;let a=!!this.source.colormap.encoding,o=n.pipeline(`tetrahedral volume|${a}`,t,e=>{let t=n.device.createShaderModule({code:r+i+f(a),label:`sciviz tetrahedral ray casting`});return{layout:n.device.createPipelineLayout({bindGroupLayouts:[n.frameLayout,this.#a,n.depthLayout]}),vertex:{module:t,entryPoint:`vertex`},fragment:{module:t,entryPoint:`fragment`,targets:[{format:e.format,blend:{color:{srcFactor:`src-alpha`,dstFactor:`one-minus-src-alpha`},alpha:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`}}}]},primitive:{topology:`triangle-list`},multisample:e.multisample,depthStencil:{format:e.depth,depthWriteEnabled:!1,depthCompare:`always`}}});e.setPipeline(o),e.setBindGroup(1,this.#s),e.setBindGroup(2,n.depthGroup),e.draw(3)}#p(){this.#i.destroy();for(let e of this.#o)e.destroy();this.#o=[],this.#s=void 0}restore(){this.#r||(this.#p(),this.#f())}dispose(){this.#r||(this.#r=!0,this.#e.renderer.remove(this),this.#p(),this.#e.remove(this.source))}[Symbol.dispose](){this.dispose()}};function m(e,t,n={}){let r=new p(e,t,n);return e.renderer.add(r),r}export{p as TetrahedralVolume,l as tetrahedralAdjacency,m as tetrahedralVolume};