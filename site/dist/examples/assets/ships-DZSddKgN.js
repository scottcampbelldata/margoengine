import{n as e,t}from"./version-DZ3BcJze.js";import{n}from"./extension-BytumP3S.js";import{s as r}from"./dist-DCciemw3.js";import{o as i}from"./mat4-Dl2hqlTt.js";import{E as a,T as o,_ as s,f as c,g as l,i as u,t as d,v as f,w as p,x as m}from"./query-state-bmQwt1Q1-BhNOc28G.js";import{a as h,c as g,d as _,l as v,o as y,s as b,u as x}from"./dist-Is_wAQbE.js";function S(e,t,n){let r=d.get(e)??[],i={order:t,draw:n};return r.push(i),r.sort((e,t)=>e.order-t.order),d.set(e,r),()=>{let t=r.indexOf(i);t>=0&&r.splice(t,1),r.length||d.delete(e)}}var C=class{constructor(){this.shader=``,this.pipelines=[]}draw(e,t,n,r,i){let a=u.get(t)?.();if(!a||a.device!==e.device)throw o(`state`,`Surface capture needs a live Water or FFTOcean rendered on the same device before composition`);(this.token!==a.token||this.shader!==a.shader)&&(this.build(e.device,a),this.shader=a.shader);let c=a.kind===`water`?[{binding:0,resource:{buffer:a.token}},{binding:3,resource:a.resources[3]},{binding:7,resource:a.resources[7]},...a.extraBindings??[]]:[{binding:0,resource:{buffer:a.token}},{binding:1,resource:{buffer:a.field}}];for(let t=0;t<3;t++){let o=this.pipelines[t],l=e.device.createBindGroup({layout:o.getBindGroupLayout(0),entries:c}),u=e.device.createBindGroup({layout:o.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:n}},...this.coordinates?[{binding:1,resource:{buffer:this.coordinates}}]:[]]}),d=e.encoder.beginRenderPass({colorAttachments:[{view:r[t].createView(),loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,0]}],depthStencilAttachment:{view:i[t].createView(),depthLoadOp:`clear`,depthStoreOp:`discard`,depthClearValue:0}});d.setPipeline(o),d.setBindGroup(0,l),d.setBindGroup(1,u),t===0&&s(d,e),d.draw(a.segments*a.segments*(t===0?6:12)),d.end()}}build(e,t){this.dispose(),this.token=t.token,t.positions&&(this.coordinates=e.createBuffer({size:t.positions.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),e.queue.writeBuffer(this.coordinates,0,t.positions));let n=t.segments,r=t.kind===`water`,i=t.shader+`
@group(1) @binding(0) var<uniform> capture:array<vec4f,20>;
${r?`@group(1) @binding(1) var<storage,read> coords:array<f32>;`:``}
struct CaptureVertex { @builtin(position) clip:vec4f, @location(0) world:vec3f, @location(1) normal:vec3f, @location(2) base:vec2f }
fn evaluate(id:u32)->CaptureVertex {
 let cell=id/6u;let corner=array<vec2u,6>(vec2u(0,0),vec2u(0,1),vec2u(1,0),vec2u(1,0),vec2u(0,1),vec2u(1,1))[id%6u];
 let grid=vec2u(cell%${n}u,cell/${n}u)+corner;let index=grid.y*${n+1}u+grid.x;
 ${r?`var base=vec2f(coords[index*3u],coords[index*3u+1u]);if(HORIZON){base+=frame.grid.xy;}
 let wave=surface(base,coords[index*3u+2u]);let world=wave.position;let normal=wave.normal;`:`let base=vec2f(grid)/f32(${n})*frame.grid.xy-frame.grid.xy*0.5+frame.water.zw;
 let wave=oceanAt(base);let world=vec3f(base.x,frame.water.x,base.y)+wave.displacement;let normal=wave.normal;`}
 return CaptureVertex(vec4f(0),world,normal,base);
}
fn dry(base:vec2f)->bool {${r?`if(inCoast(base)){let s=coastal(base);return s.edge<=0.0;} `:``}return false;}

fn stableNormal(normal:vec3f)->vec3f {let scale=max(abs(normal.x),max(abs(normal.y),abs(normal.z)));let n=normal/scale;return n/sqrt(dot(n,n));}
fn captureNormal(base:vec2f,normal:vec3f)->vec3f {return ${r?`stableNormal(normal)`:`oceanAt(base).normal`};}
@vertex fn maskVertex(@builtin(vertex_index) id:u32)->CaptureVertex {
 var v=evaluate(id);v.clip=frame.camera*vec4f(v.world,1);

 v.clip.z=v.clip.w*0.5;return v;
}
struct FieldVertex {
 @builtin(position) clip:vec4f,
 @location(0) @interpolate(flat) a:vec4f,@location(1) @interpolate(flat) b:vec4f,@location(2) @interpolate(flat) c:vec4f,
 @location(3) @interpolate(flat) baseY:vec3f,
 @location(4) @interpolate(flat) na:vec3f,@location(5) @interpolate(flat) nb:vec3f,@location(6) @interpolate(flat) nc:vec3f
}
fn rectangle(id:u32,extent:f32,resolution:f32)->FieldVertex {

 let triangle=id/6u*3u;var corners:array<CaptureVertex,3>;for(var k=0u;k<3u;k++){corners[k]=evaluate(triangle+k);}
 let a=corners[0];let b=corners[1];let c=corners[2];
 let pad=vec2f(2.0*extent/resolution);
 let low=min(a.world.xz,min(b.world.xz,c.world.xz))-pad;let high=max(a.world.xz,max(b.world.xz,c.world.xz))+pad;
 let corner=array<vec2f,6>(vec2f(0,0),vec2f(0,1),vec2f(1,0),vec2f(1,0),vec2f(0,1),vec2f(1,1))[id%6u];
 let clip=vec4f((mix(low,high,corner)-capture[8].xz)/extent*vec2f(1,-1),0.5,1);
 return FieldVertex(clip,vec4f(a.world,a.base.x),vec4f(b.world,b.base.x),vec4f(c.world,c.base.x),vec3f(a.base.y,b.base.y,c.base.y),a.normal,b.normal,c.normal);
}
@vertex fn fieldVertex(@builtin(vertex_index) id:u32)->FieldVertex {return rectangle(id,capture[12].w,capture[18].x);}
@vertex fn probeVertex(@builtin(vertex_index) id:u32)->FieldVertex {return rectangle(id,0.005,1.0);}
struct CaptureResult { @location(0) value:vec4f, @builtin(frag_depth) depth:f32 }
@fragment fn maskFragment(v:CaptureVertex,@builtin(front_facing) front:bool)->CaptureResult {
 if(dry(v.base)){discard;}
 let inverse=mat4x4f(capture[4],capture[5],capture[6],capture[7]);
 let xy=(v.clip.xy-capture[14].xy)/capture[14].zw*vec2f(2,-2)+vec2f(-1,1);
 let near=inverse*vec4f(xy,1,1);let far=inverse*vec4f(xy,0.000001,1);
 let ray=normalize(far.xyz/far.w-near.xyz/near.w);
 let distance=dot(v.world-capture[8].xyz,ray);return CaptureResult(vec4f(captureNormal(v.base,v.normal),select(-distance,distance,front)),1.0/(1.0+max(0.0,distance)));
}
fn fieldSample(v:FieldVertex,xz:vec2f)->CaptureResult {
 let a=v.a.xz-xz;let b=v.b.xz-xz;let c=v.c.xz-xz;
 var weights=vec3f(b.x*c.y-b.y*c.x,c.x*a.y-c.y*a.x,a.x*b.y-a.y*b.x);
 if(any(weights<vec3f(0))&&any(weights>vec3f(0))){discard;}
 let det=weights.x+weights.y+weights.z;if(det==0.0){discard;}weights/=det;
 let base=vec2f(dot(weights,vec3f(v.a.w,v.b.w,v.c.w)),dot(weights,v.baseY));
 if(dry(base)){discard;}
 let height=dot(weights,vec3f(v.a.y,v.b.y,v.c.y));
 let normal=captureNormal(base,v.na*weights.x+v.nb*weights.y+v.nc*weights.z);
 return CaptureResult(vec4f(normal,height),0.5+atan(height-capture[8].y)/3.14159265359);
}
@fragment fn fieldFragment(v:FieldVertex)->CaptureResult {return fieldSample(v,(v.clip.xy/capture[18].x*2.0-1.0)*capture[12].w+capture[8].xz);}
@fragment fn probeFragment(v:FieldVertex)->CaptureResult {return fieldSample(v,capture[8].xz);}
`,a=e.createShaderModule({code:i});this.pipelines=[`mask`,`field`,`probe`].map(t=>e.createRenderPipeline({layout:`auto`,vertex:{module:a,entryPoint:t+`Vertex`},fragment:{module:a,entryPoint:t+`Fragment`,targets:[{format:`rgba32float`}]},primitive:{topology:`triangle-list`,cullMode:`none`},depthStencil:{format:`depth32float`,depthCompare:`greater`,depthWriteEnabled:!0}}))}dispose(){this.coordinates?.destroy(),this.coordinates=this.token=void 0,this.pipelines=[]}},w=`${x}

fn sunRefracted(n:vec3f,toSun:vec3f,ior:f32)->vec3f {
 let i=-toSun;let eta=1.0/ior;let c=-dot(n,i);let k=1.0-eta*eta*(1.0-c*c);
 if(k<0.0){return vec3f(0,-1,0);}return normalize(eta*i+(eta*c-sqrt(k))*n);
}

fn sunDrift(n:vec3f,toSun:vec3f,ior:f32)->vec2f {let t=sunRefracted(n,toSun,ior);return t.xz/max(-t.y,0.05);}


fn sunFocus(s:vec2f,sx:vec2f,sz:vec2f,h:f32,z:f32)->f32 {
 let dx=(sx-s)/h;let dz=(sz-s)/h;let j=(1.0+z*dx.x)*(1.0+z*dz.y)-z*dx.y*z*dz.x;return min(1.0/max(abs(j),0.1),10.0);
}
fn dielectric(c:f32,eta:f32)->f32 {
 if(eta==1.0){return 0.0;}
 let s=eta*eta*max(0.0,1.0-c*c);if(s>=1.0){return 1.0;}
 let t=sqrt(1.0-s);let a=(eta*c-t)/max(eta*c+t,1e-8);let b=(c-eta*t)/max(c+eta*t,1e-8);
 return (a*a+b*b)*0.5;
}
fn world(pixel:vec2f,z:f32)->vec3f {
 let xy=(pixel-u[14].xy)/u[14].zw*vec2f(2,-2)+vec2f(-1,1);return unproject(xy,z);
}
fn project(p:vec3f)->vec2f {
 let q=mat4x4f(u[0],u[1],u[2],u[3])*vec4f(p,1);
 return u[14].xy+(q.xy/q.w*vec2f(0.5,-0.5)+0.5)*u[14].zw;
}
fn depthPoint(p:vec2i,fallback:vec3f)->vec3f {
 let low=vec2i(u[14].xy);let high=low+vec2i(u[14].zw);
 if(any(p<low)||any(p>=high)){return fallback;}
 let z=textureLoad(depth,p,0);if(z==0){return fallback;}
 return world(vec2f(p)+0.5,z);
}
fn tracePixel(origin:vec3f,ray:vec3f,pixel:vec2i,lo:f32,hi:f32)->vec4f {
  let low=vec2i(u[14].xy);let high=low+vec2i(u[14].zw);
  if(any(pixel<low)||any(pixel>=high)){return vec4f(0,0,0,-1);}
  let z=textureLoad(depth,pixel,0);if(z==0){return vec4f(0,0,0,-1);}
  let p=world(vec2f(pixel)+0.5,z);
  let right=depthPoint(pixel+vec2i(1,0),p)-p;let left=p-depthPoint(pixel-vec2i(1,0),p);
  let down=depthPoint(pixel+vec2i(0,1),p)-p;let up=p-depthPoint(pixel-vec2i(0,1),p);
  let dx=select(right,left,dot(left,left)>0&&dot(left,left)<dot(right,right));
  let dy=select(down,up,dot(up,up)>0&&dot(up,up)<dot(down,down));
  let n=cross(dx,dy);let denom=dot(n,ray);
  if(abs(denom)<1e-12){return vec4f(0,0,0,-1);}
  let distance=dot(n,p-origin)/denom;
  if(distance<lo||distance>hi){return vec4f(0,0,0,-1);}
  let hit=origin+ray*distance;let at=project(hit);


  let epsilon=max(abs(at),vec2f(1))*0.000002;
  if(any(at<vec2f(pixel)-epsilon)||any(at>vec2f(pixel)+1.0+epsilon)){return vec4f(0,0,0,-1);}
  let planeError=length(world(at,z)-hit);


  if(planeError>u[21].y+length(dx)+length(dy)){return vec4f(0,0,0,-1);}
  return vec4f(textureLoad(opaque,pixel,0).rgb,distance);
}



fn trace(origin:vec3f,ray:vec3f)->vec4f {
 let m=mat4x4f(u[0],u[1],u[2],u[3]);let a=m*vec4f(origin,1);let b=m*vec4f(ray,0);
 let ds=array<f32,6>(a.w+a.x,a.w-a.x,a.w+a.y,a.w-a.y,a.z,a.w-a.z);
 let vs=array<f32,6>(b.w+b.x,b.w-b.x,b.w+b.y,b.w-b.y,b.z,b.w-b.z);
 var lo=0.001;var hi=u[19].y;
 for(var j=0;j<6;j++){
  if(vs[j]>0){lo=max(lo,-ds[j]/vs[j]);}else if(vs[j]<0){hi=min(hi,-ds[j]/vs[j]);}
  else if(ds[j]<0){return vec4f(0,0,0,-1);}
 }
 if(lo>=hi){return vec4f(0,0,0,-1);}
 hi=mix(lo,hi,0.999999);lo=mix(lo,hi,0.000001);
 let pa=project(origin+ray*lo);let pb=project(origin+ray*hi);let delta=pb-pa;
 var pixel=vec2i(floor(pa));let step=vec2i(sign(delta));
 let increment=1.0/max(abs(delta),vec2f(1e-20));
 var edge=(vec2f(pixel)+select(vec2f(0),vec2f(1),delta>=vec2f(0))-pa)/select(vec2f(1e-20),delta,abs(delta)>vec2f(1e-20));
 edge=select(vec2f(1e20),edge,abs(delta)>vec2f(1e-20));
 for(var i=0.0;i<u[21].x;i+=1.0){
  let hit=tracePixel(origin,ray,pixel,lo,hi);if(hit.w>=0.0){return hit;}
  if(min(edge.x,edge.y)>1.0){break;}
  if(edge.x<edge.y){pixel.x+=step.x;edge.x+=increment.x;}
  else {pixel.y+=step.y;edge.y+=increment.y;}
 }
 return vec4f(0,0,0,-1);
}
fn sky(ray:vec3f)->vec3f {
 if(u[23].w>0.5){return textureSampleLevel(environment,skySampler,seaSkyUv(ray,u[21].z),0).rgb*u[21].w;}
 return mix(u[22].rgb,u[23].rgb,clamp(ray.y,0.0,1.0));
}
`,T=e=>`${l}${e?b:``}
@group(0) @binding(0) var<uniform> u:array<vec4f,24>;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var depth:texture_depth_2d;
@group(0) @binding(3) var mask:texture_2d<f32>;
@group(0) @binding(4) var field:texture_2d<f32>;
@group(0) @binding(5) var probe:texture_2d<f32>;
@group(0) @binding(6) var opaque:texture_2d<f32>;
@group(0) @binding(7) var environment:texture_2d<f32>;
@group(0) @binding(8) var skySampler:sampler;
fn unproject(xy:vec2f,d:f32)->vec3f {let p=mat4x4f(u[4],u[5],u[6],u[7])*vec4f(xy,d,1);return p.xyz/p.w;}
${w}
fn cell(xz:vec2f)->vec2i {let r=u[18].x;return vec2i(floor(((xz-u[8].xz)/u[12].w*0.5+0.5)*r));}
fn surfaceAt(p:vec2i)->vec4f {let r=i32(u[18].x);if(any(p<vec2i(0))||any(p>=vec2i(r))){return vec4f(0);}return textureLoad(field,p,0);}

fn refracted(n:vec3f)->vec3f {return sunRefracted(n,u[12].xyz,u[19].w);}
fn slope(n:vec3f)->vec2f {return sunDrift(n,u[12].xyz,u[19].w);}

fn focus(p:vec2i,z:f32)->f32 {
 let a=surfaceAt(p);let b=surfaceAt(p+vec2i(1,0));let c=surfaceAt(p+vec2i(0,1));
 if(dot(a.xyz,a.xyz)<0.5||dot(b.xyz,b.xyz)<0.5||dot(c.xyz,c.xyz)<0.5){return 1.0;}
 return sunFocus(slope(a.xyz),slope(b.xyz),slope(c.xyz),2.0*u[12].w/u[18].x,z);
}
fn hg(c:f32)->f32 {let g=u[17].w;let d=1.0+g*g-2.0*g*c;return (1.0-g*g)/(12.566370614*d*sqrt(d));}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let now=textureLoad(scene,p,0);
 let xy=(at.xy-u[14].xy)/u[14].zw*vec2f(2,-2)+vec2f(-1,1);
 let near=unproject(xy,1.0);let probed=textureLoad(probe,vec2i(0),0);
 let level=vec3f(u[8].x,probed.w,u[8].z);let found=dot(probed.xyz,probed.xyz)>0.5;
 let side=dot(near-level,select(vec3f(0,1,0),normalize(probed.xyz),found));
 let px=max(fwidth(side),1e-9);
 if(u[20].y<0.5||!found){return vec4f(${e?`toDisplay(now.rgb)`:`now.rgb`},now.a);}
 var rgb=now.rgb;

 let submerged=1.0-smoothstep(-px*0.5,px*0.5,side);
 if(submerged>0.0){
  let d=textureLoad(depth,p,0);let far=unproject(xy,max(d,0.000001));let ray=normalize(far-near);
  var span=select(u[19].y,distance(near,far),d>0.0);
  let hit=textureLoad(mask,p,0);let hitSpan=max(0.0,abs(hit.w)-distance(u[8].xyz,near));
  if(dot(hit.xyz,hit.xyz)>0.5&&hit.w<0.0&&hitSpan<span){
   span=hitSpan;let point=near+ray*span;let n=-normalize(hit.xyz);
   let cosine=clamp(dot(-ray,n),0.0,1.0);let f=dielectric(cosine,u[19].w);
   let reflected=trace(point+n*0.001,reflect(ray,n));
   let k=u[16].xyz+u[17].xyz;


   var reflection=u[15].rgb*u[17].rgb/max(k,vec3f(1e-6));
   if(reflected.w>=0.0){let t=exp(-k*reflected.w);reflection=reflected.rgb*t+reflection*(vec3f(1)-t);}
   var transmission=vec3f(0);
   if(f<1.0){let r=refract(ray,n,u[19].w);let sample=trace(point-n*0.001,r);transmission=select(sky(r),sample.rgb,sample.w>=0.0);}
   rgb=mix(transmission,reflection,f);
  }
  let a=u[16].xyz;let b=u[17].xyz;let k=a+b;let view=exp(-k*span);
  let sun=u[13].xyz*u[13].w;let down=refracted(vec3f(0,1,0));let cosine=max(0.0,u[12].y);
  let fresnel=1.0-(0.02+0.98*pow(1.0-cosine,5.0));
  let phase=hg(dot(down,-ray));let ambient=u[15].xyz;
  let march=min(span,u[19].z);let steps=u[16].w;let dt=march/steps;
  let jitter=fract(52.9829189*fract(dot(at.xy,vec2f(0.06711056,0.00583715))));
  var light=vec3f(0);
  for(var i=0.0;i<steps;i+=1.0){
   let t=(i+jitter)*dt;let q=near+ray*t;
   let lift=max(0.0,probed.w-q.y);let foot=q.xz+down.xz*lift/min(down.y,-0.05);
   let c=cell(foot);let s=surfaceAt(c);let top=select(probed.w,s.w,dot(s.xyz,s.xyz)>0.5);let z=top-q.y;
   if(z<=0.0){continue;}
   let shaft=u[20].x*focus(c,z)*fresnel*phase*sun*exp(-k*z/max(-down.y,0.05));
   light+=b*(shaft+ambient*exp(-k*z))*exp(-k*t)*dt;
  }

  let z=max(0.0,probed.w-(near+ray*march).y);
  let tail=b*(u[20].x*fresnel*phase*sun*exp(-k*z/max(-down.y,0.05))+ambient*exp(-k*z))*(exp(-k*march)-view)/max(k,vec3f(1e-6));
  rgb=mix(now.rgb,rgb*view+light+tail,submerged);
 }
 let band=select(0.0,1.0-smoothstep(0.0,u[19].x,abs(side)/px),u[19].x>0.0);
 rgb=mix(rgb,rgb*vec3f(0.35,0.5,0.55),band);
 return vec4f(${e?`toDisplay(rgb)`:`rgb`},now.a);
}`,E=class n{coreRequirement=e(`0.1.0`,import.meta.url);constructor(e){if(this.options=e,this.name=`water:underwater`,this.disposed=!1,this.values=new Float32Array(96),this.workspace=new Float64Array(52),this.capture=new C,this.targets=[],this.depths=[],this.pipelines=new Map,this.validate(),!u.has(e.surface))throw o(`state`,`Underwater surface must be a Water or FFTOcean`);this.surface=e.surface,this.resolution=e.resolution??128}static attach(i,a){t(i,e(`0.1.0`,import.meta.url));let o=new n(a);return o.stack=r.join(i,o),o}validate(){let e=this.options;if(!e||typeof e!=`object`)throw o(`state`,`Underwater needs options.surface, a live Water or FFTOcean`);for(let[t,n,r,i]of[[`anisotropy`,-.99,.99,!1],[`shafts`,0,10,!1],[`steps`,1,128,!0],[`shaftDistance`,.1,1e4,!1],[`maxDistance`,.1,1e5,!1],[`shaftExtent`,1,1e4,!1],[`resolution`,16,1024,!0],[`waterline`,0,64,!1],[`refractiveIndex`,1,2,!1],[`raySteps`,1,2048,!0],[`thickness`,.001,10,!1]]){let a=e[t];if(a!==void 0&&(!Number.isFinite(a)||a<n||a>r||i&&!Number.isInteger(a)))throw p(`Underwater ${t} must be ${i?`an integer`:`finite`} in ${n}..${r}; pass a value in range`,`geometry`)}if(e.resolution!==void 0&&e.resolution&e.resolution-1)throw p(`Underwater resolution must be a power of two; use 16, 32, ... 1024`,`geometry`);for(let t of[`absorption`,`scattering`,`skyHorizon`,`skyZenith`]){let n=e[t];if(n!==void 0&&(typeof n!=`object`||n.length!==3||n.some(e=>!Number.isFinite(e)||e<0||e>100)))throw p(`Underwater ${t} needs three finite per-metre channels in 0..100`,`geometry`)}if(e.enabled!==void 0&&typeof e.enabled!=`boolean`)throw o(`state`,`Underwater enabled must be true or false`);if(e.environment!==void 0&&typeof e.environment!=`function`||e.skyEnvironment!==void 0&&!g(e.skyEnvironment))throw o(`state`,`Pass a Sky texture callback as environment or an HDR Environment as skyEnvironment`)}joinStack(e){if(this.disposed)throw o(`disposed`,`Underwater is disposed; create another Underwater`);if(this.host||this.engine)throw o(`attached`,`Underwater is already attached; create another Underwater for the other stack`,`state`);return this.host=e,{kind:`hdr`,render:(e,t,n)=>this.composite(e,t,n)}}setup(e){if(this.disposed)throw o(`disposed`,`Underwater is disposed; create another Underwater`);if(this.engine)throw o(`attached`,`Underwater is already attached; create another Underwater for the other stack`,`state`);if(!this.host)throw o(`state`,`Use Underwater.attach or add Underwater to a PostStack`);if(!e.gpu)throw o(`unsupported`,`Underwater requires WebGPU or full WebGL2 compatibility`,`webgpu`);this.engine=e,this.uniform=e.gpu.createBuffer({size:384,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.sampler=e.gpu.createSampler({magFilter:`linear`,minFilter:`linear`,addressModeU:`repeat`}),this.removePass=S(this.surface,1,e=>this.probe(e))}textures(e){if(this.targets[0]?.width===e.width&&this.targets[0].height===e.height)return;this.releaseTextures();let t=GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING;for(let[n,r]of[[e.width,e.height],[this.resolution,this.resolution],[1,1]])this.targets.push(e.device.createTexture({size:[n,r],format:`rgba32float`,usage:t})),this.depths.push(e.device.createTexture({size:[n,r],format:`depth32float`,usage:t}));this.opaque=e.device.createTexture({size:[e.width,e.height],format:this.host.target.resolvedColor.format,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),this.opaqueDepth=e.device.createTexture({size:[e.width,e.height],format:`depth32float`,usage:t})}probe(e){this.validate();let t=this.options,n=u.get(this.surface)?.();if(!this.host?.target||!n||n.device!==e.device||this.engine.sceneOf(this)!==this.engine.sceneOf(this.surface))throw o(`state`,`Underwater and its live surface must share an engine, scene and PostStack`);if(this.prepared=e.encoder,t.enabled===!1)return!1;this.textures(e);let r=this.host.target;if(r.resolve(e.encoder),e.encoder.copyTextureToTexture({texture:r.resolvedColor},{texture:this.opaque},[e.width,e.height]),r.samples===4)r.copyDepth(e.encoder,this.opaqueDepth.createView(),1,`depth32float`);else{if(!this.depthCopy){let t=e.device.createShaderModule({code:`${l}
@group(0) @binding(0) var source:texture_depth_2d;
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {return textureLoad(source,vec2i(p.xy),0);}`});this.depthCopy=e.device.createRenderPipeline({layout:`auto`,vertex:{module:t,entryPoint:`vertex`},fragment:{module:t,entryPoint:`fragment`,targets:[]},depthStencil:{format:`depth32float`,depthWriteEnabled:!0,depthCompare:`always`}})}let t=e.encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:this.opaqueDepth.createView(),depthLoadOp:f(e,`clear`),depthStoreOp:`store`,depthClearValue:0}});t.setPipeline(this.depthCopy),t.setBindGroup(0,m(e.device,this.depthCopy,[r.resolvedDepth.createView({aspect:`depth-only`})])),s(t,e),t.draw(3),t.end()}let a=t.skyEnvironment??t.environment;this.environment=_(a);let c=this.environment;if(c&&(c.format!==`rgba16float`||c.sampleCount!==1||c.dimension!==`2d`||c.depthOrArrayLayers!==1||!(c.usage&GPUTextureUsage.TEXTURE_BINDING)))throw o(`state`,`Underwater environment needs a sampleable single-sample 2D rgba16float sky texture`);let d=this.values,p=this.engine.lighting;if(d.fill(0),d.set(e.camera.matrix),!i(e.camera.matrix,d.subarray(16,32),this.workspace))throw o(`state`,`Underwater needs an invertible camera; give it a finite projection`);d.set(e.camera.position,32);let h=p.direction,g=Math.hypot(h[0],h[1],h[2])||1;return d.set([h[0]/g,h[1]/g,h[2]/g,(t.shaftExtent??64)/2],48),d.set([p.radiance[0],p.radiance[1],p.radiance[2],h[3]],52),d.set(e.view?.viewport??[0,0,e.width,e.height],56),d.set([p.ambient[0],p.ambient[1],p.ambient[2],0],60),d.set([...t.absorption??[.38,.1,.045],t.steps??24],64),d.set([...t.scattering??[.02,.035,.04],t.anisotropy??.75],68),d[72]=this.resolution,d.set([t.waterline??2,t.maxDistance??200,t.shaftDistance??40,t.refractiveIndex??1.333],76),d.set([t.shafts??1,1,0,0],80),d.set([t.raySteps??512,t.thickness??.05],84),v(a,d,86),d.set([...t.skyHorizon??[.38,.53,.67],0],88),d.set([...t.skyZenith??[.045,.16,.34],+!!c],92),e.device.queue.writeBuffer(this.uniform,0,d),this.capture.draw(e,this.surface,this.uniform,this.targets,this.depths),!1}composite(e,t,n){if(this.validate(),this.prepared!==e.encoder)throw o(`state`,`Render the live Underwater surface in the same scene before composition`);let r=this.options.enabled!==!1&&this.targets.length>0,i=`${n.format}:${n.multisample.count??1}:${+n.hdr}`,a=this.pipelines.get(i);a||(a=c(e.device,T(!n.hdr),n.format,{multisample:n.multisample}),this.pipelines.set(i,a)),r||(this.values[81]=0,this.targets.length||this.textures(e),e.device.queue.writeBuffer(this.uniform,324,this.values,81,1));let l=this.opaqueDepth,u=e.encoder.beginRenderPass({colorAttachments:[{view:n.view,loadOp:f(e,`clear`),storeOp:`store`}]});u.setPipeline(a),u.setBindGroup(0,m(e.device,a,[{buffer:this.uniform},t,l.createView({aspect:`depth-only`}),...this.targets.map(e=>e.createView()),this.opaque.createView(),(this.environment??this.opaque).createView(),this.sampler])),s(u,e),u.draw(3),u.end()}releaseTextures(){for(let e of[...this.targets,...this.depths])e.destroy();this.targets=[],this.depths=[],this.opaque?.destroy(),this.opaqueDepth?.destroy(),this.opaque=this.opaqueDepth=void 0,this.environment=void 0}release(){this.removePass?.(),this.removePass=void 0,this.releaseTextures(),this.capture.dispose(),this.uniform?.destroy(),this.uniform=void 0,this.pipelines.clear(),this.depthCopy=void 0,this.prepared=void 0}onDeviceRestored(e){this.release(),this.engine=void 0,this.setup(e)}dispose(){if(this.disposed)return;this.disposed=!0;let e=this.engine;this.engine=void 0,e?.sceneOf(this)?.removePlugin(this.name),this.release(),this.stack?.removeEffect(this),this.stack=void 0}[Symbol.dispose??Symbol()](){this.dispose()}},D=(e,t=`0.1.0`,r=import.meta.url)=>n(e,t,r),O=9.81;Math.atan(1/Math.sqrt(8));var k=(e,t,n,r)=>{if(typeof e!=`number`||!Number.isFinite(e)||e<t||e>n)throw p(`Invalid ship ${r}; pass a finite number in ${t}..${n}`,`geometry`);return e},A=(e,t)=>{if(!Array.isArray(e)||e.length!==3||!e.every(e=>typeof e==`number`&&Number.isFinite(e)))throw a(`Ship ${t} must be three finite numbers`,`geometry`);return[e[0],e[1],e[2]]},j=(e,t,n)=>{let r=Math.min(1,Math.max(0,(n-e)/(t-e)));return r*r*(3-2*r)};function M(e){if(!e||typeof e!=`object`)throw a(`Ship hull must be { length, beam, draft }`,`geometry`);return{length:k(e.length,.5,2e3,`hull length`),beam:k(e.beam,.1,1e3,`hull beam`),draft:k(e.draft,.05,600,`hull draft`),entrance:k(e.entrance??20,2,60,`hull entrance`)}}function N(e,t){let n=M(t);if(k(e,0,100,`speed`),e===0)return{height:0,crest:0};let r=n.entrance*Math.PI/180,i=e*e/O,a=Math.min(.5,Math.tan(r)/Math.cos(r)*2.2/(1+e/Math.sqrt(O*n.draft)));return{height:a*i,crest:(1-Math.sqrt(1-2*a))*i}}function P(e,t,n,r){return j(.85*n,n,e)*Math.exp(-(e-t)*r*.5)}function F(e,t,n,r,i){if(e<=0||n<=.05)return 0;let a=O/(n*n),o=2*Math.PI/r,s=Math.max(a,o),c=Math.abs(t),l=c/e,u=Math.hypot(e,c),d=Math.max(a*u,1)**(-2/3),f=Math.sqrt(r/Math.max(u,r)),p=1-8*l*l,m=t=>P(a*(1+t*t),s,o,i)*Math.cos(a*e*Math.sqrt(1+t*t)*(1-l*t));if(p>=0){let e=Math.sqrt(p),t=Math.max(p,d)**-.25,n=m(2*l/(1+e)),r=l>1e-6?m((1+e)/(4*l)):0;return t*f*(n+r)}return 2*d**-.25*f*m(Math.SQRT1_2)*Math.exp(p/d)}function I(e,t,n,r){if(n<=0)return 0;let i=Math.max(n,Math.min(.75,.065*r)),a=Math.max(n,Math.min(.35*r,Math.sqrt(r*i))),o=Math.max(0,t);if(o>=a)return 0;let s=1+(e-n-2*o*o/a)/i;return(s<0?0:s<=1?s*(2-s):Math.exp(-(s-1)*(s-1))*Math.cos(1.2*(s-1)))*(1-j(0,a,o))}function L(e,t,n,r,i){let a=e/r,o=(e-n)/r;if(n<=0||o<=.02||a>=.97)return 0;let s=.17+.13*(1-j(.12,.64,n)),c=Math.min(.3*i,Math.max(s*i,2*n)),l=Math.max(0,t)/c;if(l>=1)return 0;let u=(1-l)*(1-l)*(1-4*l);return .45*j(.02,.14,o)*(1-j(.22,.97,a))*u}function R(e,t,n,r,i){let a=r/2,o=Math.abs(t);if(e<0)return Math.hypot(e,o);if(e>n)return Math.hypot(e-n,Math.max(o-a,0));let s=Math.min(1,e*i/r);return o-a*s*(2-s)}var z=Object.freeze({wakeHeight:1,sternWaves:.5,wakeLife:120,bowWave:1,waterlineFoam:.8,foamLife:40,turbulentWake:1,lampRoughness:null,lampIntensity:1}),B={wakeHeight:[0,5],sternWaves:[0,1],wakeLife:[1,3600],bowWave:[0,3],waterlineFoam:[0,10],foamLife:[1,600],turbulentWake:[0,3],lampRoughness:[.02,1],lampIntensity:[0,100]},V=class{constructor(e){if(this.tint=null,this.recorded=[],!e||typeof e!=`object`)throw a(`Each ship needs options { hull }`,`geometry`);if(this.hull=Object.freeze(M(e.hull)),e.path!==void 0&&typeof e.path!=`function`)throw a(`Ship path must be a function (time) => [x, z]`,`geometry`);this.path=e.path,this.lamps=H(e.lamps??[],`ship lamps`),this.wake=k(e.wake??1,0,5,`wake`),this.wakeTint=e.wakeTint??null,this.state={position:[0,0,0],heading:0,speed:0,pitch:0,roll:0},e.pose&&this.setPose(e.pose)}get pose(){return this.state}get wakeTint(){return this.tint}set wakeTint(e){if(e===null)this.tint=null;else{let[t,n,r]=A(e,`wake tint`);this.tint=Object.freeze([k(t,0,1,`wake tint red`),k(n,0,1,`wake tint green`),k(r,0,1,`wake tint blue`)])}}setPose(e){if(!e||typeof e!=`object`)throw a(`Ship pose must be { position, heading, speed }`,`geometry`);return this.state={position:A(e.position,`position`),heading:k(e.heading,-1e6,1e6,`heading`),speed:k(e.speed,0,100,`speed`),pitch:k(e.pitch??0,-Math.PI,Math.PI,`pitch`),roll:k(e.roll??0,-Math.PI,Math.PI,`roll`)},this}follow(e,t){return this.setPose({position:e.position,heading:e.heading,speed:t,pitch:e.pitch,roll:e.roll})}clearTrail(){return this.recorded=[],this}resetTime(){this.recorded=[],this.state={position:[0,0,0],heading:0,speed:0,pitch:0,roll:0}}trail(e,t){let n=this.hull.length;if(this.path){let r=e=>{let t=this.path(e);if(!Array.isArray(t)||t.length!==2||!Number.isFinite(t[0])||!Number.isFinite(t[1]))throw a(`Ship path must return a finite [x, z]`,`geometry`);return t},i=1/30,o=r(e-i),s=r(e+i),c=(s[0]-o[0])/(2*i),l=(s[1]-o[1])/(2*i),u=Math.hypot(c,l),d=r(e),f=u>1e-6?Math.atan2(c,l)*180/Math.PI:this.state.heading;this.state={...this.state,position:[d[0],this.state.position[1],d[1]],heading:f,speed:Math.min(100,u)};let p=[],m=u>.05?t/u/63:0,h=f;for(let t=0;t<64&&(t===0||m>0);t++){let a=e-t*m,o=t===0?d:r(a),s=r(a-i),c=r(a+i),l=Math.hypot(c[0]-s[0],c[1]-s[1])/(2*i);l>1e-6&&(h=Math.atan2(c[0]-s[0],c[1]-s[1])*180/Math.PI);let u=this.forward(h),f=u[0]*n/2,g=u[1]*n/2;p.push({x:o[0]+f,z:o[1]+g,sternX:o[0]-f,sternZ:o[1]-g,t:a,u:Math.min(100,l)})}return p}let r=this.forward(this.state.heading),i=this.state.position,o=r[0]*n/2,s=r[1]*n/2,c={x:i[0]+o,z:i[2]+s,sternX:i[0]-o,sternZ:i[2]-s,t:e,u:this.state.speed},l=this.recorded[0];l&&e<l.t&&(this.recorded=[]);let u=t/63;(!this.recorded.length||Math.hypot(c.x-this.recorded[0].x,c.z-this.recorded[0].z)>=u)&&this.recorded.unshift(c);let d=0,f=0,p=[c];for(let e of this.recorded){if(p.length>=64||d>t)break;f++;let n=p[p.length-1],r=Math.hypot(e.x-n.x,e.z-n.z);r<1e-9||(d+=r,p.push(e))}return this.recorded.length=f,p}forward(e){let t=e*Math.PI/180;return[Math.sin(t),Math.cos(t)]}};function H(e,t){if(!Array.isArray(e)||e.length>16)throw p(`Invalid ${t}; pass up to 16`,`geometry`);return Object.freeze(e.map(e=>Object.freeze({position:A(e?.position,`lamp position`),color:A(e.color??[1,.78,.5],`lamp color`).map(e=>k(e,0,1,`lamp color`)),intensity:k(e.intensity??50,0,1e6,`lamp intensity`)})))}var U=20,W=300,G=4096,K=`
struct ShipRecord {a:vec4f,b:vec4f,c:vec4f,d:vec4f,tint:vec4f}
struct ShipData {head:vec4f,look:vec4f,foam:vec4f,ships:array<ShipRecord,8>,lamps:array<vec4f,32>}
struct ShipSurface {height:f32,foam:f32,tint:vec4f}
fn shipSmooth(a:f32,b:f32,x:f32)->f32 {return smoothstep(a,b,x);}
fn shipHullWeight(k:f32,k0:f32,kl:f32,d:f32)->f32 {return shipSmooth(0.85*kl,kl,k)*exp(-(k-k0)*d*0.5);}
fn shipWaveTerm(t:f32,kg:f32,k0:f32,kl:f32,d:f32,x:f32,tau:f32)->f32 {
 return shipHullWeight(kg*(1.0+t*t),k0,kl,d)*cos(kg*x*sqrt(1.0+t*t)*(1.0-tau*t));
}
fn shipWaveAt(x:f32,y:f32,u:f32,l:f32,d:f32)->f32 {
 if(x<=0.0||u<=0.05){return 0.0;}
 let kg=9.81/(u*u);let kl=6.28318531/l;let k0=max(kg,kl);
 let ay=abs(y);let tau=ay/x;let r=length(vec2f(x,ay));
 let eps=pow(max(kg*r,1.0),-0.66666667);let spread=sqrt(l/max(r,l));let disc=1.0-8.0*tau*tau;
 if(disc>=0.0){
  let q=sqrt(disc);let c=pow(max(disc,eps),-0.25);
  var diverging=0.0;if(tau>1e-6){diverging=shipWaveTerm((1.0+q)/(4.0*tau),kg,k0,kl,d,x,tau);}
  return c*spread*(shipWaveTerm(2.0*tau/(1.0+q),kg,k0,kl,d,x,tau)+diverging);
 }
 return 2.0*pow(eps,-0.25)*spread*shipWaveTerm(0.70710678,kg,k0,kl,d,x,tau)*exp(disc/eps);
}
fn shipRidge(s:f32,outside:f32,crest:f32,beam:f32)->f32 {
 if(crest<=0.0){return 0.0;}
 let span=max(crest,min(0.75,0.065*beam));
 let width=max(crest,min(0.35*beam,sqrt(beam*span)));let off=max(0.0,outside);
 if(off>=width){return 0.0;}
 let sigma=1.0+(s-crest-2.0*off*off/width)/span;var along=0.0;
 if(sigma>=0.0&&sigma<=1.0){along=sigma*(2.0-sigma);}else if(sigma>1.0){along=exp(-(sigma-1.0)*(sigma-1.0))*cos(1.2*(sigma-1.0));}
 return along*(1.0-shipSmooth(0.0,width,off));
}
fn shipSideWash(s:f32,outside:f32,crest:f32,l:f32,b:f32)->f32 {
 let station=s/l;let fromCrest=(s-crest)/l;
 if(crest<=0.0||fromCrest<=0.02||station>=0.97){return 0.0;}
 let beamFraction=0.17+0.13*(1.0-shipSmooth(0.12,0.64,crest));
 let width=min(0.3*b,max(beamFraction*b,2.0*crest));let q=max(0.0,outside)/width;
 if(q>=1.0){return 0.0;}
 let section=(1.0-q)*(1.0-q)*(1.0-4.0*q);
 return 0.45*shipSmooth(0.02,0.14,fromCrest)*(1.0-shipSmooth(0.22,0.97,station))*section;
}
fn shipHullDistance(s:f32,y:f32,l:f32,b:f32,tanE:f32)->f32 {
 let half=b*0.5;let ay=abs(y);
 if(s<0.0){return length(vec2f(s,ay));}
 if(s>l){return length(vec2f(s-l,max(ay-half,0.0)));}
 let reach=min(1.0,s*tanE/b);return ay-half*reach*(2.0-reach);
}

fn shipStation(index:u32,stern:bool)->vec3f {
 return select(shipTrail[index*2u].xyz,shipTrail[index*2u+1u].yzw,stern);
}
fn shipLocal(i:u32,p:vec2f,stern:bool)->vec4f {
 let ship=shipData.ships[i];let first=u32(ship.d.x);let count=u32(ship.d.y);let f=ship.a.zw;
 let rel=p-shipStation(first,stern).xy;
 let current=vec4f(-dot(rel,f),f.y*rel.x-f.x*rel.y,ship.b.x,0.0);
 let noTrack=vec4f(1e30,0.0,0.0,0.0);
 if(count<2u){return select(current,noTrack,stern);}
 var best=1e30;var out=noTrack;
 for(var j=0u;j+1u<count;j++){
  let a=shipStation(first+j,stern);let b=shipStation(first+j+1u,stern);
  let d=b.xy-a.xy;let w=p-a.xy;let len2=dot(d,d);
  if(stern&&len2<1e-9){continue;}
  let along=dot(w,d)/max(len2,1e-9);let t=clamp(along,0.0,1.0);
  let e=w-d*t;let dist2=dot(e,e);
  if(dist2<best){
   best=dist2;let side=select(-1.0,1.0,d.x*w.y-d.y*w.x<0.0);
   let ua=shipTrail[(first+j)*2u+1u].x;let ub=shipTrail[(first+j+1u)*2u+1u].x;
   let aa=shipTrail[(first+j)*2u].w;let ab=shipTrail[(first+j+1u)*2u].w;
   out=vec4f(mix(a.z,b.z,t),side*sqrt(dist2),mix(ua,ub,t),mix(aa,ab,t));
   if(j==0u&&along<=0.0){out=current;}
   if(stern&&along>1.0&&j+2u==count){out=noTrack;}
  }
 }
 return out;
}

fn shipWake(p:vec2f,sampleFoam:bool)->ShipSurface {
 var height=0.0;var foam=0.0;var tint=vec4f(0);
 for(var i=0u;i<u32(shipData.head.x);i++){
  let ship=shipData.ships[i];let local=shipLocal(i,p,false);
  let l=ship.b.y;let b=ship.b.z;let d=ship.b.w;let span=ship.d.z;
  if(local.x>span){continue;}
  let s=local.x;let y=local.y;let u=local.z;let age=local.w;
  let fade=(1.0-shipSmooth(0.8*span,span,s))*exp(-age/shipData.look.z);
  let rel=p-ship.a.xy;let f=ship.a.zw;
  let bowS=-dot(rel,f);let bowY=f.y*rel.x-f.x*rel.y;
  let hull=shipHullDistance(bowS,bowY,l,b,ship.c.z);let mask=shipSmooth(-0.25*b,0.0,hull);
  let a0=0.25*ship.c.x*ship.c.w*shipData.look.x;
  let waves=a0*(shipWaveAt(s,y,u,l,d)-shipData.look.y*shipWaveAt(s-l,y,u,l,d))*fade;
  let crestRidge=shipRidge(bowS,hull,ship.c.y,b);
  let side=shipSideWash(bowS,hull,ship.c.y,l,b);
  let nearHull=ship.c.x*ship.c.w*shipData.look.w*(crestRidge+side);
  height+=(waves+nearHull)*mask;
  if(!sampleFoam){continue;}
  let speed=ship.b.x;let fr=speed/sqrt(9.81*l);
  let band=shipData.foam.x*(0.5+min(fr,1.0));
  var wl=0.0;if(band>0.0&&bowS<=l+band){wl=(1.0-shipSmooth(0.0,band,hull))*shipSmooth(-0.1*b,0.0,hull)*shipSmooth(0.3,2.0,speed);}
  var turbulent=0.0;
  if(shipData.foam.z>0.0){
   let stern=shipLocal(i,p,true);
   if(stern.x>=0.0&&stern.x<span){
    let half=b*0.5*(1.0+0.6*sqrt(stern.x/l));
    turbulent=shipData.foam.z*exp(-stern.w/shipData.foam.y)*(1.0-shipSmooth(0.5*half,half,abs(stern.y)))
      *shipSmooth(0.5,2.2,stern.z)*(1.0-shipSmooth(0.8*span,span,stern.x));
   }
  }
  let tintStrength=turbulent*ship.tint.w;
  if(tintStrength>tint.w){tint=vec4f(ship.tint.rgb,tintStrength);}
  var breaking=0.0;if(speed>0.05){breaking=shipSmooth(0.3,0.48,9.81*ship.c.x/(speed*speed))*shipSmooth(0.5,2.0,speed)*max(crestRidge,0.0)*mask*min(shipData.look.w,1.0);}
  foam=max(foam,max(max(wl,turbulent),breaking));
 }
 return ShipSurface(height,clamp(foam,0.0,1.0),vec4f(tint.rgb,clamp(tint.w,0.0,1.0)));
}
`,q=`


fn shipLamps(world:vec3f,n:vec3f,v:vec3f,waterRough:f32)->vec3f {
 var rough=waterRough;if(shipData.head.z>0.0){rough=shipData.head.z;}
 var sum=vec3f(0);
 for(var i=0u;i<u32(shipData.head.y);i++){
  let lamp=shipData.lamps[i*2u];let color=shipData.lamps[i*2u+1u].rgb;
  let toLamp=lamp.xyz-world;let dist2=max(dot(toLamp,toLamp),0.01);let l=toLamp*inverseSqrt(dist2);
  if(dot(n,l)<=0.0){continue;}
  sum+=color*(lamp.w*shipData.foam.w/dist2)*seaGlint(n,v,l,rough);
 }
 return sum;
}
`,J=class n{coreRequirement=e(`0.1.0`,import.meta.url);constructor(e){if(this.name=`water:ships-`+Y++,this.ships=[],this.seconds=0,this.resources=[],this.disposed=!1,this.values=new Float32Array(W),this.trails=new Float32Array(G),this.builtAt=NaN,!e?.surface||typeof e.surface.onDispose!=`function`)throw o(`state`,`ShipWakes need a Water surface; pass options.surface`);this.surface=e.surface,this.trailLengths=k(e.trail??30,2,200,`trail`),this.look={...z},this.setLook(e.look??{}),this.lamps=H(e.lamps??[],`fixed lamps`);for(let t of e.ships??[])this.add(t)}static attach(r,i){t(r,e(`0.1.0`,import.meta.url));let a=new n(i);return D(r).use(a),a}add(e){if(this.live(),this.ships.length>=8)throw p(`ShipWakes holds up to 8 ships`,`geometry`);let t=new V(e);return this.ships.push(t),this.builtAt=NaN,t}delete(e){let t=this.ships.indexOf(e);return t<0?!1:(this.ships.splice(t,1),this.builtAt=NaN,!0)}setLook(e){for(let[t,n]of Object.entries(e)){let e=B[t];if(!e)throw a(`Unknown ship look ${t}; use a name of SHIP_LOOK_DEFAULTS`,`geometry`);t===`lampRoughness`&&n===null?this.look.lampRoughness=null:this.look[t]=k(n,e[0],e[1],t)}return this.builtAt=NaN,this}get time(){return this.seconds}setTime(e){return this.seconds=k(e,-1e9,1e9,`time`),this.builtAt=NaN,this}resetTime(){this.seconds=0,this.builtAt=NaN,this.trails.fill(0),this.values.fill(0);for(let e of this.ships)e.resetTime()}advanceTime(e){e>0&&Number.isFinite(e)&&(this.seconds+=e,this.builtAt=NaN)}onPreUpdate(e){this.advanceTime(e)}build(){if(this.live(),this.builtAt===this.seconds)return;let e=this.values,t=this.look;e.fill(0),this.trails.fill(0);let n=[];this.ships.forEach((t,r)=>{let i=t.hull,a=this.trailLengths*i.length,o=t.trail(this.seconds,a),s=t.pose,c=t.forward(s.heading),l=N(s.speed,i),u=12+r*U;e.set([o[0].x,o[0].z,c[0],c[1]],u),e.set([s.speed,i.length,i.beam,i.draft],u+4),e.set([l.height,l.crest,Math.tan(i.entrance*Math.PI/180),t.wake],u+8),e.set([r*64,o.length,a,0],u+12);let d=0,f=0;o.forEach((e,t)=>{if(t){let n=o[t-1];d+=Math.hypot(e.x-n.x,e.z-n.z),f+=Math.hypot(e.sternX-n.sternX,e.sternZ-n.sternZ)}this.trails.set([e.x,e.z,d,Math.max(0,this.seconds-e.t),e.u,e.sternX,e.sternZ,f],(r*64+t)*8)});let p=Math.cos(s.pitch),m=Math.sin(s.pitch),h=Math.cos(s.roll),g=Math.sin(s.roll);for(let e of t.lamps){let[t,r,i]=e.position,a=r*h+t*g,o=t*h-r*g,l=i*p-a*m,u=a*p+i*m;n.push({p:[s.position[0]+o*c[1]+l*c[0],s.position[1]+u,s.position[2]-o*c[0]+l*c[1]],c:e.color,i:e.intensity})}});for(let e of this.lamps)n.push({p:e.position,c:e.color,i:e.intensity});if(n.length>16)throw p(`ShipWakes draws up to 16 lamps, ships' and fixed ones together`,`geometry`);e.set([this.ships.length,n.length,t.lampRoughness??-1,0],0),e.set([t.wakeHeight,t.sternWaves,t.wakeLife,t.bowWave],4),e.set([t.waterlineFoam,t.foamLife,t.turbulentWake,t.lampIntensity],8),n.forEach((t,n)=>e.set([...t.p,t.i,...t.c,0],172+n*8)),this.builtAt=this.seconds}lampPositions(){this.build();let e=this.values[1],t=[];for(let n=0;n<e;n++){let e=172+n*8;t.push([this.values[e],this.values[e+1],this.values[e+2]])}return t}trailAt(e,t,n,r){let i=this.trails,a=12+n*U,o=this.values[a+12],s=this.values[a+13],c=r?5:0,l=e-i[o*8+c],u=t-i[o*8+c+1],d=this.values[a+2],f=this.values[a+3],p=[-l*d-u*f,f*l-d*u,this.values[a+4],0],m=[1/0,0,0,0];if(s<2)return r?m:p;let h=1/0,g=m;for(let n=0;n+1<s;n++){let a=(o+n)*8,l=a+8,u=i[l+c]-i[a+c],d=i[l+c+1]-i[a+c+1],f=e-i[a+c],_=t-i[a+c+1],v=u*u+d*d;if(r&&v<1e-9)continue;let y=(f*u+_*d)/Math.max(v,1e-9),b=Math.min(1,Math.max(0,y)),x=f-u*b,S=_-d*b,C=x*x+S*S;if(!(C>=h)){if(h=C,n===0&&y<=0)g=p;else if(r&&y>1&&n+2===s)g=m;else{let e=u*_-d*f<0?1:-1;g=[i[a+c+2]+(i[l+c+2]-i[a+c+2])*b,e*Math.sqrt(C),i[a+4]+(i[l+4]-i[a+4])*b,i[a+3]+(i[l+3]-i[a+3])*b]}}}return g}sample(e,t){k(e,-1e7,1e7,`x`),k(t,-1e7,1e7,`z`),this.build();let n=this.values,r=0,i=0;for(let a=0;a<n[0];a++){let o=12+a*U,s=n[o+14],c=n[o+5],l=n[o+6],u=n[o+7],[d,f,p,m]=this.trailAt(e,t,a,!1);if(d>s)continue;let h=(1-j(.8*s,s,d))*Math.exp(-m/n[6]),g=e-n[o],_=t-n[o+1],v=-g*n[o+2]-_*n[o+3],y=R(v,n[o+3]*g-n[o+2]*_,c,l,n[o+10]),b=j(-.25*l,0,y),x=.25*n[o+8]*n[o+11]*n[4]*(F(d,f,p,c,u)-n[5]*F(d-c,f,p,c,u))*h,S=I(v,y,n[o+9],l),C=L(v,y,n[o+9],c,l),w=n[o+8]*n[o+11]*n[7]*(S+C);r+=(x+w)*b;let T=n[o+4],E=T/Math.sqrt(O*c),D=n[8]*(.5+Math.min(E,1)),k=D>0&&v<=c+D?(1-j(0,D,y))*j(-.1*l,0,y)*j(.3,2,T):0,A=0;if(n[10]>0){let[r,i,o,u]=this.trailAt(e,t,a,!0);if(r>=0&&r<s){let e=l*.5*(1+.6*Math.sqrt(r/c));A=n[10]*Math.exp(-u/n[9])*(1-j(.5*e,e,Math.abs(i)))*j(.5,2.2,o)*(1-j(.8*s,s,r))}}let M=T>.05?j(.3,.48,O*n[o+8]/(T*T))*j(.5,2,T)*Math.max(S,0)*b*Math.min(n[7],1):0;i=Math.max(i,k,A,M)}return{height:r,foam:Math.min(1,Math.max(0,i))}}setup(e){if(this.live(),this.engine)throw o(`attached`,`ShipWakes already attached; create another ShipWakes`,`state`);if(!e.gpu)throw o(`unsupported`,`ShipWakes need WebGPU or the full WebGL2 compatibility layer`,`webgpu`);if(!e.hasPlugin(this.surface.name))throw o(`state`,`Attach the Water surface to this engine before ShipWakes`);if(h.get(this.surface)?.some(e=>e.key===`ships`))throw o(`attached`,`This Water already has ship wakes; add ships to the attached ShipWakes`,`state`);this.engine=e;let t=e.gpu;this.uniform=t.createBuffer({size:W*4,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.trailBuffer=t.createBuffer({size:G*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.resources=[{buffer:this.uniform},{buffer:this.trailBuffer}],this.remove=y(this.surface,{key:`ships`,vertex:!0,count:2,shader:(e,t)=>X(e,t),prepare:e=>this.prepare(e)}),this.removeDispose=this.surface.onDispose(()=>this.dispose())}prepare(e){if(e.device!==this.engine?.gpu)throw o(`state`,`ShipWakes and Water must use the same engine; attach both to one engine`);this.build();for(let e=0;e<this.ships.length;e++){let t=12+e*U+16,n=this.ships[e].wakeTint;n&&this.values.set(n,t),this.values[t+3]=+!!n}return e.device.queue.writeBuffer(this.uniform,0,this.values),e.device.queue.writeBuffer(this.trailBuffer,0,this.trails),this.resources}onDeviceRestored(e){this.release(),this.engine=void 0,this.setup(e)}live(){if(this.disposed)throw o(`disposed`,`ShipWakes disposed; create another ShipWakes`)}release(){this.remove?.(),this.removeDispose?.(),this.remove=this.removeDispose=void 0,this.uniform?.destroy(),this.trailBuffer?.destroy(),this.uniform=this.trailBuffer=void 0,this.resources=[]}dispose(){this.disposed||(this.disposed=!0,this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.engine=void 0)}[Symbol.dispose??Symbol()](){this.dispose()}},Y=0;function X(e,t){let n=`return Surface(p,normalize(cross(binormal,tangent)),crest);`,r=`var foam=max(fresh,surfFoam);`,i=`var color=mix(body,skyColor(reflect(-v,n),rough),reflection)+glint*shade;`,a=`let body=bottom*transmission+`,s=`vec3f(0.72,0.77,0.74)`,c=`fn directionalGlint(`;for(let t of[n,r,a,i,s,c])if(!e.includes(t))throw o(`state`,`ShipWakes found no place in the Water shader for the wake; update @margoengine/water`);return`
@group(0) @binding(${t}) var<uniform> shipData:ShipData;
@group(0) @binding(${t+1}) var<storage,read> shipTrail:array<vec4f>;
${K}`+e.replace(n,`{let sw=shipWake(xz,false);p.y+=sw.height;
 if(u32(shipData.head.x)>0u){let e=0.25;
  tangent.y+=(shipWake(xz+vec2f(e,0),false).height-shipWake(xz-vec2f(e,0),false).height)/(2.0*e);
  binormal.y+=(shipWake(xz+vec2f(0,e),false).height-shipWake(xz-vec2f(0,e),false).height)/(2.0*e);}}
 ${n}`).replace(r,`${r}
 let shipSurface=shipWake(i.world.xz,true);
 let wash=shipSurface.foam;
 if(wash>0.001){
  let patternValue=noise(i.world.xz*0.38+vec2f(frame.settings.x*0.035,-frame.settings.x*0.021)).x;
  let root=sqrt(wash);
  let threshold=0.37-root;
  let flecks=smoothstep(threshold,threshold+0.16,patternValue);
  let islands=(1.0-smoothstep(0.08,0.30,wash))*0.32*root;
  foam=max(foam,clamp(pattern*(wash*mix(0.40,1.45,flecks)+islands*flecks),0.0,1.0));
 }`).replace(c,q+c).replace(a,`var body=bottom*transmission+`).replace(i,`body=mix(body,shipSurface.tint.rgb*bodyLight,shipSurface.tint.w);
 ${i}color+=shipLamps(i.world,n,v,rough);`).replace(s,`mix(${s},shipSurface.tint.rgb,0.75*shipSurface.tint.w)`)}export{S as i,E as n,C as r,J as t};