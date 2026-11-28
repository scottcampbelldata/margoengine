import{a as e,o as t}from"./index-BKoCqQ3S.js";import{_ as n,a as r,c as i,d as a,f as o,g as s,h as c,i as l,l as u,m as d,o as f,p,r as m,s as h,u as g,v as _}from"./scene-Du7DDViW.js";var v=(e,t=`1.0.0`,n=import.meta.url)=>_(e,t,n),y=class{constructor(e){let{width:t,height:n,data:r}=e;if(!Number.isInteger(t)||t<=0||!Number.isInteger(n)||n<=0)throw i(`Invalid cookie texture dimensions`,`pixel-lighting`);if(!r||r.length!==t*n*4)throw i(`Cookie texture data length must match width * height * 4`,`pixel-lighting`);this.width=t,this.height=n;let a=r instanceof Float32Array,o=new Float32Array(t*n*4);for(let e=0;e<o.length;e++){let t=r[e];if(!Number.isFinite(t))throw i(`Invalid cookie texture pixel value`,`pixel-lighting`);o[e]=a?Math.max(0,Math.min(1,t)):Math.max(0,Math.min(255,t))/255}this.data=o}};function b(e,t,n=6,r=!1){if(n<1||!Number.isInteger(n))throw i(`Invalid slats count`,`pixel-lighting`);let a=new Uint8Array(e*t*4);for(let i=0;i<t;i++)for(let o=0;o<e;o++){let s=(r?o/e:i/t)*n%1<.65?255:30,c=(i*e+o)*4;a[c]=s,a[c+1]=s,a[c+2]=s,a[c+3]=255}return new y({width:e,height:t,data:a})}var x=1/1024,S=class extends r{constructor(e={}){super(e),this.cookie=e.cookie;let t=this.radius>0?this.radius*2:64;this.cookieScale=Array.isArray(e.cookieScale)?[e.cookieScale[0],e.cookieScale[1]]:typeof e.cookieScale==`number`?[e.cookieScale,e.cookieScale]:[t,t],this.cookieOffset=e.cookieOffset?[e.cookieOffset[0],e.cookieOffset[1]]:[0,0],this.cookieRotation=e.cookieRotation??(this.kind===`spot`?this.angle:0),this.cookieWrap=e.cookieWrap??`zero`,this.cookieMode=e.cookieMode??`multiply`,C(this)}};function C(e){c(e);for(let t of e.cookieScale)o(t,`cookieScale`,Number.MIN_VALUE);for(let t of e.cookieOffset)o(t,`cookieOffset`);if(o(e.cookieRotation,`cookieRotation`),![`zero`,`clamp`,`repeat`,`mirror`].includes(e.cookieWrap))throw i(`Invalid cookieWrap: use zero, clamp, repeat or mirror`,`pixel-lighting`);if(![`multiply`,`alpha`,`color`].includes(e.cookieMode))throw i(`Invalid cookieMode: use multiply, alpha or color`,`pixel-lighting`)}var w=e=>[-Math.cos(e.angle)*Math.cos(e.elevation),-Math.sin(e.angle)*Math.cos(e.elevation),Math.sin(e.elevation)],T=`
struct Uniforms{
view:vec4f,size:vec4f,at:vec4f,way:vec4f,color:vec4f,cookie_scale:vec4f,cookie_rot:vec4f,cookie_info:vec4f,cookie_origin:vec4f,mask_bounds:vec4f,mask_info:vec4f,}
@group(0)@binding(0)var<uniform>u:Uniforms;
@group(0)@binding(1)var bumps:texture_2d<f32>;
@group(0)@binding(2)var<storage,read>edges:array<vec4f>;
@group(1)@binding(0)var cookie_tex:texture_2d<f32>;
@group(1)@binding(1)var cookie_samp:sampler;
@group(0)@binding(3)var sum:texture_2d_array<f32>;
@vertex fn wide(@builtin(vertex_index)i:u32)->@builtin(position)vec4f{
return vec4f(f32(i&1u)*4.0 - 1.0,f32(i>>1u)*4.0 - 1.0,0.0,1.0);
}
fn clip(d:vec2f)->vec2f{
return d*u.view.z/u.size.xy*vec2f(2.0,-2.0);
}
@vertex fn edge(@builtin(vertex_index)i:u32,@location(0)e:vec4f)->@builtin(position)vec4f{
var p=e.xy;
if((i&1u)==1u){
p=e.zw;
}
if(i<2u){
return vec4f(clip(p - u.view.xy)+vec2f(-1.0,1.0),0.0,1.0);
}
return vec4f(clip(p*u.at.w - u.at.xy),0.0,0.0);
}
@fragment fn none()->@location(0)vec4f{
return vec4f(0.0);
}
@fragment fn show(@builtin(position)f:vec4f)->@location(0)vec4f{
let p=vec2i(f.xy);
return vec4f(textureLoad(sum,p,0,0).rgb+textureLoad(sum,p,1,0).rgb+textureLoad(sum,p,2,0).rgb+textureLoad(sum,p,3,0).rgb,1.0);
}
@fragment fn lit(@builtin(position)f:vec4f)->@location(0)vec4f{
let world=u.view.xy+f.xy/u.view.z;
if(!maskVisible(world,u.mask_bounds,u.mask_info)){
return vec4f(0.0);
}
var n=vec3f(0.0,0.0,1.0);
if(u.size.z>0.0){
let s=textureLoad(bumps,vec2i(f.xy),0);
if(s.a>0.0){
n=normalize(s.xyz*2.0 - 1.0);
}
}
var l=u.at.xyz;
var a=1.0;
let isPoint=u.at.w>0.0;
var dL=0.0;
if(isPoint){
let d=u.at.xy - world;
dL=length(d);
a=pow(max(0.0,1.0 - dL/u.color.w),u.way.w);
let v=vec3f(d,u.at.z);
l=n;
if(dot(v,v)>0.0){
l=normalize(v);
}
if(u.size.w>0.0){
var c=1.0;
if(dL>0.0){
c=-dot(d,u.way.xy)/dL;
}
if(u.way.z>u.view.w){
a*=clamp((c - u.view.w)/(u.way.z - u.view.w),0.0,1.0);
}
else if(c<u.view.w){
a=0.0;
}
}
}
var vis=1.0;
let hasShadows=u.cookie_info.z>0.5;
let edgeCount=u32(u.cookie_info.y);
if(hasShadows&&edgeCount>0u&&a>0.0){
let thetaL=select(atan2(u.at.y,u.at.x),atan2(u.at.y - world.y,u.at.x - world.x),isPoint);
let rx=cos(thetaL);
let ry=sin(thetaL);
for(var e=0u;
e<edgeCount;
e++){
let seg=edges[e];
let ax=seg.x - world.x;
let ay=seg.y - world.y;
let ex=seg.z - seg.x;
let ey=seg.w - seg.y;
let across=rx*ey - ry*ex;
if(abs(across)>1e-6){
let t=(ax*ey - ay*ex)/across;
let s=(ax*ry - ay*rx)/across;
if(t>=0.0&&(!isPoint||t<=dL)&&s>=0.0&&s<=1.0){
vis=0.0;
break;
}
}
}
}
if(vis<=0.0||a<=0.0){
return vec4f(0.0);
}
var cookieMod=vec4f(1.0);
if(u.cookie_info.x>0.5){
let delta=world - u.cookie_origin.xy - u.cookie_scale.zw;
let rx=delta.x*u.cookie_rot.x - delta.y*u.cookie_rot.y;
let ry=delta.x*u.cookie_rot.y+delta.y*u.cookie_rot.x;
var uv=vec2f(rx/u.cookie_scale.x+0.5,ry/u.cookie_scale.y+0.5);
let wrapMode=u32(u.cookie_rot.z);
var oob=false;
if(wrapMode==0u){
if(uv.x<0.0||uv.x>1.0||uv.y<0.0||uv.y>1.0){
oob=true;
}
}
else if(wrapMode==1u){
uv=clamp(uv,vec2f(0.0),vec2f(1.0));
}
else if(wrapMode==2u){
uv=fract(uv);
}
else if(wrapMode==3u){
let m=abs(uv)% vec2f(2.0);
uv=select(m,vec2f(2.0)- m,m>vec2f(1.0));
}
if(oob){
cookieMod=vec4f(0.0);
}
else{
let dims=vec2i(textureDimensions(cookie_tex));
let texel=clamp(vec2i(floor(uv*vec2f(dims)+vec2f(${x}
))),vec2i(0),dims - vec2i(1));
cookieMod=textureLoad(cookie_tex,texel,0);
}
}
let diffuse=max(0.0,dot(n,l));
let blendMode=u32(u.cookie_rot.w);
var outCol=vec3f(0.0);
if(blendMode==1u&&u.cookie_info.x>0.5){
outCol=u.color.rgb*a*diffuse*vis*cookieMod.a;
}
else if(blendMode==2u&&u.cookie_info.x>0.5){
outCol=cookieMod.rgb*cookieMod.a*a*diffuse*vis*u.cookie_info.w;
}
else{
outCol=u.color.rgb*a*diffuse*vis*cookieMod.rgb*cookieMod.a;
}
return vec4f(outCol,0.0);
}
`,E=256,D=`rgba16float`,O=4,k=E/4,A=0,j=class r{coreRequirement=t(`1.0.0`,import.meta.url);#e;#t;#n;#r;#i;#a;#o;#s;#c;#l;#u;#d;#f;#p;#m;#h;#g;#_;#v;#y;#b;#x;#S;#C;#w;#T;#E;#D;#O;#k;#A;constructor(e){if(this.lights=[],this.#n=new s,this.#i=new Float32Array,this.#a=!1,this.#v=[],this.#b=new Float32Array,this.#D=new Map,this.#O=new WeakMap,this.#k=new l,this.#A=!1,!e?.target)throw a(`Lighting2D needs a target`,`pixel-lighting`);let t=e.order??20;o(t,`order`),this.#e=new g(e.target,`CookieLighting2D target`,`setTarget`),this.#t=new g(e.normals,`CookieLighting2D normals`,`setNormals`),this.#r=t,this.camera=e.camera??{x:0,y:0,zoom:1},this.ambient=e.ambient??`#000000`,this.layer=e.layer??4294967295;let n=e.cookieScale??64;this.cookieScale=Array.isArray(n)?[n[0],n[1]]:[n,n],this.cookieWrap=e.cookieWrap??`zero`,this.cookieMode=e.cookieMode??`multiply`,this.name=e.name??`cookie-lighting2d-${++A}`,e.occluders&&this.setOccluders(e.occluders)}static attach(n,i){e(n,t(`1.0.0`,import.meta.url));let a=new r(i);return v(n).use(a),a}addLight(e={}){if(this.#A)throw p(`disposed`,`CookieLighting2D has been disposed`,`pixel-lighting`);let t=new S({cookieScale:this.cookieScale,cookieWrap:this.cookieWrap,cookieMode:this.cookieMode,...e});return this.lights.push(t),t}removeLight(e){let t=this.lights.indexOf(e);t>=0&&this.lights.splice(t,1)}setOccluders(e){this.#i=m(e),this.#a=!1}setTarget(e){if(!e)throw a(`Lighting2D needs a target`,`pixel-lighting`);this.#e.set(e,this.#o?.gpu)}setNormals(e){this.#t.set(e,this.#o?.gpu)}setup(e){if(this.#A)throw p(`disposed`,`CookieLighting2D disposed; create a new one`);if(e.backend!==`webgpu`)throw p(`unsupported`,`CookieLighting2D needs WebGPU`,`webgpu`);this.#o=e,this.#e.fix(e.gpu),this.#t.fix(e.gpu),e.frameGraph.add({name:this.name,order:this.#r,execute:e=>{e.backend===`webgpu`&&!e.view?.index&&this.#P(e)}})}onDeviceRestored(){this.#j()}dispose(){this.#A||(this.#A=!0,this.#o?.sceneOf(this)?.removePlugin(this.name),this.#o=void 0,this.#j())}[Symbol.dispose??Symbol()](){this.dispose()}#j(){this.#k.dispose();for(let e of this.#D.values())e.destroy();this.#D.clear(),this.#O=new WeakMap,this.#y?.destroy(),this.#x?.destroy(),this.#S?.destroy(),this.#w?.destroy(),this.#g?.destroy(),this.#y=this.#x=this.#S=this.#w=void 0,this.#T=void 0,this.#E=void 0,this.#c=this.#l=this.#u=this.#d=this.#f=this.#p=void 0,this.#m=this.#h=this.#g=this.#_=void 0,this.#v=[],this.#C=this.#s=void 0,this.#n.clear(),this.#a=!1}#M(e,t){let n=this.#D.get(t);if(!n){n=e.createTexture({label:`lighting2d cookie upload`,size:[t.width,t.height,1],format:`rgba8unorm`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});let r=new Uint8Array(t.data.length);for(let e=0;e<t.data.length;e++)r[e]=Math.round(t.data[e]*255);e.queue.writeTexture({texture:n},r,{bytesPerRow:t.width*4},{width:t.width,height:t.height}),this.#D.set(t,n)}return n}#N(e,t){if(this.#s!==e&&(this.#s&&this.#j(),this.#s=e),this.#c||(this.#c=e.createShaderModule({label:`cookie-lighting2d`,code:f(4)+T}),this.#l=e.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:`uniform`,hasDynamicOffset:!0,minBindingSize:176}},{binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:`unfilterable-float`}},{binding:2,visibility:GPUShaderStage.FRAGMENT,buffer:{type:`read-only-storage`}},{binding:4,visibility:GPUShaderStage.FRAGMENT,buffer:{type:`read-only-storage`}}]}),this.#u=e.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:`float`}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:`filtering`}}]}),this.#d=e.createPipelineLayout({bindGroupLayouts:[this.#l,this.#u]}),this.#S=e.createTexture({size:[1,1],format:`rgba8unorm`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),this.#w=e.createTexture({size:[1,1],format:`rgba8unorm`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),e.queue.writeTexture({texture:this.#w},new Uint8Array([255,255,255,255]),{bytesPerRow:4},{width:1,height:1}),this.#T=e.createSampler({magFilter:`nearest`,minFilter:`nearest`}),this.#E=e.createBindGroup({layout:this.#u,entries:[{binding:0,resource:this.#w.createView()},{binding:1,resource:this.#T}]})),!this.#p){let t=this.#c,n=this.#d,r=D;this.#p=e.createRenderPipeline({label:`cookie-lighting2d light`,layout:n,vertex:{module:t,entryPoint:`wide`},fragment:{module:t,entryPoint:`lit`,targets:[{format:r,blend:{color:{srcFactor:`one`,dstFactor:`one`},alpha:{srcFactor:`zero`,dstFactor:`one`}}}]}})}t!==this.#f&&(this.#f=t,this.#m=e.createRenderPipeline({label:`cookie-lighting2d show`,layout:`auto`,vertex:{module:this.#c,entryPoint:`wide`},fragment:{module:this.#c,entryPoint:`show`,targets:[{format:t}]}}),this.#h=void 0)}#P(e){let t=e.device,r=this.#e.get(t,this.#o);if(!r)return;let a=this.#t.get(t,this.#o),o=this.camera,s=n(this.ambient),c=this.lights.filter(e=>(e.layers&this.layer)!==0);if(!s)throw i(`Invalid ambient color: use a hex color such as #rrggbb`,`pixel-lighting`);if(a&&(a.width!==r.width||a.height!==r.height))throw p(`state`,`Lighting2D normals differ in size from the target`,`pixel-lighting`);d(o),u(this.layer),this.lights.forEach(C),this.#N(t,r.format),this.#k.upload(t,c),this.#C=void 0;let l=Math.max(1,c.length)*k;(!this.#y||this.#b.length<l)&&(this.#y?.destroy(),this.#b=new Float32Array(l*2),this.#y=t.createBuffer({label:`cookie-lighting2d`,size:this.#b.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));let f=this.#i,m=f.length/4,g=Math.max(16,f.byteLength);if((!this.#x||this.#x.size<g)&&(this.#x?.destroy(),this.#x=t.createBuffer({label:`cookie-lighting2d edges`,size:g*2,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST}),this.#a=!1),this.#a||=(f.length?t.queue.writeBuffer(this.#x,0,f):t.queue.writeBuffer(this.#x,0,new Float32Array(4)),!0),this.#C=this.#n.get(t,`light`,this.#l,[{binding:0,resource:{buffer:this.#y,size:176}},{binding:1,resource:h(a??this.#S)},{binding:4,resource:{buffer:this.#k.buffer}},{binding:2,resource:{buffer:this.#x}}]),!this.#g||this.#g.width!==r.width||this.#g.height!==r.height){this.#g?.destroy();let e=[r.width,r.height];this.#g=t.createTexture({label:`cookie-lighting2d sum`,size:[e[0],e[1],O],format:D,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.#_=this.#g.createView({dimension:`2d-array`}),this.#v=Array.from({length:O},(e,t)=>this.#g.createView({dimension:`2d`,baseArrayLayer:t,arrayLayerCount:1})),this.#h=void 0}this.#h??=t.createBindGroup({layout:this.#m.getBindGroupLayout(0),entries:[{binding:3,resource:this.#_}]});let _=this.#b;c.forEach((e,t)=>{let i=n(e.color),s=e.kind===`directional`,c=s?w(e):[e.x,e.y,e.height],l=[`zero`,`clamp`,`repeat`,`mirror`].indexOf(e.cookieWrap),u=[`multiply`,`alpha`,`color`].indexOf(e.cookieMode);_.set([o.x,o.y,o.zoom,Math.cos(e.cone),r.width,r.height,+!!a,+(e.kind===`spot`),c[0],c[1],c[2],+!s,Math.cos(e.angle),Math.sin(e.angle),Math.cos(e.cone*(1-e.softness)),e.falloff,i[0]*e.intensity,i[1]*e.intensity,i[2]*e.intensity,e.radius,e.cookieScale[0],e.cookieScale[1],e.cookieOffset[0],e.cookieOffset[1],Math.cos(e.cookieRotation),-Math.sin(e.cookieRotation),l>=0?l:0,u>=0?u:0,+!!e.cookie,m,+!!e.shadows,e.intensity,e.x,e.y,0,0,...this.#k.fields[t]],t*k)}),t.queue.writeBuffer(this.#y,0,_),this.#v.forEach((t,n)=>e.encoder.beginRenderPass({colorAttachments:[{view:t,loadOp:`clear`,clearValue:n?[0,0,0,1]:[s[0],s[1],s[2],1],storeOp:`store`}]}).end()),c.forEach((n,r)=>{let i=this.#E;if(n.cookie){let e=this.#O.get(n.cookie);if(!e){let r=this.#M(t,n.cookie);e=t.createBindGroup({layout:this.#u,entries:[{binding:0,resource:r.createView()},{binding:1,resource:this.#T}]}),this.#O.set(n.cookie,e)}i=e}let a=e.encoder.beginRenderPass({colorAttachments:[{view:this.#v[r%O],loadOp:`load`,storeOp:`store`}]});a.setBindGroup(0,this.#C,[r*E]),a.setBindGroup(1,i),a.setPipeline(this.#p),a.draw(3),a.end()});let v=e.encoder.beginRenderPass({colorAttachments:[{view:h(r),loadOp:`clear`,storeOp:`store`}]});v.setBindGroup(0,this.#h),v.setPipeline(this.#m),v.draw(3),v.end()}};export{j as CookieLighting2D,b as createWindowCookie};