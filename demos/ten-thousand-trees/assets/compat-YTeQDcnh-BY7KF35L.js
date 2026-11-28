import{T as e}from"./index-Cqd1G9Ju.js";import{a as t,i as n,o as r,r as i}from"./dist-BxXSEJ9y.js";var a=()=>new e(`unsupported`,`Scatter on WebGL2 needs the shader its compatibility route was written for; update the edits in scatter/src/compat.ts`),o=(e,t,n)=>{if(e.split(t).length!==2)throw a();return e.replace(t,n)},s=3,c=64,l=e=>`@group(0) @binding(0) var<uniform> ${e}:vec4u;\n`,u=(e,t)=>`${l(`n`)}@group(0) @binding(1) var<storage,read> slots:array<u32>;
@group(0) @binding(2) var<storage,read_write> commands:array<u32>;
@group(0) @binding(3) var<storage,read_write> counts:array<u32>;
@compute @workgroup_size(1) fn main(){
 for(var l=0u;l<${t}u;l++){
  let count=slots[(l+1u)*n.x]-slots[l*n.x];
  commands[l*5u+1u]=count;counts[(l+${e}u)*${c}u]=count;
 }
}`,d=`struct Cull {light:array<mat4x4f,4>,lists:vec4u,size:vec4f}
@group(0) @binding(0) var<uniform> u:Cull;
@group(0) @binding(1) var<storage,read> counts:array<u32,15>;
@group(0) @binding(2) var<storage,read> near:array<vec4f>;
@group(0) @binding(3) var<storage,read> middle:array<vec4f>;
@group(0) @binding(4) var<storage,read> far:array<vec4f>;
@group(0) @binding(5) var<storage,read_write> marks:array<u32>;
@group(0) @binding(6) var<uniform> n:vec4u;
fn reaches(c:u32,p:vec4f)->u32 {
 let r=u.size.y*p.w;let radius=r+1e-5*(length(p.xyz)+r);
 let m=transpose(u.light[c]);var planes=array(m[3]+m[0],m[3]-m[0],m[3]+m[1],m[3]-m[1],m[2],m[3]-m[2]);var k=0u;
 while(k<6u&&dot(planes[k].xyz,p.xyz)+planes[k].w>=-radius*length(planes[k].xyz)){k++;}
 return select(0u,1u,k==6u);
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let ring=id.y;let i=id.x;if(i>=n.x){return;}
 let held=i<counts[ring*5u+1u];
 var p:vec4f;if(ring==0u){p=near[i*2u];}else if(ring==1u){p=middle[i*2u];}else{p=far[i*2u];}
 for(var c=0u;c<4u;c++){
  if(c<u32(u.size.x)){var flag=0u;if(held){flag=reaches(c,p);}marks[(c*3u+ring)*n.x+i]=flag;}
 }
}`,f=`struct Cull {light:array<mat4x4f,4>,lists:vec4u,size:vec4f}
@group(0) @binding(0) var<uniform> u:Cull;
@group(0) @binding(1) var<storage,read> marks:array<u32>;
@group(0) @binding(2) var<storage,read> slots:array<u32>;
@group(0) @binding(3) var<storage,read_write> lists:array<u32>;
@group(0) @binding(4) var<uniform> n:vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let ring=id.y;let i=id.x;if(i>=n.x){return;}
 for(var c=0u;c<4u;c++){
  let lane=(c*3u+ring)*n.x;
  if(c<u32(u.size.x)&&marks[lane+i]==1u){lists[c*u.lists.w+u.lists[ring]+slots[lane+i]-slots[lane]]=i;}
 }
}`,p=(e,t)=>`@group(${e}) @binding(${t}) var<storage,read> drawnCount:array<u32>;\n`;function m(e,t,n,r,i){return o(o(e,`@vertex`,p(n,r)+`@vertex`),t,`if(index>=drawnCount[0]){${i}}${t}`)}var h=`var none:Output;none.clip=vec4f(2,2,2,1);return none;`,g=`return vec4f(2,2,2,1);`,_=(e,t)=>e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:t}),entryPoint:`main`}}),v=e=>e.map((e,t)=>({binding:t,resource:`size`in e&&`usage`in e?{buffer:e}:e})),y=class{constructor(e){this.host=e,this.owned=[],this.shadowOwned=[],this.placedFrom=[],this.uniforms=[],this.groups=new Map,this.shadowValues=new Float32Array(36);let a=this.device=e.device,o=e.count,c=e=>this.make(e,GPUBufferUsage.STORAGE);this.candidates=c(o*32),this.slots=new r(a,o*s,this.owned),this.counts=c(3840),this.lanes=this.make(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),a.queue.writeBuffer(this.lanes,0,new Uint32Array([o,e.capacity,e.capacity,e.capacity])),this.placing=_(a,i(e.cull));let l=Math.ceil(o/64);this.finish=t.map(t=>this.kernel(n(t),[this.lanes,this.candidates,this.slots.flags,this.slots.prefix,e.rings[t]],l)),this.finish.push(this.kernel(u(0,s),[this.lanes,this.slots.prefix,e.commands,this.counts],1))}make(e,t,n=this.owned){let r=this.device.createBuffer({size:e,usage:t});return n.push(r),r}kernel(e,t,n,r=1){let i=_(this.device,e);return[i,this.device.createBindGroup({layout:i.getBindGroupLayout(0),entries:v(t)}),n,r]}run(e,[t,n,r,i]){e.setPipeline(t),e.setBindGroup(0,n),e.dispatchWorkgroups(r,i)}cull(e,t,n){let r=this.host;(!this.placeGroup||this.placedFrom[0]!==t||this.placedFrom[1]!==n)&&(this.placeGroup=this.device.createBindGroup({layout:this.placing.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:r.uniform}},{binding:1,resource:t.createView()},{binding:2,resource:{buffer:this.candidates}},{binding:3,resource:{buffer:this.slots.flags}},{binding:6,resource:{buffer:r.exclusions}},...n?[{binding:7,resource:n.createView()}]:[]]}),this.placedFrom=[t,n]);let i=e.beginComputePass();i.setPipeline(this.placing),i.setBindGroup(0,this.placeGroup),i.dispatchWorkgroups(Math.ceil(r.count/64)),this.slots.encode(i);for(let e of this.finish)this.run(i,e);i.end()}vertex(e,t){return m(e,`let data=instances[index];`,+!!t,2,h)}ringCount(e){return{buffer:this.counts,offset:e*c*4,size:16}}buildShadow(e){let t=this.host,n=t.rings.map(e=>Math.ceil(e.size/2048)*64),i=Math.max(...n),a=n[0]+n[1]+n[2],o=e*s;for(let e of this.shadowOwned)e.destroy();let c=this.shadowOwned=[],l=new r(this.device,i*o,c),p=this.make(e*a*4,GPUBufferUsage.STORAGE,c),m=this.make(o*20,GPUBufferUsage.STORAGE,c),h=this.make(288,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,c),g=this.make(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,c),_=new Float32Array(72);this.device.queue.writeBuffer(g,0,new Uint32Array([i,0,0,0])),new Uint32Array(_.buffer,256,4).set([0,n[0],n[0]+n[1],a]);let v=Math.ceil(i/64);this.shadow={cascades:e,sizes:n,prefix:l,lists:p,commands:m,uniform:h,values:_,steps:[this.kernel(d,[h,t.commands,t.rings[0],t.rings[1],t.rings[2],l.flags,g],v,s),this.kernel(f,[h,l.flags,l.prefix,p,g],v,s),this.kernel(u(s,o),[g,l.prefix,m,this.counts],1)]};for(let e of this.groups.keys())this.groups.delete(e)}prepareShadow(e,t,n,r){this.shadow?.cascades!==n&&this.buildShadow(n);let i=this.shadow;for(let e=0;e<n*16;e++)i.values[e]=t[e];i.values[68]=n,i.values[69]=r,this.device.queue.writeBuffer(i.uniform,0,i.values);let a=e.beginComputePass();this.run(a,i.steps[0]),i.prefix.encode(a),this.run(a,i.steps[1]),this.run(a,i.steps[2]),a.end(),i.encoder=e}drawShadow(e,t,n,r){let i=this.host,a=this.device,o=this.shadow,c=!!o&&o.encoder===e&&r<o.cascades,l=c?this.listPipeline??=i.shadowDepth(a,m(i.shadowListCode,`let data=instances[list[index]];`,0,3,g)):this.plainPipeline??=i.shadowDepth(a,m(i.shadowCode,`let data=instances[index];`,0,3,g)),u=this.uniforms[r]??=this.make(144,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),d=this.shadowValues;d.set(n),d.set(i.values.subarray(16,20),16),d.set(i.values.subarray(68,80),20),d[19]=i.values[80],d.set(i.values.subarray(84,88),32),a.queue.writeBuffer(u,0,d),t.setPipeline(l);for(let e=0;e<s;e++){let n=`${c}:${r}:${e}`,d=this.groups.get(n);if(!d){let t=o?new Uint32Array(o.values.buffer,256,4):void 0;d=a.createBindGroup({layout:l.getBindGroupLayout(0),entries:v([u,i.rings[e],...c?[{buffer:o.lists,offset:(r*t[3]+t[e])*4,size:(t[e+1]-t[e])*4}]:[]]).concat({binding:3,resource:c?this.ringCount(s+r*s+e):this.ringCount(e)})}),this.groups.set(n,d)}t.setBindGroup(0,d),t.setVertexBuffer(0,i.vertices[e]),t.setIndexBuffer(i.indices[e],`uint32`),t.drawIndexed(i.indexCounts[e],c?o.sizes[e]:i.capacity)}}destroy(){for(let e of[...this.owned,...this.shadowOwned])e.destroy();this.owned.length=0,this.shadowOwned=[]}};export{y as ScatterRoute,i as candidateShader,n as compactShader,m as countedVertex,f as shadowCompactShader,d as shadowMarksShader,u as totalsShader};