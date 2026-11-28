import{a as e,i as t,n,r}from"./index-BbY97TdB.js";var i=(e,i=t,a=import.meta.url)=>(n(e,r(i,a)),e),a=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e}),o=(e,t)=>`${e}; see https://margoengine.com/errors#${t}`,s=(e,t,n=e)=>a(e,o(t,n));function c(e){return e?.view?.viewport}function l(e,t){let n=c(t);if(!n)return;e.setViewport(n[0],n[1],n[2],n[3],0,1);let r=t.view.scissor??n;e.setScissorRect(r[0],r[1],r[2],r[3])}function u(e,t=`clear`){return e?.view?.index?`load`:t}(globalThis[Symbol.for(`margoengine.frame-resources`)]??={devices:new WeakMap}).devices;var d=`
struct Vertex { @builtin(position) position:vec4f,@location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[index];
 return Vertex(vec4f(p,0,1),vec2f(p.x*0.5+0.5,0.5-p.y*0.5));
}`;function f(e,t,n){return e.createBindGroup({layout:t.getBindGroupLayout(0),entries:n.map((e,t)=>({binding:t,resource:e}))})}function p(e,t,n,r={}){let i=e.createShaderModule({code:t});return e.createRenderPipeline({layout:`auto`,vertex:{module:i,entryPoint:`vertex`},fragment:{module:i,entryPoint:`fragment`,targets:[{format:n}]},...r})}function m(e,t,n,r=`load`){let i=e.encoder.beginRenderPass({colorAttachments:[{view:e.color,loadOp:u(e,r),storeOp:`store`}]});i.setPipeline(t),i.setBindGroup(0,n),l(i,e),i.draw(3),i.end()}var h=[`wipe`,`dissolve`,`radial`,`chromatic`],g=d+`
@group(0) @binding(0) var<uniform> settings:vec4f;
@group(0) @binding(1) var before:texture_2d<f32>;
@group(0) @binding(2) var after:texture_2d<f32>;
fn sample(t:texture_2d<f32>,uv:vec2f)->vec4f {let size=vec2i(textureDimensions(t));return textureLoad(t,clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1),0);}


fn dissolvePcg(v:u32)->u32 {let s=v*747796405u+2891336453u;let w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
fn dissolveThreshold(pixel:vec2u)->f32 {return f32(dissolvePcg(pixel.x+dissolvePcg(pixel.y))>>8u)*5.9604645e-8;}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let uv=i.position.xy/vec2f(textureDimensions(after));
 let p=settings.x;if(p<=0.0){return sample(before,uv);}if(p>=1.0){return sample(after,uv);}
 if(settings.y==4.0){return mix(sample(before,uv),sample(after,uv),p);}
 var edge=uv.x;
 if(settings.y==1.0){edge=dissolveThreshold(vec2u(i.position.xy));}
 if(settings.y==2.0){edge=fract(atan2(uv.x-0.5,0.5-uv.y)/6.2831853+1.0);}
 if(settings.y==3.0){let shift=vec2f(sin(p*3.14159265)*settings.z,0);let a=sample(after,uv+shift);let b=sample(after,uv-shift);return mix(sample(before,uv),vec4f(a.r,sample(after,uv).g,b.b,1),p);}
 return mix(sample(before,uv),sample(after,uv),1.0-smoothstep(p-0.01,p+0.01,edge));
}`;function _(e,t){return/^(?:(?:r|rg|rgba)(?:8|16|32)(?:unorm|snorm|float)(?:-srgb)?|bgra8unorm(?:-srgb)?|rgb10a2unorm|rg11b10ufloat)$/.test(e)&&!(t>1&&/32float$/.test(e))}var v=(e,t=`1.0.0`,n=import.meta.url)=>i(e,t,n);async function y(e,t){if(t?.throwIfAborted(),!t)return e;let n,r=new Promise((e,r)=>{n=()=>r(t.reason),t.addEventListener(`abort`,n,{once:!0})});try{return await Promise.race([e,r])}finally{t.removeEventListener(`abort`,n)}}async function b(e,t,n){let r=v(e),i=r.gpu;if(!i)throw s(`unsupported`,`Custom transitions require WebGPU; select a WebGPU engine`);if(typeof t!=`string`||!t.trim()||t.length>65536)throw TypeError(`Custom transition needs 1..65536 WGSL code units; supply a transition function`);n?.throwIfAborted();let a=`${d}
@group(0) @binding(0) var<uniform> settings:vec4f;
@group(0) @binding(1) var before:texture_2d<f32>;
@group(0) @binding(2) var after:texture_2d<f32>;
fn sample(t:texture_2d<f32>,uv:vec2f)->vec4f {
 let size=vec2i(textureDimensions(t));
 return textureLoad(t,clamp(vec2i(uv*vec2f(size)),vec2i(0),size-1),0);
}
${t}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let uv=i.position.xy/vec2f(textureDimensions(after));
 if(settings.x<=0.0){return sample(before,uv);}
 if(settings.x>=1.0){return sample(after,uv);}
 return transition(before,after,uv,settings.x);
}`;i.pushErrorScope(`validation`);let o=i.createShaderModule({code:a}),c=i.popErrorScope(),l=await y(o.getCompilationInfo(),n),u=await y(c,n),f=l.messages.find(e=>e.type===`error`);if(f||u)throw s(`failed`,`Custom transition WGSL failed; correct the function: ${f?.message??u?.message}`);let p=i.createPipelineLayout({bindGroupLayouts:[i.createBindGroupLayout({entries:[{binding:0,visibility:2,buffer:{type:`uniform`}},{binding:1,visibility:2,texture:{sampleType:`float`}},{binding:2,visibility:2,texture:{sampleType:`float`}}]})]});try{await y(i.createRenderPipelineAsync({layout:p,vertex:{module:o,entryPoint:`vertex`},fragment:{module:o,entryPoint:`fragment`,targets:[{format:`rgba8unorm`}]}}),n)}catch(e){throw n?.throwIfAborted(),Object.assign(s(`failed`,`Custom transition interface failed; use the documented function and bindings`),{cause:e})}if(n?.throwIfAborted(),r.gpu!==i||r.disposed)throw s(`state`,`Custom transition engine changed during compilation; create it on a live engine`);return a}var x=(e,t=`1.0.0`,n=import.meta.url)=>i(e,t,n),S=class t{coreRequirement=r(`1.0.0`,import.meta.url);constructor(e,t,n,r){this.engine=e,this.before=t,this.after=n,this.options=r,this.name=`transitions:live`,this.code=g,this.images=[],this.samples=0,this.elapsed=1,this.duration=1,this.disposed=!1,this.values=new Float32Array([1,4,.02,0])}static attach(i,a,o,c={}){n(i,r(`1.0.0`,import.meta.url));let l=x(i);if(!l.gpu)throw s(`unsupported`,`Live transitions require WebGPU; select a WebGPU engine`);if(l.disposed)throw s(`disposed`,`Engine is disposed; create a new engine`);if(a===o||!l.scenes.has(a)||!l.scenes.has(o))throw TypeError(`Live transitions need two distinct live scenes from this engine; use engine.createScene()`);if(c.beforeCamera&&!(c.beforeCamera instanceof e)||c.afterCamera&&!(c.afterCamera instanceof e))throw TypeError(`Live transition cameras must be Camera instances; use engine.camera or new Camera()`);let u=new t(l,a,o,{...c}),d=c.kind??`crossfade`;if(d!==`crossfade`&&!h.includes(d))throw RangeError(`Unknown live transition kind; choose wipe, dissolve, radial, chromatic or crossfade`);u.values[1]=d===`crossfade`?4:h.indexOf(d),c.mask&&u.configureMask(c.mask,c.softness??.02),u.output=i.createScene(`transitions:live`);try{u.output.use(u)}catch(e){throw u.dispose(),e}return u}get progress(){return Math.min(1,this.elapsed/this.duration)}start(e=1,t=1,n=.02){this.live();let r=typeof e==`number`?this.values[1]:e===`crossfade`?4:h.indexOf(e),i=typeof e==`number`?e:t;if(!Number.isFinite(i)||i<=0||i>60||r<0||!Number.isFinite(n)||n<0||n>.25)throw RangeError(`Live transition needs a known kind, seconds in (0,60] and displacement in [0,0.25]; check start arguments`);this.duration=i,this.elapsed=0,this.values[1]=r,this.values[2]=n}configureMask(e,t){let n=typeof ImageData<`u`&&e instanceof ImageData,r=typeof ImageBitmap<`u`&&e instanceof ImageBitmap;if(!n&&!r||n&&!(e.data instanceof Uint8ClampedArray))throw TypeError(`Live mask needs 8-bit ImageData or an open ImageBitmap; decode the image first`);let i=Math.min(4096,this.engine.gpu.limits.maxTextureDimension2D);if(![e.width,e.height].every(e=>Number.isSafeInteger(e)&&e>0&&e<=i))throw RangeError(`Live mask dimensions exceed device limits; use an image of 1..min(4096, device limit)`);if(!Number.isFinite(t)||t<0||t>1||t>0&&t<1e-6)throw RangeError(`Live mask softness is out of range; use zero or 0.000001..1`);this.maskSource=n?{width:e.width,height:e.height,data:e.data.slice()}:e,this.code=`${d}
@group(0) @binding(0) var<uniform> settings:vec4f;
@group(0) @binding(1) var before:texture_2d<f32>;
@group(0) @binding(2) var after:texture_2d<f32>;
@group(0) @binding(3) var mask:texture_2d<f32>;
fn sample(t:texture_2d<f32>,pixel:vec2u,extent:vec2u)->vec4f {
 let n=textureDimensions(t);let q=(pixel*n+n/2u)/extent;
 return textureLoad(t,vec2i(min(q,n-1u)),0);
}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let p=settings.x;let pixel=vec2u(i.position.xy);let extent=textureDimensions(after);
 if(p<=0.0){return sample(before,pixel,extent);}if(p>=1.0){return sample(after,pixel,extent);}
 let edge=sample(mask,pixel,extent).r;
 let weight=${t===0?`select(0.0,1.0,edge<=p)`:`1.0-smoothstep(p-f32(${t}),p+f32(${t}),edge)`};
 return mix(sample(before,pixel,extent),sample(after,pixel,extent),weight);
}`}static async custom(e,n,r,i,a={}){let o=await b(e,i,a.signal),s=t.attach(e,n,r,a);return s.code=o,s}live(){if(this.disposed||this.engine.disposed)throw s(`disposed`,`Live transition is disposed; attach a new one`)}render({delta:e=0,target:t,culling:n=!0}={}){if(this.live(),!Number.isFinite(e)||e<0||e>1)throw RangeError(`Live transition delta must be finite in [0,1]; pass seconds`);let r=this.engine.gpu;if(!r)throw s(`state`,`Live transition device is unavailable; wait for engine recovery`);if(!this.engine.scenes.has(this.before)||!this.engine.scenes.has(this.after))throw s(`state`,`A live transition scene was disposed; attach two live scenes`);let i=t?.width??this.engine.canvas.width,a=t?.height??this.engine.canvas.height;if(![i,a].every(e=>Number.isSafeInteger(e)&&e>0&&e<=r.limits.maxTextureDimension2D))throw RangeError(`Live transition dimensions must fit the device texture limit; resize the output`);if(t&&(!(t.usage&GPUTextureUsage.RENDER_ATTACHMENT)||t.sampleCount!==1||t.dimension!==`2d`||t.depthOrArrayLayers!==1||!_(t.format,this.engine.renderTarget?.samples??1)||this.images.includes(t)))throw TypeError(`Live transition target must be a separate single-sample 2D float color render attachment with MSAA resolve support; choose rgba8unorm`);if(this.maskSource&&Math.max(i,a)>65535)throw RangeError(`Live mask captures exceed integer addressing limits; use dimensions at most 65535`);if(this.images[0]?.width!==i||this.images[0]?.height!==a){this.releaseImages();try{for(let e=0;e<2;e++)this.images.push(r.createTexture({size:[i,a],format:`rgba8unorm`,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}))}catch(e){throw this.releaseImages(),e}}this.engine.render({delta:e,culling:n,views:[{scene:this.before,camera:this.options.beforeCamera??this.engine.camera,viewport:[0,0,1,1],target:{color:this.images[0]}},{scene:this.after,camera:this.options.afterCamera??this.engine.camera,viewport:[0,0,1,1],target:{color:this.images[1]}},{scene:this.output,camera:this.engine.camera,viewport:[0,0,1,1],target:t?{color:t}:void 0}]})}setup(e){let t=this.maskSource;if(t){if(t.width<1||t.height<1)throw s(`state`,`Live mask bitmap is closed; keep it open until transition disposal`);this.mask=e.gpu.createTexture({size:[t.width,t.height],format:`rgba8unorm`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT}),`data`in t?e.gpu.queue.writeTexture({texture:this.mask},t.data,{bytesPerRow:t.width*4},[t.width,t.height]):e.gpu.queue.copyExternalImageToTexture({source:t},{texture:this.mask},[t.width,t.height])}this.uniform=e.gpu.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}registerPasses(e){e.add({name:this.name,order:50,execute:e=>{if(e.backend!==`webgpu`||!this.images.length)return;let t=e.descriptor.multisample?.count??1;(!this.pipeline||this.format!==e.format||this.samples!==t)&&(this.pipeline=p(e.device,this.code,e.format,{multisample:{count:t}}),this.format=e.format,this.samples=t,this.bind=void 0),this.bind??=f(e.device,this.pipeline,[{buffer:this.uniform},this.images[0].createView(),this.images[1].createView(),...this.mask?[this.mask.createView()]:[]]),this.elapsed=Math.min(this.duration,this.elapsed+e.delta),this.values[0]=this.progress,e.device.queue.writeBuffer(this.uniform,0,this.values),m(e,this.pipeline,this.bind,`clear`)}})}releaseImages(){for(let e of this.images)e.destroy();this.images=[],this.bind=void 0}onDeviceRestored(e){this.releaseImages(),this.uniform?.destroy(),this.mask?.destroy(),this.mask=void 0,this.pipeline=void 0,this.setup(e)}dispose(){this.disposed||(this.disposed=!0,this.engine.sceneOf(this)?.removePlugin(this.name),this.output?.dispose(),this.output=void 0,this.releaseImages(),this.uniform?.destroy(),this.mask?.destroy(),this.mask=void 0,this.maskSource=void 0,this.uniform=void 0,this.pipeline=void 0)}[Symbol.dispose??Symbol()](){this.dispose()}},C=Math.PI*2,w=(e,t)=>e.map((e,n)=>e+t[n]),T=(e,t)=>e.map((e,n)=>e-t[n]),E=(e,t)=>e.map(e=>e*t),D=(e,t)=>[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]],O=e=>E(e,1/Math.hypot(...e)),k=(e,t,n)=>e.map((e,r)=>e+(t[r]-e)*n),A=e=>Math.min(1,Math.max(0,e));function j(e){let t=e;return()=>(t=Math.imul(1664525,t)+1013904223>>>0,t/4294967296)}function M(){let e=[],t=[];return{face(n,r,i,a){let o=e.length/10,s=a?.[0]??O(D(T(n[1],n[0]),T(n[2],n[0]))),c=Array.isArray(r[0]);for(let l=0;l<n.length;l++){let u=c?r[l]:r,d=a?a[l]:s;e.push(...n[l],...d,...u,i),l>1&&t.push(o,o+l-1,o+l)}},finish(){return{vertices:Float32Array.from(e),indices:Uint32Array.from(t)}}}}function N(e){let t=O(e),n=O(D(Math.abs(t[1])>.92?[0,0,1]:[0,1,0],t));return[n,D(t,n),t]}function P(e,t,n,r,i,a,o=48,s=0,c=C){let[l,u,d]=N(n),f=(e,n,r)=>w(t,w(E(d,n),w(E(l,Math.cos(r)*e),E(u,Math.sin(r)*e))));for(let t=1;t<r.length;t++){let[n,p]=r[t-1],[m,h]=r[t],g=h-p,_=n-m;if(!g&&!_)continue;let v=e=>O(w(E(d,_),w(E(l,g*Math.cos(e)),E(u,g*Math.sin(e)))));for(let t=0;t<o;t++){let r=s+(c-s)*t/o,l=s+(c-s)*(t+1)/o,u=[f(n,p,r),f(n,p,l),f(m,h,l),f(m,h,r)],d=[v(r),v(l),v(l),v(r)];n||(u.splice(1,1),d.splice(1,1)),m||(u.splice(3,1),d.splice(3,1)),e.face(u,i,a,d)}}}function F(e,t,n,r,i,a,o=9,s=1){let c=T(n,t),l=Math.hypot(...c),u=Math.min(l*.27,r*.43),d=r;P(e,t,c,[[0,0],[d*.79,0],[d,u],[d*s,l-u],[d*s*.78,l],[0,l]],i,a,o)}function I(e,t,n,r,i,a,o,s,c,l=6,u=[0,0],d=137){let f=j(d),p=Array.from({length:l},(e,t)=>{let n=C*t/l+f()*.17;return[Math.cos(n)*(.77+f()*.49),Math.sin(n)*(.76+f()*.46)]}),m=p.map(([e,r])=>[t[0]+e*i,n,t[1]+r*a]),h=p.map(([e,o],s)=>[t[0]+e*i*.94+u[0]*.18,n+(r-n)*(.56+.11*Math.sin(d+s*1.23)),t[1]+o*a*.96+u[1]*.23]),g=p.map(([e,s],c)=>[t[0]+e*i*o+u[0],r+(r-n)*(.049*Math.sin(d+c*1.6)),t[1]+s*a*o+u[1]]);for(let t=0;t<l;t++){let n=(t+1)%l,r=k(s,[.87,.8,.71],f()*.08);e.face([m[n],m[t],h[t],h[n]],s,c),e.face([h[n],h[t],g[t]],r,c),e.face([h[n],g[t],g[n]],k(r,[.21,.38,.47],f()*.082),c)}let _=[t[0]+u[0],r+(r-n)*.022,t[1]+u[1]];for(let t=0;t<l;t++)e.face([g[(t+1)%l],g[t],_],s,c)}function L(e,t,n,r,i,a,o,s,c){let l=Math.min(i,a)*.093,u=[[-i/2+l,-a/2],[i/2-l,-a/2],[i/2,-a/2+l],[i/2,a/2-l],[i/2-l,a/2],[-i/2+l,a/2],[-i/2,a/2-l],[-i/2,-a/2+l]],d=u.map(([e,i])=>[t+e,n-o*.5,r+i]),f=u.map(([e,i])=>[t+e*.986,n+o*.5,r+i*.986]);e.face([...f].reverse(),s,c);for(let t=0;t<8;t++)e.face([d[t],f[t],f[(t+1)%8],d[(t+1)%8]],s,c)}function R(e,t){let n=.52*Math.sin(e*.157+t*.074)+.24*Math.sin(e*.277-t*.204)+.11*Math.sin(e*.43-t*.348),r=2.9*Math.sin(e*.032+.062*t)+3.4*Math.cos(e*.026-.031*t),i=Math.exp(-((e/11)**2+((t+12)/19)**2));return .22+n*.61+r*(1-i*.95)*.31}function z(e,t){let n=-171,r=-412,i=t?(e,t)=>{let n=(e-(.057*t+1.7*Math.sin(t*.046)))/11.4,r=1.66+.62*Math.sin(e*.098+t*.028)+.51*Math.sin(e*.172-t*.081)+.21*Math.sin(t*.34+e*.22);return Math.max(-.71,r-Math.exp(-n*n)*2.59-1.65*Math.exp(-((e/26)**2+(t+14)**2/500)))}:R,a=t?(e,t,n)=>k([.19,.36,.43],[.49,.67,.68],A(.46+n*.09+.26*Math.sin(e*.22-t*.18))):(e,t,n)=>k([.35,.173,.106],[.68,.39,.218],A(.52+n*.16+.22*Math.sin(e*.16-t*.082)+.15*Math.sin(e*.48+t*.43)));function o(e,t){let n=i(e,t),r=O([i(e-.4,t)-i(e+.4,t),.8,i(e,t-.4)-i(e,t+.4)]);return{position:[e,n,t],tint:a(e,t,n),n:r}}for(let i=0;i<73;i++){let a=r+460*i/73,s=r+460*(i+1)/73;for(let r=0;r<57;r++){let i=n+347*r/57,c=n+347*(r+1)/57,l=[o(i,a),o(i,s),o(c,s),o(c,a)];e.face(l.map(e=>e.position),l.map(e=>e.tint),t?4:1,l.map(e=>e.n))}}}function B(e){e.face([[-1450,-125,-460],[1450,-125,-460],[1450,500,-460],[-1450,500,-460]],[.5,.5,.5],0)}function V(e){B(e),z(e,!1);let t=[.72,.35,.14],n=[.32,.205,.153],r=[.152,.143,.136],i=[.84,.46,.16],a=[.95,.51,.168];for(let[t,[n,r,i,a,o,s]]of[[-66,-83,16,18,16,.67],[-49,-73,12.3,13,9.6,.57],[-31,-81,10,13,13,.48],[-90,-141,22,23,16,.73],[-60,-155,20,29,19,.73],[64,-137,21,24,15,.59],[43,-115,15,23,16,.78],[95,-151,18,20,14.7,.63],[-26,-161,19,18,14,.43],[13,-197,27,35,15,.55],[-43,-10,7,11,8,.38],[38,-40,9,12,6.5,.35],[-54,-44,8.6,7.8,6.2,.58]].entries())I(e,[n,r],-1.5,i,a,o,s,k([.477,.244,.163],[.3,.227,.213],t/21),2,12,[.45*Math.sin(t),-.55*Math.cos(t)],827+t*31);let o=j(75511);for(let t=0;t<115;t++){let n=-104+o()*205,r=24-o()*117;if(Math.abs(n)<11&&Math.abs(r+12)<23)continue;let i=.32+o()*2.13;I(e,[n,r],-1.42,i*(.44+o()*.45),i*1.25,i*.87,.34+o()*.36,[.43,.253,.172],2,7,[.24,-.16],t+13)}for(let[t,n,i,a,o]of[[17.3,14.1,-13,.49,1.51],[15.2,12.5,-13,1.26,.165],[13.8,11.8,-13,1.48,.41]])L(e,0,a,i,t,n,o,r,3);let s=[0,1,0];P(e,[0,1.74,-13],s,[[0,0],[4.6,0],[4.83,.2],[4.82,.46],[4.52,.63],[0,.63]],r,3,62),P(e,[0,2.3,-13],s,[[0,0],[3.1,0],[3.15,.16],[3.07,1],[2.53,1.42],[0,1.42]],n,3,66),P(e,[0,2.52,-13],s,[[3.08,-.1],[3.19,-.1],[3.22,.01],[3.16,.15],[3.06,.14]],t,3,62);let c=[-.2,9.43,-13.72],l=O([.64,.26,.722]),[u,d]=N(l),f=(e,t,n)=>w(c,w(E(l,t),w(E(u,Math.cos(n)*e),E(d,Math.sin(n)*e))));P(e,c,l,[[4.94,-1.23],[5.34,-1.45],[6.27,-1.22],[6.61,-.63],[6.55,.54],[6.27,.94],[5.4,.83],[5.08,.56],[4.98,-.92],[4.94,-1.23]],n,3,112),P(e,c,l,[[5.37,.72],[6.12,.78],[6.41,.64],[6.45,1.01],[6.23,1.17],[5.46,1.04],[5.37,.72]],t,3,112);for(let[t,n]of[[5.43,1.02],[6.23,1.18],[6.53,.11]])P(e,c,l,[[t-.072,n-.065],[t+.034,n-.065],[t+.083,n],[t+.039,n+.067],[t-.074,n+.065],[t-.072,n-.065]],a,6,102);for(let n=0;n<14;n++){let a=n*C/14,o=a+.31;P(e,c,l,[[4.67,-.83],[5.47,-.91],[5.61,-.62],[5.17,-.49],[4.75,-.51],[4.67,-.83]],n%3==0?i:r,3,9,a,o),F(e,f(5.15,-.44,a+.15),f(3.76,-1.39,a+.1),.083,t,3,7,.67),F(e,f(6.11,.96,a+.071),f(6.11,1.2,a+.071),.095,r,3,7,.91)}P(e,c,l,[[0,-2.47],[1.16,-2.47],[2.27,-2.25],[3.2,-1.92],[4.45,-.98],[4.61,-.91]],[.36,.292,.225],3,76),P(e,c,l,[[0,-2.14],[.74,-2.14],[.9,-1.86],[.77,-1.18],[.52,.01],[.39,.37],[0,.38]],i,3,54),P(e,c,l,[[0,.39],[.43,.39],[.44,.48],[.33,.61],[0,.61]],a,6,48);for(let n of[.52,2.62,4.71])F(e,f(5.18,-.14,n),f(.5,.29,n),.16,t,3,10,.76),F(e,f(5.22,.05,n-.061),f(.51,.37,n),.071,i,3,9,.73);for(let i of[-1,1]){let a=[i*3.33,2.9,-13.23],o=f(6.16,-.65,i>0?.047:3.13);F(e,a,o,.49,r,3,10,1),F(e,[i*2.9,2.6,-15.8],w(o,[0,-.24,-.18]),.225,n,3,10,.9);for(let n=0;n<6;n++){let r=-5.8+n*.51;F(e,[i*5.9,1.73,r],[i*5.9,2.69,r],.067,t,3,8)}F(e,[i*5.9,2.65,-5.89],[i*5.9,2.65,-3.17],.075,t,3,8)}for(let t=0;t<11;t++){let n=t/10,r=-5.42+t*.91,i=-1.63+n*.48,o=R(i,r)-.14,s=Math.max(o+.25,1.55-n*1.02);if(L(e,i,(o+s)*.5,r,4.21+n*.37,.98,s-o,[.3,.235,.182],3),L(e,i,s+.044,r+.13,4.05+n*.32,.22,.086,[.415,.305,.22],3),t%3==0)for(let t of[-1,1]){let n=i+t*2.1;F(e,[n,s-.065,r],[n,s+.076,r],.081,a,6,8)}}for(let t of[-7.8,7.8])F(e,[t,1.39,-8],[t,2.31,-8],.19,r,3,10),F(e,[t,2.2,-8],[t,2.39,-8],.2,a,6,12)}function H(e){B(e),z(e,!0);let t=[.25,.52,.6],n=[.16,.3,.42],r=[.29,.48,.58],i=[.178,.258,.291],a=[.35,.5,.54],o=[.43,.91,.97],s=[.5,.35,.84];for(let[r,[i,a,o,s,c,l,u]]of[[-45,-41,15,13,13,.13,[-2.6,3]],[-31,-57,23,12,9.5,.13,[3.1,-.8]],[-54,-96,33,17,18,.17,[5.3,1.7]],[-68,-119,35,21,19,.25,[5.9,-3.6]],[56,-64,22,17,12,.16,[-6.4,-1]],[39,-52,13,14,10,.22,[-3.5,1.5]],[71,-102,28,24,18,.15,[-8.3,-5.8]],[-20,-119,17,12,13,.12,[-.7,4]],[8,-155,28,22,20,.12,[4.3,0]],[28,-143,19,16,17,.13,[-4.3,6]],[51,-153,36.1,16,17,.09,[.7,5.1]],[-29,-10,9,10,8,.2,[-2.9,-1.9]],[43,-5,15.5,15,9,.11,[-8.1,-2.6]],[-23,9,8,7,5.5,.23,[-3.1,1.9]]].entries())I(e,[i,a],-1.15,o,s,c,l,r%3==0?n:t,5,10,u,110+r*207);let c=j(151934);for(let t=0;t<80;t++){let i=-76+c()*155,a=20-c()*127;if(Math.abs(i)<9&&a>-26)continue;let o=.42+c()*2.83;I(e,[i,a],-.89,o*(.36+.56*c()),o*1.28,o*.91,.35+c()*.38,k(n,r,c()),5,6,[c()-.54,c()-.43],411+t)}for(let[t,n,r,a,o]of[[15.51,12.3,-14,.19,1.42],[14.93,11.82,-14,.91,.144],[13.33,10.92,-14,1.3,.54]])L(e,0,a,r,t,n,o,i,8);for(let t of[-6.65,6.65])F(e,[t,.62,-8.11],[t,.62,-19.81],.17,a,8,8),F(e,[t,1.61,-8.03],[t,1.61,-19.25],.08,o,7,8);for(let t=0;t<8;t++){let n=-5.97+t*2.5,r=.18-t*.018;L(e,-.46+Math.sin(t*.34)*.28,r,n,4.7-t*.12,2.04,.34,a,8);for(let t of[-2.5,1.57])F(e,[t,r+.23,n-1],[t,r+.23,n+.87],.073,o,7,7)}let l=[0,1.65,-14],u=O([.093,.997,-.04]);P(e,l,u,[[0,0],[4.38,0],[4.62,.34],[4.02,.75],[3.53,1.13],[0,1.13]],i,8,50),P(e,l,u,[[0,.96],[2.87,.96],[2.94,1.74],[2.26,3.82],[1.43,6.33],[1.05,10.11],[.82,12.21],[.64,14.12],[.28,15.42],[0,15.83]],a,8,6,.16,C+.16);let d=(e,t,n)=>w(l,[e*Math.cos(n)+u[0]*t,u[1]*t,e*Math.sin(n)+u[2]*t]);for(let t=0;t<6;t++){let n=t*C/6+.136,r=[d(2.66,1.87,n),d(1.64,6.04,n+.021),d(1.1,10.06,n+.032),d(.74,13.61,n+.04)];for(let t=1;t<r.length;t++)F(e,r[t-1],r[t],.11,o,7,8,t===3?.5:.82)}for(let[t,n]of[[3.2,2.66],[6.3,1.87],[11.68,1.13],[13.89,.9]])P(e,l,u,[[n-.27,t-.11],[n+.03,t-.11],[n+.15,t],[n+.076,t+.14],[n-.21,t+.13]],i,8,24);for(let t=0;t<3;t++){let n=.57+t*C/3,r=d(1.01,9.41,n),o=d(3.42,10.43,n),c=d(4.95,14.36,n+.16);F(e,r,o,.245,i,8,6,.86),F(e,o,c,.206,a,8,6,.5),F(e,d(.66,13.83,n),c,.11,a,8,7,.87),F(e,T(c,[0,.17,0]),w(c,[0,.36,0]),.166,s,7,10,.62)}F(e,d(0,15.16,0),d(0,17.24,0),.104,a,8,10,.45),F(e,d(0,16.49,0),d(0,17.55,0),.116,o,7,10,.72);for(let[t,n,r]of[[-6.43,-11,3.34],[6.43,-13,3.03]])P(e,[t,1.59,n],u,[[0,0],[.96,0],[1.06,.15],[.81,1.23],[.69,r-1.9],[.4,r-1.66],[0,r-1.56]],[.24,.35,.43],8,6),F(e,[t,r-.75,n],[t,r-.03,n],.135,o,7,12,.77)}function U(){let e=M(),t=M();return V(e),H(t),{dune:e.finish(),glacier:t.finish()}}var W=`
struct Frame { vp:mat4x4f, eye:vec4f, mood:vec4f }
@group(0) @binding(0) var<uniform> frame:Frame;

struct Field {
  @builtin(position) clip:vec4f,
  @location(0) p:vec3f,
  @location(1) n:vec3f,
  @location(2) tint:vec3f,
  @location(3) @interpolate(flat) group:u32,
}

@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) pigment:vec4f)->Field {
  return Field(frame.vp*vec4f(p,1),p,n,pigment.xyz,u32(pigment.w));
}
fn hash(p:vec2f)->f32 {
  let a=fract(vec3f(p.x,p.y,p.x)*vec3f(0.1031,0.1030,0.0973));
  let b=a+dot(a,a.yzx+33.33);
  return fract((b.x+b.y)*b.z);
}
fn noise(p:vec2f)->f32 {
  let cell=floor(p);
  let u=fract(p);
  let t=u*u*(3.0-2.0*u);
  return mix(mix(hash(cell),hash(cell+vec2f(1,0)),t.x),
    mix(hash(cell+vec2f(0,1)),hash(cell+vec2f(1,1)),t.x),t.y);
}
fn canopy(p:vec2f)->f32 {
  return noise(p)*0.63+noise(p*2.16+7.9)*0.26+noise(p*4.42-11.3)*0.11;
}
fn sky(p:vec3f,cold:bool,t:f32)->vec3f {
  let world=p.xy/460.0;
  let skyHeight=clamp(world.y+0.033,0.0,1.0);
  if(cold){
    let first=mix(vec3f(0.40,0.55,0.66),vec3f(0.058,0.106,0.203),smoothstep(0.0,0.48,skyHeight));
    let path=0.192+0.095*sin(world.x*3.2+0.47+t*0.071)+0.034*sin(world.x*9.4-t*0.078);
    let fold=world.y-path;
    let vertical=(0.42+0.58*canopy(vec2f(world.x*35.1-t*.027,world.y*2.12)));
    let curtain=exp(-abs(fold)*13.3)*vertical*(0.62+0.38*sin(world.x*4.8+0.31));
    let lower=exp(-abs(fold+0.021)*52.0)*vertical*0.72;
    let contrast=canopy(vec2f(world.x*5.6+t*.018,world.y*21.0)+3.9);
    var tint=first+curtain*vec3f(0.030,0.204,0.178)+lower*vec3f(0.06,0.31,0.255);
    tint+=contrast*curtain*vec3f(0.064,0.10,0.129);
    let grid=world*vec2f(197,153);
    let cell=floor(grid);
    let spark=step(0.994,hash(cell))*max(0.0,1.0-length(fract(grid)-0.5)*2.5);
    let moonDistance=length(world-vec2f(0.18,0.284));
    let moon=1.0-smoothstep(0.0252,0.0260,moonDistance);
    let crescent=moon*smoothstep(0.023,0.024,length(world-vec2f(0.187,0.290)));
    tint+=vec3f(0.41,0.56,0.72)*spark*smoothstep(.08,.27,skyHeight);
    return mix(tint,vec3f(0.716,0.846,0.90),crescent);
  }

  let off=world-vec2f(-0.517,0.079);
  let distance=length(off);
  let glow=exp(-3.3*length(off*vec2f(1.0,2.4)));
  let base=mix(vec3f(0.776,0.482,0.301),vec3f(0.291,0.432,0.517),smoothstep(0.001,0.42,skyHeight));
  let layer=canopy(vec2f(world.x*7.4-t*.028,world.y*46.0+world.x*1.8));
  let amber=vec3f(1.0,0.669,0.382);
  let wisps=smoothstep(0.535,0.728,layer)*smoothstep(0.012,0.092,skyHeight)*(1.0-smoothstep(.29,.69,skyHeight));
  let warm=mix(base,amber,glow*0.77);
  let shining=mix(warm,mix(vec3f(0.667,0.423,0.396),amber,glow*0.67),wisps*.75);
  let orb=1.0-smoothstep(0.0353,0.0367,distance);
  return mix(shining,vec3f(.993,.867,.635),orb);
}
fn paint(color:vec3f)->vec3f {
  return clamp(color,vec3f(0.0),vec3f(1.0));
}

@fragment fn fragment(input:Field)->@location(0) vec4f {
  let p=input.p;
  let v=normalize(frame.eye.xyz-p);
  let n=normalize(input.n);
  let category=input.group;
  let cold=frame.mood.y>0.5;
  let t=frame.mood.x;
  if(category==0u){
    return vec4f(paint(sky(p,cold,t)),1.0);
  }
  let key=normalize(select(vec3f(-0.74,.41,.33),vec3f(-.42,.62,.54),cold));
  let direct=max(0.0,dot(n,key));
  let far=length(p.xz-frame.eye.xz);
  let haze=1.0-exp(-far*select(.0049,.0054,cold));
  let air=select(vec3f(.617,.431,.353),vec3f(.392,.503,.634),cold);
  let movement=t*.023;
  let texture=canopy(vec2f(p.x*.82+p.y*.35,p.z*.72-p.y*.17));
  let micro=canopy(vec2f(p.x*2.03+p.z*.20,p.z*2.89+p.y));
  var base=input.tint;
  if(category==1u){
    let dune=sin(p.z*1.79+p.x*.57+texture*4.6);
    let lit=vec3f(1.16,1.03,.89)*(.65+direct*.42);
    let contact=1.0-.52*exp(-abs(p.x)*.18-abs(p.z+13.5)*.095);
    base=base*lit*contact+(texture-.45)*vec3f(.086,.060,.044)+(dune*.5+.5)*micro*.026;
    let dust=noise(vec2f(p.x*.073-movement,p.z*.102))*exp(-max(0.0,p.y)*.14);
    base=mix(base,vec3f(.744,.543,.371),smoothstep(.67,.94,dust)*.24);
  }else if(category==2u){
    let ledge=sin(p.y*2.19+p.z*.099+texture*4.8);
    base=base*(.67+direct*.56+(ledge*.081)+(texture-.5)*.16);
    base+=vec3f(.09,.047,.041)*max(0.0,n.y)*micro;
  }else if(category==4u){
    let lane=abs(p.x-(.057*p.z+1.7*sin(p.z*.046)));
    let clear=(1.0-smoothstep(3.0,13.0,lane))*(1.0-smoothstep(-.53,.42,p.y));
    let crack=sin(p.x*1.26-p.z*.65+texture*4.7)*sin(p.z*.39+p.x*.73+micro*3.0);
    let edge=1.0-smoothstep(0.04,.20,abs(crack));
    let blendIce=mix(base*.96,vec3f(.131,.227,.393),clear*.73);
    let sparkle=smoothstep(.61,.91,texture)*clear*max(0.0,n.y);
    let flux=vec3f(.073,.217,.207)*(sin(t*.38+p.z*.044)*.25+.67);
    let crystal=vec3f(.114,.19,.23)*edge*(.11+.89*micro)*(.65-clear*.54);
    base=blendIce*(.77+direct*.41)+sparkle*flux+crystal;
  }else if(category==5u){
    let layers=sin(p.y*1.76-p.x*.21+p.z*.44+micro*4.8);
    let bleed=exp(-abs(p.y-.13)*.31);
    let color=mix(input.tint,vec3f(.36,.684,.769),max(0.0,n.y)*.29);
    base=color*(.64+direct*.61)+vec3f(.037,.096,.119)*bleed+(layers*.38+micro-.55)*.052;
  }else if(category==6u||category==7u){
    let flare=.87+.13*sin(t*2.48+dot(p,vec3f(.14,.29,.037)));
    return vec4f(paint(mix(base,vec3f(1.0,.985,.95),.22+flare*.19)),1.0);
  }else{
    let reflection=reflect(-v,n);
    let angle=clamp(abs(dot(v,n)),0.0,1.0);
    let hot=pow(max(0.0,dot(reflection,key)),7.4);
    let fill=abs(dot(reflection,normalize(vec3f(.31,.45,-.832))));
    let shiny=.11*pow(fill,9.0)+.24*hot+.09*pow(1.0-angle,4.3);
    let edgeLight=select(vec3f(.94,.588,.345),vec3f(.543,.819,.902),cold);
    let lighting=(.58+direct*.48)*(0.955+micro*.069);
    base=base*lighting+edgeLight*shiny;
  }
  return vec4f(paint(mix(base,air,haze*(select(.80,.90,cold)))),1.0);
}
`;function G(e,t,n,r){let i,a,o,s,c,l,u=new Float32Array(24);function d(){a?.destroy(),o?.destroy(),s?.destroy(),a=o=s=c=l=void 0}function f(t){i=t.gpu,a=i.createBuffer({size:e.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),o=i.createBuffer({size:e.indices.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST}),s=i.createBuffer({size:u.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),i.queue.writeBuffer(a,0,e.vertices),i.queue.writeBuffer(o,0,e.indices)}function p(e){let t=r.get(i);t||(t=new Map,r.set(i,t));let n=e.format+`:`+e.descriptor.depthStencil.format+`:`+(e.descriptor.multisample?.count??1),a=t.get(n);if(!a){let r=i.createShaderModule({code:W});a=i.createRenderPipeline({layout:`auto`,vertex:{module:r,entryPoint:`vertex`,buffers:[{arrayStride:40,attributes:[{shaderLocation:0,offset:0,format:`float32x3`},{shaderLocation:1,offset:12,format:`float32x3`},{shaderLocation:2,offset:24,format:`float32x4`}]}]},fragment:{module:r,entryPoint:`fragment`,targets:[{format:e.format}]},depthStencil:{...e.descriptor.depthStencil},multisample:e.descriptor.multisample}),t.set(n,a)}return a}function m(r){let d=p(r);d!==c&&(c=d,l=i.createBindGroup({layout:c.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:s}}]})),u.set(r.camera.matrix),u.set(r.camera.position,16),u[20]=n(),u[21]=Number(t),i.queue.writeBuffer(s,0,u);let f={view:r.color,loadOp:`load`,storeOp:`store`},m={view:r.depth,depthLoadOp:`load`,depthStoreOp:`store`};r.attach?.(f,m,r.last);let h=r.encoder.beginRenderPass({colorAttachments:[f],depthStencilAttachment:m});h.setPipeline(c),h.setBindGroup(0,l),h.setVertexBuffer(0,a),h.setIndexBuffer(o,`uint32`),h.drawIndexed(e.indices.length),h.end()}return{name:`signal-world`,setup:f,onDeviceRestored(e){d(),f(e)},dispose:d,registerPasses(e){e.add({name:`draw-signal-world`,order:1,joins:!0,execute:m})}}}var K=`
fn transition(a:texture_2d<f32>,b:texture_2d<f32>,uv:vec2f,p:f32)->vec4f {
  let x=uv.x+(uv.y-0.5)*0.145;
  let k=sin(p*3.141592654);
  let near=1.0-smoothstep(0.02,0.18,abs(x-p));
  let fringe=near*k*0.047;
  let softness=0.012;
  let u=vec2f(fringe,0.0);
  let outgoing=sample(a,uv);
  let left=sample(b,uv+u);
  let middle=sample(b,uv);
  let right=sample(b,uv-u);
  let maskR=1.0-smoothstep(p-softness+fringe,p+softness+fringe,x);
  let maskG=1.0-smoothstep(p-softness,p+softness,x);
  let maskB=1.0-smoothstep(p-softness-fringe,p+softness-fringe,x);
  return vec4f(mix(outgoing.rgb,vec3f(left.r,middle.g,right.b),vec3f(maskR,maskG,maskB)),1.0);
}
`,q=()=>new Promise(e=>requestAnimationFrame(e)),J=2.3;async function Y({engine:t,worlds:n,canvas:r,notice:i,status:a,size:o,signal:s,fail:c}){let l=[...document.querySelectorAll(`[name="effect"]`)],u=document.querySelector(`#progress`),d=document.querySelector(`#amount`),f=document.querySelector(`#play`),p=matchMedia(`(max-width:650px)`),m=t.gpu.adapterInfo?.vendor===`margo-webgl2`;r.dataset.renderer=m?`compatibility`:`webgpu`,document.querySelector(`#renderer`).textContent=m?`Margo WebGL2`:`Margo WebGPU`,r.dataset.dune=String(n.dune.indices.length/3),r.dataset.glacier=String(n.glacier.indices.length/3);let h=.56,g=0,_=`wipe`,v=!1,y=!1,b=!1,x=0,C=!1,w=!0,T=0,E=t.createScene(`Dune Station`),D=t.createScene(`Glacier Relay`),O=new e({near:.85,far:900}),k=new e({near:.83,far:900}),A={beforeCamera:O,afterCamera:k},j=new WeakMap;E.use(G(n.dune,!1,()=>h,j)),D.use(G(n.glacier,!0,()=>h,j));let M=S.attach(t,E,D,A),N=S.custom(t,E,D,K,{...A,signal:s});function P(){O.position=p.matches?[12.91,8.62,29.7]:[13.6,8.14,29.4],O.target=[0,7.24,-14.25],O.fov=p.matches?44:38,k.position=p.matches?[9.1,7.16,28.9]:[10.34,7.47,29.2],k.target=[.3,8.15,-15.88],k.fov=p.matches?44:38}function F(){let e=Math.round(g*100);u.value=String(e),u.setAttribute(`aria-valuetext`,e+` percent`),d.value=e+`%`,f.textContent=v?`Pause`:g===1?`Replay`:`Play`}P(),M.start(`wipe`),M.render({delta:0}),performance.mark(`transitions-still-submitted`);let I=await N;await t.gpu.queue.onSubmittedWorkDone(),s.throwIfAborted(),performance.mark(`transitions-prism-ready`);function L(){let e=_===`chromatic`?I:M;e.start(_===`chromatic`?`wipe`:_,1),e.render({delta:g}),r.dataset.effect=_,r.dataset.progress=g.toFixed(3),r.dataset.motion=v?`playing`:`paused`,r.dataset.time=h.toFixed(4)}function R(){y||x||s.aborted||(x=requestAnimationFrame(z))}async function z(e){if(x=0,y||s.aborted)return;y=!0,b=!1;let n=C;C=!1;try{if(v){let t=T?Math.min(.08,(e-T)*.001):.026;T=e,h+=t,g=Math.min(1,g+t/J),g===1&&(v=!1,T=0)}if(F(),L(),await t.gpu.queue.onSubmittedWorkDone(),s.aborted)return;if(n){if(await q(),s.aborted)return;performance.mark(`transitions-input-rendered`),w&&(w=!1,performance.mark(`transitions-first-input`))}}catch(e){c(e)}finally{y=!1,(v||b)&&R()}}function B(e){b=!0,C||=e.isTrusted,R()}if(r.dataset.effect=_,r.dataset.progress=g.toFixed(3),r.dataset.motion=`paused`,r.dataset.time=h.toFixed(4),F(),await q(),a.ready()){i.hidden=!0;for(let e of[...l,u,f])e.disabled=!1;performance.mark(`transitions-ready`)}u.addEventListener(`input`,e=>{v=!1,T=0,g=Number(u.value)/100,B(e)},{signal:s});for(let e of l)e.addEventListener(`change`,t=>{e.checked&&(v=!1,T=0,_=e.value,(g===0||g===1)&&(g=.5),B(t))},{signal:s});f.addEventListener(`click`,e=>{g===1&&(g=0),T=0,v=!v,B(e)},{signal:s});let V=new ResizeObserver(()=>{o()&&(P(),b=!0,R())});V.observe(r),s.addEventListener(`abort`,()=>{V.disconnect(),cancelAnimationFrame(x)},{once:!0})}export{U as prepareWorlds,Y as show};