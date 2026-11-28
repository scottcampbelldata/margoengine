import{i as e,o as t,s as n}from"./query-state-bmQwt1Q1-BX4Vr1XK.js";var r=e=>{let t=Math.hypot(...e);return t?[e[0]/t,e[1]/t,e[2]/t]:[0,1,0]},i=`
@group(1) @binding(0) var<storage,read> coordinates:array<f32>;
@group(1) @binding(1) var<storage,read_write> vertices:array<vec4f>;
@group(1) @binding(2) var flux:texture_2d<f32>;
`,a=`
fn waveVelocity(xz:vec2f,width:f32)->vec3f {
 var velocity=vec3f(0);
 let spectrum=array<vec4f,3>(vec4f(0,1,0.4,0),vec4f(-0.64,0.84,0.35,2.17),vec4f(0.81,1.18,0.25,4.91));
 for(var j=0u;j<u32(frame.settings.w);j++) {let w=frame.waves[j];
  for(var c=0u;c<3u;c++) {let s=swell(w,xz,c,width);let component=spectrum[c];let speed=w.shape.y*sqrt(component.y);
   let bend=w.wave.w*component.y*0.35*dot(vec2f(-s.direction.y,s.direction.x),xz)-speed*frame.settings.x*0.12+w.shape.z+component.w;
   let rate=-speed*(1.0+0.168*cos(bend));let q=w.shape.x*0.9;
   velocity+=vec3f(-q*s.direction.x*sin(s.phase),cos(s.phase),-q*s.direction.y*sin(s.phase))*s.amplitude*rate;
  }
 }return velocity;
}
fn flowVelocity(point:vec2i)->vec3f {
 let size=vec2i(textureDimensions(coast));let p=clamp(point,vec2i(0),size-1);let water=textureLoad(coast,p,0);
 if(water.x<0.003||STILL){return vec3f(0);}
 let q=textureLoad(flux,p,0);var incoming=vec4f(0);
 if(p.x>0){incoming.x=textureLoad(flux,p-vec2i(1,0),0).y;}
 if(p.x<size.x-1){incoming.y=textureLoad(flux,p+vec2i(1,0),0).x;}
 if(p.y>0){incoming.z=textureLoad(flux,p-vec2i(0,1),0).w;}
 if(p.y<size.y-1){incoming.w=textureLoad(flux,p+vec2i(0,1),0).z;}
 let horizontal=vec2f(q.y-q.x+incoming.x-incoming.y,q.w-q.z+incoming.z-incoming.w)/max(0.04,2.0*water.x);
 var vertical=(incoming.x+incoming.y-q.x-q.y)/frame.flow.y+(incoming.z+incoming.w-q.z-q.w)/frame.flow.z;
 let xz=frame.coast.xy+(vec2f(p)+0.5)/vec2f(size)*frame.coast.zw;
 let v=coastal(xz);let slope=-v.normal.xz/max(0.0001,v.normal.y);

 let index=u32(p.y*size.x+p.x)+1u;
 if(connected[index]==0u){
  let sea=surfSea(xz,water.y,size,length(frame.flow.yz));
  vertical+=(max(0.0,sea.x-water.y)-water.x)*4.0*sea.y;
 }
 return vec3f(horizontal.x,vertical+dot(horizontal,slope),horizontal.y);
}
fn coastalVelocity(xz:vec2f)->vec3f {
 let size=vec2i(textureDimensions(coast));let p=clamp((xz-frame.coast.xy)/frame.coast.zw*vec2f(size)-0.5,vec2f(0),vec2f(size-1));
 let lo=vec2i(floor(p));let t=fract(p);
 return mix(mix(flowVelocity(lo),flowVelocity(lo+vec2i(1,0)),t.x),mix(flowVelocity(lo+vec2i(0,1)),flowVelocity(lo+vec2i(1,1)),t.x),t.y);
}
`;function o(e){let t=(e.segments+1)**2;return e.kind===`water`?e.shader+i+a+`
@compute @workgroup_size(64) fn capture(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=${t}u){return;}let o=i*3u;var base=vec2f(coordinates[o],coordinates[o+1u]);
 if(HORIZON){base+=frame.grid.xy;}
 let width=coordinates[o+2u];let v=surface(base,width);var velocity=waveVelocity(base,width);
 if(inCoast(base)){velocity=mix(velocity,coastalVelocity(base),coastal(base).blend.z);}
 ${e.extraVelocity?.map(e=>`velocity+=${e};`).join(`
`)??``}
 vertices[i*3u]=vec4f(v.position,base.x);vertices[i*3u+1u]=vec4f(v.normal,base.y);vertices[i*3u+2u]=vec4f(velocity,0);
}`:e.shader+i+`
@compute @workgroup_size(64) fn capture(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;if(i>=${t}u){return;}let cells=u32(frame.grid.z);
 let base=vec2f(f32(i%(cells+1u)),f32(i/(cells+1u)))/f32(cells)*frame.grid.xy-frame.grid.xy*0.5+frame.water.zw;
 let wave=oceanAt(base);var velocity=vec3f(0);
 for(var c=0u;c<CASCADES;c++){velocity+=sampleSurface(base,c,1u).xyz;}
 vertices[i*3u]=vec4f(vec3f(base.x,frame.water.x,base.y)+wave.displacement,base.x);
 vertices[i*3u+1u]=vec4f(wave.normal,base.y);vertices[i*3u+2u]=vec4f(velocity,0);
}`}var s=`
@group(0) @binding(0) var<storage,read> vertices:array<vec4f>;
@group(0) @binding(1) var<storage,read_write> bounds:array<vec4f>;
@group(0) @binding(2) var<uniform> config:vec4u;
fn vertex(p:vec2u)->vec2f {return vertices[(p.y*(config.x+1u)+p.x)*3u].xz;}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(config.x))){return;}
 var low=vec2f(1e30);var high=vec2f(-1e30);
 for(var z=0u;z<2u;z++){for(var x=0u;x<2u;x++){
  if(config.y==0u){let p=vertex(id.xy+vec2u(x,z));low=min(low,p);high=max(high,p);}
  else {let p=id.xy*2u+vec2u(x,z);if(all(p<vec2u(config.y))){let b=bounds[config.w+p.y*config.y+p.x];low=min(low,b.xy);high=max(high,b.zw);}}
 }}
 bounds[config.z+id.y*config.x+id.x]=vec4f(low,high);
}`,c=class i{constructor(e,t,n,r,i,a,o){this.time=e,this.segments=t,this.vertices=n,this.bounds=r,this.levels=i,this.coast=a,this.fft=o}static async capture(t,r={}){let a=r.signal;a?.throwIfAborted();let c=e.get(t),l=c?.();if(!l)throw n(`state`,`Render live Water or FFTOcean before WaveQuery.capture`,`state`);let{device:u,segments:d}=l,f=l.values.slice(),p=[],m=[],h=(e,t,n)=>{let r=u.createBuffer({size:e,usage:t});return p.push(r),n&&u.queue.writeBuffer(r,0,n),r},g=()=>{for(let e of m)e.destroy()};a?.addEventListener(`abort`,g,{once:!0});try{let e=l.token,t=h((d+1)**2*48,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),r=[],p=d,g=0;for(;r.push({side:p,offset:g}),g+=p*p,p!==1;)p=Math.ceil(p/2);let _=h(g*16,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC),v=u.createShaderModule({code:o(l)}),y=u.createComputePipeline({layout:`auto`,compute:{module:v,entryPoint:`capture`}}),b=l.kind===`water`?[{binding:0,resource:{buffer:e}},{binding:3,resource:l.resources[3]},{binding:7,resource:l.resources[7]},...l.extraBindings??[]]:[{binding:0,resource:{buffer:e}},{binding:1,resource:{buffer:l.field}}],x=u.createBindGroup({layout:y.getBindGroupLayout(0),entries:b}),S=[{binding:1,resource:{buffer:t}}];if(l.kind===`water`){let e=h(l.positions.byteLength,GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST,l.positions);S.push({binding:0,resource:{buffer:e}},{binding:2,resource:l.coast?.fluxes[l.coast.current].createView()??l.resources[3]})}let C=u.createBindGroup({layout:y.getBindGroupLayout(1),entries:S}),w=u.createCommandEncoder(),T=w.beginComputePass();T.setPipeline(y),T.setBindGroup(0,x),T.setBindGroup(1,C),T.dispatchWorkgroups(Math.ceil((d+1)**2/64)),T.end();let E=u.createShaderModule({code:s}),D=u.createComputePipeline({layout:`auto`,compute:{module:E,entryPoint:`main`}});for(let e=0;e<r.length;e++){let n=r[e],i=r[e-1],a=h(16,GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST,new Uint32Array([n.side,i?.side??0,n.offset,i?.offset??0])),o=u.createBindGroup({layout:D.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:t}},{binding:1,resource:{buffer:_}},{binding:2,resource:{buffer:a}}]}),s=w.beginComputePass();s.setPipeline(D),s.setBindGroup(0,o),s.dispatchWorkgroups(Math.ceil(n.side/8),Math.ceil(n.side/8)),s.end()}let O=(e,t)=>{let n=h(t,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST);return m.push(n),w.copyBufferToBuffer(e,0,n,0,t),n},k=O(t,(d+1)**2*48),A=O(_,g*16),j,M,N=0;l.field&&(j=O(l.field,l.resolution**2*l.lengths.length*48));let P=l.coast?.states[l.coast.current];if(P&&(N=Math.ceil(P.width*16/256)*256,M=h(N*P.height,GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST),m.push(M),w.copyTextureToBuffer({texture:P},{buffer:M,bytesPerRow:N},[P.width,P.height])),u.queue.submit([w.finish()]),await Promise.all(m.map(e=>e.mapAsync(GPUMapMode.READ))),a?.throwIfAborted(),c?.()?.token!==l.token)throw n(`state`,`Water disposed or device restored during wave capture; render and capture again`,`state`);let F=e=>new Float32Array(e.getMappedRange().slice(0)),I;if(P&&M){let e=F(M),t=new Float32Array(P.width*P.height*4);for(let n=0;n<P.height;n++)t.set(e.subarray(n*N/4,n*N/4+P.width*4),n*P.width*4);I={data:t,width:P.width,height:P.height,origin:Array.from(f.subarray(96,98)),size:Array.from(f.subarray(98,100)),still:!!l.still}}return new i(l.time,d,F(k),F(A),r,I,j?{data:F(j),resolution:l.resolution,lengths:l.lengths}:void 0)}catch(e){throw a?.throwIfAborted(),c?.()?.token===l.token?e:n(`state`,`Water disposed or device restored during wave capture; render and capture again`,`state`)}finally{a?.removeEventListener(`abort`,g);for(let e of p)e.destroy()}}sample(e,n){if(!Number.isFinite(e)||!Number.isFinite(n))throw t(`Wave query XZ must be finite world coordinates`,`geometry`);let i,a=[{level:this.levels.length-1,x:0,z:0}];for(;a.length;){let t=a.pop(),o=this.levels[t.level],s=(o.offset+t.z*o.side+t.x)*4,c=this.bounds;if(e<c[s]||n<c[s+1]||e>c[s+2]||n>c[s+3])continue;if(t.level){let e=this.levels[t.level-1].side;for(let n=0;n<2;n++)for(let r=0;r<2;r++)t.x*2+r<e&&t.z*2+n<e&&a.push({level:t.level-1,x:t.x*2+r,z:t.z*2+n});continue}let l=t.z*(this.segments+1)+t.x,u=l+this.segments+1;for(let t of[[l,u,l+1],[l+1,u,u+1]]){let a=this.vertices,o=t.map(e=>e*12),[s,c,l]=o,u=a[s]-e,d=a[s+2]-n,f=a[c]-e,p=a[c+2]-n,m=a[l]-e,h=a[l+2]-n,g=[f*h-p*m,m*d-h*u,u*p-d*f];if(g.some(e=>e<0)&&g.some(e=>e>0))continue;let _=g[0]+g[1]+g[2];if(_===0)continue;for(let e=0;e<3;e++)g[e]/=_;let v=e=>o.reduce((t,n,r)=>t+a[n+e]*g[r],0),y=v(1);if(i&&y<=i.height)continue;let b=[v(3),v(7)];if(this.dry(b[0],b[1]))continue;let x=r([v(4),v(5),v(6)]);this.fft&&(x=this.fftNormal(b[0],b[1]));let S=a[c]-a[s],C=a[c+1]-a[s+1],w=a[c+2]-a[s+2],T=a[l]-a[s],E=a[l+1]-a[s+1],D=a[l+2]-a[s+2],O=r([C*D-w*E,w*T-S*D,S*E-C*T]);O[1]<0&&(O=O.map(e=>-e)),i={height:y,normal:x,geometricNormal:O,velocity:[v(8),v(9),v(10)],time:this.time}}}return i}heightAt(e,t){return this.sample(e,t)?.height}normalAt(e,t){return this.sample(e,t)?.normal}velocityAt(e,t){return this.sample(e,t)?.velocity}dry(e,t){let n=this.coast;if(!n)return!1;let r=(e-n.origin[0])/n.size[0],i=(t-n.origin[1])/n.size[1];if(r<0||i<0||r>1||i>1)return!1;let a=Math.max(0,Math.min(n.width-1,r*n.width-.5)),o=Math.max(0,Math.min(n.height-1,i*n.height-.5)),s=Math.floor(a),c=Math.floor(o),l=a-s,u=o-c,d=0;for(let e=0;e<2;e++)for(let t=0;t<2;t++){let r=(Math.min(n.height-1,c+e)*n.width+Math.min(n.width-1,s+t))*4,i=n.data[r],a=n.data[r+3],o=i>.003?i:a>-1e29?a-n.data[r+1]:-1;d+=(n.still?o:i)*(t?l:1-l)*(e?u:1-u)}return n.still?d<=0:d<.003}fftNormal(e,t){let n=this.fft,i=n.resolution,a=[0,1,0];for(let r=0;r<n.lengths.length;r++){let o=e/n.lengths[r]*i,s=t/n.lengths[r]*i,c=Math.floor(o),l=Math.floor(s),u=o-c,d=s-l;for(let e=0;e<3;e++){let t=0;for(let a=0;a<2;a++)for(let o=0;o<2;o++){let s=((c+o)%i+i)%i,f=((l+a)%i+i)%i;t+=n.data[(r*i*i+f*i+s)*12+8+e]*(o?u:1-u)*(a?d:1-d)}a[e]+=t-+(e===1)}}return r(a)}};export{c as WaveQuery};