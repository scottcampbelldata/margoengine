import{c as e,l as t,n,r,t as i}from"./index-B9HuUix4.js";import{t as a}from"./errors-DkwPZuAq.js";var o=`
struct Cull {camera:mat4x4f,planes:array<vec4f,6>,size:vec4u,mode:vec4u,levels:array<vec4u,16>}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> u:Cull;
`,s=`

fn occluder(s:vec4f)->bool {
  let m=u.camera;let w=dot(vec4f(m[0].w,m[1].w,m[2].w,m[3].w),vec4f(s.xyz,1.0));
  return w<=s.w||s.w*length(vec3f(m[0].y,m[1].y,m[2].y))/w*f32(u.size.y)*0.5>=bitcast<f32>(u.mode.w);
}




fn unoccluded(s:vec4f)->bool {
  var lo=vec2f(3.0e38);var hi=vec2f(-3.0e38);var near=0.0;let m=u.camera;
  for(var c=0u;c<8u;c++){
    let k=vec3f(f32(c&1u),f32((c>>1u)&1u),f32(c>>2u))*2.0-1.0;let q=m*vec4f(s.xyz+s.w*k,1.0);
    if(q.w<=1e-6){return true;}
    let n=q.xyz/q.w;lo=min(lo,n.xy);hi=max(hi,n.xy);near=max(near,n.z);
  }
  let row2=vec3f(m[0].z,m[1].z,m[2].z);let row3=vec3f(m[0].w,m[1].w,m[2].w);
  if(u.mode.z==1u){let q=m*vec4f(s.xyz-s.w*normalize(row3),1.0);if(q.w>1e-6){near=min(near,q.z/q.w);}}
  if(u.mode.z==2u){let q=m*vec4f(s.xyz,1.0);near=min(near,(q.z+s.w*length(row2))/q.w);}
  return reaches(lo,hi,near);
}

fn reaches(lo:vec2f,hi:vec2f,near:f32)->bool {
  if(near>=1.0){return true;}
  let size=vec2f(u.size.xy);
  let p0=vec2u(clamp(vec2f(lo.x*0.5+0.5,0.5-hi.y*0.5)*size,vec2f(0.0),size-1.0));
  let p1=vec2u(clamp(vec2f(hi.x*0.5+0.5,0.5-lo.y*0.5)*size,vec2f(0.0),size-1.0));
  var l=0u;
  while(l+1u<u.size.z&&((p1.x>>l)-(p0.x>>l)>1u||(p1.y>>l)-(p0.y>>l)>1u)){l++;}
  let e=u.levels[l];let a=p0>>vec2u(l);let b=p1>>vec2u(l);
  let far=min(min(hiz[e.x+a.y*e.y+a.x],hiz[e.x+a.y*e.y+b.x]),min(hiz[e.x+b.y*e.y+a.x],hiz[e.x+b.y*e.y+b.x]));
  return near>=far*(1.0-1e-5);
}
`,c=`
fn boxInside(i:u32)->bool {
  let m=records[i].m;let k=u.mode.y+batchOf[i]*2u;let h=bounds[k+1u].xyz;let c=(m*vec4f(bounds[k].xyz,1.0)).xyz;
  let x=m[0].xyz*h.x;let y=m[1].xyz*h.y;let z=m[2].xyz*h.z;let pad=1e-5*(length(c)+length(x)+length(y)+length(z));
  for(var p=0u;p<6u;p++){
    let n=u.planes[p].xyz;let r=abs(dot(n,x))+abs(dot(n,y))+abs(dot(n,z))+pad;
    if(dot(n,c)+u.planes[p].w< -r){return false;}
  }
  return true;
}
fn boxUnoccluded(i:u32)->bool {
  let m=records[i].m;let k=u.mode.y+batchOf[i]*2u;let h=bounds[k+1u].xyz;let c=(m*vec4f(bounds[k].xyz,1.0)).xyz;
  let x=m[0].xyz*h.x;let y=m[1].xyz*h.y;let z=m[2].xyz*h.z;let pad=1e-5*(length(c)+length(x)+length(y)+length(z));
  var lo=vec2f(3.0e38);var hi=vec2f(-3.0e38);var near=0.0;
  for(var e=0u;e<8u;e++){
    let s=vec3f(f32(e&1u),f32((e>>1u)&1u),f32(e>>2u))*2.0-1.0;
    let q=u.camera*vec4f(c+s.x*x+s.y*y+s.z*z+s*pad,1.0);
    if(q.w<=1e-6){return true;}
    let n=q.xyz/q.w;lo=min(lo,n.xy);hi=max(hi,n.xy);near=max(near,n.z);
  }
  return reaches(lo,hi,near);
}
`,l=(e,t=!1)=>o+`
@group(0) @binding(1) var<storage,read> hidden:array<u32>;
@group(0) @binding(2) var<storage,read_write> visible:array<u32>;
@group(0) @binding(3) var<storage,read_write> local:array<u32>;
@group(0) @binding(4) var<storage,read_write> groups:array<u32>;
@group(0) @binding(5) var<storage,read_write> hiz:array<f32>;
@group(0) @binding(6) var<storage,read> batchOf:array<u32>;
@group(0) @binding(7) var<storage,read> batches:array<vec4u>;
@group(0) @binding(8) var<storage,read_write> args:array<u32>;
@group(0) @binding(9) var<storage,read_write> earlyArgs:array<atomic<u32>>;
@group(0) @binding(10) var<storage,read_write> earlyList:array<u32>;
@group(0) @binding(11) var<storage,read> records:array<Record>;
@group(0) @binding(12) var<storage,read_write> drawn:array<Record>;
@group(0) @binding(13) var<uniform> level:vec4u;
@group(0) @binding(14) var depth:${e>1?`texture_depth_multisampled_2d`:`texture_depth_2d`};
@group(0) @binding(15) var<storage,read> bounds:array<vec4f>;
var<workgroup> scratch:array<u32,256>;



fn sphereOf(i:u32)->vec4f {
  if(hidden[i]!=0u){return vec4f(0.0,0.0,0.0,-1.0);}
  let m=records[i].m;let b=bounds[batchOf[i]];let c=(m*vec4f(b.xyz,1.0)).xyz;
  let r=b.w*sqrt(max(dot(m[0].xyz,m[0].xyz),max(dot(m[1].xyz,m[1].xyz),dot(m[2].xyz,m[2].xyz))));
  return vec4f(c,r+1e-5*(length(c)+r));
}


fn inside(s:vec4f)->bool {
  if(s.w<0.0){return false;}
  if(u.mode.x==0u){return true;}
  for(var p=0u;p<6u;p++){if(dot(u.planes[p].xyz,s.xyz)+u.planes[p].w< -s.w){return false;}}
  return true;
}
${s}${t?c:``}


@compute @workgroup_size(256) fn early(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x;if(i>=u.size.w||visible[i]==0u){return;}
  let s=sphereOf(i);if(!inside(s)||!occluder(s)){return;}
  let b=batchOf[i];earlyList[batches[b].x+atomicAdd(&earlyArgs[b*5u+1u],1u)]=i;
}

@compute @workgroup_size(8,8) fn depth0(@builtin(global_invocation_id) g:vec3u) {
  if(g.x>=u.size.x||g.y>=u.size.y){return;}
  var m=1.0;for(var s=0;s<${e};s++){m=min(m,textureLoad(depth,vec2i(g.xy),s));}
  hiz[g.y*u.size.x+g.x]=m;
}
@compute @workgroup_size(8,8) fn reduce(@builtin(global_invocation_id) g:vec3u) {
  let d=u.levels[level.x];let s=u.levels[level.x-1u];
  if(g.x>=d.y||g.y>=d.z){return;}
  let a=g.xy*2u;let b=min(a+vec2u(1u),s.yz-vec2u(1u));
  hiz[d.x+g.y*d.y+g.x]=min(min(hiz[s.x+a.y*s.y+a.x],hiz[s.x+a.y*s.y+b.x]),min(hiz[s.x+b.y*s.y+a.x],hiz[s.x+b.y*s.y+b.x]));
}

@compute @workgroup_size(256) fn cull(@builtin(global_invocation_id) g:vec3u,@builtin(local_invocation_index) l:u32,@builtin(workgroup_id) w:vec3u) {
  let i=g.x;var f=0u;
  if(i<u.size.w){let s=sphereOf(i);if(inside(s)&&${t?`(u.mode.x==0u||boxInside(i))&&(u.mode.x<2u||boxUnoccluded(i))`:`(u.mode.x<2u||unoccluded(s))`}){f=1u;}visible[i]=f;}
  scratch[l]=f;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var v=0u;if(l>=o){v=scratch[l-o];}workgroupBarrier();scratch[l]+=v;workgroupBarrier();}
  if(i<u.size.w){local[i]=scratch[l]-f;}
  if(l==255u){groups[w.x]=scratch[255];}
}

@compute @workgroup_size(256) fn scan(@builtin(local_invocation_index) l:u32) {
  let n=(u.size.w+255u)/256u;let per=(n+255u)/256u;let a=min(l*per,n);let b=min(a+per,n);
  var sum=0u;for(var k=a;k<b;k++){sum+=groups[k];}
  scratch[l]=sum;workgroupBarrier();
  for(var o=1u;o<256u;o=o<<1u){var v=0u;if(l>=o){v=scratch[l-o];}workgroupBarrier();scratch[l]+=v;workgroupBarrier();}
  var run=scratch[l]-sum;for(var k=a;k<b;k++){let v=groups[k];groups[k]=run;run+=v;}
}


@compute @workgroup_size(256) fn scatter(@builtin(global_invocation_id) g:vec3u) {
  let i=g.x;if(i>=u.size.w){return;}
  let b=batchOf[i];let range=batches[b];let s=range.x;
  let base=groups[s>>8u]+local[s];let p=groups[i>>8u]+local[i];let f=visible[i];
  if(f==1u){drawn[s+p-base]=records[i];}
  if(i==range.y-1u){args[b*5u+1u]=p+f-base;}
}
`,u=o+`
@group(0) @binding(11) var<storage,read> records:array<Record>;
struct V {@builtin(position) @invariant clip:vec4f,@location(0) @interpolate(flat) side:vec2f}
@vertex fn vertex(@location(0) position:vec3f,@location(2) index:u32)->V {
  let r=records[index];let model=r.m;let p=model*vec4f(position,1);
  var o:V;o.clip=u.camera*p;o.side=vec2f(select(-1.0,1.0,dot(model[0].xyz,cross(model[1].xyz,model[2].xyz))>=0.0),r.factors.z);return o;
}

@fragment fn fragment(i:V,@builtin(front_facing) front:bool) {if(front!=(i.side.x>0.0)&&i.side.y<0.5){discard;}}
`,d=e=>e.includes(`let p=model*vec4f(i.position,1);
var o:Output;o.clip=frame.camera*p;`)&&e.split(`discard`).length===2;function f(e){let[t,n,r]=[e[2],e[6],e[10]],[i,a,o]=[e[3],e[7],e[11]],s=Math.hypot(i,a,o);return s?+(Math.hypot(n*o-r*a,r*i-t*o,t*a-n*i)<=1e-6*Math.hypot(t,n,r)*s):2}var p=()=>new Uint32Array(1024).map((e,t)=>t%64?0:t/64);function m(e,t,n){let r=e.createShaderModule({code:u});return e.createRenderPipeline({layout:`auto`,vertex:{module:r,entryPoint:`vertex`,buffers:[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:`float32x3`}]},{arrayStride:4,stepMode:`instance`,attributes:[{shaderLocation:2,offset:0,format:`uint32`}]}]},fragment:n?{module:r,entryPoint:`fragment`,targets:[]}:void 0,multisample:{count:t},depthStencil:{format:`depth32float`,depthWriteEnabled:!0,depthCompare:`greater-equal`}})}var h=class{constructor(e,t,n,r,i,a){this.device=e,this.samples=t,this.pipelines=n,this.uniform=r,this.table=i,this.words=a,this.width=0,this.height=0,this.levels=0,this.steps=[],this.target={view:void 0,depthClearValue:0,depthLoadOp:`clear`,depthStoreOp:`store`},this.pass={colorAttachments:[],depthStencilAttachment:this.target}}resize(e,t){let n=this.device,{depth0:r,reduce:i}=this.pipelines;this.destroy(),this.depth=n.createTexture({size:[e,t],format:`depth32float`,sampleCount:this.samples,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.width=e,this.height=t;let a=this.buffer=n.createBuffer({size:this.plan(e,t)*4,usage:GPUBufferUsage.STORAGE}),o=this.depth.createView(),s=(e,t)=>n.createBindGroup({layout:e.getBindGroupLayout(0),entries:t.map(([e,t])=>({binding:e,resource:t}))});this.target.view=o,this.first=s(r,[[0,{buffer:this.uniform}],[5,{buffer:a}],[14,o]]),this.steps=Array.from({length:this.levels},(e,t)=>s(i,[[0,{buffer:this.uniform}],[5,{buffer:a}],[13,{buffer:this.table,offset:t*256,size:16}]]))}plan(e,t){let n=e,r=t,i=0,a=0;for(;this.words.set([i,n,r,0],48+a*4),i+=n*r,n!==1||r!==1;a++)n=Math.ceil(n/2),r=Math.ceil(r/2);return this.levels=a+1,i}encode(e,t,n){let{depth0:r,reduce:i}=this.pipelines;e.setPipeline(r),e.setBindGroup(0,this.first),e.dispatchWorkgroups(Math.ceil(t/8),Math.ceil(n/8)),e.setPipeline(i);for(let t=1;t<this.levels;t++)e.setBindGroup(0,this.steps[t]),e.dispatchWorkgroups(Math.ceil(this.words[48+t*4+1]/8),Math.ceil(this.words[48+t*4+2]/8))}destroy(){this.depth?.destroy(),this.buffer?.destroy(),this.depth=this.buffer=void 0,this.width=this.height=0,this.steps=[]}};function g(e){return e?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`native`}function _(e,t){return g(e)===`webgl2`?t():void 0}function v(e,t){for(let n=t;n>=0;n=e.parents?.[n]??-1)if(e.hidden[n])return!0;return!1}function y(e){return e?.view?.viewport}function b(e){let t=y(e);return t?[t[2],t[3]]:[e.width,e.height]}function x(e,t){let n=y(t);if(!n)return;e.setViewport(n[0],n[1],n[2],n[3],0,1);let r=t.view.scissor??n;e.setScissorRect(r[0],r[1],r[2],r[3])}function S(){return globalThis[Symbol.for(`margoengine.layers`)]}function C(e){return S()?.maskOf(e)??1}function w(e,t){let n=e?.view?.layers;return n===void 0||(C(t)&n)!==0}var T={arrayStride:96,stepMode:`instance`,attributes:[5,6,7,8].map((e,t)=>({shaderLocation:e,offset:t*16,format:`float32x4`}))},E=class{constructor(){this.sources=new Set,this.pipelines=new Map,this.capacity=0,this.data=new Float32Array,this.samples=0}add(e){let t=e;if(!t||typeof t!=`object`||!(`id`in t||`shadowPrimitives`in t||`drawOccluder`in t))throw TypeError(`Invalid occluder; pass a core mesh, a model, a materials mesh or a Terrain`);this.sources.add(t)}remove(e){let t=e;this.sources.delete(t)}get size(){return this.sources.size}collect(e,t,n){let r=[],i=[],a=n=>!v(t.store,n.id)&&w(e,n),o=e=>e[0]*(e[5]*e[10]-e[6]*e[9])-e[4]*(e[1]*e[10]-e[2]*e[9])+e[8]*(e[1]*e[6]-e[2]*e[5])<0;for(let e of this.sources){if(`disposed`in e&&e.disposed){this.sources.delete(e);continue}if(`id`in e){let n=e.geometry,s=n&&t.geometryBuffers(n);s&&a(e)&&(i.push(e.matrix),r.push({vertex:s.vertex,offset:0,index:s.index,count:n.indices.length,stride:24,mirrored:o(e.matrix),instances:1}));continue}let s=e.shadowPrimitives;if(!s)continue;let c=new Set(e.tintPrimitives?.map(e=>e.primitive));for(let e of s){if(e.topology===`line-list`||e.cutoff||e.alpha!==void 0&&e.alpha<1||e.displacement||e.clip||e.primitive&&c.has(e.primitive)||e.instances?.mirrored||!a(e.node))continue;let t=e.instances?e.instances.count:1;t&&(i.push(e.node.matrix),r.push({vertex:e.vertex,offset:e.vertexOffset??0,index:e.index,count:e.count,stride:e.stride,mirrored:o(e.node.matrix),rows:e.instances?.upload(n),instances:t}))}}return{draws:r,models:i}}pipeline(e,t){let n=`${t.stride}:${+!!t.rows}:${+t.mirrored}`,r=this.pipelines.get(n);return r||(r=e.createRenderPipeline({layout:e.createPipelineLayout({bindGroupLayouts:[this.layout]}),vertex:{module:this.module,entryPoint:t.rows?`rows`:`plain`,buffers:[{arrayStride:t.stride,attributes:[{shaderLocation:0,offset:0,format:`float32x3`}]},...t.rows?[T]:[]]},primitive:{cullMode:`back`,frontFace:t.mirrored?`cw`:`ccw`},multisample:{count:this.samples},depthStencil:{format:`depth32float`,depthWriteEnabled:!0,depthCompare:`greater-equal`}}),this.pipelines.set(n,r)),r}draw(e,t,n,r){let i=t.device;r!==this.samples&&(this.pipelines.clear(),this.samples=r),this.layout??=i.createBindGroupLayout({entries:[{binding:0,visibility:1,buffer:{type:`uniform`,hasDynamicOffset:!0}}]}),this.module??=i.createShaderModule({code:`
struct Occluder {camera:mat4x4f,model:mat4x4f}
@group(0) @binding(0) var<uniform> o:Occluder;
@vertex fn plain(@location(0) p:vec3f)->@builtin(position) @invariant vec4f {return o.camera*(o.model*vec4f(p,1));}
@vertex fn rows(@location(0) p:vec3f,@location(5) a:vec4f,@location(6) b:vec4f,@location(7) c:vec4f,@location(8) d:vec4f)->@builtin(position) @invariant vec4f {
  return o.camera*(o.model*(mat4x4f(a,b,c,d)*vec4f(p,1)));
}
`});let{draws:a,models:o}=this.collect(t,n,i);if(a.length>this.capacity&&(this.uniform?.destroy(),this.capacity=Math.max(16,2**Math.ceil(Math.log2(a.length))),this.uniform=i.createBuffer({size:this.capacity*256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.group=i.createBindGroup({layout:this.layout,entries:[{binding:0,resource:{buffer:this.uniform,size:128}}]}),this.data=new Float32Array(this.capacity*256/4)),a.length){for(let e=0;e<o.length;e++)this.data.set(t.camera.matrix,e*256/4),this.data.set(o[e],e*256/4+16);i.queue.writeBuffer(this.uniform,0,this.data,0,a.length*256/4)}a.forEach((t,n)=>{e.setPipeline(this.pipeline(i,t)),e.setBindGroup(0,this.group,[n*256]),e.setVertexBuffer(0,t.vertex,t.offset),t.rows&&e.setVertexBuffer(1,t.rows),e.setIndexBuffer(t.index,`uint32`),e.drawIndexed(t.count,t.instances)});for(let t of this.sources)`drawOccluder`in t&&t.drawOccluder?.({device:i,pass:e,samples:r})}release(){this.uniform?.destroy(),this.uniform=this.group=this.layout=this.module=void 0,this.pipelines.clear(),this.capacity=this.samples=0}};function D(e,t,n){let r=Math.hypot(n[0],n[1],n[2]);e[t]=n[0]/r,e[t+1]=n[1]/r,e[t+2]=n[2]/r,e[t+3]=n[3]}var O=[`none`,`frustum`,`occlusion`],k=0,A=class o{coreRequirement=r(`1.0.0`,import.meta.url);static attach(e,t,i){n(e,r(`1.0.0`,import.meta.url));let a=new o(t,i);return e.use(a),a}constructor(n,{culling:r=`frustum`,occluderSize:i=8,bounds:a=`sphere`}={}){if(this.name=`culling:`+ ++k,this.disposed=!1,this.low=1/0,this.high=0,this.hiddenLow=1/0,this.hiddenHigh=0,this.uniform=new ArrayBuffer(448),this.floats=new Float32Array(this.uniform),this.words=new Uint32Array(this.uniform),this.frame=new Float32Array(32),this.buffers={},this.geometryBuffers=new Map,this.groups={},this.samples=0,this.base={shader:``,format:``},this.pipelineKey=``,this.bindings=[],this.color={view:void 0,loadOp:`load`,storeOp:`store`},this.target={view:void 0,depthLoadOp:`load`,depthStoreOp:`store`},this.main={colorAttachments:[this.color],depthStencilAttachment:this.target},!Array.isArray(n)||!n.length)throw TypeError(`Expected culled batches`);if(!O.includes(r))throw TypeError(`Invalid culling mode; use "none", "frustum" or "occlusion"`);if(a!==`sphere`&&a!==`box`)throw TypeError(`Invalid culling bounds; use "sphere" or "box"`);this.boxes=a===`box`,this.culling=r,this.occluderSize=i;let o=[],s=0;for(let r of n){if(!(r?.geometry instanceof t)||!(r.material instanceof e)||!(r.transforms instanceof Float32Array)||!r.transforms.length||r.transforms.length%16)throw TypeError(`Invalid culled batch; give each batch a geometry, a PbrMaterial and a non-empty Float32Array of 16-float matrices`);o.push(s),s+=r.transforms.length/16}if(s>1e6)throw RangeError(`Culled instances: at most 1,000,000`);this.batches=n.map(e=>({...e})),this.slots=s,this.starts=o,this.records=new Float32Array(s*24),this.bounds=new Float32Array(n.length*4),this.shapes=new Float32Array(n.length*(this.boxes?12:4)),this.batchOf=new Uint32Array(s),this.hidden=new Uint32Array(s),this.flipped=new Uint8Array(s),this.flips=new Uint32Array(n.length),this.table=new Uint32Array(n.length*4),this.args=new Uint32Array(n.length*5),this.earlyReset=new Uint32Array(n.length*5),n.forEach((e,t)=>{let r=o[t],i=r+e.transforms.length/16;this.table.set([r,i,e.geometry.indices.length,0],t*4),this.bounds.set(e.geometry.bounds,t*4),this.shapes.set(e.geometry.bounds,t*4),this.boxes&&j(e.geometry.vertices,this.shapes,(n.length+t*2)*4),this.args[t*5]=this.earlyReset[t*5]=e.geometry.indices.length;for(let n=r;n<i;n++)this.batchOf[n]=t,this.records.set(e.material.data,n*24+16),this.records[n*24+23]=-1,this.write(n,e.transforms.subarray((n-r)*16,(n-r+1)*16))})}get count(){return this.slots}setTransform(e,t,n){let r=this.index(e,t);this.write(r,n),this.dirty(r)}setVisible(e,t,n){let r=this.index(e,t);if(typeof n!=`boolean`)throw TypeError(`Invalid visibility; pass true or false`);this.show(r,+!n)}addOccluder(e){return(this.outside??=new E).add(e),this}removeOccluder(e){return this.outside?.remove(e),this}async readCounts(){let e=this.device;if(!e)throw new a(`state`,`CulledInstances is not attached; attach it to an engine first`);let t=this.args.byteLength,n=e.createBuffer({size:t,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST});try{let r=e.createCommandEncoder();r.copyBufferToBuffer(this.buffers.args,0,n,0,t),e.queue.submit([r.finish()]),await n.mapAsync(GPUMapMode.READ);let i=new Uint32Array(n.getMappedRange().slice(0));return n.unmap(),this.starts.map((e,t)=>i[t*5+1])}finally{n.destroy()}}setup(e){if(this.disposed||!e.gpu)throw new a(this.disposed?`disposed`:`unsupported`,`CulledInstances requires WebGPU; attach a new CulledInstances to a WebGPU engine; see https://margoengine.com/errors#webgpu`);this.engine=e;let t=this.device=e.gpu,n=this.slots,r=this.batches.length,o=(e,n,r,i)=>{if(n>t.limits.maxStorageBufferBindingSize)throw RangeError(`Culled instances exceed GPU buffer limits; split the instances across fewer or smaller batches`);let a=this.buffers[e]=t.createBuffer({size:Math.max(16,Math.ceil(n/4)*4),usage:r|GPUBufferUsage.COPY_DST});return i&&t.queue.writeBuffer(a,0,i),a},s=GPUBufferUsage.STORAGE;try{o(`uniform`,448,GPUBufferUsage.UNIFORM),o(`frame`,128,GPUBufferUsage.UNIFORM),o(`levels`,4096,GPUBufferUsage.UNIFORM,p()),o(`records`,n*96,s|GPUBufferUsage.VERTEX,this.records),o(`drawn`,n*96,s|GPUBufferUsage.VERTEX),o(`hidden`,n*4,s|GPUBufferUsage.VERTEX,this.hidden),o(`bounds`,this.shapes.byteLength,s,this.shapes),o(`visible`,n*4,s),o(`local`,n*4,s),o(`groups`,Math.ceil(n/256)*4,s),o(`batchOf`,n*4,s,this.batchOf),o(`batches`,r*16,s,this.table),o(`args`,r*20,s|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_SRC,this.args),o(`earlyArgs`,r*20,s|GPUBufferUsage.INDIRECT),o(`earlyList`,n*4,s|GPUBufferUsage.VERTEX);for(let{geometry:e}of this.batches)if(e.indices.length&&!this.geometryBuffers.has(e)){let n=t.createBuffer({size:e.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),r=t.createBuffer({size:e.indices.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});this.geometryBuffers.set(e,{vertex:n,index:r}),t.queue.writeBuffer(n,0,e.vertices),t.queue.writeBuffer(r,0,e.indices)}}catch(e){throw this.release(),e}this.low=this.hiddenLow=1/0,this.high=this.hiddenHigh=0;let c=this.buffers.records;_(t,()=>i(()=>import(`./compat-BKAGbQv4-DF4BNMuB.js`),[],import.meta.url))?.then(({instancesRoute:e})=>{this.buffers.records===c&&(this.route=e({records:this.records,hidden:this.hidden,bounds:this.bounds,batchOf:this.batchOf,starts:this.starts,count:n},this.args,r))})}registerPasses(e){e.add({name:this.name+`:base`,order:-Number.MAX_VALUE,execute:e=>{if(e.backend!==`webgpu`)return;let t=this.base;t.shader=e.shader,t.format=e.format,t.descriptor=e.descriptor}}),e.add({name:this.name,order:1,joins:!0,execute:e=>{e.backend===`webgpu`&&this.draw(e)}})}show(e,t){this.hidden[e]=t,e<this.hiddenLow&&(this.hiddenLow=e),e>=this.hiddenHigh&&(this.hiddenHigh=e+1)}index(e,t){let n=this.starts[e],r=e+1<this.starts.length?this.starts[e+1]:this.slots;if(!Number.isInteger(e)||n===void 0||!Number.isInteger(t)||t<0||n+t>=r)throw RangeError(`Invalid culled instance; pass a batch index and an instance index inside that batch`);return n+t}dirty(e){e<this.low&&(this.low=e),e>=this.high&&(this.high=e+1)}flush(e){if(this.high>this.low){let{low:t,high:n}=this;e.queue.writeBuffer(this.buffers.records,t*96,this.records,t*24,(n-t)*24),this.low=1/0,this.high=0}if(this.hiddenHigh>this.hiddenLow){let{hiddenLow:t,hiddenHigh:n}=this;e.queue.writeBuffer(this.buffers.hidden,t*4,this.hidden,t,n-t),this.hiddenLow=1/0,this.hiddenHigh=0}}determinant(e){if(e?.length!==16)throw TypeError(`Expected 16 matrix values`);let t=0;for(let n=0;n<16;n++)t+=Math.fround(e[n]);if(!Number.isFinite(t))throw RangeError(`Invalid instance transform: pass 16 finite float32 values`);if(!ArrayBuffer.isView(e)){for(let t=0;t<16;t++)if(typeof e[t]!=`number`)throw RangeError(`Invalid instance transform: pass 16 finite float32 values`)}let n=e[0]*(e[5]*e[10]-e[6]*e[9])-e[4]*(e[1]*e[10]-e[2]*e[9])+e[8]*(e[1]*e[6]-e[2]*e[5]);if(e[3]||e[7]||e[11]||e[15]!==1||!Number.isFinite(n)||!n)throw RangeError(`Expected nonsingular affine instance transforms`);return n}backFaces(e){return this.batches[e].material.data[6]>=.5||this.flips[e]>0}singleSided(e){return this.batches[e].material.data[6]<.5}write(e,t){let n=this.determinant(t),r=this.records,i=e*24;for(let e=0;e<16;e++)r[i+e]=t[e];let a=+(n<0);this.flips[this.batchOf[e]]+=a-this.flipped[e],this.flipped[e]=a}bind(e,t){return this.device.createBindGroup({layout:e.getBindGroupLayout(0),entries:t.map(([e,t])=>({binding:e,resource:t}))})}build(e){let t=e.device,n=e.descriptor.multisample?.count??1,r=this.buffers,i=t.createShaderModule({code:l(n,this.boxes)}),a=e=>t.createComputePipeline({layout:`auto`,compute:{module:i,entryPoint:e}});this.compute={early:a(`early`),depth0:a(`depth0`),reduce:a(`reduce`),cull:a(`cull`),scan:a(`scan`),scatter:a(`scatter`)},this.prepass={plain:m(t,n,!1),sided:m(t,n,!0)};let o=e=>({buffer:r[e]}),s=this.compute;this.groups.early=this.bind(s.early,[[0,o(`uniform`)],[1,o(`hidden`)],[2,o(`visible`)],[6,o(`batchOf`)],[7,o(`batches`)],[9,o(`earlyArgs`)],[10,o(`earlyList`)],[11,o(`records`)],[15,o(`bounds`)]]),this.groups.scan=this.bind(s.scan,[[0,o(`uniform`)],[4,o(`groups`)]]),this.groups.scatter=this.bind(s.scatter,[[0,o(`uniform`)],[2,o(`visible`)],[3,o(`local`)],[4,o(`groups`)],[6,o(`batchOf`)],[7,o(`batches`)],[8,o(`args`)],[11,o(`records`)],[12,o(`drawn`)]]),this.groups.prepass=this.bind(this.prepass.plain,[[0,o(`uniform`)],[11,o(`records`)]]),this.groups.sided=this.bind(this.prepass.sided,[[0,o(`uniform`)],[11,o(`records`)]]),this.samples=n,this.hiz?.destroy(),this.hiz=new h(t,n,this.compute,r.uniform,r.levels,this.words)}resize(e,t){let n=this.buffers,r=this.hiz;r.resize(e,t);let i={buffer:r.buffer};this.groups.cull=this.bind(this.compute.cull,[[0,{buffer:n.uniform}],[1,{buffer:n.hidden}],[2,{buffer:n.visible}],[3,{buffer:n.local}],[4,{buffer:n.groups}],[5,i],[6,{buffer:n.batchOf}],[11,{buffer:n.records}],[15,{buffer:n.bounds}]])}draw(e){let t=e.device,n=this.buffers;(!this.compute||(e.descriptor.multisample?.count??1)!==this.samples)&&this.build(e);let[r,i]=b(e),a=this.hiz;(e.view?r>a.width||i>a.height:r!==a.width||i!==a.height)&&this.resize(Math.max(r,e.view?a.width:0),Math.max(i,e.view?a.height:0)),a.plan(r,i);let o=this.culling===`occlusion`&&d(e.shader),s=o?2:this.culling===`none`?0:1;if(!(this.occluderSize>=0))throw RangeError(`Invalid occluder size; set occluderSize to a number of 0 or more`);let c=e.camera.matrix,l=this.floats;l.set(c),l.set(e.camera.planes,16),this.words.set([r,i,a.levels,this.slots,s,this.batches.length,f(c)],40),l[47]=this.occluderSize,t.queue.writeBuffer(n.uniform,0,this.words),this.flush(t);let u=this.engine.lighting;this.frame.set(e.camera.matrix),this.frame.set(e.camera.position,16),D(this.frame,20,u.direction),this.frame.set(u.radiance,24),this.frame.fill(1,28,31),u.ambient&&this.frame.set(u.ambient,28),t.queue.writeBuffer(n.frame,0,this.frame);let p=this.compute,m=Math.ceil(this.slots/256);if(this.route)this.route(t,n,e.camera.planes,s>0);else{if(o){t.queue.writeBuffer(n.earlyArgs,0,this.earlyReset);let o=e.encoder.beginComputePass();o.setPipeline(p.early),o.setBindGroup(0,this.groups.early),o.dispatchWorkgroups(m),o.end();let s=e.encoder.beginRenderPass(a.pass);e.view&&s.setViewport(0,0,r,i,0,1),this.batches.forEach((e,t)=>{if(!e.geometry.indices.length)return;let n=this.singleSided(t);s.setPipeline(n?this.prepass.sided:this.prepass.plain),s.setBindGroup(0,n?this.groups.sided:this.groups.prepass);let r=this.geometryBuffers.get(e.geometry);s.setVertexBuffer(0,r.vertex),this.drawOccluders(s,t,r.index)}),this.outside?.draw(s,e,this.engine,this.samples),s.end()}let s=e.encoder.beginComputePass();o&&a.encode(s,r,i),s.setPipeline(p.cull),s.setBindGroup(0,this.groups.cull),s.dispatchWorkgroups(m),s.setPipeline(p.scan),s.setBindGroup(0,this.groups.scan),s.dispatchWorkgroups(1),s.setPipeline(p.scatter),s.setBindGroup(0,this.groups.scatter),s.dispatchWorkgroups(m),s.end()}this.refine(e);let h=this.base,g=!e.bindings.length&&e.shader===h.shader&&e.format===h.format&&e.descriptor===h.descriptor,_=e.shader+e.format+e.descriptor.multisample?.count+e.descriptor.depthStencil.format+g;if(_!==this.pipelineKey){let n=t.createShaderModule({code:e.shader}),r={...e.descriptor.fragment,module:n,targets:[{format:e.format}]},i={...e.descriptor,vertex:{...e.descriptor.vertex,module:n},fragment:r};this.pipeline=t.createRenderPipeline(i),this.culledPipeline=e.shader.includes(`override C=`)?t.createRenderPipeline({...i,primitive:{...e.descriptor.primitive,cullMode:`back`},fragment:g?{...r,constants:{...r.constants,C:1}}:r}):void 0,this.pipelineKey=_,this.group=this.culledGroup=void 0}if(!this.group||!M(this.bindings,e.bindings)){let t=[[0,{buffer:n.frame}],...e.bindings.map(e=>[e.binding,e.resource])];this.group=this.bind(this.pipeline,t),this.culledGroup=this.culledPipeline&&this.bind(this.culledPipeline,t),this.bindings=e.bindings.map(({binding:e,resource:t})=>({binding:e,resource:`buffer`in t?{...t}:t}))}this.color.view=e.color,this.target.view=e.depth,this.target.stencilReadOnly=e.descriptor.depthStencil.format.includes(`stencil`)||void 0,this.target.stencilLoadOp=this.target.stencilStoreOp=void 0,this.color.resolveTarget=void 0,this.color.loadOp=this.target.depthLoadOp=`load`,this.color.storeOp=this.target.depthStoreOp=`store`,e.attach?.(this.color,this.target,!0);let v=e.encoder.beginRenderPass(this.main);x(v,e);let y;this.batches.forEach((e,t)=>{if(!e.geometry.indices.length)return;let n=this.culledPipeline&&!this.backFaces(t),r=n?this.culledPipeline:this.pipeline;r!==y&&(y=r,v.setPipeline(r),v.setBindGroup(0,n?this.culledGroup:this.group));let i=this.geometryBuffers.get(e.geometry);v.setVertexBuffer(0,i.vertex),this.drawBatch(v,t,i.index)}),v.end()}drawOccluders(e,t,n){let r=this.buffers;e.setVertexBuffer(1,r.earlyList,this.starts[t]*4),e.setIndexBuffer(n,`uint32`),e.drawIndexedIndirect(r.earlyArgs,t*20)}refine(e){}drawBatch(e,t,n){let r=this.buffers;e.setVertexBuffer(1,r.drawn,this.starts[t]*96),e.setIndexBuffer(n,`uint32`),e.drawIndexedIndirect(r.args,t*20)}release(){this.route=void 0,this.outside?.release();for(let e of Object.values(this.buffers))e.destroy();for(let e of this.geometryBuffers.values())e.vertex.destroy(),e.index.destroy();this.hiz?.destroy(),this.buffers={},this.geometryBuffers.clear(),this.groups={},this.hiz=void 0,this.compute=this.prepass=this.pipeline=this.group=this.culledPipeline=this.culledGroup=void 0,this.pipelineKey=``,this.bindings=[],this.samples=0,this.device=void 0}onDeviceRestored(e){this.release(),this.setup(e)}dispose(){this.disposed||(this.disposed=!0,this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.engine=void 0)}[Symbol.dispose??Symbol()](){this.dispose()}};function j(e,t,n){if(!e.length)t.fill(0,n,n+8);else for(let r=0;r<3;r++){let i=1/0,a=-1/0;for(let t=r;t<e.length;t+=6)e[t]<i&&(i=e[t]),e[t]>a&&(a=e[t]);t[n+r]=(i+a)/2,t[n+4+r]=(a-i)/2}}function M(e,t){return e.length===t.length&&e.every((e,n)=>{let r=e.resource,i=t[n].resource;return e.binding===t[n].binding&&(r===i||r.buffer!==void 0&&r.buffer===i.buffer&&r.offset===i.offset&&r.size===i.size)})}var N=`struct Input {@builtin(instance_index) n:u32,@location(0) p:vec3f,@location(2) a:vec4f,@location(3) b:vec4f,@location(4) c:vec4f,@location(5) d:vec4f,@location(6) factors:vec4f,@location(7) hidden:u32}
const away=vec4f(2.0,2.0,2.0,1.0);

@group(0) @binding(0) var<uniform> light:mat4x4f;
@vertex fn vertex(i:Input)->@builtin(position) @invariant vec4f {
  if(i.hidden!=0u){return away;}
  return light*mat4x4f(i.a,i.b,i.c,i.d)*vec4f(i.p,1);
}
`,P=`struct Input {@builtin(instance_index) n:u32,@location(0) p:vec3f,@location(2) a:vec4f,@location(3) b:vec4f,@location(4) c:vec4f,@location(5) d:vec4f,@location(6) factors:vec4f,@location(7) hidden:u32}
const away=vec4f(2.0,2.0,2.0,1.0);

@group(0) @binding(0) var<uniform> camera:mat4x4f;
struct Output {@builtin(position) clip:vec4f,@location(0) @interpolate(flat) id:u32,@location(1) @interpolate(flat) side:vec2f}
@vertex fn vertex(i:Input)->Output {
  let m=mat4x4f(i.a,i.b,i.c,i.d);var o:Output;o.clip=away;
  if(i.hidden==0u){o.clip=camera*m*vec4f(i.p,1);}
  o.id=i.n+1u;o.side=vec2f(select(-1.0,1.0,dot(m[0].xyz,cross(m[1].xyz,m[2].xyz))>=0.0),i.factors.z);return o;
}
@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) u32 {
  if(front!=(i.side.x>0.0)&&i.side.y<0.5){discard;}
  return i.id;
}
`,F=[{arrayStride:24,attributes:[{shaderLocation:0,offset:0,format:`float32x3`}]},{arrayStride:96,stepMode:`instance`,attributes:[...[2,3,4,5].map((e,t)=>({shaderLocation:e,offset:t*16,format:`float32x4`})),{shaderLocation:6,offset:80,format:`float32x4`}]},{arrayStride:4,stepMode:`instance`,attributes:[{shaderLocation:7,offset:0,format:`uint32`}]}],I=2;function L(t){return Array.isArray(t)?t.map(t=>{if(!(t?.transforms instanceof Float32Array)||t.transforms.length%16)return t;let n=t.transforms.length/16;if(t.materials!==void 0&&(!Array.isArray(t.materials)||t.materials.length!==n||t.materials.some(t=>!(t instanceof e))))throw TypeError(`Invalid culled batch materials; pass one PbrMaterial per part of transforms`);if(t.capacity===void 0)return t;if(!Number.isInteger(t.capacity)||t.capacity<n)throw RangeError(`Invalid culled batch capacity; pass a whole number no smaller than its part count`);let r=new Float32Array(t.capacity*16);r.set(t.transforms);for(let e=n;e<t.capacity;e++)for(let t=0;t<16;t+=5)r[e*16+t]=1;return{...t,transforms:r}}):t}var R=class t extends A{static attach(e,i,a){n(e,r(`1.0.0`,import.meta.url));let o=new t(i,a);return e.use(o),o}constructor(t,n){super(L(t),n),this.shadowVersion=0,this.live=0,this.scratch=new e,this.product=new Float32Array(16),this.odd=new Uint32Array(t.length),this.free=t.map((e,t)=>{let n=e.transforms.length/16,r=[];for(let i=(e.capacity??n)-1;i>=n;i--)this.hidden[this.starts[t]+i]=I,r.push(i);return this.live+=n,e.materials?.forEach((e,n)=>this.paint(this.starts[t]+n,e.data)),r})}get count(){return this.live}setTransform(e,t,n){this.place(this.index(e,t),n)}setMaterial(t,n,r){let i=this.index(t,n);if(r instanceof e){this.paint(i,r.data);return}let a=this.scratch;a.data.set(this.records.subarray(i*24+16,i*24+23)),a.set(r),this.paint(i,a.data)}setColor(e,t,n){this.setMaterial(e,t,{color:n})}getMaterial(e,t){let n=this.index(e,t)*24+16,r=this.records;return{color:[r[n],r[n+1],r[n+2]],roughness:r[n+4],metalness:r[n+5],doubleSided:r[n+6]>=.5}}setParent(e,t,n){let r=this.index(e,t),i=n?this.index(n.batch,n.index):-1,a=this.parents??=new Int32Array(this.slots).fill(-1),o=this.locals??=new Float32Array(this.slots*16),s=this.children??=new Map;for(let e=i;e>=0;e=a[e])if(e===r)throw RangeError(`Invalid culled parent; pick a part outside this part's own subtree`);let c=a[r];if(c>=0?this.unlink(r,c):i>=0&&o.set(this.records.subarray(r*24,r*24+16),r*16),a[r]=i,i>=0){let e=s.get(i);e?e.push(r):s.set(i,[r]),this.place(r,o.subarray(r*16,r*16+16))}}getWorldMatrix(e,t,n=new Float32Array(16)){let r=this.index(e,t)*24;for(let e=0;e<16;e++)n[e]=this.records[r+e];return n}addParts(t,n,r){let i=this.free[t];if(!i)throw RangeError(`Invalid culled batch index; pass a batch index from 0 up to the batch count`);if(!(n instanceof Float32Array)||n.length%16)throw TypeError(`Invalid culled parts; pass a Float32Array of 16-float matrices`);let a=n.length/16;if(a>i.length)throw RangeError(`Culled batch ${t} has ${i.length} free slots for ${a} parts; set a larger capacity on the batch`);if(r&&(r.length!==a||r.some(t=>!(t instanceof e))))throw TypeError(`Invalid culled part materials; pass one PbrMaterial per new part`);for(let e=0;e<a;e++)this.determinant(n.subarray(e*16,e*16+16));let o=[];for(let e=0;e<a;e++){let a=i.pop(),s=this.starts[t]+a;this.show(s,0),this.place(s,n.subarray(e*16,e*16+16)),r&&this.paint(s,r[e].data),o.push(a)}return this.live+=a,o}removeParts(e,t){let n=t.map(t=>this.index(e,t)),r=new Set(n);if(r.size!==n.length)throw RangeError(`Invalid culled parts; list each part to remove once`);for(let e of n)if(this.children?.get(e)?.some(e=>!r.has(e)))throw RangeError(`Culled part still has children; detach them with setParent or remove them too`);n.forEach((n,r)=>{let i=this.parents?.[n]??-1;i>=0&&this.unlink(n,i),this.parents&&(this.parents[n]=-1),this.flips[e]-=this.flipped[n],this.flipped[n]=0,this.paint(n,this.batches[e].material.data),this.show(n,I),this.free[e].push(t[r])}),this.live-=n.length}pick(e,t){if(!this.engine||!this.device)return Promise.reject(new a(`state`,`CulledInstances is not attached; attach it to an engine first`));if(!Number.isFinite(e)||!Number.isFinite(t))return Promise.reject(RangeError(`Invalid pick; pass finite CSS pixels`));let n=(this.picking??Promise.resolve(null)).then(()=>this.pickNow(e,t),()=>this.pickNow(e,t));return this.picking=n,n}drawShadow({context:e,pass:t,matrix:n,cascade:r}){let i=e.device;if(!this.device)return;let a=this.shadow??=(()=>{let e=i.createShaderModule({code:N}),t=i.createRenderPipeline({layout:`auto`,vertex:{module:e,entryPoint:`vertex`,buffers:F},depthStencil:{format:`depth32float`,depthWriteEnabled:!0,depthCompare:`less-equal`}}),n=[],r=[];for(let e=0;e<4;e++){let e=i.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});n.push(e),r.push(this.bind(t,[[0,{buffer:e}]]))}return{pipeline:t,uniforms:n,groups:r}})();this.flush(i),i.queue.writeBuffer(a.uniforms[r],0,n),t.setPipeline(a.pipeline),t.setBindGroup(0,a.groups[r]),this.drawParts(t,r)}drawParts(e,t){e.setVertexBuffer(1,this.buffers.records),e.setVertexBuffer(2,this.buffers.hidden),this.batches.forEach((t,n)=>{if(!t.geometry.indices.length)return;let r=this.geometryBuffers.get(t.geometry),i=this.table;e.setVertexBuffer(0,r.vertex),e.setIndexBuffer(r.index,`uint32`),e.drawIndexed(t.geometry.indices.length,i[n*4+1]-i[n*4],0,0,i[n*4])})}async pickNow(e,t){let n=this.engine,r=this.device;if(!n||!r)return null;let i=n.canvas,a=i.clientWidth||i.width,o=i.clientHeight||i.height;if(e<0||t<0||e>=a||t>=o)return null;let s=this.picker??=(()=>{let e=r.createShaderModule({code:P}),t=r.createRenderPipeline({layout:`auto`,vertex:{module:e,entryPoint:`vertex`,buffers:F},fragment:{module:e,entryPoint:`fragment`,targets:[{format:`r32uint`}]},depthStencil:{format:`depth32float`,depthWriteEnabled:!0,depthCompare:`greater-equal`}}),n=r.createBuffer({size:64,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),i=r.createTexture({size:[1,1],format:`r32uint`,usage:17}),a=r.createTexture({size:[1,1],format:`depth32float`,usage:16});return{pipeline:t,uniform:n,ids:i,depth:a,group:this.bind(t,[[0,{buffer:n}]]),descriptor:{colorAttachments:[{view:i.createView(),clearValue:[0,0,0,0],loadOp:`clear`,storeOp:`store`}],depthStencilAttachment:{view:a.createView(),depthClearValue:0,depthLoadOp:`clear`,depthStoreOp:`discard`}}}})(),c=n.camera.matrix,l=this.product,u=Math.floor(e*i.width/a)+.5,d=Math.floor(t*i.height/o)+.5;for(let e=0;e<4;e++){let t=c[e*4+3];l[e*4]=c[e*4]*i.width-(2*u-i.width)*t,l[e*4+1]=c[e*4+1]*i.height+(2*d-i.height)*t,l[e*4+2]=c[e*4+2],l[e*4+3]=t}r.queue.writeBuffer(s.uniform,0,l),this.flush(r);let f=r.createBuffer({size:4,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});try{let e=r.createCommandEncoder(),t=e.beginRenderPass(s.descriptor);t.setPipeline(s.pipeline),t.setBindGroup(0,s.group),this.drawParts(t),t.end(),e.copyTextureToBuffer({texture:s.ids},{buffer:f},[1,1]),r.queue.submit([e.finish()]),await f.mapAsync(GPUMapMode.READ);let n=new Uint32Array(f.getMappedRange().slice(0))[0]-1;if(f.unmap(),n<0||n>=this.slots||this.hidden[n])return null;let i=this.batchOf[n];return{batch:i,index:n-this.starts[i]}}finally{f.destroy()}}paint(e,t){let n=e*24+16,r=this.records,i=this.batchOf[e],a=this.batches[i].material.data[6]>=.5;this.odd[i]+=+(t[6]>=.5!==a)-(r[n+6]>=.5!==a);for(let e=0;e<7;e++)r[n+e]=t[e];this.dirty(e)}backFaces(e){return this.odd[e]>0||super.backFaces(e)}singleSided(e){return this.odd[e]>0||super.singleSided(e)}unlink(e,t){let n=this.children.get(t);n.splice(n.indexOf(e),1),n.length||this.children.delete(t)}show(e,t){super.show(e,t),this.shadowVersion++}place(e,t){let n=this.parents?.[e]??-1;n>=0?(this.write(e,this.fold(n,t,0)),this.locals.set(t,e*16)):this.write(e,t),this.dirty(e),this.shadowVersion++;let r=this.children?.get(e);if(!r)return;let i=[...r];for(;i.length;){let e=i.pop();this.write(e,this.fold(this.parents[e],this.locals,e*16)),this.dirty(e);let t=this.children.get(e);t&&i.push(...t)}}fold(e,t,n){let r=this.records,i=e*24,a=this.product;for(let e=0;e<4;e++)for(let o=0;o<4;o++)a[e*4+o]=r[i+o]*t[n+e*4]+r[i+4+o]*t[n+e*4+1]+r[i+8+o]*t[n+e*4+2]+r[i+12+o]*t[n+e*4+3];return a}index(e,t){let n=super.index(e,t);if(this.hidden[n]===I)throw RangeError(`Invalid culled instance; pass a batch index and an instance index inside that batch`);return n}release(){for(let e of this.shadow?.uniforms??[])e.destroy();this.picker?.uniform.destroy(),this.picker?.ids.destroy(),this.picker?.depth.destroy(),this.shadow=this.picker=void 0,super.release()}};function z(e,{maxVertices:t=64,maxTriangles:n=124}={}){if(!Number.isInteger(t)||t<3)throw RangeError(`Invalid maxVertices; pass a whole number of 3 or more`);if(!Number.isInteger(n)||n<1)throw RangeError(`Invalid maxTriangles; pass a whole number of 1 or more`);let r=e.indices,i=e.vertices,a=Math.floor(r.length/3),o=i.length/6,s=new Uint32Array(o+1);for(let e=0;e<a*3;e++)s[r[e]+1]++;for(let e=0;e<o;e++)s[e+1]+=s[e];let c=s.slice(),l=new Uint32Array(a*3);for(let e=0;e<a*3;e++)l[c[r[e]]++]=Math.floor(e/3);let u=new Uint8Array(a),d=new Uint32Array(a),f=new Uint32Array(o),p=new Uint32Array(a*3),m=[],h=[],g=0,_=0;for(let e=0;e<a;e++){if(u[e])continue;let a=g,o=[e];_++,d[e]=_;let c=0,v=0;for(let e=0;e<o.length&&v<n;e++){let n=o[e];if(u[n])continue;let i=0;for(let e=0;e<3;e++){let t=r[n*3+e];f[t]!==_&&(e<1||t!==r[n*3])&&(e<2||t!==r[n*3+1])&&i++}if(!(c+i>t)){c+=i,u[n]=1,v++;for(let e=0;e<3;e++){let t=r[n*3+e];f[t]=_,p[g++]=t;for(let e=s[t];e<s[t+1];e++){let t=l[e];!u[t]&&d[t]!==_&&(d[t]=_,o.push(t))}}}}m.push(a,g-a),B(i,p,a,g,h)}return{count:m.length/2,indices:p,ranges:new Uint32Array(m),bounds:new Float32Array(h)}}function B(e,t,n,r,i){let a=[1/0,1/0,1/0],o=[-1/0,-1/0,-1/0];for(let i=n;i<r;i++)for(let n=0;n<3;n++){let r=e[t[i]*6+n];r<a[n]&&(a[n]=r),r>o[n]&&(o[n]=r)}let s=a.map((e,t)=>(e+o[t])/2),c=0;for(let i=n;i<r;i++){let n=t[i]*6;c=Math.max(c,Math.hypot(e[n]-s[0],e[n+1]-s[1],e[n+2]-s[2]))}let l=[],u=[0,0,0];for(let i=n;i<r;i+=3){let n=t[i]*6,r=t[i+1]*6,a=t[i+2]*6,o=[0,1,2].map(t=>e[r+t]-e[n+t]),s=[0,1,2].map(t=>e[a+t]-e[n+t]),c=[o[1]*s[2]-o[2]*s[1],o[2]*s[0]-o[0]*s[2],o[0]*s[1]-o[1]*s[0]],d=Math.hypot(c[0],c[1],c[2]);if(!d)continue;let f=c.map(e=>e/d);l.push(f);for(let e=0;e<3;e++)u[e]+=f[e]}let d=Math.hypot(u[0],u[1],u[2]),f=d?1:-1;if(d){for(let e=0;e<3;e++)u[e]/=d;for(let e of l)f=Math.min(f,e[0]*u[0]+e[1]*u[1]+e[2]*u[2])}i.push(s[0],s[1],s[2],c,u[0],u[1],u[2],f>0?Math.sqrt(1-f*f):-1)}var V=(e,t)=>`
struct Frame {planes:array<vec4f,6>,eye:vec4f,size:vec4u,list:vec4u}
struct Record {m:mat4x4f,color:vec4f,factors:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<storage,read> parts:array<Record>;
@group(0) @binding(2) var<storage,read> bounds:array<vec4f>;
@group(0) @binding(3) var<storage,read> ranges:array<vec2u>;
@group(0) @binding(5) var<storage,read_write> kept:array<u32>;
@group(0) @binding(6) var<storage,read_write> args:array<u32>;
@group(0) @binding(7) var<storage,read> live:array<u32>;
${t?`struct Cull {camera:mat4x4f,planes:array<vec4f,6>,size:vec4u,mode:vec4u,levels:array<vec4u,16>}
@group(0) @binding(8) var<uniform> u:Cull;
@group(0) @binding(9) var<storage,read> hiz:array<f32>;
${s}`:``}
var<workgroup> sums:array<u32,256>;
fn keep(n:u32,m:mat4x4f)->bool {
  let s=bounds[n*2u];let c=(m*vec4f(s.xyz,1.0)).xyz;
  var r=s.w*sqrt(max(dot(m[0].xyz,m[0].xyz),max(dot(m[1].xyz,m[1].xyz),dot(m[2].xyz,m[2].xyz))));
  r+=1e-5*(length(c)+r);
  for(var p=0u;p<6u;p++){if(dot(f.planes[p].xyz,c)+f.planes[p].w< -r){return false;}}
  ${t?`if(f.size.z!=0u&&!unoccluded(vec4f(c,r))){return false;}`:``}
  let cone=bounds[n*2u+1u];
  if(f.eye.w==0.0||cone.w<0.0){return true;}

  let a=m[0].xyz;let b=m[1].xyz;let e=m[2].xyz;let x=cross(b,e);let det=dot(a,x);
  if(det<=0.0){return true;}
  let q=f.eye.xyz-m[3].xyz;let eye=vec3f(dot(x,q),dot(cross(e,a),q),dot(cross(a,b),q))/det;

  let d=s.xyz-eye;let l=length(d);
  if(l<=s.w){return true;}
  let along=dot(d,cone.xyz);let aside=sqrt(max(l*l-along*along,0.0));
  let cosine=sqrt(1.0-cone.w*cone.w);
  return along*cosine-aside*cone.w<=s.w*(1.0+1e-4)+1e-5*l;
}

fn word(s:u32,n:u32)->u32 {return f.list.x+s*f.size.x+n;}

fn add(a:u32,b:u32)->u32 {return select(a+b,0xffffffffu,b>0xffffffffu-a);}
@compute @workgroup_size(64) fn test(@builtin(workgroup_id) w:vec3u,@builtin(local_invocation_index) l:u32) {
  let n=(w.y*65535u+w.x)*64u+l;let j=w.z;
  if(n>=f.size.x){return;}
  var size=0u;
  if(${e?`live[j]==0u`:`live[j]!=0u`}&&keep(n,parts[j].m)){size=ranges[n].y;}
  args[word(f.size.w+j,n)]=size;
}
@compute @workgroup_size(256) fn scan(@builtin(workgroup_id) w:vec3u,@builtin(local_invocation_index) l:u32) {
  let slot=f.size.w+w.x;
  var carry=0u;
  for(var first=0u;first<f.size.x;first+=256u){
    let n=first+l;
    var v=0u;
    if(n<f.size.x){v=args[word(slot,n)];}
    sums[l]=v;
    for(var d=1u;d<256u;d<<=1u){
      workgroupBarrier();
      var t=sums[l];
      if(l>=d){t+=sums[l-d];}
      workgroupBarrier();
      sums[l]=t;
    }
    workgroupBarrier();
    if(n<f.size.x){args[word(slot,n)]=select(0xffffffffu,carry+sums[l]-v,v!=0u);}
    carry+=sums[255];
    workgroupBarrier();
  }
  if(l==0u){args[slot*5u]=carry;}
}
@compute @workgroup_size(256) fn place(@builtin(local_invocation_index) l:u32) {
  let n=f.list.w;let per=(n+255u)/256u;let lo=min(l*per,n);let hi=min(lo+per,n);
  var sum=0u;
  for(var k=lo;k<hi;k++){sum=add(sum,args[(f.size.w+k)*5u]);}
  sums[l]=sum;
  for(var d=1u;d<256u;d<<=1u){
    workgroupBarrier();
    var t=sums[l];
    if(l>=d){t=add(t,sums[l-d]);}
    workgroupBarrier();
    sums[l]=t;
  }
  workgroupBarrier();
  var run=0u;
  if(l>0u){run=sums[l-1u];}
  for(var k=lo;k<hi;k++){
    let a=(f.size.w+k)*5u;let count=args[a];
    if(count!=0u&&add(run,count)>f.list.z){args[a]=f.size.y;args[a+2u]=0u;}else{args[a+2u]=f.list.y+min(run,f.list.z);}
    run=add(run,count);
  }
}
@compute @workgroup_size(64) fn copy(@builtin(workgroup_id) w:vec3u,@builtin(local_invocation_index) l:u32) {
  let n=w.y*65535u+w.x;
  if(n>=f.size.x){return;}
  let slot=f.size.w+w.z;let at=args[word(slot,n)];let first=args[slot*5u+2u];
  if(at==0xffffffffu||first<f.list.y){return;}
  let range=ranges[n];
  for(var k=l;k<range.y;k+=64u){kept[first+at+k]=kept[range.x+k];}
}
`,H=65535,U=4194304;function W(e,t,n,r,i,a){let o=t*8,s=e[o],c=e[o+1],l=e[o+2],u=e[o+3],d=n[r],f=n[r+1],p=n[r+2],m=n[r+4],h=n[r+5],g=n[r+6],_=n[r+8],v=n[r+9],y=n[r+10],b=d*s+m*c+_*l+n[r+12],x=f*s+h*c+v*l+n[r+13],S=p*s+g*c+y*l+n[r+14],C=u*Math.sqrt(Math.max(d*d+f*f+p*p,m*m+h*h+g*g,_*_+v*v+y*y));C+=1e-5*(Math.sqrt(b*b+x*x+S*S)+C);for(let e=0;e<24;e+=4)if(i[e]*b+i[e+1]*x+i[e+2]*S+i[e+3]<-C)return!1;let w=e[o+7];if(!a||w<0)return!0;let T=h*y-g*v,E=g*_-m*y,D=m*v-h*_,O=d*T+f*E+p*D;if(O<=0)return!0;let k=a[0]-n[r+12],A=a[1]-n[r+13],j=a[2]-n[r+14],M=(T*k+E*A+D*j)/O,N=((v*p-y*f)*k+(y*d-_*p)*A+(_*f-v*d)*j)/O,P=((f*g-p*h)*k+(p*m-d*g)*A+(d*h-f*m)*j)/O,F=s-M,I=c-N,L=l-P,R=Math.sqrt(F*F+I*I+L*L);if(R<=u)return!0;let z=F*e[o+4]+I*e[o+5]+L*e[o+6],B=Math.sqrt(Math.max(R*R-z*z,0));return z*Math.sqrt(1-w*w)-B*w<=u*1.0001+1e-5*R}function G(e,t,n){for(let r=0;r<6;r++){let i=r>>1,a=r&1?-1:1,o=[0,1,2,3].map(t=>r===4?e[t*4+2]:e[t*4+3]+a*e[t*4+(i===2?2:i)]),s=Math.hypot(o[0],o[1],o[2])||1;for(let e=0;e<4;e++)t[n+r*4+e]=o[e]/s}}var K=class e extends R{static attach(t,i,a){n(t,r(`1.0.0`,import.meta.url));let o=new e(i,a);return t.use(o),o}constructor(e,{maxVertices:t,maxTriangles:n,maxKeptTriangles:r,...i}={}){if(e?.length!==1)throw RangeError(`Invalid MeshletMesh; pass one batch, one mesh with its parts`);if(r!==void 0&&!(Number.isInteger(r)&&r>=0))throw RangeError(`Invalid maxKeptTriangles; pass a whole number of 0 or more`);if(super(e,i),this.clusterValues=new ArrayBuffer(144),this.clusterFloats=new Float32Array(this.clusterValues),this.clusterWords=new Uint32Array(this.clusterValues),this.whole=new Float32Array(8),this.slots>H)throw RangeError(`Invalid MeshletMesh; pass at most ${H} parts, or split them over several meshes`);this.meshlets=z(e[0].geometry,{maxVertices:t,maxTriangles:n}),this.maxKeptTriangles=r??Math.min(U,this.slots*this.triangles());let{bounds:a,count:o}=this.meshlets,s=[1/0,1/0,1/0],c=[-1/0,-1/0,-1/0];for(let e=0;e<o;e++)for(let t=0;t<3;t++)s[t]=Math.min(s[t],a[e*8+t]-a[e*8+3]),c[t]=Math.max(c[t],a[e*8+t]+a[e*8+3]);let l=o?s.map((e,t)=>(e+c[t])/2):[0,0,0],u=0;for(let e=0;e<o;e++)u=Math.max(u,Math.hypot(a[e*8]-l[0],a[e*8+1]-l[1],a[e*8+2]-l[2])+a[e*8+3]);this.whole.set([l[0],l[1],l[2],u*(1+1e-6),0,0,0,-1])}async readTriangles(){return this.cpu?this.cpu.triangles:this.readKept(this.clusters?.args,0,this.slots)}async readShadowTriangles(e){if(this.cpu){if(e<this.cpu.cascades)return this.cpu.shadowTriangles[e];let t=0;for(let e=0;e<this.slots;e++)this.hidden[e]===0&&t++;return t*this.triangles()}return this.readKept(this.shadowClusters?.args,e*this.slots,this.slots)}triangles(){return this.batches[0].geometry.indices.length/3}async readKept(e,t,n){let r=this.device;if(!r||!e)return 0;let i=r.createBuffer({size:n*20,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),a=r.createCommandEncoder();a.copyBufferToBuffer(e,t*20,i,0,n*20),r.queue.submit([a.finish()]),await i.mapAsync(GPUMapMode.READ);let o=new Uint32Array(i.getMappedRange()),s=0;for(let e=0;e<n;e++)s+=o[e*5];return i.unmap(),i.destroy(),s/3}lists(e,t){let n=this.meshlets.indices.length,r=Math.floor(e.limits.maxStorageBufferBindingSize/4)-n,i=t*this.slots;if(r<0)throw RangeError(`MeshletMesh needs ${n*4} bytes for its indices, over this device's ${e.limits.maxStorageBufferBindingSize}; split the mesh`);let a=Math.min(this.maxKeptTriangles*3,Math.floor(r/t/3)*3),o=e.createBuffer({size:Math.max((n+t*a)*4,4),usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});e.queue.writeBuffer(o,0,this.meshlets.indices);let s=new Uint32Array(i*5);for(let e=0;e<i;e++)s[e*5+1]=1;let c=e.createBuffer({size:s.byteLength+i*this.meshlets.count*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.INDIRECT|GPUBufferUsage.COPY_DST|GPUBufferUsage.COPY_SRC});return e.queue.writeBuffer(c,0,s),{kept:o,args:c,first:i*5,pool:a}}buildClusters(e){let{bounds:t,ranges:n}=this.meshlets,r=GPUBufferUsage.STORAGE,i=GPUBufferUsage.COPY_DST,a=(t,n=r)=>{let a=e.createBuffer({size:Math.max(t.byteLength,4),usage:n|i});return e.queue.writeBuffer(a,0,t),a};return{...this.lists(e,1),frame:e.createBuffer({size:144,usage:GPUBufferUsage.UNIFORM|i}),bounds:a(t),ranges:a(n),ids:a(Uint32Array.from({length:this.slots},(e,t)=>t),GPUBufferUsage.VERTEX),kernels:this.kernels(e,!1,this.culling===`occlusion`)}}kernels(e,t,n){let r=(e,t)=>({binding:e,visibility:4,buffer:{type:t}}),i=e.createBindGroupLayout({entries:[r(0,`uniform`),...[1,2,3].map(e=>r(e,`read-only-storage`)),r(5,`storage`),r(6,`storage`),r(7,`read-only-storage`),...n?[r(8,`uniform`),r(9,`read-only-storage`)]:[]]}),a=e.createShaderModule({code:V(t,n)}),o=e.createPipelineLayout({bindGroupLayouts:[i]}),s=t=>e.createComputePipeline({layout:o,compute:{module:a,entryPoint:t}});return{layout:i,test:s(`test`),scan:s(`scan`),place:s(`place`),copy:s(`copy`)}}entries(e,t,n,{kept:r,args:i}){let a=this.clusters,o=(e,t)=>({binding:e,resource:{buffer:t}});return[{binding:0,resource:e},o(1,t),o(2,a.bounds),o(3,a.ranges),o(5,r),o(6,i),o(7,n)]}cameraGroup(e){let t=this.clusters,n=this.culling===`occlusion`?this.hiz.buffer:void 0;return t.group&&t.pyramid===n?t.group:(t.pyramid=n,t.group=e.createBindGroup({layout:t.kernels.layout,entries:[...this.entries({buffer:t.frame},this.buffers.records,this.buffers.visible,t),...n?[{binding:8,resource:{buffer:this.buffers.uniform}},{binding:9,resource:{buffer:n}}]:[]]}))}listValues(e,t,n){let r=this.clusterWords,i=this.meshlets.indices.length;r[28]=this.meshlets.count,r[29]=i,r[31]=e,r[32]=t.first,r[33]=i+n*t.pool,r[34]=t.pool,r[35]=this.slots}dispatch(e,{test:t,scan:n,place:r,copy:i},a){let o=this.meshlets.count,s=Math.ceil(o/64),c=e.beginComputePass();c.setBindGroup(0,a),c.setPipeline(t),c.dispatchWorkgroups(Math.min(s,65535),Math.ceil(s/65535),this.slots),c.setPipeline(n),c.dispatchWorkgroups(this.slots),c.setPipeline(r),c.dispatchWorkgroups(1),c.setPipeline(i),c.dispatchWorkgroups(Math.min(o,65535),Math.ceil(o/65535),this.slots),c.end()}cpuRoute(e){if(this.cpu)return this.cpu;let t=this.meshlets.indices,n=e.createBuffer({size:Math.max(t.byteLength,4),usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST});return e.queue.writeBuffer(n,0,t),this.cpu={index:n,planes:new Float32Array(24),eye:new Float32Array(3),cone:!1,shadows:new Float32Array(96),cascades:0,triangles:0,shadowTriangles:new Float64Array(4)}}coneTest(e){return!this.backFaces(0)&&!!(e[3]||e[7]||e[11])}refine(e){let t=e.device,n=e.camera.matrix;if(g(t)===`webgl2`){let r=this.cpuRoute(t);r.planes.set(e.camera.planes),r.eye.set(e.camera.position.slice(0,3)),r.cone=this.coneTest(n);return}let r=this.clusters??=this.buildClusters(t),i=this.clusterFloats,a=this.clusterWords;i.set(e.camera.planes),i.set(e.camera.position.slice(0,3),24),i[27]=+!!this.coneTest(n),this.listValues(0,r,0),a[30]=this.culling===`occlusion`&&d(e.shader)?1:0,t.queue.writeBuffer(r.frame,0,this.clusterValues),this.dispatch(e.encoder,r.kernels,this.cameraGroup(t))}drawRuns(e,t,n,r){let{ranges:i,bounds:a,count:o}=this.meshlets,s=this.records;e.setIndexBuffer(this.cpu.index,`uint32`);let c=0;for(let l=0;l<this.slots;l++){let u=l*24;if(this.hidden[l]!==0||!W(this.whole,0,s,u,t,void 0))continue;let d=0,f=0,p=!1;for(let m=0;m<=o;m++){let h=m<o&&W(a,m,s,u,t,n);h&&f&&d+f===i[m*2]?f+=i[m*2+1]:(f&&(p||=(e.setVertexBuffer(1,this.buffers.records,l*96),r&&e.setVertexBuffer(2,this.buffers.hidden,l*4),!0),e.drawIndexed(f,1,d,0,0),c+=f/3),d=h?i[m*2]:0,f=h?i[m*2+1]:0)}}return c}drawBatch(e,t,n){let r=this.cpu;if(r){r.triangles=this.drawRuns(e,r.planes,r.cone?r.eye:void 0,!1);return}let i=this.clusters;if(!i)super.drawBatch(e,t,n);else{e.setIndexBuffer(i.kept,`uint32`);for(let t=0;t<this.slots;t++)this.hidden[t]===0&&(e.setVertexBuffer(1,this.buffers.records,t*96),e.drawIndexedIndirect(i.args,t*20))}}drawOccluders(e,t,n){let r=this.clusters;if(!r)super.drawOccluders(e,t,n);else{e.setIndexBuffer(r.kept,`uint32`);for(let t=0;t<this.slots;t++)this.hidden[t]===0&&(e.setVertexBuffer(1,r.ids,t*4),e.drawIndexedIndirect(r.args,t*20))}}prepareShadow({context:e,matrices:t,cascades:n}){let r=e.device;if(!this.device)return;if(g(r)===`webgl2`){let e=this.cpuRoute(r);for(let r=0;r<n;r++)G(t.subarray(r*16,r*16+16),e.shadows,r*24);e.cascades=n;return}this.clusters??=this.buildClusters(r);let i=this.shadowClusters;if(!i){let e=this.lists(r,4),t=this.kernels(r,!0,!1),n=r.createBuffer({size:1024,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),a=[0,1,2,3].map(i=>r.createBindGroup({layout:t.layout,entries:this.entries({buffer:n,offset:i*256,size:144},this.buffers.records,this.buffers.hidden,e)}));i=this.shadowClusters={...e,frames:n,kernels:t,groups:a,cascades:0}}this.flush(r);let a=this.clusterFloats,o=this.clusterWords;for(let s=0;s<n;s++)G(t.subarray(s*16,s*16+16),a,0),a.fill(0,24,28),this.listValues(s*this.slots,i,s),o[30]=0,r.queue.writeBuffer(i.frames,s*256,this.clusterValues),this.dispatch(e.encoder,i.kernels,i.groups[s]);i.cascades=n}drawParts(e,t){if(!this.batches[0].geometry.indices.length)return;let n=this.cpu,r=this.shadowClusters;if(t!==void 0&&n&&t<n.cascades)e.setVertexBuffer(0,this.geometryBuffers.get(this.batches[0].geometry).vertex),n.shadowTriangles[t]=this.drawRuns(e,n.shadows.subarray(t*24,t*24+24),void 0,!0);else if(t===void 0||!r||t>=r.cascades)super.drawParts(e);else{e.setVertexBuffer(0,this.geometryBuffers.get(this.batches[0].geometry).vertex),e.setIndexBuffer(r.kept,`uint32`);for(let n=0;n<this.slots;n++)e.setVertexBuffer(1,this.buffers.records,n*96),e.setVertexBuffer(2,this.buffers.hidden,n*4),e.drawIndexedIndirect(r.args,(t*this.slots+n)*20)}}release(){let e=this.clusters,t=this.shadowClusters;if(e)for(let t of[e.frame,e.bounds,e.ranges,e.ids,e.kept,e.args])t.destroy();if(t)for(let e of[t.frames,t.kept,t.args])e.destroy();this.cpu?.index.destroy(),this.clusters=this.shadowClusters=this.cpu=void 0,super.release()}};function q({positions:n,normals:r,indices:i}){let a=new K([{geometry:new t(n,r,i),material:new e({color:`#b8814c`,roughness:.38,metalness:.45,doubleSided:!1}),transforms:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,.24,0,1])}],{culling:`occlusion`});return performance.mark(`statue-clustered`),{statue:a,total:i.length/3}}export{q as cluster};