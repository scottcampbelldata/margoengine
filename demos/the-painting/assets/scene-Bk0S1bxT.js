import{i as e,n as t,r as n}from"./index-CueAo-6T.js";var r=(r,i=e,a=import.meta.url)=>(t(r,n(i,a)),r),i=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e}),a=(e,t)=>`${e}; see https://margoengine.com/errors#${t}`,o=(e,t,n=e)=>i(e,a(t,n)),s=(e,t)=>RangeError(a(e,t));function c(e){return e?.view?.viewport}function l(e,t){let n=c(t);if(!n)return;e.setViewport(n[0],n[1],n[2],n[3],0,1);let r=t.view.scissor??n;e.setScissorRect(r[0],r[1],r[2],r[3])}function u(e,t=`clear`){return e?.view?.index?`load`:t}function d(e){return e?.view?.id??0}var f=class{constructor(e,t=()=>{}){this.create=e,this.release=t,this.states=new Map,this.frame=0}get(e){let t=d(e),n=this.states.get(t);return n||this.states.set(t,n={state:this.create(e),frame:0}),n.frame=this.frame,n.state}find(e){return this.states.get(e)?.state}*values(){for(let e of this.states.values())yield e.state}*drawn(){for(let e of this.states.values())e.frame===this.frame&&(yield e.state)}prune(){for(let[e,t]of this.states)t.frame<this.frame&&(this.states.delete(e),this.release(t.state));this.frame++}clear(){for(let e of this.states.values())this.release(e.state);this.states.clear()}},p=`
struct Vertex { @builtin(position) position:vec4f,@location(0) uv:vec2f }
@vertex fn vertex(@builtin(vertex_index) index:u32)->Vertex {
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[index];
 return Vertex(vec4f(p,0,1),vec2f(p.x*0.5+0.5,0.5-p.y*0.5));
}`;function m(e,t,n){return e.createBindGroup({layout:t.getBindGroupLayout(0),entries:n.map((e,t)=>({binding:t,resource:e}))})}function h(e,t,n,r={}){let i=e.createShaderModule({code:t});return e.createRenderPipeline({layout:`auto`,vertex:{module:i,entryPoint:`vertex`},fragment:{module:i,entryPoint:`fragment`,targets:[{format:n}]},...r})}var g=(e,t)=>Object.assign(Error(t),{name:`MargoError`,code:e}),_=(e,t)=>`${e}; see https://margoengine.com/errors#${t}`,v=(e,t,n=e)=>g(e,_(t,n)),y=(globalThis[Symbol.for(`margoengine.frame-resources`)]??={devices:new WeakMap}).devices;function b(e){let t=y.get(e);return t||(y.set(e,t={frame:0,open:!1,lost:!1,views:new Set,drawing:0,retired:[],written:new WeakMap}),e.lost?.then?.(()=>{t.lost=!0;let e=t.retired;t.retired=[];for(let t of e)t.destroy()})),t}function x(e,t){if(!t)return;let n=b(e),r=[t,...n.written.get(t)?.extras??[]];if(n.written.delete(t),!n.lost&&n.open&&(n.views.size>1||n.drawing>0))n.retired.push(...r);else for(let e of r)e.destroy()}function S(e){return e?.view?.viewport}function C(e,t){let n=S(t);if(!n)return;e.setViewport(n[0],n[1],n[2],n[3],0,1);let r=t.view.scissor??n;e.setScissorRect(r[0],r[1],r[2],r[3])}function w(e,t=`clear`){return e?.view?.index?`load`:t}function T(e,t,n=`full`){let r={ldr:0,"half-float":1,full:2};if(!Object.hasOwn(r,n))throw TypeError(`minimum must be full, half-float or ldr`);let i=e?.adapter?.capabilities?.tier;if(i&&r[i]<r[n])throw v(`unsupported`,`${t} requires the ${n} compatibility tier; this device is ${i}`,`compatibility-layer`)}function E(e){return e?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`native`}function D(e){return E(e)===`native`&&e?.features?.has(`core-features-and-limits`)===!1}var O=`@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}`,k=(e,t,n)=>e.createBindGroup({layout:t.getBindGroupLayout(0),entries:[{binding:0,resource:n}]}),A=Symbol.for(`margoengine.optional.msaa`),j=O+`
@group(0) @binding(0) var source:texture_depth_multisampled_2d;
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {
 let q=vec2i(p.xy);
 return max(max(textureLoad(source,q,0),textureLoad(source,q,1)),max(textureLoad(source,q,2),textureLoad(source,q,3)));
}`;function M(e,t,n,r,i,a=!1){let o=e=>j.replace(/return max[^;]+;/,`return textureLoad(source,q,${e});`),s=(n,r)=>{let a=e.createShaderModule({code:n}),o=e.createRenderPipeline({layout:`auto`,vertex:{module:a,entryPoint:`vertex`},fragment:{module:a,entryPoint:`fragment`,targets:[]},depthStencil:{format:i,depthWriteEnabled:!0,depthCompare:`always`},multisample:r});return{pipeline:o,group:k(e,o,t)}};return{draws:a?[s(o(0).replace(`_multisampled`,``),{count:r})]:r===4?D(e)?[0,1,2,3].map(e=>s(o(e),{count:r,mask:1<<e})):[s(o(`i32(sample)`).replace(`p:vec4f)`,`p:vec4f,@builtin(sample_index) sample:u32)`),{count:r})]:[s(j,{count:r})],descriptor:{colorAttachments:[],depthStencilAttachment:{view:n,depthLoadOp:`clear`,depthClearValue:0,depthStoreOp:`store`,stencilReadOnly:!0}}}}var ee=class{constructor(e,t,n,r=4){if(r!==1&&r!==4)throw RangeError(`Scene samples must be 1 or 4`);this.samples=r,this.device=e,this.resolvedColor=t,this.resolvedDepth=n,this.textures=[],this.pipelines=new Map;try{if(r===1){this.color=t.createView(),this.depth=n.createView();return}for(let r of[t,n])this.textures.push(e.createTexture({size:[r.width,r.height],format:r.format,sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}));this.color=this.textures[0].createView(),this.depth=this.textures[1].createView(),this.resolution={colorAttachments:[{view:this.color,resolveTarget:t.createView(),loadOp:`load`,storeOp:`store`}]},this.finalResolution={colorAttachments:[{...this.resolution.colorAttachments[0],storeOp:`discard`}],depthStencilAttachment:{view:this.depth,depthLoadOp:`load`,depthStoreOp:`discard`,stencilReadOnly:!0}},this.depthSource=this.textures[1].createView({aspect:`depth-only`}),this.resolvedDepthView=n.createView()}catch(e){throw this.dispose(),e}}begin(e){(this.viewContext??={}).view=e.view,Object.assign(this.original??={},{color:e.color,depth:e.depth,format:e.format,descriptor:e.descriptor,owner:te(e)}),e.color=this.color,e.depth=this.depth,e.format=this.resolvedColor.format,this.baseDescriptor!==e.descriptor&&(this.baseDescriptor=e.descriptor,this.descriptor={...e.descriptor,depthStencil:{...e.descriptor.depthStencil,format:this.resolvedDepth.format},multisample:{count:this.samples}}),e.descriptor=this.descriptor,e[A]=this,this.retired=!1}copyDepth(e,t,n,r=this.resolvedDepth.format){let i=this.pipelines.get(n);i||this.pipelines.set(n,i=new Map);let a=i.get(r);a||(this.depthSource??=this.resolvedDepth.createView({aspect:`depth-only`}),i.set(r,a=M(this.device,this.depthSource,t,n,r,this.samples===1))),a.descriptor.depthStencilAttachment.view=t,a.descriptor.depthStencilAttachment.depthLoadOp=this.viewContext?.view?`load`:`clear`;let o=e.beginRenderPass(a.descriptor);this.viewContext&&C(o,this.viewContext);let s=a.draws;for(let e=0;e<s.length;e++)o.setPipeline(s[e].pipeline),o.setBindGroup(0,s[e].group),o.draw(3);o.end()}resolve(e,t=!1,n=!0){if(this.samples!==1){if(n&&this.copyDepth(e,this.resolvedDepthView,1),t){let t=this.viewContext?.view?`store`:`discard`;this.finalResolution.colorAttachments[0].storeOp=t,this.finalResolution.depthStencilAttachment.depthStoreOp=t,this.original&&this.copyDepth(e,this.original.depth,this.original.descriptor.multisample?.count??1,this.original.descriptor.depthStencil.format),this.retired=!0}e.beginRenderPass(t?this.finalResolution:this.resolution).end()}}restore(e){let t=this.original;this.samples===1?(Object.assign(e,{color:t.color,depth:t.depth,format:t.format,descriptor:t.descriptor}),e[A]=t.owner):(this.retired||this.copyDepth(e.encoder,t.depth,t.descriptor.multisample?.count??1,t.descriptor.depthStencil.format),Object.assign(e,{color:t.color,depth:t.depth,format:t.format,descriptor:t.descriptor}),e[A]=t.owner)}present(e){this.resolve(e.encoder,!0),this.restore(e);let t=e.descriptor.multisample?.count??1;if(!this.presentation||this.presentationFormat!==e.format||this.presentationSamples!==t){let n=this.device.createShaderModule({code:O+`@group(0) @binding(0) var source:texture_2d<f32>;@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{return textureLoad(source,vec2i(p.xy),0);}`});this.presentation=this.device.createRenderPipeline({layout:`auto`,vertex:{module:n,entryPoint:`vertex`},fragment:{module:n,entryPoint:`fragment`,targets:[{format:e.format}]},multisample:e.descriptor.multisample}),this.presentationGroup=k(this.device,this.presentation,this.resolvedColor.createView()),this.presentationFormat=e.format,this.presentationSamples=t}let n=this.presentationPass??={colorAttachments:[{view:e.color,loadOp:`clear`,storeOp:`store`}]};n.colorAttachments[0].view=e.color,n.colorAttachments[0].loadOp=w(e,`clear`);let r=e.encoder.beginRenderPass(n);r.setPipeline(this.presentation),r.setBindGroup(0,this.presentationGroup),C(r,e),r.draw(3),r.end()}dispose(){for(let e of this.textures)x(this.device,e);this.textures=[],this.pipelines.clear()}};function te(e){let t=e[A];return t?.color===e.color&&t.depth===e.depth?t:void 0}var ne=/let mapped=pbrNeutral\([\s\S]*?return vec4f\([^\n]+\);/,re=e=>e.replace(ne,`return vec4f(linear,1);`),N=e=>`${e} requires the standard core lighting shader; remove the plugin that replaced core's shader`,ie=(e,t)=>t>1&&D(e)&&e.features.has(`rg11b10ufloat-renderable`)?`rg11b10ufloat`:`rgba16float`,P=(e,t=`1.0.0`,n=import.meta.url)=>r(e,t,n),ae=[`bloom`,`ssao`,`dof`,`tonemap`,`post-processing`],F={hdr:0,display:1,ldr:2},I={count:1},oe=`PostStack order: HDR, at most one display, then LDR; reorder the effects`,se=class e{coreRequirement=n(`1.0.0`,import.meta.url);constructor(e=[]){if(this.name=`post:stack`,this.host={},this.items=[],this.joined=new WeakMap,this.view=[],this.count=0,this.composing=!1,this.used=0,this.owned=!1,this.disposed=!1,this.linear=``,this.slots=[],this.views=[],this.hdr={view:void 0,format:`rgba16float`,multisample:I,hdr:!0},this.ldr={view:void 0,format:`bgra8unorm`,multisample:I,hdr:!1},this.final={view:void 0,format:`bgra8unorm`,multisample:I,hdr:!1},!Array.isArray(e))throw TypeError(`PostStack needs distinct effects`);if(e.some(e=>e?.name===`smaa`)&&e.some(e=>e?.name===`fxaa`))throw TypeError(`PostStack: use SMAA or FXAA, never both`);for(let t of e)this.place(t,this.items.length,!0)}static attach(r,i=[]){t(r,n(`1.0.0`,import.meta.url));let a=P(r);if(a.hasPlugin(`post:stack`))throw g(`attached`,`This scene already has a PostStack; add effects to it with addEffect or PostStack.join`);let o=new e(i);return a.use(o),o}static join(t,n,r){let i=P(t),a=i.plugins.get(`post:stack`);if(a){if(!(a instanceof e))throw TypeError(`post:stack is not a PostStack; remove it first`);return a.addEffect(n,r)}let o=new e;return o.owned=!0,o.place(n,r,!1),i.use(o),o}get effects(){return this.view}get depthTexture(){return this.host.depthTexture}get sceneTexture(){let e=this.color?.format;return e===`rgba16float`||e===`rg11b10ufloat`?this.color:void 0}addEffect(e,t){if(this.disposed)throw g(`disposed`,`This PostStack is disposed; attach a new PostStack`);return this.place(e,t,!1),this}removeEffect(e){if(this.disposed||this.at(e)<0)return!1;this.idle();let t=this.engine?.sceneOf(e);t?.removePlugin(e.name);let n=this.at(e);return n>=0&&this.splice(n,1),t||e.dispose?.(),this.owned&&!this.items.length&&this.dispose(),!0}moveEffect(e,t){if(this.disposed)throw g(`disposed`,`This PostStack is disposed; attach a new PostStack`);let n=this.at(e);if(n<0)throw TypeError(`${e?.name} is not in this PostStack; use addEffect`);this.idle();let r=this.items[n],i=this.kinds();return i.splice(n,1),L(i,r.stage.kind,t),this.splice(n,1),this.splice(t,0,r),this}idle(){if(this.composing)throw g(`state`,`PostStack is composing a frame; change it outside the frame`)}at(e){return this.items.findIndex(t=>t.effect===e)}kinds(){return this.items.map(e=>e.stage.kind)}splice(e,t,n){n?this.items.splice(e,t,n):this.items.splice(e,t),this.view=Object.freeze(this.items.map(e=>e.effect))}place(e,t,n){let r=e?.name;if(!r||this.view.some(e=>e.name===r))throw TypeError(`PostStack needs distinct effects`);if((r===`smaa`||r===`fxaa`)&&this.view.some(e=>e.name===(r===`smaa`?`fxaa`:`smaa`)))throw TypeError(`PostStack: use SMAA or FXAA, never both`);let i=this.engine?.sceneOf(this);this.idle();let a=this.joined.get(e);if(!a){let t=e.joinStack;if(typeof t!=`function`)throw TypeError(`${r} cannot join a PostStack; pass a post effect.`);a=t.call(e,this.host),this.joined.set(e,a)}let o=this.kinds(),s=a.kind,c=t??(n?o.length:o.filter(e=>F[e]<=F[s]).length);L(o,s,c);let l=this.engine?.gpu;l&&s!==`ldr`&&T(l,`PostStack HDR/display effects`,`half-float`),this.splice(c,0,{effect:e,stage:a});try{i?.use(e)}catch(e){throw this.splice(c,1),e}this.joined.delete(e)}setup(e){if(this.disposed||!e.gpu)throw g(this.disposed?`disposed`:`unsupported`,`Attach a new PostStack on WebGPU; see https://margoengine.com/errors#webgpu`);this.requireTier(e.gpu);for(let t of ae)if(e.hasPlugin(t))throw g(`attached`,`Add ${t} to the PostStack instead of attaching it alone`);this.engine=e;for(let t of this.view)e.use(t)}requireTier(e){this.kinds().some(e=>e!==`ldr`)&&T(e,`PostStack HDR/display effects`,`half-float`)}registerPasses(e){e.add({name:`post:stack:capture`,order:-65,execute:e=>{e.backend===`webgpu`&&this.capture(e)}}),e.add({name:`post:stack:compose`,order:30,execute:e=>{e.backend===`webgpu`&&this.compose(e)}})}capture(e){let t=!1,n=this.engine.sceneOf(this);this.count=0;for(let e of this.items)(e.live=this.engine.sceneOf(e.effect)===n)&&(this.count++,t||=e.stage.kind!==`ldr`);if(!this.count)return;if(t&&this.source!==e.shader){let t=re(e.shader);if(t===e.shader)throw g(`unsupported`,N(`PostStack`));this.source=e.shader,this.linear=t}let r=e.descriptor.multisample?.count??4,i=e.descriptor.depthStencil.format,a=t?ie(e.device,r):e.format,o=this.host;if(this.color?.width!==e.width||this.color.height!==e.height||this.color.format!==a||o.depthTexture.format!==i||o.target.samples!==r){this.release();let t=GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING;this.color=e.device.createTexture({size:[e.width,e.height],format:a,usage:t|GPUTextureUsage.COPY_SRC}),this.colorView=this.color.createView(),o.depthTexture=e.device.createTexture({size:[e.width,e.height],format:i,usage:t}),o.target=new ee(e.device,this.color,o.depthTexture,r)}let s=this.final;s.view=e.color,s.format=this.ldr.format=e.format,s.multisample=e.descriptor.multisample??I,o.target.begin(e),t&&(e.shader=this.linear)}compose(e){if(this.count){this.composing=!0;try{this.host.target.resolve(e.encoder,!0);let t=this.colorView,n=0,r=-1,i=0,a=2;this.used=0;let o=this.items;for(let e=0;e<o.length;e++)o[e].live&&(n=e,o[e].stage.kind!==`ldr`&&(r=e));for(let s=0;s<=n;s++){if(!o[s].live)continue;let c=s===n?this.final:s<r?this.hdr:this.ldr;c===this.hdr?(c.view=this.slot(e,i,`rgba16float`),i^=1):c===this.ldr&&(c.view=this.slot(e,a,c.format),a^=1),t=o[s].stage.render(e,t,c)||c.view}for(let e=0;e<4;e++)this.slots[e]&&!(this.used&1<<e)&&(this.slots[e].destroy(),this.slots[e]=void 0)}finally{this.composing=!1,this.host.target.restore(e)}}}slot(e,t,n){this.used|=1<<t;let r=this.slots[t];if(r?.width!==e.width||r.height!==e.height||r.format!==n){r?.destroy();let i=this.slots[t]=e.device.createTexture({size:[e.width,e.height],format:n,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});this.views[t]=i.createView()}return this.views[t]}release(){this.host.target?.dispose(),this.color?.destroy(),this.host.depthTexture?.destroy();for(let e of this.slots)e?.destroy();this.slots=[],this.views=[],this.host.target=this.host.depthTexture=this.color=this.colorView=void 0}onDeviceRestored(){if(!this.disposed){this.release();try{this.engine?.gpu&&this.requireTier(this.engine.gpu)}catch(e){throw this.dispose(),e}}}dispose(){if(this.disposed)return;this.disposed=!0;let e=this.engine;this.engine=void 0,e?.sceneOf(this)?.removePlugin(this.name);for(let t of this.view)e?.sceneOf(t)?.removePlugin(t.name);this.release()}[Symbol.dispose??Symbol()](){this.dispose()}};function L(e,t,n){if(!Number.isInteger(n)||n<0||n>e.length)throw RangeError(`PostStack index ${n}; pass 0 to ${e.length}`);let r=e[n-1],i=e[n];if(r&&F[r]>F[t]||i&&F[i]<F[t]||t===`display`&&e.includes(`display`))throw RangeError(oe)}var ce=(e,t=`1.0.0`,n=import.meta.url)=>r(e,t,n),R=`${p}
struct Paint {rect:vec4i,parameters:vec4f}
@group(0) @binding(0) var<uniform> paint:Paint;
@group(0) @binding(1) var image:texture_2d<f32>;
fn coord(p:vec2i)->vec2i {return clamp(p,paint.rect.xy,paint.rect.xy+paint.rect.zw-1);}
fn read(p:vec2i)->vec3f {return textureLoad(image,coord(p),0).rgb;}
`,le=`${R}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);
 let nw=read(p+vec2i(-1,-1));let n=read(p+vec2i(0,-1));let ne=read(p+vec2i(1,-1));
 let w=read(p+vec2i(-1,0));let e=read(p+vec2i(1,0));
 let sw=read(p+vec2i(-1,1));let s=read(p+vec2i(0,1));let se=read(p+vec2i(1,1));
 let dx=(ne+2.0*e+se-nw-2.0*w-sw)*0.125;
 let dy=(sw+2.0*s+se-nw-2.0*n-ne)*0.125;
 return vec4f(dot(dx,dx),dot(dx,dy),dot(dy,dy),0);
}`,ue=`${R}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);
 return vec4f((read(p-vec2i(2,0))+4.0*read(p-vec2i(1,0))+6.0*read(p)+4.0*read(p+vec2i(1,0))+read(p+vec2i(2,0)))/16.0,0);
}`,de=`${R}
@group(0) @binding(2) var tensor:texture_2d<f32>;
fn tensorAt(p:vec2i)->vec3f {return textureLoad(tensor,coord(p),0).rgb;}
@fragment fn fragment(@builtin(position) at:vec4f)->@location(0) vec4f {
 let p=vec2i(at.xy);let centre=textureLoad(image,p,0);
 if(paint.parameters.y==0.0){return centre;}
 let t=(tensorAt(p-vec2i(0,2))+4.0*tensorAt(p-vec2i(0,1))+6.0*tensorAt(p)+4.0*tensorAt(p+vec2i(0,1))+tensorAt(p+vec2i(0,2)))/16.0;
 let trace=t.x+t.z;let gap=length(vec2f(t.x-t.z,2.0*t.y));
 var angle=0.0;var adaptation=0.0;
 if(trace>1e-8){angle=0.5*atan2(2.0*t.y,t.x-t.z)+1.57079632679;adaptation=clamp(gap/trace,0.0,1.0)*paint.parameters.z;}
 let tangent=vec2f(cos(angle),sin(angle));let normal=vec2f(-tangent.y,tangent.x);
 let radius=paint.parameters.x;let a=radius*(1.0+adaptation);let b=radius/(1.0+adaptation);
 let bound=i32(ceil(a));let zeta=2.0/radius;let eta=(zeta+0.83146961230)/0.30865828382;
 let dirs=array<vec2f,8>(vec2f(1,0),vec2f(0.70710678118,0.70710678118),vec2f(0,1),vec2f(-0.70710678118,0.70710678118),vec2f(-1,0),vec2f(-0.70710678118,-0.70710678118),vec2f(0,-1),vec2f(0.70710678118,-0.70710678118));
 var sums:array<vec3f,8>;var squares:array<vec3f,8>;var weights:array<f32,8>;
 for(var y=-bound;y<=bound;y++){for(var x=-bound;x<=bound;x++){
  let delta=vec2f(f32(x),f32(y));let q=vec2f(dot(delta,tangent)/a,dot(delta,normal)/b);let r2=dot(q,q);
  if(r2>1.0){continue;}
  var w:array<f32,8>;var total=0.0;
  for(var k=0;k<8;k++){let d=dirs[k];let across=dot(q,vec2f(-d.y,d.x));let value=max(0.0,zeta+dot(q,d)-eta*across*across);w[k]=value*value;total+=w[k];}
  let distance=sqrt(r2);let edge=max(0.0,1.0-distance);let radial=exp(-3.125*r2)*edge*edge*edge*edge*(1.0+4.0*distance)/max(total,1e-20);let colour=read(p+vec2i(x,y));
  for(var k=0;k<8;k++){let weight=w[k]*radial;sums[k]+=colour*weight;squares[k]+=colour*colour*weight;weights[k]+=weight;}
 }}
 var result=vec3f(0);var total=0.0;
 for(var k=0;k<8;k++){
  let mean=sums[k]/weights[k];let variance=max(squares[k]/weights[k]-mean*mean,vec3f(0));
  let preference=1.0/(1.0+pow(100.0*sqrt(dot(variance,vec3f(1))),paint.parameters.w));
  result+=mean*preference;total+=preference;
 }
 return vec4f(mix(centre.rgb,clamp(result/total,vec3f(0),vec3f(1)),paint.parameters.y),centre.a);
}`,fe=class e{coreRequirement=n(`1.0.0`,import.meta.url);#e;#t;#n;#r;#i;#a;#o;#s;#c;#l;#u;#d;constructor(e={}){this.options=e,this.name=`anisotropic-painterly`,this.#n=!1,this.#r=!1,this.#s=new Map,this.#c=new ArrayBuffer(32),this.#l=new Int32Array(this.#c,0,4),this.#u=new Float32Array(this.#c,16,4),this.#d=new f(()=>({uniform:this.#e.gpu.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})}),e=>{e.uniform.destroy(),e.first?.destroy(),e.second?.destroy()}),this.#p()}static attach(r,i={}){t(r,n(`1.0.0`,import.meta.url));let a=new e(i);if(!ce(r).gpu)throw o(`unsupported`,`Anisotropic paint needs a GPU device; use WebGPU or the full compatibility layer`);return a.#t=se.join(r,a),a}get enabled(){return this.options.enabled??!0}set enabled(e){if(typeof e!=`boolean`)throw s(`Invalid anisotropic enabled; pass true or false`,`arguments`);this.options.enabled=e}joinStack(){if(this.#f(),this.#n||this.#e)throw o(`attached`,`Anisotropic paint is attached; create a new effect`,`state`);return this.#n=!0,{kind:`ldr`,render:(e,t,n)=>this.#h(e,t,n)}}setup(e){if(this.#f(),this.#e)throw o(`attached`,`Anisotropic paint is attached; create a new effect`,`state`);if(!e.gpu)throw o(`unsupported`,`Anisotropic paint needs a GPU device; use WebGPU or the full compatibility layer`);if(!this.#n)throw o(`state`,`Anisotropic paint needs a stack; use attach or PostStack`);this.#p(),this.#e=e}#f(){if(this.#r)throw o(`disposed`,`Anisotropic paint is disposed; create a new effect`)}#p(){let e=this.options;if(!e||typeof e!=`object`||Array.isArray(e))throw s(`Invalid anisotropic options; pass an options object`,`arguments`);if(e.radius!==void 0&&(!Number.isInteger(e.radius)||e.radius<1||e.radius>8))throw s(`Invalid anisotropic radius; pass an integer in 1..8`,`arguments`);for(let[t,n,r,i]of[[`strength`,e.strength,0,1],[`anisotropy`,e.anisotropy,0,1],[`sharpness`,e.sharpness,1,8]])if(n!==void 0&&(!Number.isFinite(n)||n<r||n>i))throw s(`Invalid anisotropic ${t}; pass a finite number in ${r}..${i}`,`arguments`);if(e.enabled!==void 0&&typeof e.enabled!=`boolean`)throw s(`Invalid anisotropic enabled; pass true or false`,`arguments`)}#m(e,t){let n=e.device;if(!this.#i){let e=[{binding:0,visibility:GPUShaderStage.FRAGMENT,buffer:{type:`uniform`}},{binding:1,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:`unfilterable-float`}}],t=n.createPipelineLayout({bindGroupLayouts:[n.createBindGroupLayout({entries:e})]});this.#i=h(n,le,`rgba32float`,{layout:t}),this.#a=h(n,ue,`rgba32float`,{layout:t}),this.#o=n.createBindGroupLayout({entries:[...e,{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:`unfilterable-float`}}]})}let r=t.format+`:`+(t.multisample?.count??1),i=this.#s.get(r);return i||(i=h(n,de,t.format,{layout:n.createPipelineLayout({bindGroupLayouts:[this.#o]}),multisample:t.multisample}),this.#s.set(r,i)),i}#h(e,t,n){if(this.#f(),this.#p(),!this.#e)throw o(`state`,`Anisotropic paint needs a live stack; attach before drawing`);if(e.width*e.height*32>536870912)throw s(`Anisotropic intermediate textures exceed 512 MiB; reduce render resolution`,`arguments`);let r=this.#m(e,n),i=this.#d.get(e);if(i.width!==e.width||i.height!==e.height){i.first?.destroy(),i.second?.destroy();let t=()=>e.device.createTexture({size:[e.width,e.height],format:`rgba32float`,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});i.first=t(),i.second=t(),i.firstView=i.first.createView(),i.secondView=i.second.createView(),i.width=e.width,i.height=e.height,i.input=void 0}i.input!==t&&(i.tensorGroup=m(e.device,this.#i,[{buffer:i.uniform},t]),i.blurGroup=m(e.device,this.#a,[{buffer:i.uniform},i.firstView]),i.filterGroup=m(e.device,r,[{buffer:i.uniform},t,i.secondView]),i.input=t),this.#l.set(c(e)??[0,0,e.width,e.height]),this.#u.set([this.options.radius??3,this.enabled?this.options.strength??1:0,this.options.anisotropy??1,this.options.sharpness??8]),e.device.queue.writeBuffer(i.uniform,0,this.#c),this.#u[1]>0&&(this.#g(e,this.#i,i.tensorGroup,i.firstView),this.#g(e,this.#a,i.blurGroup,i.secondView)),this.#g(e,r,i.filterGroup,n.view)}#g(e,t,n,r){let i=e.encoder.beginRenderPass({colorAttachments:[{view:r,loadOp:u(e,`clear`),storeOp:`store`}]});i.setPipeline(t),i.setBindGroup(0,n),l(i,e),i.draw(3),i.end()}onPreUpdate(e){e>0&&this.#d.prune()}#_(){this.#d.clear(),this.#s.clear(),this.#i=void 0,this.#a=void 0,this.#o=void 0}onDeviceRestored(e){this.#f(),this.#_(),this.#e=void 0,this.setup(e)}dispose(){if(this.#r)return;this.#r=!0;let e=this.#e;this.#e=void 0,e?.sceneOf(this)?.removePlugin(this.name),this.#_(),this.#t?.removeEffect(this),this.#t=void 0}[Symbol.dispose](){this.dispose()}},z=(e,t=0,n=1)=>Math.max(t,Math.min(n,e)),B=(e,t,n)=>e.map((e,r)=>e+(t[r]-e)*n),V=e=>Math.exp(-e*e),H=e=>-7+12*V((e-12)/15)-13*V((e+25)/18)+23*V((e+62)/23)-19*V((e+100)/29)+17*V((e+147)/34)+1.9*Math.sin(e*.118)+.58*Math.sin(e*.407);function U(e){return 3.75+3.25*V((e-9)/27)+4.7*V((e+61)/30)+.66*Math.sin(e*.151)+.47*Math.sin(e*.302)}function W(e,t){let n=Math.max(0,H(t)-e);return U(t)+Math.min(6.4,n*.13)+1.55*Math.sin(t*.044+e*.071)*Math.min(1,n*.24)+.49*Math.sin(t*.33-e*.27)*Math.min(1,n*.2)}function pe(e,t){let n=H(t)-e;return B(B(B([.242,.285,.174],[.58,.457,.268],z(.5+.24*Math.sin(e*.13+t*.116)+.18*Math.sin(e*.27-t*.16))),[.677,.54,.289],Math.exp(-(((n-2.65-.62*Math.sin(t*.14))/.95)**2))*.76),[.687,.584,.328],z((1.1-n)/1.2)*.51)}function G(e){let t=Math.hypot(...e);return e.map(e=>e/t)}function K(e,t){return[e[1]*t[2]-e[2]*t[1],e[2]*t[0]-e[0]*t[2],e[0]*t[1]-e[1]*t[0]]}function q(e,t){return e.map((e,n)=>e-t[n])}function J(e=5041){let t=e;return()=>(t=Math.imul(t,1664525)+1013904223>>>0,t*23283064365386963e-26)}var Y=Math.PI*2;function me(){let e=[],t=[];function n(n,r,i,{flex:a=[],normals:o}={}){let s=e.length/11,c=o??n.map(()=>G(K(q(n[1],n[0]),q(n[2],n[0]))));for(let[o,l]of n.entries())e.push(...l,...c[o],...Array.isArray(r[0])?r[o]:r,i,a[o]??0),o>1&&t.push(s,s+o-1,s+o)}return{face:n,finish:()=>({vertices:Float32Array.from(e),indices:Uint32Array.from(t)})}}function he(e){let t=[0,.18,.52,1.1,2,3.4,4.9,6.5,8.2,10.2,12.5,15.8,20,26,34,44,58,75,94,119,153,200,260],n=-251,r=(e,t)=>[H(e)-t,W(H(e)-t,e),e],i=[0,.075,.14,.27,.32,.48,.65,.73,.88,.94,1],a=[[.246,.245,.228],[.404,.367,.296],[.544,.451,.355],[.421,.382,.351],[.592,.491,.371],[.444,.368,.306],[.657,.555,.433],[.453,.419,.338],[.643,.555,.406],[.552,.487,.335]],o=(e,t)=>{if(t===1)return r(e,0);let n=H(e),i=U(e),a=.36*Math.sin(e*.54+t*8)+.11*Math.sin(e*1.72+t*17);return[n+(1.18*(1-t)+a*(1-t*.63)+.44*Math.sin(t*40)),i*t-.32+(1-t)*.26*Math.sin(e*.39),e]};for(let s=0;s<244;s++){let c=n+279*s/244,l=n+279*(s+1)/244;for(let n=0;n<t.length-1;n++){let i=t[n],a=t[n+1],o=[r(l,i),r(c,i),r(c,a),r(l,a)];e.face(o,o.map(([e,,t])=>pe(e,t)),2)}for(let[t,n]of i.slice(0,-1).entries()){let r=i[t+1],s=[o(l,n),o(c,n),o(c,r),o(l,r)],u=.12+.15*Math.sin(c*.31)+.14*Math.sin(c*1.34),d=B(a[t],[.896,.674,.41],z(u));e.face(s,d,3)}}}function ge(e){e.face([[-1540,-160,-805],[1540,-160,-805],[1540,660,-805],[-1540,660,-805]],[.67,.7,.76],0);let t=[34,25,17,10,5,0,-5,-10,-16,-23,-32,-42,-55,-70,-88,-113,-145,-184,-226,-272,-338,-416,-506,-623,-791],n=[-760,-411,-250,-140,-90,-52,-29,-13,-4,3,9,16,24,33,45,64,94,141,230,405,760];for(let r=0;r<t.length-1;r++){let i=t[r],a=t[r+1];for(let t=0;t<n.length-1;t++){let r=n[t],o=n[t+1];e.face([[r,0,i],[o,0,i],[o,0,a],[r,0,a]],[.295,.411,.465],1)}}}function _e(e,t,n,r,i,a){let o=t*(1+i);return[e[0]+o*Math.cos(n)*Math.cos(r)*a[0],e[1]+o*Math.sin(r)*a[1],e[2]+o*Math.sin(n)*Math.cos(r)*a[2]]}function X(e,t,n,r,i,a,o,s=0,c=9,l=6){let u=(e,t)=>.18*Math.cos(o+e*2)*Math.sin(t*3)+.09*Math.cos(e*3-t*4+o),d=(e,i)=>{let a=Y*e/c,o=Math.PI*(i/l-.5);return _e(t,n,a,o,u(a,o),r)},f=e=>Math.max(0,s+s*(e-3)/l*.28);for(let t=0;t<l;t++)for(let n=0;n<c;n++){let r=d(n,t),s=d(n+1,t),c=d(n+1,t+1),u=d(n,t+1),p=B(i,[.76,.67,.32],z(.07+.1*Math.sin(o+n*.92+t*.84)));t===0?e.face([r,c,u],p,a,{flex:[f(t),f(t+1),f(t+1)]}):t===l-1?e.face([c,s,r],p,a,{flex:[f(t+1),f(t),f(t)]}):e.face([r,u,c,s],p,a,{flex:[f(t),f(t+1),f(t+1),f(t)]})}}function Z(e,t,n,r,i,a,o=8,s=0,c=0){let l=G(q(n,t)),u=G(K(l,Math.abs(l[1])>.84?[1,0,0]:[0,1,0])),d=K(l,u),f=(e,t,n)=>e.map((e,r)=>e+t*(u[r]*Math.cos(n*Y/o)+d[r]*Math.sin(n*Y/o)));for(let l=0;l<o;l++){let o=B(a,[.63,.461,.272],.08+.075*Math.sin(l));e.face([f(t,r,l),f(t,r,l+1),f(n,i,l+1),f(n,i,l)],o,4,{flex:[s,s,c,c]})}}function Q(e,t,n,r,i){let a=W(t,n)-.11,o=[t,a,n],s=(e,i,o)=>[t+e*r,a+i*r,n+o*r],c=[o,s(-.16,.89,.007),s(-.39,1.85,-.14),s(-.66,2.68,-.31),s(-1.02,3.48,-.54),s(-1.54,4.31,-.72)],l=[.29,.188,.158,.13,.087,.038],u=[.266,.225,.18],d=J(i);for(let t=1;t<c.length;t++)Z(e,c[t-1],c[t],l[t-1]*r,l[t]*r,u,10,(t-1)**2*.011*r,t**2*.011*r);for(let[t,n,a,o]of[[2,[-1.81,2.34,.38],[-2.63,3.3,.48],.85],[2,[1.22,2.39,-.16],[1.39,3.23,-.31],.57],[3,[-.8,3.76,.92],[-1.24,4.06,1.21],.83],[3,[-1.68,3.21,-1.53],[-2.53,3.87,-1.78],.91],[4,[-1.38,3.86,.39],[-2.05,4.62,.18],.83],[4,[-.76,4.07,-.56],[-.52,4.65,-.89],.68],[5,[-2.25,4.4,-.88],[-2.76,4.68,-1.22],.68]]){let l=s(...n),f=s(...a);Z(e,c[t],l,.105*r,.057*r,u,7,.1*r,.2*r),Z(e,l,f,.057*r,.013*r,u,7,.2*r,.32*r);for(let n=0;n<7;n++){let a=f[0]+(d()-.5)*o*2.8*r,s=f[2]+(d()-.5)*o*1.9*r,c=f[1]+d()*o*.87*r,l=B([.169,.223,.159],[.483,.479,.251],.22+d()*.53);X(e,[a,c,s],o*(.43+d()*.48)*r,[1.38,.54,.9],l,5,i+n+t*.47,.29*r,8,5)}}}function ve(e){Q(e,1.87,4.8,1.06,10911),Q(e,-3.81,8.9,.66,11901),Q(e,H(-53.2)-5.3,-53.2,1.13,19513),Q(e,H(-54.5)-9.3,-54.5,.88,5113);let t=J(490789);for(let n=0;n<2510;n++){let r=-84+Math.sqrt(t())*104,i=.18+t()*13,a=H(r)-i;if(i>2.2&&i<4.1&&t()>.2)continue;let o=W(a,r)-.07,s=.055+t()*.26,c=.01+t()*.042,l=B([.301,.34,.161],[.76,.591,.31],t()),u=.05+t()*.07;e.face([[a-c,o,r-.028],[a+c,o,r+.022],[a-u,o+s,r-.011]],l,6,{flex:[0,0,.1+s*.55]}),n%3==0&&e.face([[a-.025,o,r-c],[a+.024,o,r+c],[a+u*.5,o+s*.71,r]],l,6,{flex:[0,0,.07+s*.5]})}for(let n=0;n<94;n++){let r=-169+t()*196,i=H(r),a=.27+t()*1.15;X(e,[i+.2+t()*2.02,-.195+t()*.54,r],a,[1.32,.68,1.11],[.396,.382,.341],3,n)}for(let n=0;n<27;n++){let r=-27-t()*52,i=H(r)+5+t()*13,a=.5+t()*.96;X(e,[i,-.26+a*.12,r],a,[1.2,.67,1.46],[.352,.371,.369],3,47+n)}for(let[t,n,r,i]of[[32,.4,-104,6],[36,.38,-110,5.3],[32,.4,-119,7.1],[46,.56,-140,8.4],[46,.14,-159,8.5],[50,.9,-174,8.2],[53,.54,-218,12.2],[119,.94,-286,19.5],[147,.91,-306,23.1],[118,1,-330,20],[114,.45,-340,18.6]])X(e,[t,n,r],i,[1.53,.28,.87],[.342,.348,.443],3,t+r,0,13,8);let n=H(-49)-5.75,r=W(n,-49),i=[[n,r,-49],[n+3.2,r,-49],[n+3.2,r,-51.4],[n,r,-51.4]],a=i.map(e=>[e[0],e[1]+1.84,e[2]]);for(let t=0;t<4;t++)e.face([i[t],i[(t+1)%4],a[(t+1)%4],a[t]],[.582,.467,.325],7);let o=[n+1.6,r+2.71,-48.79],s=[o[0],o[1],-51.58];e.face([[n-.18,r+1.75,-48.79],o,s,[n-.18,r+1.75,-51.58]],[.361,.324,.358],7),e.face([o,[n+3.38,r+1.75,-48.79],[n+3.38,r+1.75,-51.58],s],[.338,.345,.395],7),e.face([a[0],a[1],[o[0],o[1],-49]],[.603,.43,.299],7),e.face([[n+1.65,r+.03,-48.985],[n+2.35,r+.03,-48.985],[n+2.35,r+1.36,-48.985],[n+1.65,r+1.36,-48.985]],[.259,.246,.232],7)}function ye(){let e=me();return ge(e),he(e),ve(e),e.finish()}var be=`
struct Camera {
  matrix: mat4x4f,
  time: vec4f,
}
@group(0) @binding(0) var<uniform> camera:Camera;

struct Field {
  @builtin(position) clip:vec4f,
  @location(0) p:vec3f,
  @location(1) n:vec3f,
  @location(2) tint:vec3f,
  @location(3) @interpolate(flat) tag:u32,
}

fn strand(z:f32)->f32 {
  let a=(z-12.0)/15.0;
  let b=(z+25.0)/18.0;
  let c=(z+62.0)/23.0;
  let d=(z+100.0)/29.0;
  let e=(z+147.0)/34.0;
  return -7.0+12.0*exp(-a*a)-13.0*exp(-b*b)+23.0*exp(-c*c)-19.0*exp(-d*d)+17.0*exp(-e*e)
    +1.9*sin(z*0.118)+0.58*sin(z*0.407);
}

@vertex fn vertex(@location(0) p:vec3f,@location(1) n:vec3f,@location(2) colour:vec4f,
  @location(3) flex:f32)->Field {
  var point=p;
  let t=camera.time.x;
  let tag=u32(colour.w);
  if(tag==1u){
    let swell=sin(p.x*0.188+p.z*0.092-t*0.85)+0.42*sin(p.z*0.38-p.x*0.07+t*1.06);
    point.y+=swell*0.14;
  }
  if(flex>0.0){
    let sw=sin(t*1.42+p.z*0.23+p.x*0.13)+0.34*sin(t*3.17+p.x*0.48);
    point.x-=sw*flex*0.53;
    point.z+=0.25*sw*flex;
  }
  return Field(camera.matrix*vec4f(point,1),point,n,colour.xyz,tag);
}

fn hash(p:vec2f)->f32 {
  let a=fract(vec3f(p.x,p.y,p.x)*vec3f(0.1031,0.1030,0.0973));
  let b=a+dot(a,a.yzx+33.33);
  return fract((b.x+b.y)*b.z);
}
fn noise(p:vec2f)->f32 {
  let i=floor(p);
  let f=fract(p);
  let m=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2f(1,0)),m.x),mix(hash(i+vec2f(0,1)),hash(i+vec2f(1,1)),m.x),m.y);
}
fn pigment(p:vec2f)->f32 {
  return noise(p)*0.58+noise(p*2.03+3.12)*0.27+noise(p*4.17-4.51)*0.15;
}


