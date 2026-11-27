import{t as e}from"./errors-DkwPZuAq.js";var t=128,n=`@group(0) @binding(0) var<uniform> n:vec4u;
@group(0) @binding(1) var<storage,read> words:array<u32>;
`,r=n+`@group(0) @binding(2) var<storage,read_write> sums:array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  let first=id.x*16u;if(first>=n.x){return;}
  var sum=0u;for(var j=first;j<min(first+16u,n.x);j++){sum+=words[j];}
  sums[id.x]=sum;
}`,i=n+`@group(0) @binding(2) var<storage,read_write> counts:array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>n.x){return;}
  var count=0u;for(var j=0u;j<id.x;j++){count+=words[j];}
  counts[id.x]=count;
}`,a=n+`@group(0) @binding(2) var<storage,read_write> counts:array<u32>;
@group(0) @binding(3) var<storage,read> parents:array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>n.x){return;}
  var count=parents[id.x>>4u];for(var j=id.x&~15u;j<id.x;j++){count+=words[j];}
  counts[id.x]=count;
}`;function o(e){let t=[e];for(;t.at(-1)>16;)t.push(Math.ceil(t.at(-1)/16));return t}var s=class{constructor(e,n,s,{totalOnly:c=!1}={}){if(!Number.isInteger(n)||n<1)throw RangeError(`A prefix count needs at least one flag word; pass a positive whole number`);let l=(t,n)=>{let r=e.createBuffer({size:t,usage:n});return s.push(r),r},u=o(n),d=t=>e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:t}),entryPoint:`main`}}),f=d(r),p=d(i),m=c||u.length===1?void 0:d(a);this.steps=[];let h=(t,n,r,i)=>{let a=l(16,72);e.queue.writeBuffer(a,0,new Uint32Array([n,0,0,0])),this.steps.push([t,e.createBindGroup({layout:t.getBindGroupLayout(0),entries:[a,...i].map((e,t)=>({binding:t,resource:{buffer:e}}))}),Math.ceil(r/256)])};this.flags=l(Math.max(16,n*4),t);let g=[this.flags];for(let e=1;e<u.length;e++){let n=l(u[e]*4,t);h(f,u[e-1],u[e],[g[e-1],n]),g.push(n)}let _=u.length-1,v=l((u[_]+1)*4,t);if(h(p,u[_],u[_]+1,[g[_],v]),this.total=v,this.totalWord=u[_],m)for(let e=_-1;e>=0;e--){let n=l((u[e]+1)*4,t);h(m,u[e],u[e]+1,[g[e],n,v]),v=n}this.prefix=v}encode(e){for(let[t,n,r]of this.steps)e.setPipeline(t),e.setBindGroup(0,n),e.dispatchWorkgroups(r)}},c=()=>new e(`unsupported`,`Scatter culls in order only with the distribute shader its edits were written for; update the edits in scatter/src/order.ts`),l=(e,t,n)=>{if(e.split(t).length!==2)throw c();return e.replace(t,n)},u=`@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){`,d=`@group(0) @binding(0) var<uniform> n:vec4u;
`;function f(e){let t=e;for(let[e,n]of[[`@group(0) @binding(2) var<storage,read_write> near:array<Instance>;
`,`@group(0) @binding(2) var<storage,read_write> candidates:array<Instance>;
`],[`@group(0) @binding(3) var<storage,read_write> middle:array<Instance>;
`,`@group(0) @binding(3) var<storage,read_write> marks:array<u32>;
`],[`@group(0) @binding(4) var<storage,read_write> far:array<Instance>;
`,``],[`struct Command {indices:u32,count:atomic<u32>,first:u32,base:u32,instance:u32}
`,``],[`@group(0) @binding(5) var<storage,read_write> commands:array<Command,3>;
`,``],[`fn emit(ring:u32,instance:Instance){
 let slot=atomicAdd(&commands[ring].count,1u);
 if(ring==0u){near[slot]=instance;}else if(ring==1u){middle[slot]=instance;}else{far[slot]=instance;}
}
`,`var<private> placed:Instance;
`],[u,`fn place(id:vec3u)->u32{`],[`instance.rotation.w=1.0;emit(ring,instance);
   instance.rotation.w=2.0;emit(ring+1u,instance);return;`,`instance.rotation.w=f32(ring)+1.0;placed=instance;return 3u<<ring;`],[`emit(select(select(2u,1u,d<frame.lod.y),0u,d<frame.lod.x),instance);`,`placed=instance;return 1u<<select(select(2u,1u,d<frame.lod.y),0u,d<frame.lod.x);`]])t=l(t,e,n);return`${t.replaceAll(`return;`,`return 0u;`)}
${u}
 if(id.x>=frame.ids.x){return;}
 let mask=place(id);
 if(mask!=0u){candidates[id.x]=placed;}
 let n=frame.ids.x;marks[id.x]=mask&1u;marks[n+id.x]=(mask>>1u)&1u;marks[2u*n+id.x]=mask>>2u;
}`}var p=[0,1,2],m=e=>{if(!p.includes(e))throw RangeError(`Invalid scatter LOD ring; pass 0, 1 or 2.`);return`struct Instance {position:vec4f,rotation:vec4f}
${d}@group(0) @binding(1) var<storage,read> candidates:array<Instance>;
@group(0) @binding(2) var<storage,read> marks:array<u32>;
@group(0) @binding(3) var<storage,read> slots:array<u32>;
@group(0) @binding(4) var<storage,read_write> rings:array<Instance>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
 let at=${e}u*n.x+id.x;
 if(id.x>=n.x||marks[at]!=1u){return;}
 let slot=slots[at]-slots[${e}u*n.x];if(slot>=n[${e+1}u]){return;}
 var c=candidates[id.x];
 if(c.rotation.w>0.0){c.rotation.w=select(2.0,1.0,u32(c.rotation.w)==${e+1}u);}
 rings[slot]=c;
}`},h=`${d}@group(0) @binding(1) var<storage,read> slots:array<u32>;
@group(0) @binding(2) var<storage,read_write> commands:array<u32>;
@compute @workgroup_size(1) fn main(){
 for(var l=0u;l<3u;l++){commands[l*5u+1u]=min(slots[(l+1u)*n.x]-slots[l*n.x],n[l+1u]);}
}`,g=(e,t,n,r)=>{let i=e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:t}),entryPoint:`main`}});return[i,e.createBindGroup({layout:i.getBindGroupLayout(0),entries:n.map((e,t)=>({binding:t,resource:{buffer:e}}))}),r]},_=class{constructor(e,t){this.device=e,this.n=t,this.owned=[],this.steps=[],this.bound=[];let n=(t,n)=>{let r=e.createBuffer({size:t,usage:n});return this.owned.push(r),r};this.candidates=n(t*32,GPUBufferUsage.STORAGE),this.prefix=new s(e,t*3,this.owned),this.flags=this.prefix.flags,this.lanes=n(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST),this.values=new Uint32Array([t,0,0,0])}encode(e,t,n){let r=this.device,i=this.values,a=[...t,n];if(a.some((e,t)=>e!==this.bound[t])){let e=Math.ceil(this.n/64);this.steps=p.map(n=>g(r,m(n),[this.lanes,this.candidates,this.flags,this.prefix.prefix,t[n]],e)),this.steps.push(g(r,h,[this.lanes,this.prefix.prefix,n],1)),this.bound=a;for(let e=0;e<3;e++)i[e+1]=t[e].size/32;r.queue.writeBuffer(this.lanes,0,i)}this.prefix.encode(e);for(let[t,n,r]of this.steps)e.setPipeline(t),e.setBindGroup(0,n),e.dispatchWorkgroups(r)}get bytes(){let e=0;for(let t of this.owned)e+=t.size;return e}destroy(){for(let e of this.owned)e.destroy();this.owned.length=0}};export{s as a,p as i,f as n,m as r,_ as t};