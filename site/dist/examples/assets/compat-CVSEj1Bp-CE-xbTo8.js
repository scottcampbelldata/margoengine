import{t as e}from"./frame-BuvMFBPp-D9XuJ2Dy.js";import{t}from"./errors-DkwPZuAq.js";var n=128,r=`@group(0) @binding(0) var<uniform> n:vec4u;
@group(0) @binding(1) var<storage,read> words:array<u32>;
`,i=r+`@group(0) @binding(2) var<storage,read_write> sums:array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  let first=id.x*16u;if(first>=n.x){return;}
  var sum=0u;for(var j=first;j<min(first+16u,n.x);j++){sum+=words[j];}
  sums[id.x]=sum;
}`,a=r+`@group(0) @binding(2) var<storage,read_write> counts:array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>n.x){return;}
  var count=0u;for(var j=0u;j<id.x;j++){count+=words[j];}
  counts[id.x]=count;
}`,o=r+`@group(0) @binding(2) var<storage,read_write> counts:array<u32>;
@group(0) @binding(3) var<storage,read> parents:array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>n.x){return;}
  var count=parents[id.x>>4u];for(var j=id.x&~15u;j<id.x;j++){count+=words[j];}
  counts[id.x]=count;
}`;function s(e){let t=[e];for(;t.at(-1)>16;)t.push(Math.ceil(t.at(-1)/16));return t}var c=class{constructor(e,t,r,{totalOnly:c=!1}={}){if(!Number.isInteger(t)||t<1)throw RangeError(`A prefix count needs at least one flag word; pass a positive whole number`);let l=(t,n)=>{let i=e.createBuffer({size:t,usage:n});return r.push(i),i},u=s(t),d=t=>e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:t}),entryPoint:`main`}}),f=d(i),p=d(a),m=c||u.length===1?void 0:d(o);this.steps=[];let h=(t,n,r,i)=>{let a=l(16,72);e.queue.writeBuffer(a,0,new Uint32Array([n,0,0,0])),this.steps.push([t,e.createBindGroup({layout:t.getBindGroupLayout(0),entries:[a,...i].map((e,t)=>({binding:t,resource:{buffer:e}}))}),Math.ceil(r/256)])};this.flags=l(Math.max(16,t*4),n);let g=[this.flags];for(let e=1;e<u.length;e++){let t=l(u[e]*4,n);h(f,u[e-1],u[e],[g[e-1],t]),g.push(t)}let _=u.length-1,v=l((u[_]+1)*4,n);if(h(p,u[_],u[_]+1,[g[_],v]),this.total=v,this.totalWord=u[_],m)for(let e=_-1;e>=0;e--){let t=l((u[e]+1)*4,n);h(m,u[e],u[e]+1,[g[e],t,v]),v=t}this.prefix=v}encode(e){for(let[t,n,r]of this.steps)e.setPipeline(t),e.setBindGroup(0,n),e.dispatchWorkgroups(r)}},l=()=>new t(`unsupported`,`VFX on WebGL2 needs the shader its compatibility route was written for; update the edits in vfx/src/compat.ts`),u=(e,t,n)=>{if(e.split(t).length!==2)throw l();return e.replace(t,n)},d=`@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u`,f=`atomicAdd(&indirect.instanceCount,1u);`,p=`  return 1u;
}`,m=`@group(0) @binding(1) var<storage,read> particles:array<vec4f>;
`,h=`var<private> eventHere:u32;`,g=28;function _(t){let n=/fn dies\(i:u32\)->u32 \{[^\n]*\n/.exec(t)?.[0],r=/var<workgroup> scratch[^\n]*\nfn prefix[^\n]*\n/.exec(t)?.[0],i=t.indexOf(f),a=t.indexOf(p,i),o=t.indexOf(`@compute @workgroup_size(256) fn main(`);if(!n||!r||i<0||a<0||o<a)throw l();let s=t.slice(i+38,a),c=t.slice(0,i)+t.slice(a,o);for(let[e,t]of[[n,``],[r,``],[`@group(0) @binding(2) var<storage,read_write> groups:array<u32>;
`,``],[`@group(0) @binding(3) var<storage,read_write> alive:array<u32>;
`,``],[`struct Indirect {vertexCount:u32,instanceCount:atomic<u32>,rest:array<u32,3>}
`,``],[`@group(0) @binding(4) var<storage,read_write> indirect:Indirect;
`,``],[`@group(0) @binding(5) var<storage,read> births:array<u32>;`,`@group(0) @binding(5) var<storage,read> tickets:array<u32>;`],[`@group(0) @binding(9) var<storage,read_write> listed:array<u32>;
`,``],[`@group(0) @binding(10) var<storage,read_write> total:array<u32,5>;
`,``]])c=u(c,e,t);let g=c.includes(h);return{events:g,flags:`${e}${m}@group(0) @binding(2) var<storage,read_write> flags:array<u32>;
${n}${d}){if(id.x<f.control.x){flags[id.x]=dies(id.x);}}`,update:g?`${c}@group(0) @binding(28) var<storage,read_write> eventFlags:array<u32>;
${d}){if(id.x<f.control.x){let drawn=update(id.x,tickets[id.x]);storeEvents(id.x);eventFlags[id.x]=eventHere;}}`:`${c}${d}){if(id.x<f.control.x){let drawn=update(id.x,tickets[id.x]);}}`,marks:`${c}@group(0) @binding(2) var<storage,read_write> living:array<u32>;
@group(0) @binding(3) var<storage,read_write> shown:array<u32>;
fn onScreen(p:Particle)->u32 {${s}  return 1u;
}
${d}){
  if(id.x>=f.control.x){return;}
  let p=Particle(particles[id.x*2],particles[id.x*2+1],vec4f(0),vec4f(0));
  var isLive=0u;var isShown=0u;if(p.positionLife.w>0){isLive=1u;isShown=onScreen(p);}
  living[id.x]=isLive;shown[id.x]=isShown;
}`}}var v=`@group(0) @binding(0) var<uniform> n:vec4u;
@group(0) @binding(1) var<storage,read> shown:array<u32>;
@group(0) @binding(2) var<storage,read> places:array<u32>;
@group(0) @binding(3) var<storage,read_write> alive:array<u32>;
${d}){if(id.x<n.x&&shown[id.x]==1u){alive[places[id.x]]=id.x;}}`,y=`@group(0) @binding(0) var<uniform> n:vec4u;
@group(0) @binding(1) var<storage,read> raised:array<u32>;
@group(0) @binding(2) var<storage,read> places:array<u32>;
@group(0) @binding(3) var<storage,read_write> events:array<u32>;
${d}){if(id.x<n.x&&raised[id.x]==1u){events[4u+n.y*257u+places[id.x]]=id.x;}}`,b=e=>`@group(0) @binding(0) var<storage,read> total:array<u32>;
@group(0) @binding(1) var<storage,read_write> events:array<u32>;
@compute @workgroup_size(1) fn main(){events[1]=total[${e}];}`,x=(e,t)=>`@group(0) @binding(0) var<storage,read> living:array<u32>;
@group(0) @binding(1) var<storage,read> shown:array<u32>;
@group(0) @binding(2) var<storage,read_write> indirect:array<u32,5>;
@group(0) @binding(3) var<storage,read_write> visible:array<u32,5>;
@compute @workgroup_size(1) fn main(){indirect[1]=living[${e}];visible[1]=shown[${t}];}`,S=`@vertex fn vertex(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->Out {`,C=13,w=e=>u(e,S,`@group(0) @binding(13) var<storage,read> drawn:array<u32,5>;
${S}
  if(instance>=drawn[1]){var none:Out;none.clip=vec4f(2,2,2,1);return none;}`);function T(e){let t=e.replace(/\/\/[^\n]*/g,``).replace(/\/\*[\s\S]*?\*\//g,``),n=new Map,r=new Map;for(let e of t.matchAll(/@group\(0\)\s*@binding\((\d+)\)\s*var(?:<[^>]*>)?\s+(\w+)/g))n.set(e[2],+e[1]);for(let e of t.matchAll(/\bfn\s+(\w+)\s*\(/g)){let n=t.indexOf(`{`,e.index+e[0].length),i=0,a=n;for(;n<t.length;n++)if(t[n]===`{`)i++;else if(t[n]===`}`&&--i===0)break;r.set(e[1],t.slice(a,n+1))}let i=new Set,a=new Set([`main`]),o=[r.get(`main`)??``];for(;o.length;)for(let[e]of o.pop().matchAll(/\b[A-Za-z_]\w*\b/g)){let t=n.get(e);t!==void 0&&i.add(t),r.has(e)&&!a.has(e)&&(a.add(e),o.push(r.get(e)))}return i}var E=class{constructor(e,t,n,r,i,a){let o=_(t),s=Math.ceil(n/256),u=(t,n,r)=>{let i=e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:t}),entryPoint:`main`}}),a=T(t);return[i,e.createBindGroup({layout:i.getBindGroupLayout(0),entries:n.filter(e=>a.has(e.binding))}),r]},d=(e,t)=>({binding:e,resource:{buffer:t}});if(this.deaths=new c(e,n,a),this.living=new c(e,n,a,{totalOnly:!0}),this.shown=new c(e,n,a),o.events!==(r.events!==void 0))throw l();let f=r.events?new c(e,n,a):void 0;this.flagging=u(o.flags,[d(0,r.uniform),d(1,r.particles),d(2,this.deaths.flags)],s),this.updating=u(o.update,[d(0,r.uniform),d(1,r.particles),d(5,this.deaths.prefix),...f?[d(28,f.flags)]:[],...i],s),this.marking=u(o.marks,[d(0,r.uniform),d(1,r.particles),d(2,this.living.flags),d(3,this.shown.flags),d(5,this.deaths.prefix),...i],s);let p=e.createBuffer({size:16,usage:72});a.push(p),e.queue.writeBuffer(p,0,new Uint32Array([n,s,0,0])),this.compacting=u(v,[d(0,p),d(1,this.shown.flags),d(2,this.shown.prefix),d(3,r.alive)],s),this.totals=u(x(this.living.totalWord,this.shown.totalWord),[d(0,this.living.total),d(1,this.shown.total),d(2,r.indirect),d(3,r.visible)],1),f&&r.events&&(this.events={count:f,compact:u(`@group(0) @binding(0) var<uniform> n:vec4u;
@group(0) @binding(1) var<storage,read> raised:array<u32>;
@group(0) @binding(2) var<storage,read> places:array<u32>;
@group(0) @binding(3) var<storage,read_write> events:array<u32>;
@compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){if(id.x<n.x&&raised[id.x]==1u){events[4u+n.y*257u+places[id.x]]=id.x;}}`,[d(0,p),d(1,f.flags),d(2,f.prefix),d(3,r.events)],s),total:u(b(f.totalWord),[d(0,f.total),d(1,r.events)],1)})}encode(e,t){let n=([t,n,r])=>{e.setPipeline(t),e.setBindGroup(0,n),e.dispatchWorkgroups(r)};t&&(n(this.flagging),this.deaths.encode(e)),n(this.updating),this.events&&(this.events.count.encode(e),n(this.events.compact),n(this.events.total)),n(this.marking),this.living.encode(e),this.shown.encode(e),n(this.compacting),n(this.totals)}};export{C as COUNT_BINDING,g as EVENT_FLAGS_BINDING,E as SimulationRoute,v as compactShader,w as countedBillboard,y as eventCompactShader,b as eventTotalShader,_ as routeShaders,x as totalsShader,T as usedBindings};