fn brush(p:vec2f)->f32 {
  let jitter=noise(p*0.27)*0.76;
  let q=p+vec2f(jitter,jitter*0.4);
  let id=floor(q);
  let b=hash(id);
  let local=(fract(q)-vec2f(0.52,0.46))*vec2f(2.1,2.65);
  let mark=1.0-smoothstep(0.46,1.05,dot(local,local)+noise(p*vec2f(11.0,44.0))*0.25);
  return (b-0.49)*mark;
}
fn sky(position:vec3f,t:f32)->vec3f {
  let x=position.x/805.0;
  let y=max(0.0,position.y/805.0);
  let light=exp(-2.9*length((vec2f(x,y)-vec2f(0.25,0.092))*vec2f(0.92,1.77)));
  let gradient=pow(clamp(y*1.95,0.0,1.0),0.61);
  var base=mix(vec3f(0.803,0.667,0.602),vec3f(0.425,0.539,0.631),gradient);
  base=mix(base,vec3f(0.991,0.788,0.556),light*0.66);
  let p=vec2f(x*5.9-t*0.016,(y+x*0.041)*24.8);
  let streak=pigment(p+vec2f(2.4,1.3));
  let wisps=pigment(p*1.71+vec2f(6.0,-2.7));
  let mask=smoothstep(0.49,0.70,streak*0.82+wisps*0.18)*smoothstep(0.012,0.063,y)
    *(1.0-smoothstep(0.48,0.7,y));
  let cloud=mix(vec3f(0.471,0.473,0.590),vec3f(0.996,0.720,0.570),
    smoothstep(0.11,0.83,light*0.73+streak*0.62));
  base=mix(base,cloud,mask*0.91);
  base+=brush(p*vec2f(2.2,3.06)+t*0.031)*mask*vec3f(0.125,0.102,0.083);
  let sunDist=length(vec2f(x,y)-vec2f(0.249,0.091));
  let orb=1.0-smoothstep(0.0081,0.0097,sunDist);
  return mix(base,vec3f(1.0,0.880,0.679),orb*(1.0-mask*0.55));
}

