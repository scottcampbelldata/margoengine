import{c as e,d as t,l as n,o as r,s as i,u as a}from"./native-DOR7KMwp.js";function o(o,s={}){if(!o||typeof o.options!=`object`||!(o.drift?.length>=3))throw TypeError(`volumetricCloudShadows needs VolumetricClouds; pass the clouds whose shadows these are`);let c=new Float32Array(232),l,u,d,f=0,p=!1;return{options:s,get call(){return`vec3f(shadowFxVolume${f}(position))`},get revision(){return i(o.options)&&e(o.options)?1:0},wgsl(t,r){f=r;let i=e(o.options);return p=!!i,`${a(n,i).replace(/\bcloud(Remap|Altitude|DensityAt|LightDepth|Base|Storm[A-Za-z]*)\b/g,`shadowFxCloud$1${r}`).replace(/\bClouds\b/g,`ShadowFxClouds${r}`)}
@group(${t}) @binding(${r}) var<uniform> shadowFxCloudFrame${r}:ShadowFxClouds${r};
@group(${t}) @binding(${r+1}) var shadowFxCloudShape${r}:texture_3d<f32>;
@group(${t}) @binding(${r+2}) var shadowFxCloudErosion${r}:texture_3d<f32>;
@group(${t}) @binding(${r+3}) var shadowFxCloudSampler${r}:sampler;
fn shadowFxCloudExit${r}(c:ShadowFxClouds${r},p:vec3f,s:vec3f,h:f32)->f32 {
 let R=c.eye.w;let b=dot(p,s)+R*s.y;let k=dot(p,p)+2.0*R*(p.y-h)-h*h;let root=sqrt(max(b*b-k,0.0));
 return select(-b+root,-k/(b+root),b>0.0);
}
fn shadowFxVolume${r}(position:vec3f)->f32 {
 let c=shadowFxCloudFrame${r};let s=c.sun.xyz;
 if(c.layer.z<=0.0||c.flags.y<=0.0||s.y<=0.0){return 1.0;}
 let altitude=shadowFxCloudAltitude${r}(c,position);if(altitude>=c.layer.y){return 1.0;}
 let enter=select(0.0,shadowFxCloudExit${r}(c,position,s,c.layer.x),altitude<c.layer.x);
 let leave=shadowFxCloudExit${r}(c,position,s,c.layer.y);
 let n=u32(c.shape.w);let dt=(leave-enter)/f32(n);var od=0.0;
 for(var i=0u;i<n;i++){
  od+=shadowFxCloudDensityAt${r}(c,shadowFxCloudShape${r},shadowFxCloudErosion${r},shadowFxCloudSampler${r},position+s*(enter+(f32(i)+0.5)*dt),true)*dt;
 }
 return mix(1.0,exp(-od*c.layer.w),c.flags.y);
}
`},resources(){return[{buffer:l},u.shape.createView(),u.erosion.createView(),u.sampler]},setup(e){d!==e&&(this.dispose(),d=e,l=e.createBuffer({size:c.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),u=new r(e))},update(e){let{strength:n=1,samples:r=12}=this.options,{device:a,encoder:s}=e.context;if(!(n>=0&&n<=1))throw RangeError(`Invalid cloud shadow strength; use a number from 0 to 1`);if(!Number.isInteger(r)||r<2||r>64)throw RangeError(`Invalid cloud shadow samples; use an integer from 2 to 64`);u.fill(a,s),t(c,o.options,o.drift,o.time??0);for(let t=0;t<3;t++)c[20+t]=e.light[t];c[35]=r,c[41]=i(o.options)&&!p?0:n,a.queue.writeBuffer(l,0,c)},dispose(){l?.destroy(),u?.dispose(),l=u=d=void 0}}}export{o as volumetricCloudShadows};