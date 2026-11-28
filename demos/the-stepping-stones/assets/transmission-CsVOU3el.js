import{n as e}from"./errors-D0VAEAiW-CZKkhVCh.js";import{C as t,D as n,E as r,F as i,P as a,S as o,T as s,j as c,k as l,w as u}from"./index-5ZISRTT9.js";var d=(e,t=`1.0.0`,n=import.meta.url)=>c(e,t,n),f=((254.5/255+.055)/1.055)**2.4;.56+.0576/(1-f);var p=`fn pbrNeutralInverse(input:vec3f)->vec3f {let top=${f};var peak=max(input.r,max(input.g,input.b));var v=max(input*select(1.0,top/peak,peak>top),vec3f(0.0));peak=min(peak,top);if(peak>=0.76){let old=0.52+0.24*0.24/(1.0-peak);let keep=1.0/(0.15*(old-peak)+1.0);v=(v-peak*(1.0-keep))/keep*old/peak;}let m=min(v.r,min(v.g,v.b));return v+select(0.04,0.4*sqrt(max(m,0.0))-m,m<0.04);}
`,m=Object.freeze({color:{srcFactor:`src-alpha`,dstFactor:`one-minus-src-alpha`,operation:`add`},alpha:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`}});function h(e,t,n){let r=e.get(t);return r===void 0&&e.set(t,r=n(t)),r}var g=124,_=e=>`
@group(${e}) @binding(${g}) var margoScene:texture_2d<f32>;
@group(${e}) @binding(125) var margoSceneSampler:sampler;
fn margoTransmissionBehind(i:Out,n:vec3f,v:vec3f,ior:f32,path:f32,level:f32)->vec3f {
  let r=refract(-v,faceForward(n,-v,n),1.0/ior);
  let c=f.camera*vec4f(i.position+r*path,1.0);
  let uv=clamp(c.xy/max(c.w,0.000001)*vec2f(0.5,-0.5)+0.5,vec2f(0),vec2f(1));
  return textureSampleLevel(margoScene,margoSceneSampler,uv,level).rgb;
}
// Blur level from the transmitted lobe width (derivation above declarations) at one IOR: dispersed rays each have their own.
fn margoTransmissionLevel(roughness:f32,ior:f32,path:f32)->f32 {
  let size=vec2f(textureDimensions(margoScene,0));
  let alpha=roughness*roughness;
  let sinTilt=alpha*inverseSqrt(1.0+alpha*alpha);
  let sinOut=sinTilt/ior;
  let tanOut=sinOut*inverseSqrt(1.0-sinOut*sinOut);
  let deviation=max((alpha-tanOut)/(1.0+alpha*tanOut),0.0);
  let wRow=vec3f(f.camera[0].w,f.camera[1].w,f.camera[2].w);
  let yRow=vec3f(f.camera[0].y,f.camera[1].y,f.camera[2].y);
  let reach=select(path,1.0,dot(wRow,wRow)>0.0);
  let texels=deviation*reach*length(yRow)*size.y;
  return clamp(log2(max(texels,1.0)),0.0,f32(textureNumLevels(margoScene)-1u));
}
fn margoVolumeChord(i:Out,n:vec3f,v:vec3f,ior:f32)->f32 {
  let m=mat3x3f(f.model[0].xyz,f.model[1].xyz,f.model[2].xyz);
  let r=refract(-v,faceForward(n,-v,n),1.0/ior);
  let c0=cross(m[1],m[2]); let c1=cross(m[2],m[0]); let c2=cross(m[0],m[1]);
  let normal=normalize(vec3f(dot(m[0],i.normal),dot(m[1],i.normal),dot(m[2],i.normal)));
  let projected=abs(dot(vec3f(dot(c0,r),dot(c1,r),dot(c2,r)),normal));
  return select(abs(dot(m[0],c0))/projected,1e30,projected==0.0);
}
fn margoTransmission(s:Surface,v:vec3f,i:Out)->vec3f {
  let ior=select(max(f.ext.y,1.0),1e30,f.ext.y==0.0);
  let path=max(margoVolume.x*s.th*margoVolumeThickness(i)*margoVolumeChord(i,s.n,v,ior),0.0);
  var behind=margoTransmissionBehind(i,s.n,v,ior,path,margoTransmissionLevel(s.roughness,ior,path));
  if(f.ext.w>0.0&&path>0.0){
    // KHR_materials_dispersion: IOR spread (IOR-1)*0.025*dispersion; red and blue each read on their own ray.
    let spread=(ior-1.0)*0.025*f.ext.w;
    let red=max(1.0,ior-spread); let blue=ior+spread;
    behind=vec3f(margoTransmissionBehind(i,s.n,v,red,path,margoTransmissionLevel(s.roughness,red,path)).r,behind.g,margoTransmissionBehind(i,s.n,v,blue,path,margoTransmissionLevel(s.roughness,blue,path)).b);
  }
  // Beer-Lambert through the volume: margoVolume.yzw is the transmittance per world unit.
  var transmittance=vec3f(1.0);
  if(path>0.0){
    let t=margoVolume.yzw;
    transmittance=select(select(pow(max(t,vec3f(0.000001)),vec3f(path)),vec3f(0.0),t<=vec3f(0.0)),vec3f(1.0),t>=vec3f(1.0));
  }
  // The dielectric's Fresnel: glTF 2.0 Appendix B mixes the metal part in beside this one, not over it.
  let keep=1.0-margoFresnelPeak(margoDielectricFresnel(s.f0,s.sw,clamp(dot(s.n,v),0.0,1.0)));
  return (1.0-s.metal)*s.tr*keep*s.base.rgb*transmittance*behind;
}
`,v=`
@group(0) @binding(0) var source:texture_2d<f32>;
@vertex fn vertex(@builtin(vertex_index) k:u32)->@builtin(position) vec4f {
  let corner=vec2f(f32((k<<1u)&2u),f32(k&2u));
  return vec4f(corner*2.0-1.0,0.0,1.0);
}
@fragment fn level0(@builtin(position) p:vec4f)->@location(0) vec4f {
  return textureLoad(source,vec2i(p.xy),0);
}
// A display-encoded source holds toDisplay(light): the PBR Neutral curve, then the sRGB transfer (shared/display.js).
// Level 0 undoes both, so every mip averages scene light (an encoded average is a darker blur) and margoTransmission
// adds the same light it would on an HDR target; the glass shader's own display transform then applies the curve once,
// so clear IOR 1 glass shows exactly what is behind it (a plain decode applied the curve twice: 230 drew 225).
@fragment fn level0Display(@builtin(position) p:vec4f)->@location(0) vec4f {
  let c=textureLoad(source,vec2i(p.xy),0);
  let x=clamp(c.rgb,vec3f(0.0),vec3f(1.0));
  return vec4f(pbrNeutralInverse(select(x/12.92,pow((x+0.055)/1.055,vec3f(2.4)),x>vec3f(0.04045))),c.a);
}
${p}`,y=m,b=0,x=class c{coreRequirement=i(`1.0.0`,import.meta.url);static attach(e,t){a(e,i(`1.0.0`,import.meta.url));let n=new c(t);return d(e).use(n),n}constructor({order:e=3,depthWrite:t=!1}={}){if(this.name=`transmission:`+b++,this.targets=[],this.disposed=!1,this.models=new Map,this.code=new Map,this.formats=new Map,this.levels=[],this.reduceGroups=[],this.ordered=[],!Number.isFinite(e)||e<=0)throw RangeError(`Transmission order must be a number > 0`);if(typeof t!=`boolean`)throw TypeError(`Transmission depthWrite must be true or false`);this.order=e,this.depthWrite=t}add(t){if(this.disposed||!this.engine)throw e(this.disposed?`disposed`:`state`,this.disposed?`Transmission is disposed; create a new Transmission.`:`Transmission.add needs Transmission.attach(engine) first`);let n=this.models.get(t);if(!n){let e=t.setTransmission(this),r=t.onDispose(()=>this.models.delete(t));n=()=>{this.models.get(t)===n&&(this.models.delete(t),r(),e())},this.models.set(t,n)}return n}setup(t){if(this.disposed)throw e(`disposed`,`Transmission is disposed; create a new Transmission.`);if(!t.gpu)throw e(`unsupported`,`Transmission requires WebGPU: create the engine with a WebGPU device; see https://margoengine.com/errors#webgpu`);this.engine=t,this.device=t.gpu}registerPasses(e){e.add({name:this.name,order:this.order,execute:e=>{e.backend===`webgpu`&&this.render(e)}})}declarations(e){return h(this.code,e,_)}bindings(){return[{binding:g,resource:this.view},{binding:125,resource:this.sampler}]}begin(){if(this.pass)return this.pass;let e=this.context,t=s(e),i=e.encoder,a=this.pipelines;t?.resolve(i);let c=t?t.resolvedColor:n(e).resolved(e);this.source!==c&&(this.source=c,this.sourcePipeline=o(c.format)||c.format.endsWith(`-srgb`)?a.level0:a.display,this.sourceGroup=e.device.createBindGroup({layout:this.sourcePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:c.createView()}]}));for(let e=0;e<this.levels.length;e++){let t=i.beginRenderPass({label:`transmission:copy`,colorAttachments:[{view:this.levels[e],loadOp:`clear`,storeOp:`store`,clearValue:[0,0,0,0]}]});t.setPipeline(e?a.reduce:this.sourcePipeline),t.setBindGroup(0,e?this.reduceGroups[e-1]:this.sourceGroup),t.draw(3),t.end()}return this.pass=i.beginRenderPass({label:`transmission`,colorAttachments:[{view:e.color,loadOp:`load`,storeOp:`store`}],depthStencilAttachment:this.depthWrite?{view:e.depth,depthLoadOp:`load`,depthStoreOp:`store`,stencilReadOnly:!0}:{view:e.depth,depthReadOnly:!0,stencilReadOnly:!0}}),r(this.pass,e),this.pass}takes(e){return!this.disposed&&(!!s(e)||!!n(e)?.resolved?.(e,!1))}render(e){if(t(e.device,e.view??e),this.disposed||!this.models.size||!this.takes(e))return;let n=e.device;if(!this.pipelines){let e=(e,t)=>{let r=n.createShaderModule({code:e});return n.createRenderPipeline({label:`transmission:copy`,layout:`auto`,vertex:{module:r,entryPoint:`vertex`},fragment:{module:r,entryPoint:t,targets:[{format:`rgba16float`}]}})};this.pipelines={level0:e(v,`level0`),display:e(v,`level0Display`),reduce:e(l(!1),`fragment`)},this.sampler=n.createSampler({magFilter:`linear`,minFilter:`linear`,mipmapFilter:`linear`})}if(this.texture?.width!==e.width||this.texture.height!==e.height){this.release();let t=Math.floor(Math.log2(Math.max(e.width,e.height)))+1,r=this.texture=n.createTexture({label:`transmission:scene`,size:[e.width,e.height],format:`rgba16float`,mipLevelCount:t,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});this.view=r.createView(),this.levels=Array.from({length:t},(e,t)=>r.createView({baseMipLevel:t,mipLevelCount:1})),this.reduceGroups=this.levels.slice(0,-1).map(e=>n.createBindGroup({layout:this.pipelines.reduce.getBindGroupLayout(0),entries:[{binding:0,resource:e}]}))}let r=this.formats.get(e.format);r||this.formats.set(e.format,r=[{format:e.format,blend:y}]),this.targets=r;let i=e.camera.position,a=e=>{let t=e.root.matrix;return Math.hypot(i[0]-t[12],i[1]-t[13],i[2]-t[14])};this.context=e,this.pass=void 0;let o=this.ordered;o.length=0;for(let e of this.models.keys())o.push(e);o.sort((e,t)=>a(t)-a(e));try{for(let t=0;t<o.length;t++)o[t].draw(e,`transmission`,e.color,e.depth)}finally{this.context=void 0,this.pass?.end(),this.pass=void 0,o.length=0}}release(){u(this.device,this.texture),this.texture=this.view=this.source=this.sourceGroup=this.sourcePipeline=void 0,this.levels=[],this.reduceGroups=[]}onDeviceRestored(e){this.release(),this.pipelines=void 0,this.setup(e)}dispose(){if(!this.disposed){this.disposed=!0;for(let e of[...this.models.values()])e();this.release(),this.pipelines=void 0,this.engine?.sceneOf(this)?.removePlugin(this.name)}}[Symbol.dispose??Symbol()](){this.dispose()}},S=new WeakMap,C={attach(e,t,n){let r=S.get(n);if(!r){let e=new x({depthWrite:!0}),i;for(let e of t.scenes)e.frameGraph===n&&(i=e);i?t.use(e,i):t.use(e),S.set(n,r={pass:e,users:new Set})}let i=r,a=i.pass.add(e);return i.users.add(e),()=>{a(),i.users.delete(e)&&!i.users.size&&(S.get(n)===i&&S.delete(n),i.pass.dispose())}}};export{C as screenTransmission};