fn water(p:vec3f,t:f32)->vec3f {
  let d=length(p.xz-vec2f(12.1,23.8));
  let coast=clamp(p.x-strand(p.z),0.0,900.0);
  let ripple=sin(p.z*1.32+p.x*0.095+t*1.38+noise(vec2f(p.x*0.17,p.z*0.243))*4.4);
  let swell=sin(p.z*0.56+p.x*0.11+t*0.90)+sin(p.x*0.23-p.z*0.46-t*0.64)*0.34;
  let streak=noise(vec2f(p.x*0.18+p.z*0.033,p.z*0.44+t*0.32));
  let reach=exp(-coast*0.058);
  let hue=mix(vec3f(0.266,0.402,0.479),vec3f(0.399,0.504,0.486),reach*0.84);
  var color=hue+(ripple*0.013+swell*0.014+(streak-0.5)*0.132)*vec3f(0.69,0.98,1.0);
  let direction=(p.x-12.1)/max(1.0,23.8-p.z);
  let spread=0.095+0.065*exp(-d*0.018);
  let glow=exp(-abs(direction-0.29)/spread)*smoothstep(22.0,94.0,d);
  let glitter=smoothstep(0.41,0.93,streak*0.8+ripple*0.21+swell*0.045);
  color=mix(color,vec3f(0.970,0.742,0.489),glow*(0.13+glitter*0.69));
  let shoreFlow=0.65*sin(p.z*0.079)+0.36*sin(p.z*0.38);
  let limit=1.0-smoothstep(3.0,10.5,coast);
  let edge=1.0-smoothstep(0.12,2.9,coast);
  let wrap=sin(coast*1.17+shoreFlow-t*1.32+(1.0-streak)*0.62);
  let surf=smoothstep(0.61,0.99,wrap)*(0.38+streak*0.63)*limit*0.87+edge*streak*0.34;

  color=mix(color,vec3f(0.823,0.805,0.692),clamp(surf,0.0,0.87));
  return mix(color,vec3f(0.692,0.620,0.614),1.0-exp(-d*0.00225));
}

