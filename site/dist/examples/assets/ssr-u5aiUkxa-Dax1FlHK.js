import{n as e,t}from"./version-DZ3BcJze.js";import{C as n,S as r,_ as i,a,b as o,c as s,d as c,f as l,g as u,h as d,i as f,l as p,o as m,s as h,v as g,x as _,y as v}from"./dist-DCciemw3.js";import{t as y}from"./preset-Czkwunbj-Czkwunbj.js";import{n as ee,t as te}from"./capture-BHyzZamr-W2j1uW54.js";import{o as b}from"./mat4-Dl2hqlTt.js";var x=`@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}
`,S=(e,t)=>`
@group(0) @binding(0) var source:${e};
@group(0) @binding(1) var reduced:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u) {
let size=vec2i(textureDimensions(reduced));let p=vec2i(id.xy);if(any(p>=size)){return;}
let base=p*2;let end=select(base+1,vec2i(textureDimensions(source))-1,p==size-1);var m=0.0;
for(var y=base.y;y<=end.y;y++){for(var x=base.x;x<=end.x;x++){m=max(m,textureLoad(source,vec2i(x,y),0)${t});}}
textureStore(reduced,p,vec4f(m));
}`;function C(e,t,n,r,i,a,o){let s=GPUTextureUsage.TEXTURE_BINDING,c=GPUTextureUsage.STORAGE_BINDING,l=g(e),u=o(i,`r32float`,s|(l?GPUTextureUsage.COPY_DST:c),a),d=u.createView(),p=[],m=[],h=[];for(let d=0;d<a;d++){let a=[Math.max(1,i[0]>>d),Math.max(1,i[1]>>d)];l&&p.push(o(a,`r32float`,s|c|GPUTextureUsage.COPY_SRC)),h.push(a),m.push(f(e,d?r:n,[d?l?p[d-1].createView():u.createView({baseMipLevel:d-1,mipLevelCount:1}):t,l?p[d].createView():u.createView({baseMipLevel:d,mipLevelCount:1})]))}return{view:d,groups:m,sizes:h,own:l?{pyramid:u,levels:p}:void 0}}function w(e,t,n,r){let i=e.beginComputePass();for(let e=0;e<t.groups.length;e++)i.setPipeline(e?r:n),i.setBindGroup(0,t.groups[e]),i.dispatchWorkgroups(Math.ceil(t.sizes[e][0]/8),Math.ceil(t.sizes[e][1]/8));if(i.end(),t.own)for(let n=0;n<t.sizes.length;n++)e.copyTextureToTexture({texture:t.own.levels[n]},{texture:t.own.pyramid,mipLevel:n},[t.sizes[n][0],t.sizes[n][1]])}var T=`@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}

@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var bilinear:sampler;
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f {return textureSampleLevel(source,bilinear,p.xy*2.0/vec2f(textureDimensions(source)),0.0);}
`,E=`fn world(q:vec2f,d:f32)->vec3f {let w=u.inverse*vec4f(q.x/u.a.x*2.0-1.0,1.0-q.y/u.a.y*2.0,d,1.0);return w.xyz/w.w;}
fn screen(p:vec4f)->vec3f {let n=p.xyz/p.w;return vec3f((n.x*0.5+0.5)*u.a.x,(0.5-n.y*0.5)*u.a.y,n.z);}
fn closest(cell:vec2i,level:i32)->f32 {
if(level==0){return textureLoad(depth,cell,0);}
return textureLoad(hiz,min(cell,vec2i(textureDimensions(hiz,level-1))-1),level-1).r;
}
`,D=`let start=u.matrix*vec4f(p,1.0);var end=u.matrix*vec4f(p+r*u.b.x,1.0);
// Clip to the near plane (reversed-Z: z<=w) and the far plane (z>=0), then to the screen.
if(end.z>end.w){end=mix(start,end,0.999*(start.w-start.z)/((start.w-start.z)-(end.w-end.z)));}
if(end.z<0.0){end=mix(start,end,start.z/(start.z-end.z));}
let o=screen(start);var dir=screen(end)-o;
let room=select(vec2f(0.5)-o.xy,u.a.xy-0.5-o.xy,dir.xy>vec2f(0));
let fit=select(vec2f(1),room/dir.xy,abs(dir.xy)>vec2f(1e-6));dir*=clamp(min(fit.x,fit.y),0.0,1.0);
let len=length(dir.xy);
if(len>1.5){
var t=1.5/len;var level=0;var hit=false;let top=i32(u.b.z);let nudge=0.01/max(abs(dir.x),abs(dir.y));
for(var i=0;i<i32(u.b.y);i++){
if(t>1.0){break;}
let h=o+dir*t;let size=exp2(f32(level));let cell=floor(h.xy/size);let z=closest(vec2i(cell),level);
let edge=(cell+select(vec2f(0),vec2f(1),dir.xy>vec2f(0)))*size;
let across=select(vec2f(1e30),(edge-o.xy)/dir.xy,abs(dir.xy)>vec2f(1e-6));let exit=min(across.x,across.y)+nudge;
if(h.z>z){
// In front of everything in this cell: drop to its closest depth if the ray gets there inside the cell, else move on.
let plane=select(2.0,(z-o.z)/dir.z,dir.z<0.0);
if(plane<exit){t=max(t,plane);if(level==0){hit=z>0.0;break;}level--;}else{t=exit;level=min(level+1,top);}
}else if(level>0){level--;}
else if(z>0.0&&distance(world(h.xy,z),world(h.xy,h.z))<u.a.w){hit=true;break;}
else{t=exit;}
}
`,O=[.018,.023,.035,1],k=e=>/^#([\da-f]{3}){1,2}$/i.test(e)?parseInt((e[4]?e:e.replace(/\w/g,`$&$&`)).slice(1),16):-1,A=e=>(e/=255)>.04045?((e+.055)/1.055)**2.4:e/12.92,j=e=>e/255,M=/float$|srgb$/;function N(e,t){if(typeof e!=`string`)return O;let n=k(e),r=M.test(t)?A:j;if(n<0)throw RangeError(`Invalid color; use #rrggbb`);return[r(n>>16),r(n>>8&255),r(n&255),1]}var P=new WeakMap;function F(e,t){let n=P.get(e);if(!n){let t=e.createBindGroupLayout({entries:[{binding:0,visibility:2,buffer:{}}]});n={group:t,layout:e.createPipelineLayout({bindGroupLayouts:[t]}),groups:new Map},P.set(e,n)}let r=t.join(),i=n.groups.get(r);if(!i){let a=e.createBuffer({size:16,usage:72});if(e.queue.writeBuffer(a,0,new Float32Array(t)),i=e.createBindGroup({layout:n.group,entries:[{binding:0,resource:{buffer:a}}]}),i.b=a,n.groups.size>63){let[t,r]=n.groups.entries().next().value;n.groups.delete(t),e.queue.onSubmittedWorkDone().then(()=>r.b.destroy())}n.groups.set(r,i)}return[n.layout,i]}function I(e){let t=P.get(e)?.groups,n=t?[...t.values()].map(e=>e.b):[];return t?.clear(),n}function L(e,t,n,{formats:r,values:i=[],depthFormat:a,writeDepth:o,samples:s=1,writeColor:c=!0,tint:l=O}){let u=[r,i,a,+!!o,s,+c].join(`|`),[d,f]=F(e,l),p=t.get(u);if(!p){let n=r.map((e,t)=>`@location(${t}) c${t}:vec4f`).join(`,`),l=e.createShaderModule({code:`@group(0) @binding(0) var<uniform> t:vec4f;
struct Out{${n}}
@vertex fn v(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{return vec4f(f32(i&1u)*4-1,f32(i>>1u)*4-1,0,1);}
@fragment fn f()->Out{return Out(t${i.map(e=>`,vec4f(${e})`).join(``)});}`});p=e.createRenderPipeline({layout:d,vertex:{module:l,entryPoint:`v`},fragment:{module:l,entryPoint:`f`,targets:r.map((e,t)=>t?{format:e}:{format:e,writeMask:c?15:0})},...a?{depthStencil:{format:a,depthWriteEnabled:!!o,depthCompare:`always`}}:{},multisample:{count:s}}),t.set(u,p)}n.setPipeline(p),n.setBindGroup(0,f),n.draw(3)}var R=[0,0,0,0];function z(e){let t=u(e);return!!t&&(i(t,e.width,e.height)||i(e.view?.scissor,e.width,e.height))}function B(e){if(e===void 0)return R;if(Symbol.iterator in Object(e))return Array.from(e);let t=e;return[t.r,t.g,t.b,t.a]}var V=class{constructor(e,t){this.formats=e,this.pipelines=new Map,this.values=t.map(e=>B(e.clearValue)),this.extra=t.map(e=>({view:e.view,loadOp:`load`,storeOp:`store`})),this.attachments=[{view:void 0,loadOp:`load`,storeOp:`store`},...this.extra]}draw(e,t){let n=t&&(e.view?.clear?.depth??!0);this.attachments[0].view=e.color,this.device=e.device;let r=e.encoder.beginRenderPass({colorAttachments:this.attachments,...n?{depthStencilAttachment:{view:e.depth,depthLoadOp:`load`,depthStoreOp:`store`}}:{}});try{d(r,e),L(e.device,this.pipelines,r,{formats:this.formats,values:this.values,depthFormat:n?e.descriptor.depthStencil.format:void 0,writeDepth:n,tint:t?N(e.view?.clear?.color,e.format):R})}finally{r.end()}}dispose(){let e=this.device;if(this.device=void 0,e)for(let t of I(e))r(e,t)}},H=`fn margoConeTangent(rough:f32)->f32 {
let alpha=rough*rough;let a2=alpha*alpha;let x=${(2*Math.log(.25)).toFixed(7)}*a2/(2.0-a2);
let m=select(1.0-exp(x),-x*(1.0+x*(0.5+x/6.0)),x>-0.01);
return tan(min(2.0*atan(sqrt(m/exp(x))),1.4));
}
fn margoConeLevel(rough:f32,distance:f32,pixelsPerUnit:f32,maxLevel:f32)->f32 {
return clamp(log2(max(2.0*distance*margoConeTangent(rough)*pixelsPerUnit,1.0)),0.0,maxLevel);
}
`;H+``;var U=e=>{let t=K(e),n=e.includes(`fn probeSpecular(`);return`
${n?`var<private> margoPosition:vec3f;
`:``}struct MargoSSR {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}
fn margoSSR(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32)->MargoSSR {return margoSSRFresnel(n,v,base,metal,rough,vec3f(0.04),1.0);}
fn margoSSRFresnel(n:vec3f,v:vec3f,base:vec3f,metal:f32,rough:f32,dielectricF0:vec3f,dielectricF90:f32)->MargoSSR {
let nv=clamp(dot(n,v),1e-4,1.0);let f0=mix(dielectricF0,base,metal);let f90=mix(dielectricF90,1.0,metal);
${t?`let ab=iblBrdfTerms(nv,rough);let w=f0*ab.x+f90*ab.y;`:`let r=rough*vec4f(-1,-0.0275,-0.572,0.022)+vec4f(1,0.0425,1.04,-0.04);let k=min(r.x*r.x,exp2(-9.28*nv))*r.x+r.y;let w=f0*(r.z-1.04*k)+f90*(r.w+1.04*k);`}${n?`let e=probeSpecular(margoPosition,n,v,rough)*w;`:t?`let e=iblPrefiltered(iblSpecular,iblSampler,iblParams,reflect(-v,n),rough)*w*iblParams.w;`:`let e=vec3f(0);`}
return MargoSSR(vec4f(e,rough),vec4f(w,1),vec4f(n*0.5+0.5,1));
}`},W=/struct Surface\s*\{\s*base:vec4f/,G=e=>U(e)+(W.test(e)?`
struct MargoCapture {@location(0) specular:vec4f,@location(1) weight:vec4f,@location(2) normal:vec4f}
fn margoCapture(s:Surface,v:vec3f,k:vec3f)->MargoCapture {let m=margoSSRFresnel(s.n,v,s.base.rgb,s.metal,s.roughness,${e.includes(` f0:vec3f`)?`s.f0`:`vec3f(0.04)`},${e.includes(` sw:f32`)?`s.sw`:`1.0`});let o=k*s.occlusion;return MargoCapture(vec4f(m.specular.rgb*o,m.specular.a),vec4f(m.weight.rgb*o,1),m.normal);}
`:``),K=e=>e.includes(`let margoAmbient=`)&&e.includes(`fn iblBrdfTerms(`),q=x+`
struct U {inverse:mat4x4f,matrix:mat4x4f,a:vec4f,b:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var scene:texture_2d<f32>;
@group(0) @binding(2) var blurred:texture_2d<f32>;
@group(0) @binding(3) var bilinear:sampler;
@group(0) @binding(4) var depth:texture_depth_2d;
@group(0) @binding(5) var hiz:texture_2d<f32>;
@group(0) @binding(6) var specular:texture_2d<f32>;
@group(0) @binding(7) var weight:texture_2d<f32>;
@group(0) @binding(8) var normals:texture_2d<f32>;
${E}${c}${H}
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let q=vec2i(frag.xy);let s=textureLoad(scene,q,0);var c=s.rgb;
let m=textureLoad(weight,q,0);let e=textureLoad(specular,q,0);let rough=e.a;let d=textureLoad(depth,q,0);
if(u.b.w>0.5&&m.a>0.5&&rough<=u.a.z&&d>0.0){
let px=vec2f(q)+0.5;let p=world(px,d);let v=normalize(world(px,1.0)-p);
let n=normalize(textureLoad(normals,q,0).xyz*2.0-1.0);let r=reflect(-v,n);let toward=dot(r,v);
if(toward<0.5){
${D}if(hit){
let h=o+dir*t;let hq=vec2i(h.xy);let hp=world(vec2f(hq)+0.5,textureLoad(depth,hq,0));let hn=textureLoad(normals,hq,0).xyz*2.0-1.0;
// Fades: rays toward the camera, back faces, roughness, screen edges, distance.
let f=(1.0-smoothstep(0.0,0.5,toward))*(1.0-smoothstep(0.0,0.3,dot(hn,r)))*(1.0-smoothstep(u.a.z*0.5,u.a.z,rough))
*clamp(min(min(h.x,u.a.x-h.x),min(h.y,u.a.y-h.y))/(0.08*min(u.a.x,u.a.y)),0.0,1.0)*(1.0-smoothstep(0.8*u.b.x,u.b.x,distance(p,hp)));
let hc=u.matrix*vec4f(hp,1.0);let lod=margoConeLevel(rough,distance(p,hp),length(vec3f(u.matrix[0].y,u.matrix[1].y,u.matrix[2].y))*0.5*u.a.y/max(abs(hc.w),1e-20),f32(textureNumLevels(blurred)));var reflected=textureLoad(scene,hq,0).rgb;
if(lod>0.0){reflected=mix(reflected,textureSampleLevel(blurred,bilinear,h.xy/u.a.xy,min(lod-1.0,f32(textureNumLevels(blurred)-1))).rgb,min(lod,1.0));}
c=max(vec3f(0),c+f*(m.rgb*reflected-e.rgb));
}}}}
return vec4f(toDisplay(c),s.a);
}`,J=q.replace(`return vec4f(toDisplay(c),s.a);`,`return vec4f(c,s.a);`);if(J.includes(`vec4f(toDisplay(c)`))throw n(`failed`,`SSR: the HDR composite still encodes for display; update its linear-output patch`);var Y=e=>e.replace(`c=max(vec3f(0),c+f*(m.rgb*reflected-e.rgb));`,`let q=select(vec3f(1),c/e.rgb,e.rgb>vec3f(1e-6));c=max(vec3f(0),c+f*min(1.0,min(q.x,min(q.y,q.z)))*(m.rgb*reflected-e.rgb));`),X=x+`
struct U {inverse:mat4x4f,matrix:mat4x4f,a:vec4f,b:vec4f}
struct R {previous:mat4x4f,c:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var<uniform> rr:R;
@group(0) @binding(2) var scene:texture_2d<f32>;
@group(0) @binding(3) var depth:texture_depth_2d;
@group(0) @binding(4) var hiz:texture_2d<f32>;
@group(0) @binding(5) var specular:texture_2d<f32>;
@group(0) @binding(6) var weight:texture_2d<f32>;
@group(0) @binding(7) var normals:texture_2d<f32>;
${E}
fn pcg3d(seed:vec3u)->vec3u {var v=seed*1664525u+1013904223u;v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;v^=v>>vec3u(16u);
v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;return v;}
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let q=vec2i(frag.xy);let e=textureLoad(specular,q,0);let rough=e.a;let m=textureLoad(weight,q,0);let d=textureLoad(depth,q,0);
var out=vec4f(0);
if(m.a>0.5&&rough>u.a.z*0.5&&d>0.0){
let px=vec2f(q)+0.5;let p=world(px,d);let v=normalize(world(px,1.0)-p);
let n=normalize(textureLoad(normals,q,0).xyz*2.0-1.0);
let sg=select(-1.0,1.0,n.z>=0.0);let ba=-1.0/(sg+n.z);let bb=n.x*n.y*ba;
let t1=vec3f(1.0+sg*n.x*n.x*ba,sg*bb,-sg*n.x);let b1=vec3f(bb,sg+n.y*n.y*ba,-n.y);
let a=max(rough*rough,0.002);let ve=vec3f(dot(v,t1),dot(v,b1),max(dot(v,n),1e-4));
let vh=normalize(vec3f(a*ve.x,a*ve.y,ve.z));let l2=dot(vh.xy,vh.xy);
let ta=select(vec3f(1,0,0),vec3f(-vh.y,vh.x,0)/sqrt(l2),l2>0.0);let tb=cross(vh,ta);
let xi=vec2f(pcg3d(vec3u(vec2u(q),u32(rr.c.x))).xy)*(1.0/4294967296.0);
let radius=sqrt(xi.x);let phi=6.2831853*xi.y;let blend=0.5*(1.0+vh.z);
let p1=radius*cos(phi);let p2=mix(sqrt(max(0.0,1.0-p1*p1)),radius*sin(phi),blend);
let nh=p1*ta+p2*tb+sqrt(max(0.0,1.0-p1*p1-p2*p2))*vh;let ne=normalize(vec3f(a*nh.x,a*nh.y,max(nh.z,0.0)));
let r=reflect(-v,t1*ne.x+b1*ne.y+n*ne.z);let toward=dot(r,v);
if(dot(r,n)>0.0&&toward<0.5){
${D}if(hit){
let h=o+dir*t;let hq=vec2i(h.xy);let hp=world(vec2f(hq)+0.5,textureLoad(depth,hq,0));let hn=textureLoad(normals,hq,0).xyz*2.0-1.0;
let f=(1.0-smoothstep(0.0,0.5,toward))*(1.0-smoothstep(0.0,0.3,dot(hn,r)))
*clamp(min(min(h.x,u.a.x-h.x),min(h.y,u.a.y-h.y))/(0.08*min(u.a.x,u.a.y)),0.0,1.0)*(1.0-smoothstep(0.8*u.b.x,u.b.x,distance(p,hp)));
out=vec4f(f*textureLoad(scene,hq,0).rgb,f);
}}}}
return out;
}`,Z=x+`
struct U {inverse:mat4x4f,matrix:mat4x4f,a:vec4f,b:vec4f}
struct R {previous:mat4x4f,c:vec4f}
@group(0) @binding(0) var<uniform> u:U;
@group(0) @binding(1) var<uniform> rr:R;
@group(0) @binding(2) var noisy:texture_2d<f32>;
@group(0) @binding(3) var history:texture_2d<f32>;
@group(0) @binding(4) var depth:texture_depth_2d;
@group(0) @binding(5) var bilinear:sampler;
@fragment fn fragment(@builtin(position) frag:vec4f)->@location(0) vec4f {
let q=vec2i(frag.xy);let size=vec2i(u.a.xy);let now=textureLoad(noisy,q,0);var m1=vec4f(0);var m2=vec4f(0);
for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){let k=textureLoad(noisy,clamp(q+vec2i(x,y),vec2i(0),size-1),0);m1+=k;m2+=k*k;}}
m1/=9.0;m2/=9.0;let sigma=sqrt(max(m2-m1*m1,vec4f(0)));
let d=textureLoad(depth,q,0);let px=vec2f(q)+0.5;
let w=u.inverse*vec4f(px.x/u.a.x*2.0-1.0,1.0-px.y/u.a.y*2.0,d,1.0);let c=rr.previous*vec4f(w.xyz/w.w,1.0);
let uv=vec2f(c.x/c.w*0.5+0.5,0.5-c.y/c.w*0.5);
let old=clamp(textureSampleLevel(history,bilinear,uv,0.0),m1-sigma,m1+sigma);
if(rr.c.z<0.5||d<=0.0||c.w<=0.0||any(uv<vec2f(0))||any(uv>vec2f(1))){return now;}
return mix(old,now,rr.c.y);
}`,ne=(e,t)=>e.replace(`@group(0) @binding(8) var normals:texture_2d<f32>;`,`@group(0) @binding(8) var normals:texture_2d<f32>;
@group(0) @binding(9) var roughs:texture_2d<f32>;`).replace(/\nreturn vec4f\((toDisplay\(c\)|c),s\.a\);/,`
if(u.b.w>0.5&&m.a>0.5&&rough>u.a.z*0.5&&d>0.0){let g=textureLoad(roughs,q,0);let ws=smoothstep(u.a.z*0.5,u.a.z,rough);${t?`let k=select(vec3f(1),c/e.rgb,e.rgb>vec3f(1e-6));c=max(vec3f(0),c+ws*min(1.0,min(k.x,min(k.y,k.z)))*(m.rgb*g.rgb-g.a*e.rgb));`:`c=max(vec3f(0),c+ws*(m.rgb*g.rgb-g.a*e.rgb));`}}
return vec4f($1,s.a);`),Q=[`rgba16float`,`rgb10a2unorm`,`rgb10a2unorm`],$=5,re=Q.map(e=>({format:e})),ie=class i{coreRequirement=e(`0.1.0`,import.meta.url);constructor(e={}){this.options=e,this.name=`ssr`,this.disposed=!1,this.textures=[],this.width=0,this.height=0,this.owned=!1,this.material=[],this.blurViews=[],this.blurGroups=[],this.key=``,this.extra=[],this.blurPasses=[],this.compositeAttachment={view:void 0,loadOp:`clear`,storeOp:`store`},this.compositePass={colorAttachments:[this.compositeAttachment]},this.models=new Map,this.modelCode=new Map,this.hook={targets:re,declarations:e=>{let t=this.modelCode.get(e);return t===void 0&&(this.modelCode.size>=64&&this.modelCode.clear(),this.modelCode.set(e,t=G(e))),t},begin:()=>{if(this.pass)return this.pass;let e=this.context,t=e.descriptor.depthStencil.format.includes(`stencil`)?{stencilLoadOp:`load`,stencilStoreOp:`store`}:{},n=this.pass=e.encoder.beginRenderPass({colorAttachments:this.material.map(e=>({view:e,loadOp:`load`,storeOp:`store`})),depthStencilAttachment:{view:e.depth,depthLoadOp:`load`,depthStoreOp:`store`,...t}});return d(n,e),n}},this.values=new Float32Array(40),this.roughViews=[],this.roughTextures=[],this.roughPasses=[],this.roughFrames=0,this.roughSeed=0,this.stochastic=!1,this.previous=new Float32Array(16),this.roughValues=new Float32Array(20),this.workspace=new Float64Array(52),this.inverse=this.values.subarray(0,16),this.options=y(`ssr`,e),this.validate()}static attach(n,r={}){t(n,e(`0.1.0`,import.meta.url));let a=new i(r);return a.stack=h.attach(n,[a]),a}add(e){if(this.disposed)throw n(`disposed`,`SSR is disposed; create a new SSR`);return ee(this.models,e,this.hook)}get enabled(){return this.options.enabled??!0}set enabled(e){if(typeof e!=`boolean`)throw TypeError(`SSR enabled must be boolean`);this.options.enabled=e}joinStack(e){if(this.engine||this.host||this.disposed)throw n(`attached`,`SSR is already attached; create a new SSR`);return this.host=e,{kind:`hdr`,render:(e,t,n)=>this.stage(e,t,n)}}validate(){let e=this.options,t=e.maxRoughness??.6,n=e.thickness??.5,r=e.maxDistance??100,i=e.steps??64;if(!(t>0&&t<=1)||!(n>0&&Number.isFinite(n))||!(r>0&&Number.isFinite(Math.fround(r)))||!Number.isInteger(i)||i<1||i>256||e.enabled!==void 0&&typeof e.enabled!=`boolean`||e.stochastic!==void 0&&typeof e.stochastic!=`boolean`)throw RangeError(`Invalid SSR options; maxRoughness must be in (0, 1], thickness and maxDistance above 0, steps 1-256, stochastic a boolean.`)}setup(e){if(this.disposed)throw n(`disposed`,`SSR is disposed; create a new SSR`);if(!this.host)throw n(`state`,`SSR runs in a PostStack; use SSR.attach(engine) or PostStack.attach(engine, [..., new SSR(), ...]).`);if(!e.gpu)throw n(`unsupported`,`SSR requires WebGPU; use a WebGPU engine; see https://margoengine.com/errors#webgpu`);this.engine=e,this.device=e.gpu;let t=e.gpu;this.uniform=t.createBuffer({size:160,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.sampler=t.createSampler({magFilter:`linear`,minFilter:`linear`,mipmapFilter:`linear`}),this.reduceDepth=m(t,S(`texture_depth_2d`,``)),this.reduce=m(t,S(`texture_2d<f32>`,`.r`)),this.downsample=a(t,T,`rgba16float`)}registerPasses(e){e.add({name:`ssr:gbuffer`,order:14,execute:e=>{e.backend===`webgpu`&&this.host?.target&&this.prepare(e)}})}prepare(e){this.validate(),this.resize(e);let t=this.values,r=this.options,i=this.ownDepth;if(!b(e.camera.matrix,this.inverse,this.workspace))throw n(`state`,`Invalid SSR camera; give the camera a finite, invertible projection`);if(t.set(e.camera.matrix,16),t[32]=e.width,t[33]=e.height,t[34]=r.maxRoughness??.6,t[35]=r.thickness??.5,t[36]=r.maxDistance??100,t[37]=r.steps??64,t[38]=this.hizLevels.groups.length,t[39]=+this.enabled,this.slice=o(e.device,this.uniform,t,e.view??e),!this.enabled)return;this.traced?.active(e.device)&&this.traced.prepare(e),this.base!==e.descriptor&&(this.base=e.descriptor,this.single={...e.descriptor,multisample:{count:1},depthStencil:{format:`depth32float`,depthWriteEnabled:!0,depthCompare:`greater-equal`}});let a=e.shader+!!i;if(this.replayKey!==a){let t=e.shader.replace(/(@fragment[^{]*)->@location\(0\) vec4f/,`$1->MargoSSR`).replace(/(let direct=[\s\S]*)return (vec4f\([^\n]+\));/,e.shader.includes(`fn probeSpecular(`)?`if(false){$1_=$2;}margoPosition=i.position;return margoSSR(n,v,i.color,i.material.y,i.material.x);`:`if(false){$1_=$2;}return margoSSR(n,v,i.color,i.material.y,i.material.x);`);if(!t.includes(`->MargoSSR`)||!t.includes(`return margoSSR(`))throw n(`unsupported`,`SSR requires the standard core lighting shader; remove the plugin that replaced core's shader`);let r=e.device.createShaderModule({code:t+U(t)});this.replay=e.device.createRenderPipeline({...this.single,layout:`auto`,vertex:{...e.descriptor.vertex,module:r},fragment:{module:r,entryPoint:`fragment`,targets:Q.map(e=>({format:e}))},depthStencil:i?this.single.depthStencil:{...e.descriptor.depthStencil,depthWriteEnabled:!1,depthCompare:`equal`}}),this.replayKey=a}let s=z(e),{color:c,depth:l,descriptor:u}=e;e.color=this.material[0],i&&(e.depth=i,e.descriptor=this.single);try{if(s){let t=this.materialClear??=new V(Q,this.extra);t.draw(e,!!i),e.draw({pipeline:this.replay,clear:!1,clearDepth:!1,bindings:e.bindings,colorAttachments:t.extra})}else i||e.encoder.beginRenderPass(this.clearPass).end(),e.draw({pipeline:this.replay,clear:!!i,bindings:e.bindings,colorAttachments:this.extra});if(this.models.size){this.context=e;for(let t of this.models.keys())te(t,this.hook,e)}}finally{this.pass?.end(),this.pass=this.context=void 0,Object.assign(e,{color:c,depth:l,descriptor:u})}w(e.encoder,this.hizLevels,this.reduceDepth,this.reduce)}stage(e,t,n){let r=this.models.size>0,i=this.stochastic,o=this.traced?.active(e.device)?this.traced:void 0,c=n.format+n.multisample.count+n.hdr+r+i+p(this.engine)+!!o,u=n.hdr?J:q,m=r?Y(u):u;if(this.key!==c){this.key=c;let t=i?ne(m,r):m,l=o?o.mirror(t,r):t;this.composite=a(e.device,n.hdr?l:s(this.engine,l),n.format,{multisample:n.multisample}),this.input=void 0,this.roughTrace=void 0}if(this.input!==t&&(this.input=t,this.blurGroups[0]=f(e.device,this.downsample,[t,this.sampler]),this.compositeGroups=v(this.uniform,n=>f(e.device,this.composite,[n,t,this.blur,this.sampler,this.depthView,this.hiz,...this.material,...i?[this.roughViews[1]]:[]])),i)){let n=e.device;this.roughTrace??=a(n,o?o.rough(X):X,`rgba16float`),this.roughResolve??=a(n,Z,`rgba16float`),this.roughTraceGroups=v(this.uniform,e=>f(n,this.roughTrace,[e,{buffer:this.roughUniform},t,this.depthView,this.hiz,...this.material])),this.roughResolveGroups=v(this.uniform,e=>f(n,this.roughResolve,[e,{buffer:this.roughUniform},this.roughViews[0],this.roughViews[2],this.depthView,this.sampler]))}if(this.enabled)for(let t=0;t<$;t++){let n=e.encoder.beginRenderPass(this.blurPasses[t]);n.setPipeline(this.downsample),n.setBindGroup(0,this.blurGroups[t]),n.draw(3),n.end()}this.enabled&&i&&this.traceRough(e,o),this.compositeAttachment.view=n.view,this.compositeAttachment.loadOp=l(e,`clear`);let h=e.encoder.beginRenderPass(this.compositePass);h.setPipeline(this.composite),h.setBindGroup(0,this.compositeGroups.get(this.slice)),o&&h.setBindGroup(1,o.group(e.device,this.composite)),d(h,e),h.draw(3),h.end()}traceRough(e,t){let n=this.roughValues;n.set(this.roughFrames?this.previous:this.values.subarray(16,32)),n[16]=this.roughSeed=this.roughSeed+1>>>0,n[17]=Math.max(1/(this.roughFrames+1),1/16),n[18]=+(this.roughFrames>0),e.device.queue.writeBuffer(this.roughUniform,0,n),this.previous.set(this.values.subarray(16,32)),this.roughFrames++;for(let[n,r,i]of[[this.roughTrace,this.roughTraceGroups,this.roughPasses[0]],[this.roughResolve,this.roughResolveGroups,this.roughPasses[1]]]){let a=e.encoder.beginRenderPass(i);a.setPipeline(n),a.setBindGroup(0,r.get(this.slice)),t&&n===this.roughTrace&&a.setBindGroup(1,t.group(e.device,n)),a.draw(3),a.end()}let r=[this.width,this.height];e.encoder.copyTextureToTexture({texture:this.roughTextures[1]},{texture:this.roughTextures[2]},r)}resize(e){_(e.device,e.view??e);let t=this.host.target,n=t.samples===4||this.models.size>0,r=this.enabled&&(this.options.stochastic??!1);if(r!==this.stochastic&&(this.stochastic=r,this.width=0,this.key=``),this.width===e.width&&this.height===e.height&&this.target===t&&this.owned===n)return;this.release(),this.width=e.width,this.height=e.height,this.target=t,this.owned=n;let i=e.device,a=GPUTextureUsage.TEXTURE_BINDING,o=(e,t,n,r=1)=>{let a=i.createTexture({size:e,format:t,usage:n,mipLevelCount:r});return this.textures.push(a),a},s=this.host.depthTexture,c=n?o([e.width,e.height],`depth32float`,a|GPUTextureUsage.RENDER_ATTACHMENT):s;this.depthView=c.createView({aspect:`depth-only`}),c!==s&&(this.ownDepth=c.createView());let l=[Math.max(1,e.width>>1),Math.max(1,e.height>>1)],u=Math.max(1,Math.min(6,Math.floor(Math.log2(Math.min(e.width,e.height)))));this.hizLevels=C(i,this.depthView,this.reduceDepth,this.reduce,l,u,o),this.hiz=this.hizLevels.view;let d=a|GPUTextureUsage.RENDER_ATTACHMENT,p={r:.5,g:.5,b:.5,a:0};this.material=Q.map(t=>o([e.width,e.height],t,d).createView()),this.clearPass={colorAttachments:[{view:this.material[0],loadOp:`clear`,storeOp:`store`}]},this.extra=[1,2].map(e=>({view:this.material[e],loadOp:`clear`,storeOp:`store`,clearValue:e===2?p:{r:0,g:0,b:0,a:0}}));let m=o(l,`rgba16float`,d,$);this.blur=m.createView();for(let e=0;e<$;e++){let t=m.createView({baseMipLevel:e,mipLevelCount:1});this.blurViews.push(t),this.blurPasses.push({colorAttachments:[{view:t,loadOp:`clear`,storeOp:`store`}]}),e&&(this.blurGroups[e]=f(i,this.downsample,[this.blurViews[e-1],this.sampler]))}this.stochastic&&(this.roughUniform??=i.createBuffer({size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.roughTextures=[d,d|GPUTextureUsage.COPY_SRC,a|GPUTextureUsage.COPY_DST].map(t=>o([e.width,e.height],`rgba16float`,t)),this.roughViews=this.roughTextures.map(e=>e.createView()),this.roughPasses=[0,1].map(e=>({colorAttachments:[{view:this.roughViews[e],loadOp:`clear`,storeOp:`store`}]})),this.roughFrames=0)}release(){for(let e of this.textures)r(this.device,e);this.textures=[],this.width=this.height=0,this.target=void 0,this.input=void 0,this.hizLevels=void 0,this.material=[],this.blurViews=[],this.blurGroups=[],this.blurPasses=[],this.extra=[],this.roughTextures=[],this.roughViews=[],this.roughPasses=[],this.roughTraceGroups=this.roughResolveGroups=void 0,this.roughFrames=0,this.depthView=this.ownDepth=this.hiz=this.blur=void 0,this.compositeGroups=void 0,this.clearPass=void 0,this.materialClear?.dispose(),this.materialClear=void 0,this.compositeAttachment.view=void 0}onDeviceRestored(e){this.release(),r(this.device,this.uniform),r(this.device,this.roughUniform),this.roughUniform=this.roughTrace=this.roughResolve=void 0,this.stochastic=!1,this.replay=this.composite=void 0,this.replayKey=this.base=void 0,this.key=``,this.setup(e)}dispose(){if(this.disposed)return;this.disposed=!0;let e=this.stack;this.stack=void 0;for(let e of[...this.models.values()])e();this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),r(this.device,this.uniform),r(this.device,this.roughUniform),this.uniform=this.roughUniform=void 0,this.replay=this.composite=this.roughTrace=this.roughResolve=void 0,this.engine=void 0,e?.dispose()}[Symbol.dispose??Symbol()](){this.dispose()}};export{ie as t};