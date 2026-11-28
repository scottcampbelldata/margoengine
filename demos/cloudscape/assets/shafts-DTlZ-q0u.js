import{a as e,n as t,o as n,r,t as i}from"./validate-kwD6NxR0.js";import{_ as a,b as o,c as s,d as c,f as l,g as u,h as d,l as f,m as p,o as m,p as h,s as g,u as _,v,y}from"./native-DOR7KMwp.js";var b=(e,t=`1.0.0`,n=import.meta.url)=>r(e,t,n),x={intensity:.1,anisotropy:.6,decay:.97,length:.9,samples:48,cloudSamples:12},S=`
struct Shafts {inverse:mat4x4f,eye:vec4f,sun:vec4f,color:vec4f,screen:vec4f,params:vec4f,rect:vec4f}
@group(0) @binding(0) var<uniform> shafts:Shafts;
fn shaftNoise(p:vec2f)->f32 {return fract(52.9829189*fract(dot(p,vec2f(0.06711056,0.00583715))));}
fn shaftRay(uv:vec2f)->vec3f {
 let a=shafts.inverse*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,0.000001,1);let b=shafts.inverse*vec4f(uv.x*2.0-1.0,1.0-uv.y*2.0,1.0,1);
 return normalize(a.xyz/a.w-b.xyz/b.w)*select(-1.0,1.0,(b.w-a.w)*a.w*b.w>0.0);
}
`,C=`${f}
@group(0) @binding(2) var<uniform> shaftClouds:Clouds;
@group(0) @binding(3) var shaftShape:texture_3d<f32>;
@group(0) @binding(4) var shaftErosion:texture_3d<f32>;
@group(0) @binding(5) var shaftSampler:sampler;
fn shaftExit(c:Clouds,p:vec3f,s:vec3f,h:f32)->f32 {
 let R=c.eye.w;let b=dot(p,s)+R*s.y;let k=dot(p,p)+2.0*R*(p.y-h)-h*h;let root=sqrt(max(b*b-k,0.0));
 return select(-b+root,-k/(b+root),b>0.0);
}
fn shaftCloudsOpen(d:vec3f,jitter:f32)->f32 {
 let c=shaftClouds;let e=c.eye.xyz;if(c.layer.z<=0.0){return 1.0;}
 let altitude=cloudAltitude(c,e);if(altitude>c.layer.y){return 1.0;}
 var start=0.0;
 if(altitude<c.layer.x){if(dot(d,normalize(vec3f(e.x,e.y+c.eye.w,e.z)))<=0.0){return 1.0;}start=shaftExit(c,e,d,c.layer.x);}
 let end=min(shaftExit(c,e,d,c.layer.y),start+c.shape.z);
 let n=u32(c.shape.w);let dt=(end-start)/f32(n);var od=0.0;
 for(var i=0u;i<n;i++){od+=cloudDensityAt(c,shaftShape,shaftErosion,shaftSampler,e+d*(start+(f32(i)+jitter)*dt),true)*dt;}
 return exp(-od*c.layer.w);
}
`,w=(e,t)=>`${v}${S}${e}${t?C:``}
@fragment fn mask(i:Vertex)->@location(0) vec4f {
 let full=vec2i(textureDimensions(sceneDepth));let base=vec2i(i.position.xy)*2;var open=0.0;
 for(var k=0;k<4;k++){if(sceneDepthAt(min(base+vec2i(k&1,k>>1),full-1))<=0.0){open+=0.25;}}
 ${t?`if(open>0.0){let view=(i.uv-shafts.rect.xy)/shafts.rect.zw;open*=shaftCloudsOpen(shaftRay(view),shaftNoise(i.position.xy));}`:``}
 return vec4f(open,0,0,1);
}
`,T=`${v}${S}${d}
@group(0) @binding(1) var shaftMask:texture_2d<f32>;
@group(0) @binding(2) var maskSampler:sampler;
@fragment fn composite(i:Vertex)->@location(0) vec4f {
 let f=shafts;let n=u32(f.screen.w);let step=(f.screen.xy-i.uv)*f.screen.z/f32(n);
 var uv=i.uv+step*shaftNoise(i.position.xy);var weight=1.0;var sum=0.0;var total=0.0;
 for(var k=0u;k<n;k++){
  sum+=textureSampleLevel(shaftMask,maskSampler,f.rect.xy+clamp(uv,vec2f(0),vec2f(1))*f.rect.zw,0.0).r*weight;
  total+=weight;weight*=f.params.x;uv+=step;
 }
 let g=f.params.y;let nu=dot(shaftRay(i.uv),f.sun.xyz);
 let phase=(1.0-g*g)/pow(max(1.0+g*g-2.0*g*nu,0.0001),1.5)/12.566371;
 var light=f.color.rgb*phase*(sum/total)*f.sun.w;
 if(f.color.w>0.5){light=toDisplay(light);}
 return vec4f(light,1);
}
`,E=(e,t,n)=>Number.isFinite(e)&&e>=t&&e<=n,D=class r{coreRequirement=n(`1.0.0`,import.meta.url);constructor(e){this.options=e,this.name=`sky:shafts`,this.maskKey=``,this.blurKey=``,this.disposed=!1,this.values=new Float32Array(48),this.cloudValues=new Float32Array(232),this.scratch=new Float64Array(52),this.color=new Float32Array(3),this.validate()}static attach(t,i){e(t,n(`1.0.0`,import.meta.url));let a=new r(i);return b(t).use(a),a}validate(){let e=this.options;if(typeof e!=`object`||!e||typeof e.depth!=`function`)throw TypeError(`LightShafts needs a depth function returning the scene depth texture; pass {depth}`);if(e.sky!==void 0&&(typeof e.sky!=`object`||e.sky===null||!(e.sky.sun?.length>=3)))throw TypeError(`LightShafts sky must be a Sky (with a sun direction); pass the sky whose sun casts the shafts`);if(e.clouds!==void 0&&(typeof e.clouds?.options!=`object`||!(e.clouds.drift?.length>=3)))throw TypeError(`LightShafts clouds must be VolumetricClouds; pass the clouds the light comes through`);if(e.sunDirection&&i(e.sunDirection,3,`LightShafts sunDirection`),e.sunDirection&&!(Math.hypot(...e.sunDirection)>0))throw RangeError(`LightShafts sunDirection needs a nonzero length`);let t=e.samples??x.samples,n=e.cloudSamples??x.cloudSamples;if(!E(e.intensity??x.intensity,0,100)||!E(e.anisotropy??x.anisotropy,0,.95)||!E(e.decay??x.decay,.5,1)||!E(e.length??x.length,.05,1)||!Number.isInteger(t)||!E(t,8,128)||!Number.isInteger(n)||!E(n,2,64)||!E(e.sunIlluminance??10,0,1e6))throw RangeError(`Invalid LightShafts options; keep intensity 0 to 100, anisotropy 0 to 0.95, decay 0.5 to 1, length 0.05 to 1, integer samples 8 to 128 and cloudSamples 2 to 64, and sunIlluminance 0 or more.`)}setup(e){if(this.disposed||!e.gpu)throw new t(this.disposed?`disposed`:`unsupported`,`LightShafts requires WebGPU; attach new LightShafts to a WebGPU engine; see https://margoengine.com/errors#webgpu`);this.engine=e;let n=e.gpu;this.uniform=n.createBuffer({size:this.values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.sampler=n.createSampler({magFilter:`linear`,minFilter:`linear`})}registerPasses(e){e.add({name:`sky:shafts`,order:4.5,execute:e=>{e.backend===`webgpu`&&this.draw(e)}})}onPreUpdate(e){if(this.validate(),!Number.isFinite(e)||e<0)throw RangeError(`Invalid LightShafts delta; pass a finite delta of 0 or more seconds.`)}write(e){let n=this.options,r=this.values,i=n.sky,o=i?.sun??n.sunDirection??[.3,.6,.4],s=Math.hypot(o[0],o[1],o[2])||1,c=e.camera.matrix;if(!p(c,r.subarray(0,16),this.scratch))throw new t(`state`,`Invalid LightShafts camera; give the camera a finite, invertible projection`);let l=[o[0]/s,o[1]/s,o[2]/s],d=c[0]*l[0]+c[4]*l[1]+c[8]*l[2],f=c[1]*l[0]+c[5]*l[1]+c[9]*l[2],m=c[3]*l[0]+c[7]*l[1]+c[11]*l[2],h=Math.min(1,Math.max(0,m/.25)),g=h*h*(3-2*h);if(i?.sunTransmittance)for(let e=0;e<3;e++)this.color[e]=i.sunTransmittance[e];else a(l[1],.001,i?.options.turbidity??2,this.color);let _=(n.sunIlluminance??i?.sunIlluminance??(i&&(i.options.model??`preetham`)===`preetham`?10:20))*2**(i?.options.exposure??0)*(i?.pictureScale??1)*(n.intensity??x.intensity);if(!(g>0&&_>0&&Math.max(this.color[0],this.color[1],this.color[2])>0))return!1;r.set(e.camera.position,16),r.set(l,20),r[23]=g;for(let e=0;e<3;e++)r[24+e]=this.color[e]*_;r[27]=+!u(e.format),r[28]=d/m*.5+.5,r[29]=.5-f/m*.5,r[30]=n.length??x.length,r[31]=n.samples??x.samples,r[32]=n.decay??x.decay,r[33]=n.anisotropy??x.anisotropy;let v=y(e);return v?r.set([v[0]/e.width,v[1]/e.height,v[2]/e.width,v[3]/e.height],36):r.set([0,0,1,1],36),e.device.queue.writeBuffer(this.uniform,0,r),!0}writeClouds(e,t){let n=this.cloudValues;n.set(e.camera.position,16),c(n,t.options,t.drift,t.time??0),n[34]=t.options.maxDistance??8e4,n[35]=this.options.cloudSamples??x.cloudSamples,this.cloudUniform??=e.device.createBuffer({size:n.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.volumes??=new m(e.device),this.volumes.fill(e.device,e.encoder),e.device.queue.writeBuffer(this.cloudUniform,0,n)}draw(e){if(!this.uniform)return;let t=h(e,this.options.depth,`LightShafts`);if(!t||!this.write(e))return;let n=e.device,r=this.options.clouds,i=Math.max(1,Math.ceil(e.width/2)),a=Math.max(1,Math.ceil(e.height/2)),c=r?s(r.options):void 0;if(r&&g(r.options)&&!c)return;r&&this.writeClouds(e,r),(!this.mask||this.mask.width!==i||this.mask.height!==a)&&(this.mask?.destroy(),this.mask=n.createTexture({size:[i,a],format:`r16float`,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING}),this.blurGroup=void 0,this.bound=void 0);let u=`${t.samples}:${!!r}:${!!c}`;if(this.maskKey!==u){let e=n.createShaderModule({code:_(w(l(1,t.samples),!!r),c)});this.maskPipeline=n.createRenderPipeline({layout:`auto`,vertex:{module:e,entryPoint:`vertex`},fragment:{module:e,entryPoint:`mask`,targets:[{format:`r16float`}]}}),this.maskKey=u,this.bound=void 0}this.bound!==t.texture&&(this.maskGroup=n.createBindGroup({layout:this.maskPipeline.getBindGroupLayout(0),entries:[{binding:1,resource:t.resource},...r?[{binding:0,resource:{buffer:this.uniform}},{binding:2,resource:{buffer:this.cloudUniform}},{binding:3,resource:this.volumes.shape.createView()},{binding:4,resource:this.volumes.erosion.createView()},{binding:5,resource:this.volumes.sampler}]:[]]}),this.bound=t.texture);let d=`${e.format}:${e.descriptor.multisample?.count??1}`;if(this.blurKey!==d){let t=n.createShaderModule({code:T});this.blurPipeline=n.createRenderPipeline({layout:`auto`,vertex:{module:t,entryPoint:`vertex`},fragment:{module:t,entryPoint:`composite`,targets:[{format:e.format,blend:{color:{srcFactor:`one`,dstFactor:`one`,operation:`add`},alpha:{srcFactor:`zero`,dstFactor:`one`,operation:`add`}}}]},multisample:e.descriptor.multisample}),this.blurKey=d,this.blurGroup=void 0}this.blurGroup??=n.createBindGroup({layout:this.blurPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:this.mask.createView()},{binding:2,resource:this.sampler}]});let f=e.encoder.beginRenderPass({colorAttachments:[{view:this.mask.createView(),loadOp:`clear`,clearValue:[0,0,0,0],storeOp:`store`}]});f.setPipeline(this.maskPipeline),f.setBindGroup(0,this.maskGroup),f.draw(3),f.end();let p=e.encoder.beginRenderPass({colorAttachments:[{view:e.color,loadOp:`load`,storeOp:`store`}]});o(p,e),p.setPipeline(this.blurPipeline),p.setBindGroup(0,this.blurGroup),p.draw(3),p.end()}release(){this.uniform?.destroy(),this.cloudUniform?.destroy(),this.volumes?.dispose(),this.mask?.destroy(),this.uniform=this.cloudUniform=this.volumes=this.mask=this.sampler=void 0,this.maskPipeline=this.blurPipeline=this.maskGroup=this.blurGroup=this.bound=void 0,this.maskKey=this.blurKey=``}onDeviceRestored(e){this.release(),this.setup(e)}dispose(){this.disposed||(this.disposed=!0,this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.engine=void 0)}[Symbol.dispose??Symbol()](){this.dispose()}};export{D as LightShafts};