@fragment fn fragment(input:Field)->@location(0) vec4f {
  let t=camera.time.x;
  let p=input.p;
  if(input.tag==0u){return vec4f(sky(p,t),1);}
  if(input.tag==1u){return vec4f(water(p,t),1);}
  let n=normalize(input.n);
  let key=normalize(vec3f(0.71,0.43,-0.57));
  let diffuse=max(0.0,dot(n,key));
  let shadows=vec3f(0.736,0.768,0.895);
  let sunlight=vec3f(1.32,1.17,0.90);
  var color=input.tint*mix(shadows,sunlight,diffuse);
  let texture=0.66*pigment(p.xz*vec2f(0.92,1.84)+p.y*0.73)
    +0.34*noise(vec2f(p.z*2.56,p.y*2.08+p.x*0.93));
  
  color+= (texture-0.47)*vec3f(0.198,0.155,0.106);
  if(input.tag==2u){
    let motion=vec2f(p.x*1.57+p.z*0.29,p.z*3.33+p.x*0.42);
    let marks=brush(motion)*0.75+brush(motion*1.77+vec2f(0.42,0.26))*0.25;
    let under= pigment(vec2f(p.x*0.38+p.z*0.073,p.z*0.52));
    color=mix(color,vec3f(0.66,0.40,0.29),smoothstep(0.49,0.85,under)*0.33);
    color+=marks*vec3f(0.202,0.186,0.092);
  }
  if(input.tag==3u){
    let layering=sin(p.y*4.76+p.z*0.053+0.45*sin(p.z*0.51));
    color*=0.96+0.093*layering;
    color=mix(color,vec3f(0.342,0.396,0.357),0.18*(1.0-smoothstep(0.0,1.4,p.y)));
  }
  if(input.tag==5u||input.tag==6u){
    let back=max(0.0,dot(-n,key));
    color+=back*vec3f(0.057,0.049,0.014);
  }
  let r=length(p.xz-vec2f(12.1,23.8));
  let aerial=1.0-exp(-r*0.00258);
  let haze=vec3f(0.588,0.580,0.648);
  color=mix(color,haze,aerial*0.89);
  return vec4f(clamp(color,vec3f(0.0),vec3f(1.0)),1);
}
`;function xe(e,t){let n,r,i,a,o,s,c,l=new Float32Array(20);function u(){r?.destroy(),i?.destroy(),a?.destroy(),r=i=a=o=s=c=void 0}function d(t){n=t.gpu,r=n.createBuffer({size:e.vertices.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),i=n.createBuffer({size:e.indices.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST}),a=n.createBuffer({size:l.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),n.queue.writeBuffer(r,0,e.vertices),n.queue.writeBuffer(i,0,e.indices)}return{name:`painted-headland`,setup:d,onDeviceRestored(e){u(),d(e)},dispose:u,registerPasses(u){u.add({name:`draw-headland`,order:1,joins:!0,execute(u){if(!s||c!==u.format){let e=n.createShaderModule({code:be});c=u.format,s=n.createRenderPipeline({layout:`auto`,vertex:{module:e,entryPoint:`vertex`,buffers:[{arrayStride:44,attributes:[{shaderLocation:0,format:`float32x3`,offset:0},{shaderLocation:1,format:`float32x3`,offset:12},{shaderLocation:2,format:`float32x4`,offset:24},{shaderLocation:3,format:`float32`,offset:40}]}]},fragment:{module:e,entryPoint:`fragment`,targets:[{format:c}]},depthStencil:{...u.descriptor.depthStencil}}),o=n.createBindGroup({layout:s.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:a}}]})}l.set(u.camera.matrix),l[16]=t(),n.queue.writeBuffer(a,0,l);let d={view:u.color,loadOp:`load`,storeOp:`store`},f={view:u.depth,depthLoadOp:`load`,depthStoreOp:`store`};u.attach?.(d,f,u.last);let p=u.encoder.beginRenderPass({colorAttachments:[d],depthStencilAttachment:f});p.setPipeline(s),p.setBindGroup(0,o),p.setVertexBuffer(0,r),p.setIndexBuffer(i,`uint32`),p.drawIndexed(e.indices.length),p.end()}})}}}var $={fine:{radius:3,anisotropy:.77,strength:.9,note:`Fine strokes preserve the edges of grass and stone.`},broad:{radius:7,anisotropy:.95,strength:1,note:`Broad strokes gather the cliffs and water into larger patches of colour.`},plain:{radius:3,anisotropy:0,strength:0,note:`The same moving landscape with its brush filter off.`}},Se=()=>new Promise(e=>requestAnimationFrame(e));async function Ce({engine:e,land:t,canvas:n,notice:r,status:i,size:a,signal:o,fail:s}){let c=document.querySelector(`fieldset`),l=document.querySelector(`#motion`),u=document.querySelector(`#detail`),d=matchMedia(`(max-width:650px)`),f=matchMedia(`(prefers-reduced-motion: reduce)`),p=e.gpu.adapterInfo?.vendor===`margo-webgl2`,m=`fine`,h=f.matches,g=1.4,_=0,v=0,y=!1,b=0,x=!1,S=!1,C=!0;document.querySelector(`#renderer`).textContent=p?`Margo WebGL2`:`Margo WebGPU`,n.dataset.renderer=p?`compatibility`:`webgpu`,n.dataset.triangles=String(t.indices.length/3),e.scene.background=`#bd9e93`,e.use(xe(t,()=>g));let w=fe.attach(e,{radius:3,strength:$.fine.strength,anisotropy:$.fine.anisotropy,sharpness:7});function T(){let t=e.camera;t.position=d.matches?[12.22,12.29,23.8]:[12,12.29,23.8],t.target=d.matches?[-9.25,2.82,-75]:[-11.03,3.12,-75],t.fov=d.matches?52:44}function E(){l.textContent=h?`Play motion`:`Pause motion`,n.dataset.motion=h?`paused`:`playing`,u.textContent=$[m].note}async function D(t){if(v=0,o.aborted||y)return;y=!0;let r=x;x=!1,S=!1,!h&&_&&(g+=Math.min((t-_)*.001,.075)),_=h?0:t;try{let t=m;if(e.render(0),await e.gpu.queue.onSubmittedWorkDone(),o.aborted)return;if(n.dataset.time=g.toFixed(4),n.dataset.brush=t,n.dataset.frame=String(++b),r){if(await Se(),o.aborted)return;performance.mark(`painting-input-rendered`),C&&(C=!1,performance.mark(`painting-first-input-rendered`))}}catch(e){s(e)}finally{y=!1,(!h||S)&&O()}}function O(){o.aborted||v||y||(v=requestAnimationFrame(D))}function k(e){x||=e.isTrusted,S=!0,O()}if(T(),E(),e.render(0),await e.gpu.queue.onSubmittedWorkDone(),o.throwIfAborted(),n.dataset.brush=m,n.dataset.time=g.toFixed(4),n.dataset.frame=String(++b),i.ready()){r.hidden=!0;for(let e of document.querySelectorAll(`button,input`))e.disabled=!1;performance.mark(`painting-ready`)}c.addEventListener(`change`,e=>{let t=$[e.target.value];t&&(m=e.target.value,w.options.radius=t.radius,w.options.anisotropy=t.anisotropy,w.options.strength=t.strength,E(),k(e))},{signal:o}),l.addEventListener(`click`,e=>{h=!h,_=0,E(),k(e)},{signal:o}),f.addEventListener(`change`,()=>{f.matches&&(h=!0,_=0,E())},{signal:o});let A=new ResizeObserver(()=>{a()&&(T(),S=!0,O())});A.observe(n),o.addEventListener(`abort`,()=>{cancelAnimationFrame(v),A.disconnect()},{once:!0}),h||O()}export{ye as prepareLand,Ce as show};