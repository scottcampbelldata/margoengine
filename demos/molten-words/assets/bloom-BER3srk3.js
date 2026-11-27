import{a as e,i as t,r as n}from"./index-Dqo_DTet.js";import{a as r,c as i,d as a,f as o,i as s,l as c,n as l,o as u,r as d,s as f,t as p,u as m}from"./capture-H0c3L2CN-CL9KTi4h.js";function h(e,t,n,r={}){let i=e.createShaderModule({code:t});return e.createRenderPipeline({layout:`auto`,vertex:{module:i,entryPoint:`vertex`},fragment:{module:i,entryPoint:`fragment`,targets:[{format:n}]},...r})}var g=(e,t=`1.0.0`,r=import.meta.url)=>n(e,t,r),_=`fn dither(p:vec2f)->f32{
 var x=(u32(p.x)*0x9e3779b9u)^(u32(p.y)*0x85ebca6bu);x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;x^=x>>16u;
 return f32(x&0xffffu)/65536.0+f32(x>>16u)/65536.0-1.0;
}`,v=`
fn bad(c:vec3f)->vec3<bool>{return (bitcast<vec3u>(c)&vec3u(0x7f800000u))==vec3u(0x7f800000u);}
fn clean(c:vec3f)->vec3f{return select(min(c,vec3f(65504)),select(vec3f(0),vec3f(65504),bitcast<vec3u>(c)==vec3u(0x7f800000u)),bad(c));}
`,y=[`temporal`,`karis`,`none`],b=`
fn tent(t:texture_2d<f32>,s:sampler,uv:vec2f)->vec3f{
 let d=1.0/vec2f(textureDimensions(t));var c=vec3f(0);
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){c+=textureSampleLevel(t,s,uv+vec2f(f32(x),f32(y))*d,0.0).rgb*f32((2-abs(x))*(2-abs(y)));}}
 return c/16.0;
}`,x=b+v+`
@group(0) @binding(0) var source:texture_2d<f32>;
@group(0) @binding(1) var bilinear:sampler;
@group(0) @binding(2) var output:texture_storage_2d<rgba16float,write>;
@group(0) @binding(3) var detail:texture_2d<f32>;
@group(0) @binding(4) var<uniform> settings:vec4f;
@group(0) @binding(5) var<uniform> spikes:vec4f;
fn luma(c:vec3f)->f32{return dot(c,vec3f(0.2126,0.7152,0.0722));}
fn cleanTap(uv:vec2f)->vec3f{
 let size=vec2i(textureDimensions(source));let x=uv*vec2f(size)-0.5;let i=vec2i(floor(x));let f=x-floor(x);
 let a=clean(textureLoad(source,clamp(i,vec2i(0),size-1),0).rgb);
 let b=clean(textureLoad(source,clamp(i+vec2i(1,0),vec2i(0),size-1),0).rgb);
 let c=clean(textureLoad(source,clamp(i+vec2i(0,1),vec2i(0),size-1),0).rgb);
 let d=clean(textureLoad(source,clamp(i+vec2i(1,1),vec2i(0),size-1),0).rgb);
 return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}
fn boxes(id:vec2u,top:bool)->array<vec4f,5>{
 let uv=(vec2f(id)+0.5)/vec2f(textureDimensions(output));let t=1.0/vec2f(textureDimensions(source));
 let o=array<vec2f,13>(vec2f(-2,-2),vec2f(0,-2),vec2f(2,-2),vec2f(-1,-1),vec2f(1,-1),vec2f(-2,0),vec2f(0,0),vec2f(2,0),vec2f(-1,1),vec2f(1,1),vec2f(-2,2),vec2f(0,2),vec2f(2,2));
 var s:array<vec4f,13>;
 for(var i=0;i<13;i++){
  var c=textureSampleLevel(source,bilinear,uv+o[i]*t,0.0);
  if(top){
   var r=c.rgb;if(any(bad(r))){r=cleanTap(uv+o[i]*t);}
   r=min(r,vec3f(65504.0));let m=max(r.r,max(r.g,r.b));c=vec4f(r*(max(0.0,m-settings.w)/max(0.0001,m)),0);
  }
  s[i]=c;
 }
 return array<vec4f,5>((s[3]+s[4]+s[8]+s[9])*0.25,(s[0]+s[1]+s[5]+s[6])*0.25,(s[1]+s[2]+s[6]+s[7])*0.25,(s[5]+s[6]+s[10]+s[11])*0.25,(s[6]+s[7]+s[11]+s[12])*0.25);
}
@compute @workgroup_size(8,8) fn down(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=textureDimensions(output))){return;}
 let b=boxes(id.xy,false);
 textureStore(output,vec2i(id.xy),b[0]*0.5+(b[1]+b[2]+b[3]+b[4])*0.125);
}
fn budget(id:vec2u)->f32{
 let size=vec2f(textureDimensions(output));let n=vec2i(textureDimensions(detail));
 let p=vec2i((vec2f(id)+0.5)/size*vec2f(n));var e=0.0;
 for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let q=p+vec2i(x,y);if(all(q>=vec2i(0))&&all(q<n)){e+=textureLoad(detail,q,0).a;}
 }}
 return max(spikes.y,e*spikes.x*size.x*size.y/f32(n.x*n.y));
}
@compute @workgroup_size(8,8) fn prefilter(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=textureDimensions(output))){return;}
 let b=boxes(id.xy,true);
 var lin=vec3f(0);var rob=vec3f(0);var total=0.0;
 for(var i=0;i<5;i++){
  let w=select(0.125,0.5,i==0);lin+=b[i].rgb*w;let k=w/(1+luma(b[i].rgb));rob+=b[i].rgb*k;total+=k;
 }
 rob/=total;
 let ll=luma(lin);let lr=luma(rob);
 let keep=select(1.0,clamp((budget(id.xy)-lr)/(ll-lr),0.0,1.0),ll>lr);
 textureStore(output,vec2i(id.xy),vec4f(mix(rob,lin,keep),ll));
}
@compute @workgroup_size(8,8) fn up(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(output);if(any(id.xy>=size)){return;}
 let uv=(vec2f(id.xy)+0.5)/vec2f(size);
 textureStore(output,vec2i(id.xy),vec4f(min(textureLoad(detail,vec2i(id.xy),0).rgb+tent(source,bilinear,uv),vec3f(65504.0)),1));
}`,S=x.replace(`.rgb+tent(source,bilinear,uv)`,`.rgb*settings.x+tent(source,bilinear,uv)*settings.y`);if(S===x)throw o(`failed`,`Bloom: the up pass lost its weights; update the radius patch`);var C=256;function w(e,t){let n=4**(2*e-1),r=Array.from({length:t},(e,t)=>n**t),i=r.reduce((e,t)=>e+t,0);return r.map(e=>e*t/i)}var T=u+b+v+`
@group(0) @binding(0) var scene:texture_2d<f32>;
@group(0) @binding(1) var bloom:texture_2d<f32>;
@group(0) @binding(2) var<uniform> settings:vec4f;
@group(0) @binding(3) var bilinear:sampler;
@vertex fn vertex(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
${_}
@fragment fn fragment(@builtin(position) p:vec4f)->@location(0) vec4f{
 let s=textureLoad(scene,vec2i(p.xy),0);let hdr=clean(s.rgb)+tent(bloom,bilinear,p.xy/vec2f(textureDimensions(scene)))*settings.x;
 let o=toDisplay(hdr*exp2(settings.y));let a=max(s.a,max(o.r,max(o.g,o.b)));return vec4f(min(o+dither(p.xy)*min(vec3f(settings.z),min(o,1-o)),vec3f(a)),a);
}`,E=T.replace(/let o=toDisplay\(hdr\*exp2\(settings\.y\)\);[^\n]+/,`return vec4f(max(hdr,vec3f(0))*exp2(settings.y),s.a);`);if(E.includes(`toDisplay(hdr`))throw o(`failed`,`Bloom: the HDR composite still encodes for display; update its linear-output patch`);var D=T.replace(`let o=toDisplay(hdr*exp2(settings.y));`,`let o=toDisplayStraight(hdr*exp2(settings.y),s.a);`);if(D===T)throw o(`failed`,`Bloom: the composite has no display output to make straight`);var O=e=>s(e)?d(e,D):T;function k(e,t,n){return e.createBindGroup({layout:t.getBindGroupLayout(0),entries:n.flatMap((e,t)=>e?[{binding:t,resource:e}]:[])})}var A=class n{coreRequirement=e(`1.0.0`,import.meta.url);constructor(e={}){this.options=e,this.name=`bloom`,this.passes=[],this.steps=[],this.levels=1,this.weighted=!1,this.weightValues=new Float32Array(5*C/4),this.textures=[],this.lists=[[],[]],this.linearShader=``,this.sourceShader=``,this.scenePipelines=new Map,this.sceneOptions={},this.drawScene=e=>this.originalDraw(e??this.sceneOptions),this.values=new Float32Array(68),this.fresh=!0,this.attachment={view:void 0,loadOp:`clear`,storeOp:`store`},this.presentation={colorAttachments:[this.attachment]},this.disposed=!1,this.key=``,this.straight=!1,this.validate()}static attach(r,i={}){t(r,e(`1.0.0`,import.meta.url));let a=new n(i);return g(r).use(a),a}get depthTexture(){return this.host?this.host.depthTexture:this.textures[1]}get sceneTexture(){return this.host?void 0:this.textures[0]}joinStack(e){if(this.engine||this.host||this.disposed)throw o(`attached`,`Bloom is already attached; create a new Bloom`);return this.host=e,{kind:`hdr`,render:(e,t,n)=>this.stage(e,t,n)}}validate(){let e=this.options.strength??.8,t=this.options.threshold??1,n=this.options.exposure??0,r=this.options.radius??.5;if(!y.includes(this.options.fireflies??`temporal`))throw RangeError(`Invalid bloom fireflies; use 'temporal', 'karis' or 'none'.`);if(!Number.isFinite(r)||r<0||r>1||!Number.isFinite(e)||e<0||e>4||!Number.isFinite(t)||t<0||t>100||!Number.isFinite(n)||Math.abs(n)>10)throw RangeError(`Invalid bloom options; use finite values: radius 0-1, strength 0-4, threshold 0-100, exposure -10 to 10.`)}setup(e){if(this.disposed||!e.gpu)throw o(this.disposed?`disposed`:`unsupported`,`Bloom requires WebGPU and a live effect; attach a new Bloom to a WebGPU engine; see https://margoengine.com/errors#webgpu`);if(!this.host&&(e.hasPlugin(`ssao`)||e.hasPlugin(`post-processing`)||e.hasPlugin(`tonemap`)||e.hasPlugin(`dof`)))throw o(`state`,`Bloom owns the output target; remove the other post effect first`);this.engine=e,this.initialize(e.gpu)}initialize(e){i(e,`Bloom HDR processing`,`half-float`),this.uniform=e.createBuffer({size:272,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.sampler=e.createSampler({magFilter:`linear`,minFilter:`linear`});let t=e.createShaderModule({code:x});this.passes=[`prefilter`,`down`,`up`].map(n=>e.createComputePipeline({layout:`auto`,compute:{module:t,entryPoint:n}}))}encodeImage(e,t,n){if(this.disposed)throw o(`disposed`,`Bloom.encodeImage: create a new Bloom after disposal`);if(this.engine||this.host)throw o(`state`,`Bloom.encodeImage: this Bloom is attached to an engine; use a separate unattached Bloom`);this.validate();for(let t of[e.width,e.height])if(!Number.isInteger(t)||t<1||t>(e.device.limits.maxTextureDimension2D??16384))throw RangeError(`Bloom.encodeImage: image dimensions must be positive integers within the device texture limit`);if(this.imageDevice&&this.imageDevice!==e.device)throw o(`state`,`Bloom.encodeImage: the GPU device changed; use a new Bloom for the new device`);this.imageDevice||=(this.initialize(e.device),e.device),this.stage(e,t,{view:n,format:`rgba16float`,multisample:{count:1},hdr:!0})}registerPasses(e){this.host||(e.add({name:`bloom:capture`,order:-60,execute:e=>{if(e.backend===`webgpu`){if(this.validate(),this.engine.hasPlugin(`ssao`)||this.engine.hasPlugin(`post-processing`)||this.engine.hasPlugin(`tonemap`)||this.engine.hasPlugin(`dof`))throw o(`state`,`Bloom cannot share its output target; put both effects in one PostStack`);if(this.resize(e),this.original=e.color,this.originalDepth=e.depth,this.originalFormat=e.format,this.sourceShader!==e.shader){let t=r(e.shader);if(t===e.shader)throw o(`unsupported`,l(`Bloom`));this.sourceShader=e.shader,this.linearShader=t}this.capture.begin(e),e.shader=this.linearShader}}}),e.add({name:`bloom:scene-pipeline`,order:-.25,execute:e=>{if(e.backend!==`webgpu`)return;let t=this.scenePipelines.get(e.shader);if(!t){let n=e.device.createShaderModule({code:e.shader});t=e.device.createRenderPipeline({...e.descriptor,layout:`auto`,vertex:{...e.descriptor.vertex,module:n},fragment:{...e.descriptor.fragment,module:n,targets:[{format:this.textures[0].format}]}}),this.scenePipelines.set(e.shader,t)}this.sceneOptions.pipeline=t,e.draw!==this.drawScene&&(this.originalDraw=e.draw),e.draw=this.drawScene}}),e.add({name:`bloom:present`,order:30,execute:e=>{e.backend===`webgpu`&&this.draw(e)}}))}resize(e){if(this.textures[0]?.width===e.width&&this.textures[0]?.height===e.height&&this.originalFormat===e.format&&this.straight===s(this.engine)&&this.textures[1]?.format===e.descriptor.depthStencil.format&&this.capture?.samples===(e.descriptor.multisample?.count??4))return;(this.textures[1]?.format!==e.descriptor.depthStencil.format||this.capture?.samples!==(e.descriptor.multisample?.count??4))&&this.scenePipelines.clear(),this.capture?.dispose(),this.capture=void 0;for(let e of this.textures)e.destroy();this.textures=[];let t=e.device;this.textures.push(t.createTexture({size:[e.width,e.height],format:p(t,e.descriptor.multisample?.count??4),usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC})),this.textures.push(t.createTexture({size:[e.width,e.height],format:e.descriptor.depthStencil.format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING})),this.allocate(t,Math.max(1,Math.ceil(e.width/2)),Math.max(1,Math.ceil(e.height/2))),this.scene=this.textures[0].createView(),this.depth=this.textures[1].createView(),this.straight=s(this.engine),this.present=h(t,O(this.engine),e.format,{multisample:e.descriptor.multisample}),this.link(t,this.scene),this.capture=new c(t,this.textures[0],this.textures[1],e.descriptor.multisample?.count??4)}allocate(e,t,n){this.levels=Math.min(6,32-Math.clz32(Math.min(t,n))),this.fresh=!0;let r=a(e);this.lists=[this.levels,Math.max(1,this.levels-1)].map(i=>{let a=[];for(let o=0;o<(r?i:1);o++){let s=e.createTexture({size:[Math.max(1,t>>o),Math.max(1,n>>o)],mipLevelCount:r?1:i,format:`rgba16float`,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});this.textures.push(s),a.push(s)}return a})}link(e,t){this.weighted=(this.options.radius??.5)!==.5,this.group=k(e,this.present,[t,this.chain(e,t),{buffer:this.uniform},this.sampler]),this.source=t}chain(e,t){this.weighted&&(this.weights??=e.createBuffer({size:this.weightValues.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.weightedUp??=e.createComputePipeline({layout:`auto`,compute:{module:e.createShaderModule({code:S}),entryPoint:`up`}}));let[n,r]=this.lists,i=n[0],[a,o]=this.passes,s=this.weighted?this.weightedUp:this.passes[2],c=this.levels,l=(e,t)=>e[1]?e[t].createView():e[0].createView({baseMipLevel:t,mipLevelCount:1}),u=Array.from({length:c},(e,t)=>l(n,t)),d=Array.from({length:c-1},(e,t)=>l(r,t)),f=[],p=(t,n,r)=>f.push([t,k(e,t,r),Math.ceil(Math.max(1,i.width>>n)/8),Math.ceil(Math.max(1,i.height>>n)/8)]);for(let e=0;e<c;e++)p(e?o:a,e,[e?u[e-1]:t,this.sampler,u[e],e?void 0:c>1?u[c-1]:l(r,0),{buffer:this.uniform},e?void 0:{buffer:this.uniform,offset:C,size:16}]);for(let e=c-2;e>=0;e--)p(s,e,[d[e+1]??u[e+1],this.sampler,d[e],u[e],this.weighted?{buffer:this.weights,offset:e*C,size:16}:void 0]);return this.steps=f,d[0]??u[0]}draw(e){this.capture.resolve(e.encoder,!0),this.apply(e,this.original,this.originalFormat),this.capture.restore(e),e.draw=this.originalDraw}stage(e,t,n){this.validate();let r=e.device,i=Math.max(1,Math.ceil(e.width/2)),a=Math.max(1,Math.ceil(e.height/2)),o=n.format+n.multisample.count+n.hdr+s(this.engine);if(this.lists[0][0]?.width!==i||this.lists[0][0].height!==a){for(let e of this.textures)e.destroy();this.textures=[],this.source=void 0,this.allocate(r,i,a)}this.key!==o&&(this.key=o,this.source=void 0,this.present=h(r,n.hdr?E:O(this.engine),n.format,{multisample:n.multisample})),this.source!==t&&this.link(r,t),this.apply(e,n.view,n.format)}apply(e,t,n){this.values[0]=(this.options.strength??.8)/this.levels,this.values[1]=this.options.exposure??0,this.values[2]=n.includes(`8unorm`)?1/255:0,this.values[3]=this.options.threshold??1;let r=this.options.fireflies??`temporal`,i=r===`none`||r===`temporal`&&(this.fresh||this.levels<2);this.values[C/4]=+(r===`temporal`),this.values[65]=i?3e38:0,this.fresh=!1,e.device.queue.writeBuffer(this.uniform,0,this.values);let a=this.options.radius??.5;if(a!==.5!==this.weighted&&this.link(e.device,this.source),this.weighted){let t=w(a,this.levels);for(let e=0;e<this.levels-1;e++)this.weightValues[e*C/4]=t[e],this.weightValues[e*C/4+1]=e===this.levels-2?t[e+1]:1;e.device.queue.writeBuffer(this.weights,0,this.weightValues)}let o=e.encoder.beginComputePass();for(let e=0;e<this.steps.length;e++){let t=this.steps[e];o.setPipeline(t[0]),o.setBindGroup(0,t[1]),o.dispatchWorkgroups(t[2],t[3])}o.end(),this.attachment.view=t,this.attachment.loadOp=f(e,`clear`);let s=e.encoder.beginRenderPass(this.presentation);s.setPipeline(this.present),s.setBindGroup(0,this.group),m(s,e),s.draw(3),s.end()}release(){this.capture?.dispose(),this.capture=void 0,this.uniform?.destroy(),this.weights?.destroy();for(let e of this.textures)e.destroy();this.uniform=this.weights=this.sampler=this.group=this.present=this.weightedUp=void 0,this.weighted=!1,this.passes=[],this.steps=[],this.textures=[],this.lists=[[],[]],this.scene=this.depth=this.original=this.originalDepth=void 0,this.originalFormat=void 0,this.sourceShader=this.linearShader=this.key=``,this.source=void 0,this.scenePipelines.clear(),this.sceneOptions.pipeline=void 0,this.originalDraw=void 0,this.imageDevice=void 0}onDeviceRestored(e){if(!this.disposed){this.release();try{this.setup(e)}catch(e){throw this.dispose(),e}}}dispose(){this.disposed||(this.disposed=!0,this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.engine=void 0)}[Symbol.dispose??Symbol()](){this.dispose()}};export{A as Bloom,w as bloomWeights};