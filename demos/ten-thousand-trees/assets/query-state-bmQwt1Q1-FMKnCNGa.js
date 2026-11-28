import{M as e}from"./index-Cqd1G9Ju.js";import{t}from"./errors-D8rc8kzg-DREbrEsS.js";function n(e){return e?.view?.viewport}function r(e,t){let r=n(t);if(!r)return;e.setViewport(r[0],r[1],r[2],r[3],0,1);let i=t.view.scissor??r;e.setScissorRect(i[0],i[1],i[2],i[3])}function i(e,t=`clear`){return e?.view?.index?`load`:t}function a(e){return e?.view?.id??0}var o=class{constructor(e,t=()=>{}){this.create=e,this.release=t,this.states=new Map,this.frame=0}get(e){let t=a(e),n=this.states.get(t);return n||this.states.set(t,n={state:this.create(e),frame:0}),n.frame=this.frame,n.state}find(e){return this.states.get(e)?.state}*values(){for(let e of this.states.values())yield e.state}*drawn(){for(let e of this.states.values())e.frame===this.frame&&(yield e.state)}prune(){for(let[e,t]of this.states)t.frame<this.frame&&(this.states.delete(e),this.release(t.state));this.frame++}clear(){for(let e of this.states.values())this.release(e.state);this.states.clear()}},s=(globalThis[Symbol.for(`margoengine.frame-resources`)]??={devices:new WeakMap}).devices;function c(e){let t=s.get(e);return t||(s.set(e,t={frame:0,open:!1,lost:!1,views:new Set,drawing:0,retired:[],written:new WeakMap}),e.lost?.then?.(()=>{t.lost=!0;let e=t.retired;t.retired=[];for(let t of e)t.destroy()})),t}function l(e,t){if(!t)return;let n=c(e),r=[t,...n.written.get(t)?.extras??[]];if(n.written.delete(t),!n.lost&&n.open&&(n.views.size>1||n.drawing>0))n.retired.push(...r);else for(let e of r)e.destroy()}function u(e){return e?.adapterInfo?.vendor===`margo-webgl2`?`webgl2`:`native`}function d(e){return u(e)===`native`&&e?.features?.has(`core-features-and-limits`)===!1}var f=`@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {return vec4f(array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i],0,1);}`,p=(e,t,n)=>e.createBindGroup({layout:t.getBindGroupLayout(0),entries:[{binding:0,resource:n}]}),m=Symbol.for(`margoengine.optional.msaa`),h=f+`
@group(0) @binding(0) var source:texture_depth_multisampled_2d;
@fragment fn fragment(@builtin(position) p:vec4f)->@builtin(frag_depth) f32 {
 let q=vec2i(p.xy);
 return max(max(textureLoad(source,q,0),textureLoad(source,q,1)),max(textureLoad(source,q,2),textureLoad(source,q,3)));
}`;function g(e,t,n,r,i,a=!1){let o=e=>h.replace(/return max[^;]+;/,`return textureLoad(source,q,${e});`),s=(n,r)=>{let a=e.createShaderModule({code:n}),o=e.createRenderPipeline({layout:`auto`,vertex:{module:a,entryPoint:`vertex`},fragment:{module:a,entryPoint:`fragment`,targets:[]},depthStencil:{format:i,depthWriteEnabled:!0,depthCompare:`always`},multisample:r});return{pipeline:o,group:p(e,o,t)}};return{draws:a?[s(o(0).replace(`_multisampled`,``),{count:r})]:r===4?d(e)?[0,1,2,3].map(e=>s(o(e),{count:r,mask:1<<e})):[s(o(`i32(sample)`).replace(`p:vec4f)`,`p:vec4f,@builtin(sample_index) sample:u32)`),{count:r})]:[s(h,{count:r})],descriptor:{colorAttachments:[],depthStencilAttachment:{view:n,depthLoadOp:`clear`,depthClearValue:0,depthStoreOp:`store`,stencilReadOnly:!0}}}}function _(e,t,n,i,a,o){let s=e.pipelines.get(i);s||e.pipelines.set(i,s=new Map);let c=s.get(a);if(!c){let t=e.samples===1;s.set(a,c=g(e.device,e.depthSource,n,i,a,t))}c.descriptor.depthStencilAttachment.view=n,c.descriptor.depthStencilAttachment.depthLoadOp=o?.view?`load`:`clear`;let l=t.beginRenderPass(c.descriptor);o&&r(l,o);let u=c.draws;for(let e=0;e<u.length;e++)l.setPipeline(u[e].pipeline),l.setBindGroup(0,u[e].group),l.draw(3);l.end()}var v=class{constructor(e,t,n){this.device=e,this.samples=n,this.pipelines=new Map,this.depthSource=t.createView({aspect:`depth-only`})}copy(e,t,n,r){_(this,e.encoder,t,n,r,e)}},y=class{constructor(e,t,n,r=4){if(r!==1&&r!==4)throw RangeError(`Scene samples must be 1 or 4`);this.samples=r,this.device=e,this.resolvedColor=t,this.resolvedDepth=n,this.textures=[],this.pipelines=new Map;try{if(r===1){this.color=t.createView(),this.depth=n.createView();return}for(let r of[t,n])this.textures.push(e.createTexture({size:[r.width,r.height],format:r.format,sampleCount:4,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}));this.color=this.textures[0].createView(),this.depth=this.textures[1].createView(),this.resolution={colorAttachments:[{view:this.color,resolveTarget:t.createView(),loadOp:`load`,storeOp:`store`}]},this.finalResolution={colorAttachments:[{...this.resolution.colorAttachments[0],storeOp:`discard`}],depthStencilAttachment:{view:this.depth,depthLoadOp:`load`,depthStoreOp:`discard`,stencilReadOnly:!0}},this.depthSource=this.textures[1].createView({aspect:`depth-only`}),this.resolvedDepthView=n.createView()}catch(e){throw this.dispose(),e}}begin(e){(this.viewContext??={}).view=e.view,Object.assign(this.original??={},{color:e.color,depth:e.depth,format:e.format,descriptor:e.descriptor,owner:b(e)}),e.color=this.color,e.depth=this.depth,e.format=this.resolvedColor.format,this.baseDescriptor!==e.descriptor&&(this.baseDescriptor=e.descriptor,this.descriptor={...e.descriptor,depthStencil:{...e.descriptor.depthStencil,format:this.resolvedDepth.format},multisample:{count:this.samples}}),e.descriptor=this.descriptor,e[m]=this,this.retired=!1,this.resized=e.width!==void 0&&(e.width!==this.resolvedDepth.width||e.height!==this.resolvedDepth.height)}copyDepth(e,t,n,r=this.resolvedDepth.format){this.depthSource??=this.resolvedDepth.createView({aspect:`depth-only`}),_(this,e,t,n,r,this.viewContext)}resolve(e,t=!1,n=!0){if(this.samples===1)t&&this.give(e);else{if(n&&this.copyDepth(e,this.resolvedDepthView,1),t){let t=this.viewContext?.view?`store`:`discard`;this.finalResolution.colorAttachments[0].storeOp=t,this.finalResolution.depthStencilAttachment.depthStoreOp=t,this.give(e)}e.beginRenderPass(t?this.finalResolution:this.resolution).end()}}give(e){let t=this.original;this.retired||!t||this.resized||(this.copyDepth(e,t.depth,t.descriptor.multisample?.count??1,t.descriptor.depthStencil.format),this.retired=!0)}restore(e){let t=this.original;this.give(e.encoder),Object.assign(e,{color:t.color,depth:t.depth,format:t.format,descriptor:t.descriptor}),e[m]=t.owner}present(e){this.resolve(e.encoder,!0),this.restore(e);let t=e.descriptor.multisample?.count??1;if(!this.presentation||this.presentationFormat!==e.format||this.presentationSamples!==t){let n=this.device.createShaderModule({code:f+`@group(0) @binding(0) var source:texture_2d<f32>;@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{return textureLoad(source,vec2i(p.xy),0);}`});this.presentation=this.device.createRenderPipeline({layout:`auto`,vertex:{module:n,entryPoint:`vertex`},fragment:{module:n,entryPoint:`fragment`,targets:[{format:e.format}]},multisample:e.descriptor.multisample}),this.presentationGroup=p(this.device,this.presentation,this.resolvedColor.createView()),this.presentationFormat=e.format,this.presentationSamples=t}let n=this.presentationPass??={colorAttachments:[{view:e.color,loadOp:`clear`,storeOp:`store`}]};n.colorAttachments[0].view=e.color,n.colorAttachments[0].loadOp=i(e,`clear`);let a=e.encoder.beginRenderPass(n);a.setPipeline(this.presentation),a.setBindGroup(0,this.presentationGroup),r(a,e),a.draw(3),a.end()}dispose(){for(let e of this.textures)l(this.device,e);this.textures=[],this.pipelines.clear()}};function b(e){let t=e[m];return t?.color===e.color&&t.depth===e.depth?t:void 0}function x(e,t){return t>1&&d(e)?Array.from({length:t},(e,t)=>t):[null]}function S(e){b(e)?.resolve(e.encoder)}function C(e,t,n){return e.createBindGroup({layout:t.getBindGroupLayout(0),entries:n.map((e,t)=>({binding:t,resource:e}))})}function w(e,t,n=`main`){return e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:t}),entryPoint:n}})}function T(n){if(!n.gpu)throw t(`unsupported`,`Scene depth requires WebGPU; see https://margoengine.com/errors#webgpu`);if(n.hasPlugin(`ssao`)||n.hasPlugin(`dof`))throw t(`state`,`Another effect owns scene capture; use its depth texture`);let r=n.plugins.get(`optional:scene-depth`);r||(r={coreRequirement:e(`1.0.0`,import.meta.url),name:`optional:scene-depth`,references:0,texture:void 0,color:void 0,target:void 0,borrowed:!1,setup(){},registerPasses(e){e.add({name:this.name+`:capture`,order:-15,execute:e=>{if(e.backend!==`webgpu`)return;if(n.hasPlugin(`ssao`)||n.hasPlugin(`dof`))throw t(`state`,`Another effect owns scene capture; use its depth texture`);let r=b(e);if(this.borrowed=!!r,r){this.borrowedDepth=r.resolvedDepth;return}let i=e.descriptor.multisample?.count??4;try{if(i===1){(!this.depthView||this.texture?.width!==e.width||this.texture?.height!==e.height||this.texture?.format!==e.descriptor.depthStencil.format)&&(this.onDeviceRestored(),this.texture=e.device.createTexture({size:[e.width,e.height],format:e.descriptor.depthStencil.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.depthView=this.texture.createView()),this.outer=e.depth,e.depth=this.depthView;return}(this.target?.samples!==i||this.texture?.width!==e.width||this.texture?.height!==e.height||this.texture?.format!==e.descriptor.depthStencil.format||this.color?.format!==e.format)&&(this.onDeviceRestored(),this.texture=e.device.createTexture({size:[e.width,e.height],format:e.descriptor.depthStencil.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.color=e.device.createTexture({size:[e.width,e.height],format:e.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.target=new y(e.device,this.color,this.texture,i)),this.target.begin(e)}catch(e){throw this.onDeviceRestored(),e}}}),e.add({name:this.name+`:restore`,order:1e4,execute:e=>{if(!(e.backend!==`webgpu`||this.borrowed)){if(e.descriptor.multisample?.count!==1)return this.target.present(e);this.outer&&=(this.copier??=new v(e.device,this.texture,1),this.copier.copy(e,this.outer,1,e.descriptor.depthStencil.format),e.depth=this.outer,void 0)}}})},onDeviceRestored(){this.target?.dispose(),this.texture?.destroy(),this.color?.destroy(),this.target=this.texture=this.color=this.depthView=this.copier=this.outer=void 0},dispose(){this.onDeviceRestored()}},n.use(r)),r.references++;let i=!1;return{texture:()=>r.borrowed?r.borrowedDepth:r.texture,release(){i||(i=!0,--r.references===0&&n.sceneOf(r)?.removePlugin(r.name))}}}var E=`
struct Swell {direction:vec2f,gradient:vec2f,phase:f32,amplitude:f32}

fn swellComponent(index:u32)->vec4f {
 let spectrum=array<vec4f,3>(vec4f(0,1,0.4,0),vec4f(-0.64,0.84,0.35,2.17),vec4f(0.81,1.18,0.25,4.91));return spectrum[index];
}

fn swellFilter(k:f32,sampleWidth:f32)->f32 {let t=clamp((6.2831853/(k*1.114)/max(0.0001,sampleWidth)-2.0)*0.5,0.0,1.0);return t*t*(3.0-2.0*t);}
`,D=`

fn swellAt(w:Wave,xz:vec2f,index:u32,sampleWidth:f32,time:f32)->Swell {
 let component=swellComponent(index);
 let rotation=vec2f(cos(component.x),sin(component.x));let d=vec2f(w.wave.x*rotation.x-w.wave.y*rotation.y,w.wave.x*rotation.y+w.wave.y*rotation.x);let across=vec2f(-d.y,d.x);let k=w.wave.w*component.y;let speed=w.shape.y*sqrt(component.y);
 let bend=k*0.35*dot(across,xz)-speed*time*0.12+w.shape.z+component.w;

 let gradient=k*(d+across*0.49*cos(bend));
 return Swell(d,gradient,k*dot(d,xz)-speed*time+w.shape.z+component.w+1.4*sin(bend),w.wave.z*component.z*min(w.shape.w,swellFilter(k,sampleWidth)));
}
`,O=`
struct Wave {wave:vec4f,shape:vec4f}
struct Light {direction:vec4f,radiance:vec4f}
struct Frame {camera:mat4x4f,eye:vec4f,settings:vec4f,color:vec4f,cameraData:vec4f,waves:array<Wave,8>,coast:vec4f,flow:vec4f,sun:vec4f,radiance:vec4f,lights:array<Light,2>,grid:vec4f,foam:vec4f,shallow:vec4f,viewport:vec4f,far:array<vec4f,18>,sea:vec4f,seaWaves:array<vec4f,896>}
@group(0) @binding(0) var<uniform> frame:Frame;

fn hdrSkyTurn()->f32 {return frame.lights[0].radiance.w;}
fn hdrSkyScale()->f32 {return frame.lights[1].radiance.w;}
`,k=E+`fn swell(w:Wave,xz:vec2f,index:u32,sampleWidth:f32)->Swell {return swellAt(w,xz,index,sampleWidth,frame.settings.x);}`+D,A=e=>k+e+`
fn oceanHeight(p:vec2i,size:vec2i,ground:f32)->vec4f{
 surfShift=surfClock(u32(size.x*size.y)).x;
 return surfSea(frame.coast.xy+(vec2f(p)+0.5)/vec2f(size)*frame.coast.zw,ground,size,length(frame.flow.yz));
}

fn coastStep(size:vec2i)->f32 {let s=surfClock(u32(size.x*size.y)).y;return select(frame.flow.x,s,s>0.0);}
`,j=k+`
fn oceanHeight(p:vec2i,size:vec2i,ground:f32)->vec4f{
 let xz=frame.coast.xy+(vec2f(p)+0.5)/vec2f(size)*frame.coast.zw;
 var h=frame.settings.y;
 for(var j=0u;j<u32(frame.settings.w);j++){
  for(var c=0u;c<3u;c++){let s=swell(frame.waves[j],xz,c,length(frame.flow.yz));h+=s.amplitude*sin(s.phase);}
 }return vec4f(h,smoothstep(0.65,2.4,frame.settings.y-ground),0.0,0.0);
}
`,M=O+`
@group(0) @binding(1) var terrain:texture_2d<f32>;
@group(0) @binding(2) var state:texture_storage_2d<rgba32float,write>;
@group(0) @binding(3) var flux:texture_storage_2d<rgba32float,write>;
@group(0) @binding(4) var<storage,read_write> connected:array<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(state);if(any(id.xy>=size)){return;}
 let p=vec2i(id.xy);let ground=textureLoad(terrain,p,0).r;
 let index=id.y*size.x+id.x+1u;let edge=id.x==0u||id.y==0u||id.x==size.x-1u||id.y==size.y-1u;
 connected[index]=select(select(index,0u,edge),0xffffffffu,ground>=frame.settings.y);
 textureStore(state,p,vec4f(max(0.0,frame.settings.y-ground),ground,0,0));textureStore(flux,p,vec4f(0));
}`,N=O+`
@group(0) @binding(1) var terrain:texture_2d<f32>;
@group(0) @binding(2) var fill:texture_2d<f32>;
@group(0) @binding(3) var state:texture_storage_2d<rgba32float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(state);if(any(id.xy>=size)){return;}
 let p=vec2i(id.xy);let ground=textureLoad(terrain,p,0).r;let level=textureLoad(fill,p,0).r;
 textureStore(state,p,vec4f(max(max(0.0,frame.settings.y-ground),level-ground),ground,0,level));
}`,P=`
@group(0) @binding(0) var terrain:texture_2d<f32>;
@group(0) @binding(1) var<storage,read_write> connected:array<atomic<u32>>;
fn root(index:u32)->u32 {
 var p=index;
 loop {let next=atomicLoad(&connected[p]);if(next==p){break;}atomicMin(&connected[p],atomicLoad(&connected[next]));p=next;}
 return p;
}
fn join(a:u32,b:u32){
 var x=a;var y=b;
 loop {x=root(x);y=root(y);if(x==y){return;}let high=max(x,y);let low=min(x,y);let previous=atomicMin(&connected[high],low);if(previous==high){return;}

  x=previous;y=low;
 }
}
@compute @workgroup_size(8,8) fn connect(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(terrain);if(any(id.xy>=size)){return;}let index=id.y*size.x+id.x+1u;if(atomicLoad(&connected[index])==0xffffffffu){return;}
 if(id.x>0u&&atomicLoad(&connected[index-1u])!=0xffffffffu){join(index,index-1u);}
 if(id.y>0u&&atomicLoad(&connected[index-size.x])!=0xffffffffu){join(index,index-size.x);}
}
@compute @workgroup_size(8,8) fn compress(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(terrain);if(any(id.xy>=size)){return;}let index=id.y*size.x+id.x+1u;if(atomicLoad(&connected[index])!=0xffffffffu){atomicStore(&connected[index],root(index));}
}`,F=(e=``)=>O+e+`
@group(0) @binding(1) var state:texture_2d<f32>;
@group(0) @binding(2) var previous:texture_2d<f32>;
@group(0) @binding(3) var next:texture_storage_2d<rgba32float,write>;
${e?`@group(0) @binding(4) var<storage,read> connected:array<u32>;`:``}

const COAST_DRY=1e-4;
const COAST_MANNING=0.02;
var<private> coastGrid:vec2i;
fn axisStep(axis:i32)->vec2i {return select(vec2i(0,1),vec2i(1,0),axis==0);}
fn axisLength(axis:i32)->f32 {return select(frame.flow.z,frame.flow.y,axis==0);}
fn inside(p:vec2i,n:vec2i)->bool {return all(p>=vec2i(0))&&all(n<coastGrid);}

fn faceQ(p:vec2i,axis:i32)->f32 {
 let n=p+axisStep(axis);if(!inside(p,n)){return 0.0;}
 let a=textureLoad(previous,p,0);let b=textureLoad(previous,n,0);return select(a.w-b.z,a.y-b.x,axis==0);
}

fn faceDepth(p:vec2i,axis:i32)->f32 {
 let n=p+axisStep(axis);if(!inside(p,n)){return 0.0;}
 let a=textureLoad(state,p,0);let b=textureLoad(state,n,0);return max(a.x+a.y,b.x+b.y)-max(a.y,b.y);
}
fn faceU(p:vec2i,axis:i32)->f32 {let h=faceDepth(p,axis);return select(0.0,faceQ(p,axis)/h,h>COAST_DRY);}

fn koren(d1:f32,d2:f32)->f32 {if(abs(d1)<1e-12){return 0.0;}let r=d2/d1;return 0.5*d1*max(0.0,min(min(2.0*r,(1.0+2.0*r)/3.0),2.0));}



fn faceStep(p:vec2i,axis:i32,dt:f32)->f32 {
 let e=axisStep(axis);let t=axisStep(1-axis);let n=p+e;if(!inside(p,n)){return 0.0;}
 let a=textureLoad(state,p,0);let b=textureLoad(state,n,0);let za=a.x+a.y;let zb=b.x+b.y;
 let bed=max(a.y,b.y);let h=max(za,zb)-bed;if(h<=COAST_DRY){return 0.0;}

 var u:array<f32,7>;
 for(var k=0;k<7;k++){u[k]=faceU(select(p+(k-2)*e,p+select(-t,t,k==6),k>4),axis);}
 let q=faceQ(p,axis);let along=axisLength(axis);let across=axisLength(1-axis);


 var mean=array<f32,2>(0.5*(faceQ(p-e,axis)+q),0.5*(q+faceQ(n,axis)));var star:array<f32,2>;
 for(var c=0;c<2;c++){
  let w=c+1;
  if(mean[c]>0.0){star[c]=u[w]+koren(u[w]-u[w-1],u[w+1]-u[w]);}else{star[c]=u[w+1]+koren(u[w+1]-u[w+2],u[w]-u[w+1]);}
 }
 var flux=(mean[1]*star[1]-mean[0]*star[0])/along;

 let qn=0.5*(faceQ(p,1-axis)+faceQ(n,1-axis));let qs=0.5*(faceQ(p-t,1-axis)+faceQ(n-t,1-axis));
 flux+=(qn*select(u[6],u[2],qn>0.0)-qs*select(u[2],u[5],qs>0.0))/across;


 let pressure=0.5*(max(0.0,za-bed)+max(0.0,zb-bed));
 var moved=q-dt*flux-dt*9.81*pressure*(zb-za)/along;
 moved/=1.0+dt*9.81*COAST_MANNING*COAST_MANNING*abs(moved)/pow(h,2.3333333);
 let cap=h*0.5*min(frame.flow.y,frame.flow.z)/dt;return clamp(moved,-cap,cap);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 coastGrid=vec2i(textureDimensions(state));let size=coastGrid;let p=vec2i(id.xy);if(any(p>=size)){return;}
 let v=textureLoad(state,p,0);let dt=${e?`coastStep(size)`:`frame.flow.x`};

 var out:array<f32,4>;
 for(var k=0;k<4;k++){let axis=k/2;let back=k%2==0;let f=faceStep(select(p,p-axisStep(axis),back),axis,dt);out[k]=max(0.0,select(f,-f,back));}
 var q=vec4f(out[0],out[1],out[2],out[3]);
${e?`
 if(connected[u32(p.y*size.x+p.x)+1u]==0u&&surfReady(u32(size.x*size.y))){
  let sea=oceanHeight(p,size,v.y);
  q=mix(q,vec4f(max(0.0,-sea.z),max(0.0,sea.z),max(0.0,-sea.w),max(0.0,sea.w)),(1.0-exp(-dt*4.0))*sea.y);



  for(var k=0;k<4;k++){let axis=k/2;if(faceDepth(select(p,p-axisStep(axis),k%2==0),axis)<=COAST_DRY){q[k]=0.0;}}
 }
`:``} if(p.x==0){q.x=0;}if(p.x==size.x-1){q.y=0;}if(p.y==0){q.z=0;}if(p.y==size.y-1){q.w=0;}

 let outgoing=(q.x+q.y)/frame.flow.y+(q.z+q.w)/frame.flow.z;
 q*=min(1.0,v.x/max(0.000001,dt*outgoing));textureStore(next,p,q);
}`,I=(e=`frame.flow.x`,t=``,n=j)=>O+n+t+`
@group(0) @binding(1) var state:texture_2d<f32>;
@group(0) @binding(2) var flux:texture_2d<f32>;
@group(0) @binding(3) var next:texture_storage_2d<rgba32float,write>;
@group(0) @binding(4) var<storage,read> connected:array<u32>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 let size=vec2i(textureDimensions(state));let p=vec2i(id.xy);if(any(p>=size)){return;}
 let v=textureLoad(state,p,0);let q=textureLoad(flux,p,0);let dt=${e};
 var incoming=vec4f(0);
 if(p.x>0){incoming.x=textureLoad(flux,p-vec2i(1,0),0).y;}
 if(p.x<size.x-1){incoming.y=textureLoad(flux,p+vec2i(1,0),0).x;}
 if(p.y>0){incoming.z=textureLoad(flux,p-vec2i(0,1),0).w;}
 if(p.y<size.y-1){incoming.w=textureLoad(flux,p+vec2i(0,1),0).z;}
 var h=max(0.0,v.x+dt*((incoming.x+incoming.y-q.x-q.y)/frame.flow.y+(incoming.z+incoming.w-q.z-q.w)/frame.flow.z)${t?`+dt*inflow(p,size)`:``});

 let seaCell=connected[id.y*u32(size.x)+id.x+1u]==0u;let boundary=p.x==0||p.y==0||p.x==size.x-1||p.y==size.y-1;
 if(seaCell||boundary){
  let sea=oceanHeight(p,size,v.y);
  if(seaCell){h=mix(h,max(0.0,sea.x-v.y),(1.0-exp(-dt*4.0))*sea.y);}
  if(boundary){h=max(0.0,sea.x-v.y);}
 }
 var carried=v.x*v.z;
 if(p.x>0){carried+=dt*incoming.x*textureLoad(state,p-vec2i(1,0),0).z/frame.flow.y;}
 if(p.x<size.x-1){carried+=dt*incoming.y*textureLoad(state,p+vec2i(1,0),0).z/frame.flow.y;}
 if(p.y>0){carried+=dt*incoming.z*textureLoad(state,p-vec2i(0,1),0).z/frame.flow.z;}
 if(p.y<size.y-1){carried+=dt*incoming.w*textureLoad(state,p+vec2i(0,1),0).z/frame.flow.z;}
 carried-=dt*v.z*((q.x+q.y)/frame.flow.y+(q.z+q.w)/frame.flow.z);
 let velocity=vec2f(q.y-q.x+incoming.x-incoming.y,q.w-q.z+incoming.z-incoming.w)/max(0.04,2.0*h);
 let froude=length(velocity)/sqrt(9.81*max(0.03,h));
 let breaker=smoothstep(0.45,1.0,froude)*smoothstep(0.01,0.08,h)*(1.0-smoothstep(0.8,1.8,h));
 let foam=max(clamp(carried/max(0.003,h),0.0,1.0)*exp(-dt*0.8),breaker);
 textureStore(next,p,vec4f(h,v.y,foam,breaker));
}`,L=F(),R=I(),z=-1e30,B=class{constructor(e,t,n,r,i=!1,a,o){this.terrain=n,this.still=i,this.river=a,this.states=[],this.views=[],this.fluxes=[],this.flowGroups=[],this.integrateGroups=[],this.descriptor={},this.initialized=!1,this.spinFrames=0,this.current=0,this.device=e;try{let s=n.width*n.height,c=i||a?void 0:o;this.connected=e.createBuffer({size:(c?c.words(s):s+1)*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});for(let t=0;t<2;t++)this.states.push(e.createTexture({size:[n.width,n.height],format:`rgba32float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_SRC})),this.fluxes.push(e.createTexture({size:[n.width,n.height],format:`rgba32float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING}));this.views=this.states.map(e=>e.createView());let l=this.fluxes.map(e=>e.createView());this.initializer=w(e,M);let u=c&&A(c.waves);this.flowing=w(e,a?.flow??(u?F(u):L)),this.integrating=w(e,a?.integrate??(u?I(`coastStep(size)`,``,u):R)),a&&(this.sources=e.createBuffer({size:a.sources.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));let d=e.createShaderModule({code:P});this.connector=e.createComputePipeline({layout:`auto`,compute:{module:d,entryPoint:`connect`}}),this.compressor=e.createComputePipeline({layout:`auto`,compute:{module:d,entryPoint:`compress`}}),this.connectGroup=C(e,this.connector,[n.createView(),{buffer:this.connected}]),this.surf=c?.build(e,t,n,this.connected,O),this.spinFrames=c?.spinFrames??0,this.compressGroup=C(e,this.compressor,[n.createView(),{buffer:this.connected}]),this.initialGroup=C(e,this.initializer,[{buffer:t},n.createView(),this.views[0],l[0],{buffer:this.connected}]),r&&(this.fillTexture=e.createTexture({size:[n.width,n.height],format:`r32float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),e.queue.writeTexture({texture:this.fillTexture},r,{bytesPerRow:n.width*4,rowsPerImage:n.height},[n.width,n.height]),this.filling=w(e,N),this.fillGroup=C(e,this.filling,[{buffer:t},n.createView(),this.fillTexture.createView(),this.views[0]]));for(let n=0;n<2;n++)this.flowGroups.push(C(e,this.flowing,[{buffer:t},this.views[n],l[n],l[1-n],...u?[{buffer:this.connected}]:[]])),this.integrateGroups.push(C(e,this.integrating,[{buffer:t},this.views[n],l[1-n],this.views[1-n],{buffer:this.connected},...this.sources?[{buffer:this.sources}]:[]]))}catch(e){throw this.dispose(),e}}get substeps(){return this.river?.substeps??3}get isSetUp(){return this.initialized}ready(){this.initialized||this.setUp(Math.ceil(this.terrain.width/8),Math.ceil(this.terrain.height/8))}writeSources(){this.river&&this.device.queue.writeBuffer(this.sources,0,this.river.sources)}tick(e){if(this.ready(),this.still)return;let t=e.beginComputePass(this.descriptor);this.substep(()=>t,Math.ceil(this.terrain.width/8),Math.ceil(this.terrain.height/8)),t.end()}step(e){if(this.still&&this.initialized)return;let t=Math.ceil(this.terrain.width/8),n=Math.ceil(this.terrain.height/8);if(this.initialized||this.setUp(t,n),this.still)return;let r=e.beginComputePass(this.descriptor),i=()=>r;this.river&&this.device.queue.writeBuffer(this.sources,0,this.river.sources);for(let e=0;e<(this.river?.substeps??3);e++)this.substep(i,t,n);r.end()}setUp(e,t){let n,r,i=0,a=()=>{n&&(r.end(),this.device.queue.submit([n.finish()]),n=r=void 0,i=0)},o=(o=e*t)=>(i+o>262144&&a(),i+=o,r||=(n=this.device.createCommandEncoder()).beginComputePass(this.descriptor),r),s=(n,r)=>{let i=o();i.setPipeline(n),i.setBindGroup(0,r),i.dispatchWorkgroups(e,t)};if(s(this.initializer,this.initialGroup),s(this.connector,this.connectGroup),s(this.compressor,this.compressGroup),this.surf?.build(o,this.terrain.width,this.terrain.height),this.filling&&s(this.filling,this.fillGroup),this.surf&&!this.still&&this.spinFrames>0){this.surf.clock(o(1),0);for(let n=0;n<this.spinFrames;n++){for(let n=0;n<3;n++)this.substep(o,e,t);this.surf.clock(o(1),1)}this.surf.clock(o(1),2)}a(),this.initialized=!0}substep(e,t,n){let r=e();r.setPipeline(this.flowing),r.setBindGroup(0,this.flowGroups[this.current]),r.dispatchWorkgroups(t,n),r=e(),r.setPipeline(this.integrating),r.setBindGroup(0,this.integrateGroups[this.current]),r.dispatchWorkgroups(t,n),this.current=1-this.current}dispose(){this.connected?.destroy(),this.fillTexture?.destroy(),this.sources?.destroy();for(let e=0;e<this.states.length;e++)this.states[e].destroy();for(let e=0;e<this.fluxes.length;e++)this.fluxes[e].destroy()}},V=new WeakMap,H=new WeakMap,U=new WeakMap,W=new WeakMap;export{b as _,k as a,z as c,w as d,o as f,S as g,r as h,H as i,O as l,T as m,U as n,I as o,x as p,W as r,B as s,V as t,C as u};