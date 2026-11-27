import{n as e,t}from"./version-DZ3BcJze.js";import{n}from"./extension-BytumP3S.js";import{r,s as i}from"./pass-Ds4X-3Cx-RvEACC2X.js";import{a,i as o,n as s,r as c}from"./dist-Dgi2wPiM.js";import{n as l,t as u}from"./cloud-types-K__RieAz-DLYFNbfD.js";import{o as d}from"./mat4-Dl2hqlTt.js";import{t as f}from"./errors-DkwPZuAq.js";import{t as p}from"./validate-ChuY9rdH.js";import{t as m}from"./preload-helper-CRzLMJPS.js";function h(e,t,n){let r=a(e),i=t?t():r?.resolvedDepth;if(!i)return;let o=e.descriptor.multisample?.count??1;if(!i.format.startsWith(`depth`)||i.dimension!==`2d`||i.depthOrArrayLayers!==1||i.width!==e.width||i.height!==e.height||!(i.usage&GPUTextureUsage.TEXTURE_BINDING)||i.sampleCount!==1&&i.sampleCount!==o)throw RangeError(`${n} requires sampleable scene depth matching the viewport; pass the scene's depth texture`);let s=r?.samples===4&&r.resolvedDepth===i?r.depthSource:void 0;return s?{resource:s,texture:s,samples:4}:{resource:i.createView({aspect:`depth-only`}),texture:i,samples:i.sampleCount}}function g(e,t){return t===1?`@group(0) @binding(${e}) var sceneDepth:texture_depth_2d;
fn sceneDepthAt(pixel:vec2i)->f32 {return textureLoad(sceneDepth,pixel,0);}
`:`@group(0) @binding(${e}) var sceneDepth:texture_depth_multisampled_2d;
fn sceneDepthAt(pixel:vec2i)->f32 {return textureLoad(sceneDepth,pixel,0);}
`}var _=(e,t=`0.1.0`,r=import.meta.url)=>n(e,t,r),v=636e4,y={coverage:.5,bottom:1500,top:4e3,density:.04,scale:14e3,evolution:3,steps:64,lightSteps:6,maxDistance:8e4,sunIntensity:.55,stepCap:150,groundAlbedo:.2},b=[.3,.6,.4],x=.17,S=[[.22,.3,.45],[.015,.018,.012]],C=`
fn cloudHash3(p:vec3u)->vec3f {
 var v=p*1664525u+1013904223u;
 v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;v^=v>>vec3u(16u);
 v.x+=v.y*v.z;v.y+=v.z*v.x;v.z+=v.x*v.y;
 return vec3f(v)*2.3283064e-10;
}
`,w=`${C}
@group(0) @binding(0) var volume:texture_storage_3d<rgba8unorm,write>;
fn wrapCell(c:vec3i,period:i32)->vec3u {return vec3u(((c%period)+period)%period);}
fn worley(p:vec3f,period:i32)->f32 {
 let cell=vec3i(floor(p));let f=fract(p);var best=3.0;
 for(var z=-1;z<=1;z++){for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
  let o=vec3i(x,y,z);let d=vec3f(o)+cloudHash3(wrapCell(cell+o,period))-f;best=min(best,dot(d,d));
 }}}
 return clamp(1.0-sqrt(best),0.0,1.0);
}
fn worleyFbm(p:vec3f,period:i32)->f32 {return worley(p,period)*0.625+worley(p*2.0,period*2)*0.25+worley(p*4.0,period*4)*0.125;}
fn gradientNoise(p:vec3f,period:i32)->f32 {
 let cell=vec3i(floor(p));let f=fract(p);let u=f*f*f*(f*(f*6.0-15.0)+10.0);var v=array<f32,8>();
 for(var i=0;i<8;i++){
  let o=vec3i(i&1,(i>>1)&1,(i>>2)&1);let g=normalize(cloudHash3(wrapCell(cell+o,period))*2.0-1.0+vec3f(0.0001));
  v[i]=dot(g,f-vec3f(o));
 }
 return mix(mix(mix(v[0],v[1],u.x),mix(v[2],v[3],u.x),u.y),mix(mix(v[4],v[5],u.x),mix(v[6],v[7],u.x),u.y),u.z);
}
fn perlinFbm(p:vec3f,period:i32)->f32 {
 var sum=0.0;var weight=0.5;var q=p;var n=period;
 for(var i=0;i<4;i++){sum+=gradientNoise(q,n)*weight;q*=2.0;n*=2;weight*=0.5;}
 return clamp(sum*1.1+0.5,0.0,1.0);
}
@compute @workgroup_size(4,4,4) fn shape(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(volume);if(any(id>=size)){return;}let p=(vec3f(id)+0.5)/vec3f(size);
 let w=worleyFbm(p*4.0,4);
 let perlinWorley=clamp((perlinFbm(p*4.0,4)-(w-1.0))/(2.0-w),0.0,1.0);
 textureStore(volume,vec3i(id),vec4f(perlinWorley,w,worleyFbm(p*8.0,8),worleyFbm(p*16.0,16)));
}
@compute @workgroup_size(4,4,4) fn erosion(@builtin(global_invocation_id) id:vec3u){
 let size=textureDimensions(volume);if(any(id>=size)){return;}let p=(vec3f(id)+0.5)/vec3f(size);
 textureStore(volume,vec3i(id),vec4f(worleyFbm(p*2.0,2),worleyFbm(p*4.0,4),worleyFbm(p*8.0,8),1));
}
`,T=`
struct Clouds {inverse:mat4x4f,eye:vec4f,sun:vec4f,sunColor:vec4f,layer:vec4f,shape:vec4f,wind:vec4f,flags:vec4f,moon:vec4f,moonColor:vec4f,flash:vec4f,flashColor:vec4f,look:vec4f,storm:array<vec4f,8>}
fn cloudRemap(x:f32,a:f32,b:f32)->f32 {return (x-a)/max(b-a,0.00001);}
fn cloudAltitude(c:Clouds,p:vec3f)->f32 {let R=c.eye.w;return (dot(p,p)+2.0*R*p.y)/(length(vec3f(p.x,p.y+R,p.z))+R);}
fn cloudBase(s:vec4f)->f32 {let low=s.g*0.625+s.b*0.25+s.a*0.125;return clamp((clamp(cloudRemap(s.r,low-1.0,1.0),0.0,1.0)-0.67)/0.21,0.0,1.0);}
//[storm-fns]
fn cloudDensityAt(c:Clouds,shape:texture_3d<f32>,detail:texture_3d<f32>,smp:sampler,p:vec3f,erode:bool)->f32 {
 let h=(cloudAltitude(c,p)-c.layer.x)/(c.layer.y-c.layer.x);if(h<=0.0||h>=1.0){return 0.0;}
//[storm-branch]
 let q=(p+vec3f(c.wind.x,c.wind.z,c.wind.y))*c.shape.x;
 let s=textureSampleLevel(shape,smp,q.xzy,0.0);
 let weather=textureSampleLevel(shape,smp,vec3f((p.xz+c.flags.zw)*c.shape.x*${x},0.37),0.0).g;
 let cover=clamp(c.layer.z*(1.0+2.5*(weather-0.48)),0.0,1.0);
 let low=s.g*0.625+s.b*0.25+s.a*0.125;
 let base=clamp((clamp(cloudRemap(s.r,low-1.0,1.0),0.0,1.0)-0.67)/0.21,0.0,1.0);
 let profile=smoothstep(0.0,0.12,h)*smoothstep(1.0,0.45,h);
 let cloud=clamp(cloudRemap(base*profile,1.0-cover,1.0),0.0,1.0)*cover;
 if(cloud<=0.0||!erode){return cloud;}
 let e=textureSampleLevel(detail,smp,((p+vec3f(c.wind.x,c.wind.z*2.0,c.wind.y)*1.5)*c.shape.y).xzy,0.0).rgb;
 let high=e.r*0.625+e.g*0.25+e.b*0.125;
 return clamp(cloudRemap(cloud,mix(high,1.0-high,clamp(h*4.0,0.0,1.0))*0.35*c.look.x,1.0),0.0,1.0);
}
fn cloudLightDepth(c:Clouds,shape:texture_3d<f32>,detail:texture_3d<f32>,smp:sampler,p:vec3f,l:vec3f,n:u32)->f32 {
 let reach=(c.layer.y-c.layer.x)*0.75/max(l.y,0.25);var od=0.0;var previous=0.0;
 for(var i=0u;i<n;i++){let f=(f32(i)+1.0)/f32(n);let t=reach*f*f;od+=cloudDensityAt(c,shape,detail,smp,p+l*(0.5*(t+previous)),false)*(t-previous);previous=t;}
 return od*c.layer.w;
}
`,E=`${C}${T}
@group(0) @binding(0) var<uniform> clouds:Clouds;
@group(0) @binding(1) var shapeNoise:texture_3d<f32>;
@group(0) @binding(2) var erosionNoise:texture_3d<f32>;
@group(0) @binding(3) var noiseSampler:sampler;
@group(0) @binding(4) var skyLight:texture_2d<f32>;
fn cloudShell(d:vec3f,h:f32)->vec2f {
 let e=clouds.eye.xyz;let R=clouds.eye.w;let b=dot(e,d)+R*d.y;let k=dot(e,e)+2.0*R*(e.y-h)-h*h;let disc=b*b-k;
 if(disc<0.0){return vec2f(-1.0);}
 let q=-(b+select(-sqrt(disc),sqrt(disc),b>=0.0));if(abs(q)<1e-6){return vec2f(0.0);}
 let roots=vec2f(q,k/q);return vec2f(min(roots.x,roots.y),max(roots.x,roots.y));
}
fn cloudHG(nu:f32,g:f32)->f32 {return (1.0-g*g)/pow(max(1.0+g*g-2.0*g*nu,0.0001),1.5);}
fn cloudPhaseK(nu:f32,k:f32)->f32 {return mix(cloudHG(nu,0.8*k),cloudHG(nu,-0.3*k),0.3);}
fn cloudTwoStream(a:f32,b:f32,nu:f32,u:f32)->f32 {
 let t=2.0/(2.0+0.15*(a+b));
 return max(0.0,0.5*(t*(1.0+0.15*b)-u)+0.75*(t-u)*nu);
}
fn cloudScatter(a:f32,b:f32,nu:f32)->f32 {
 let forward=exp(-0.15*a);let back=exp(-a);
 return 0.7*cloudHG(nu,0.8)*forward+0.3*cloudHG(nu,-0.3)*back+4.0*cloudTwoStream(a,b,nu,0.7*forward+0.3*back);
}
fn cloudSkyScatter(above:vec3f,below:vec3f,a:f32,b:f32,nu:f32)->vec3f {
 let t=2.0/(2.0+0.15*(a+b));
 return max(vec3f(0),t*(0.5*(above*(1.0+0.15*b)+below*(1.0+0.15*a))+0.75*nu*(above-below)));
}
fn cloudColumn(p:vec3f,dir:vec3f,reach:f32,n:u32)->f32 {
 var od=0.0;for(var i=0u;i<n;i++){od+=cloudDensityAt(clouds,shapeNoise,erosionNoise,noiseSampler,p+dir*(reach*(f32(i)+0.5)/f32(n)),false);}
 return od*reach/f32(n)*clouds.layer.w;
}
fn cloudAirPath(h0:f32,h1:f32,t:f32)->f32 {
 let a=exp(-h0/8000.0);let dh=max(h1,0.0)-h0;if(abs(dh)<1.0){return t*a;}return t*8000.0*(a-exp(-max(h1,0.0)/8000.0))/dh;
}
fn cloudStepPower(L:f32,n:f32,cap:f32)->f32 {
 if(cap<=0.0||L<=cap*n){return 1.0;}
 let ln=log(n);var p=max(1.0,log(L/cap)/ln);
 for(var i=0;i<8;i++){p=max(1.0,log(L*(exp2(p)-1.0)/cap)/ln);}
 return p;
}
fn cloudSpan(d:vec3f)->vec2f {
 let bottom=clouds.layer.x;let top=clouds.layer.y;let altitude=cloudAltitude(clouds,clouds.eye.xyz);
 var start=0.0;var end=-1.0;
 if(altitude<bottom){
  let up=normalize(vec3f(clouds.eye.x,clouds.eye.y+clouds.eye.w,clouds.eye.z));
  if(dot(d,up)>0.0){start=cloudShell(d,bottom).y;end=cloudShell(d,top).y;}
 } else if(altitude<=top){
  let low=cloudShell(d,bottom);end=select(cloudShell(d,top).y,low.x,low.x>0.0);
 } else {
  let high=cloudShell(d,top);
  if(high.x>0.0){start=high.x;let low=cloudShell(d,bottom);end=select(high.y,low.x,low.x>0.0);}
 }
 return vec2f(start,min(end,start+clouds.shape.z));
}
struct CloudLight {light:vec3f,scene:vec3f,opacity:f32}
fn cloudMarch(d:vec3f,start:f32,end:f32,n:u32,jitter:f32,glow:f32)->CloudLight {
 let bottom=clouds.layer.x;let top=clouds.layer.y;
 let span=end-start;let nf=f32(n);let power=cloudStepPower(span,nf,clouds.moonColor.w);let s=clouds.sun.xyz;let nu=dot(d,s);
 let lit=max(clouds.sunColor.r,max(clouds.sunColor.g,clouds.sunColor.b))>0.0;
 let above=textureLoad(skyLight,vec2i(0,0),0).rgb;let below=textureLoad(skyLight,vec2i(1,0),0).rgb+clouds.look.w*above;
 let m=clouds.moon.xyz;let nuMoon=dot(d,m);let moonLit=clouds.moon.w>0.0&&max(clouds.moonColor.r,max(clouds.moonColor.g,clouds.moonColor.b))>0.0;
 let lightN=u32(clouds.wind.w);let columnN=max(1u,(lightN+1u)/2u);let eyeHeight=max(cloudAltitude(clouds,clouds.eye.xyz),0.0);

 let ground=clouds.sunColor.rgb*clouds.sun.w*4.0*clouds.look.w*max(s.y,0.0);
 var t=start+span*pow(jitter/nf,power);
 var transmittance=1.0;var light=vec3f(0);var scene=vec3f(0);var opacity=0.0;
 for(var k=0u;k<n;k++){
  let next=start+span*pow((f32(k)+1.0+jitter)/nf,power);let dt=next-t;
  let p=clouds.eye.xyz+d*t;let density=cloudDensityAt(clouds,shapeNoise,erosionNoise,noiseSampler,p,true);
  if(density>0.0){
   let sigma=density*clouds.layer.w;
   let altitude=cloudAltitude(clouds,p);let up=normalize(vec3f(p.x,p.y+clouds.eye.w,p.z));let nuUp=dot(d,up);

   let below0=cloudColumn(p,-up,max(altitude-bottom,0.0),columnN);
   var sun=vec3f(0);var aUp=-1.0;
   if(lit){
    let a=cloudLightDepth(clouds,shapeNoise,erosionNoise,noiseSampler,p,s,lightN);let slant=max(s.y,0.25);aUp=a*slant;
    sun=clouds.sunColor.rgb*clouds.sun.w*cloudScatter(a,below0/slant,nu)+cloudSkyScatter(vec3f(0),ground,aUp,below0,nuUp);
   }
   var moon=vec3f(0);
   if(moonLit){
    let od=cloudLightDepth(clouds,shapeNoise,erosionNoise,noiseSampler,p,m,lightN);let slant=max(m.y,0.25);
    if(aUp<0.0){aUp=od*slant;}
    moon=clouds.moonColor.rgb*clouds.moon.w*0.15*(cloudScatter(od,below0/slant,nuMoon)+0.5*(cloudHG(nuMoon,glow)-cloudPhaseK(nuMoon,1.0))*exp(-0.15*od));
   }
   if(aUp<0.0){aUp=cloudColumn(p,up,max(top-altitude,0.0),columnN);}
   let sky=cloudSkyScatter(above,below,aUp,below0,nuUp);
   var flash=vec3f(0);
   if(clouds.flash.w>0.0){
    let toward=clouds.flash.xyz-p;let r2=dot(toward,toward);var od=0.0;
    for(var f=1u;f<=3u;f++){od+=cloudDensityAt(clouds,shapeNoise,erosionNoise,noiseSampler,p+toward*(f32(f)*0.25),false);}
    od*=clouds.layer.w*sqrt(r2)*0.25;
    flash=clouds.flashColor.rgb*clouds.flash.w*(exp(-od)+0.5*exp(-0.3*od)+0.25*exp(-0.08*od))/(r2+clouds.flashColor.w*clouds.flashColor.w);
   }
   let step=exp(-sigma*dt);let haze=exp(-cloudAirPath(eyeHeight,altitude,t)/40000.0);let w=transmittance*(1.0-step)*haze;
   light+=w*(sun+sky+moon+flash);scene+=w*(sky+flash+clouds.look.y*sun+clouds.look.z*moon);opacity+=w;transmittance*=step;
   if(transmittance<0.01){break;}
  }
  t=next;
 }
 return CloudLight(light,scene,opacity);
}
`,D=e=>`${r}${E}${s}
${e}
@fragment fn fragment(i:Vertex)->@location(0) vec4f {
 let ndc=vec2f(i.uv.x*2.0-1.0,1.0-i.uv.y*2.0);let far=clouds.inverse*vec4f(ndc,0.000001,1);
 let d=normalize(far.xyz/far.w-clouds.eye.xyz);
 let span=cloudSpan(d);var end=span.y;
 ${e?`let z=sceneDepthAt(vec2i(i.position.xy));if(z>0.0){let w=clouds.inverse*vec4f(ndc,z,1);end=min(end,length(w.xyz/w.w-clouds.eye.xyz));}`:``}
 if(end<=span.x){discard;}
 let m=cloudMarch(d,span.x,end,u32(clouds.shape.w),fract(cloudHash3(vec3u(vec2u(i.position.xy),7u)).x+clouds.flags.y),0.95);
 if(m.opacity<=0.0){discard;}
 var color=m.light*clouds.sunColor.w;
 if(clouds.flags.x>0.5){color=toDisplay(color/m.opacity)*m.opacity;}
 return vec4f(color,m.opacity);
}
`,O=`${E}
@group(0) @binding(5) var deck:texture_storage_2d<rgba16float,write>;
@group(0) @binding(6) var deckLight:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(any(id.xy>=vec2u(64,32))){return;}
 var light=vec3f(0);var scene=vec3f(0);var opacity=0.0;
 for(var r=0u;r<4u;r++){
  let uv=(vec2f(id.xy)+vec2f(f32(r&1u),f32(r>>1u))*0.5+0.25)/vec2f(64,32);
  let phi=(uv.x-0.5)*6.2831853;let theta=uv.y*3.14159265;
  let d=vec3f(sin(theta)*cos(phi),cos(theta),sin(theta)*sin(phi));
  let span=cloudSpan(d);
  if(span.y>span.x){let m=cloudMarch(d,span.x,span.y,32u,(f32(r)+0.5)*0.25,0.8);light+=m.light;scene+=m.scene;opacity+=m.opacity;}
 }
 let k=0.25*clouds.sunColor.w;
 textureStore(deck,vec2i(id.xy),vec4f(light*k,opacity*0.25));
 textureStore(deckLight,vec2i(id.xy),vec4f(scene*k,opacity*0.25));
}
`,k=`${T}
@group(0) @binding(0) var<uniform> clouds:Clouds;
@group(0) @binding(1) var map:texture_2d<f32>;
@group(0) @binding(2) var lightOut:texture_storage_2d<rgba32float,write>;
var<workgroup> sums:array<vec4f,128>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) x:u32){
 var above=vec4f(0);var side=vec4f(0);
 for(var y=0u;y<16u;y++){let theta=(f32(y)+0.5)/32.0*3.14159265;let w=cos(theta)*sin(theta);above+=vec4f(textureLoad(map,vec2u(x,y),0).rgb*w,w);
  side+=vec4f(textureLoad(map,vec2u(x,31u-y),0).rgb*w,w);}
 sums[x]=above;sums[64u+x]=side;workgroupBarrier();
 for(var s=32u;s>0u;s=s>>1u){if(x<s){sums[x]+=sums[x+s];sums[64u+x]+=sums[64u+x+s];}workgroupBarrier();}
 if(x==0u){let unexpose=1.0/clouds.sunColor.w;
  textureStore(lightOut,vec2i(0,0),vec4f(sums[0].rgb/sums[0].w*unexpose,1));textureStore(lightOut,vec2i(1,0),vec4f(sums[64].rgb/sums[64].w*unexpose,1));}
}
`,A=class{constructor(e){this.filled=!1;let t=t=>e.createTexture({size:[t,t,t],dimension:`3d`,format:`rgba8unorm`,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});this.shape=t(64),this.erosion=t(32),this.sampler=e.createSampler({magFilter:`linear`,minFilter:`linear`,addressModeU:`repeat`,addressModeV:`repeat`,addressModeW:`repeat`})}fill(e,t){if(this.filled)return;let n=e.createShaderModule({code:w});for(let[r,i,a]of[[this.shape,`shape`,16],[this.erosion,`erosion`,8]]){let o=e.createComputePipeline({layout:`auto`,compute:{module:n,entryPoint:i}}),s=t.beginComputePass();s.setPipeline(o),s.setBindGroup(0,e.createBindGroup({layout:o.getBindGroupLayout(0),entries:[{binding:0,resource:r.createView()}]})),s.dispatchWorkgroups(a,a,a),s.end()}this.filled=!0}dispose(){this.shape.destroy(),this.erosion.destroy()}[Symbol.dispose??Symbol()](){this.dispose()}},j={cloud:.5},M={coverage:0,bottom:0,top:0,density:0},N={coverage:0,bottom:0,top:0,density:0};function P(e,t={coverage:0,bottom:0,top:0,density:0}){let n=e.type??(e.hurricane===void 0?void 0:`hurricane`),r=e.weather||n?l(e.weather??j,M,n):void 0;return t.coverage=e.coverage??r?.coverage??y.coverage,t.bottom=e.bottom??r?.bottom??y.bottom,t.top=e.top??r?.top??y.top,t.density=e.density??r?.density??y.density,t}var F,I,L,R=e=>e.hurricane!==void 0||e.type===`hurricane`;function z(){return I??=m(()=>import(`./storm-field-BBINzcyw-CM5BpLRS.js`).then(e=>F=e.stormField(x)),[],import.meta.url)}function B(e){if(L!==void 0)throw L;return!F&&R(e)&&z().catch(e=>L=e??Error(`storm field failed to load`)),F}var V=(e,t)=>t?e.replace(`//[storm-fns]`,t.fns).replace(`//[storm-branch]`,t.branch):e;function H(e,t,n,r=0){let i=t.scale??y.scale,a=P(t,N);e[19]=v,e[28]=a.bottom,e[29]=a.top,e[30]=a.coverage,e[31]=a.density,e[32]=1/i,e[33]=8/i,e[36]=n[0],e[37]=n[1],e[38]=n[2],e[42]=n[3]??0,e[43]=n[4]??0,e[60]=t.erosion??1,F?F.write(e,t,r,i):e.fill(0,64,96)}var U=(e,t,n)=>Number.isFinite(e)&&e>=t&&e<=n,W=class n{coreRequirement=e(`0.1.0`,import.meta.url);constructor(e={}){this.options=e,this.name=`sky:volumetric-clouds`,this.key=``,this.disposed=!1,this.frames=0,this.extra=0,this.pending=!1,this.seconds=0,this.values=new Float32Array(96),this.scratch=new Float64Array(52),this.color=new Float32Array(3),this.ambientValues=new Float32Array(8),this.layer={coverage:0,bottom:0,top:0,density:0},this.deckOf=e=>{if(this.options.dimLight===!1)return 1;let t=P(this.options,this.layer),n=F?.of(this.options);if(n){let e=this.engine?.camera.position??[0,0,0];t.coverage*=Math.min(1,F.coverOver(n,e[0],e[2],this.seconds,t.top-t.bottom))}return u(t,e)},this.drift=new Float64Array(5),this.validate()}static attach(r,i={}){t(r,e(`0.1.0`,import.meta.url));let a=new n(i);return _(r).use(a),a}validate(){let e=this.options;if(typeof e!=`object`||!e)throw TypeError(`VolumetricClouds options must be an object`);if(e.sky!==void 0&&(typeof e.sky!=`object`||e.sky===null||!(e.sky.sun?.length>=3)))throw TypeError(`VolumetricClouds sky must be a Sky (with a sun direction); pass the sky that lights the clouds`);if(e.temporal!==void 0&&typeof e.temporal!=`boolean`&&e.temporal!==`auto`)throw TypeError(`VolumetricClouds temporal must be true, false or 'auto'`);if(e.dimLight!==void 0&&typeof e.dimLight!=`boolean`)throw TypeError(`VolumetricClouds dimLight must be true or false`);if((e.weather!==void 0||e.type!==void 0)&&l(e.weather??j,void 0,e.type),e.hurricane!==void 0&&(typeof e.hurricane!=`object`||e.hurricane===null))throw TypeError(`VolumetricClouds hurricane must be a Hurricane or its options`);if(e.depth!==void 0&&typeof e.depth!=`function`)throw TypeError(`VolumetricClouds depth must be a function returning the scene depth texture`);if(e.sunDirection&&p(e.sunDirection,3,`VolumetricClouds sunDirection`),e.sunDirection&&!(Math.hypot(...e.sunDirection)>0))throw RangeError(`VolumetricClouds sunDirection needs a nonzero length`);if(e.wind&&p(e.wind,2,`VolumetricClouds wind`),e.ambient)for(let t of e.ambient)p(t,3,`VolumetricClouds ambient`);if(e.flash!==void 0){if(typeof e.flash!=`object`||e.flash===null)throw TypeError(`VolumetricClouds flash must be an object with a position and an intensity`);if(p(e.flash.position,3,`VolumetricClouds flash position`),e.flash.color&&p(e.flash.color,3,`VolumetricClouds flash color`),!U(e.flash.intensity,0,0xe8d4a51000)||e.flash.color&&e.flash.color.some(e=>e<0)||!U(e.flash.radius??200,1,1e5))throw RangeError(`Invalid VolumetricClouds flash; use an intensity of 0 to 1e12, a color of 0 or more and a radius of 1 to 100000`)}let{coverage:t,bottom:n,top:r,density:i}=P(e,this.layer);if(!U(t,0,1)||!U(n,100,2e4)||!U(r,n+1,2e4)||!U(i,1e-6,1)||!U(e.stepCap??y.stepCap,10,1e4)||!U(e.erosion??1,0,2)||!U(e.groundAlbedo??y.groundAlbedo,0,1)||!U(e.scale??y.scale,1e3,2e5)||!U(e.evolution??y.evolution,0,50)||!Number.isInteger(e.steps??y.steps)||!U(e.steps??y.steps,8,256)||!Number.isInteger(e.lightSteps??y.lightSteps)||!U(e.lightSteps??y.lightSteps,1,16)||!U(e.maxDistance??y.maxDistance,1e3,4e5)||!U(e.sunIntensity??y.sunIntensity,0,1e3))throw RangeError(`Invalid VolumetricClouds options; keep coverage 0 to 1, bottom 100 to 20000 below top (at most 20000), density above 0 to 1, scale 1000 to 200000, evolution 0 to 50, integer steps 8 to 256 and lightSteps 1 to 16, maxDistance 1000 to 400000, stepCap 10 to 10000, groundAlbedo 0 to 1 and sunIntensity 0 or more.`)}setup(e){if(this.disposed||!e.gpu)throw new f(this.disposed?`disposed`:`unsupported`,`VolumetricClouds requires WebGPU; attach new VolumetricClouds to a WebGPU engine; see https://margoengine.com/errors#webgpu`);this.engine=e,this.hookDeck();let t=e.gpu;this.uniform=t.createBuffer({size:this.values.byteLength,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.volumes=new A(t),this.light=t.createTexture({size:[2,1],format:`rgba32float`,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});let n=()=>t.createTexture({size:[64,32],format:`rgba16float`,usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});this.deck=n(),this.deckLight=n()}registerPasses(e){e.add({name:`sky:volumetric-clouds`,order:3,execute:e=>{e.backend===`webgpu`&&this.draw(e)}})}get ready(){return R(this.options)?z().then(e=>void e.of(this.options)):Promise.resolve()}get time(){return this.seconds}onPreUpdate(e){this.advanceTime(e)}resetTime(){this.seconds=0,this.frames=0,this.extra=0,this.pending=!1,this.drift.fill(0)}advanceTime(e){if(this.validate(),!Number.isFinite(e)||e<0)throw RangeError(`Invalid VolumetricClouds delta; pass a finite delta of 0 or more seconds.`);if(!(e>0)){this.pending=!0;return}this.hookDeck(),this.seconds+=e,this.frames=(this.frames+1)%1024,this.extra=0,this.pending=!1;let t=this.options.wind??[10,3],n=this.options.scale??y.scale,r=n/x;this.drift[0]=(this.drift[0]+t[0]*e)%n,this.drift[1]=(this.drift[1]+t[1]*e)%n,this.drift[2]=(this.drift[2]+(this.options.evolution??y.evolution)*e)%n,this.drift[3]=(this.drift[3]+t[0]*e)%r,this.drift[4]=(this.drift[4]+t[1]*e)%r}write(e){let t=this.options,n=this.values,r=t.sky;if(!d(e.camera.matrix,n.subarray(0,16),this.scratch))throw new f(`state`,`Invalid VolumetricClouds camera; give the camera a finite, invertible projection`);let i=P(t,this.layer),{bottom:a,top:s}=i,l=r?.sun??t.sunDirection??b,p=Math.hypot(l[0],l[1],l[2])||1;n.set(e.camera.position,16),H(n,t,this.drift,this.seconds);for(let e=0;e<3;e++)n[20+e]=l[e]/p;n[23]=t.sunIntensity??y.sunIntensity,o(n[21],(a+s)/2e3,r?.options.turbidity??2,this.color),n.set(this.color,24),n[27]=2**(r?.options.exposure??0),n[34]=t.maxDistance??y.maxDistance,n[35]=t.steps??y.steps,n[39]=t.lightSteps??y.lightSteps,n[40]=+!c(e.format),this.pending&&(this.extra=(this.extra+1)%1024),this.pending=!1,n[41]=t.temporal===!0||t.temporal!==!1&&this.engine?.hasPlugin(`taa`)?(this.frames+this.extra+1023)%1024*.6180339887498949%1:0;let m=r?.lights?.[1];for(let e=0;e<4;e++)n[44+e]=m?m.direction[e]:0;for(let e=0;e<3;e++)n[48+e]=m?m.radiance[e]:0;n[51]=t.stepCap??y.stepCap;let h=t.flash;n.set(h?.position??[0,0,0],52),n[55]=h?.intensity??0,n.set(h?.color??[.75,.82,1],56),n[59]=h?.radius??200;let g=t.dimLight!==!1&&!!r,_=n[23],v=r?.lightScale??1,x=r?.options.lighting?r.options.lighting.intensity??1:0;return n[61]=g||!(_>0)||!(v>0)?0:x/v/(4*Math.PI*_),n[62]=g||!(v>0)?0:1/(4*Math.PI*.15)/v,n[63]=(t.groundAlbedo??y.groundAlbedo)*u(i,Math.max(n[21],.1)),e.device.queue.writeBuffer(this.uniform,0,n),n[30]>0}skyLight(e){let t=this.options.sky?.reflectionTexture;if(t){this.lightSource!==t&&(this.lightPipeline??=e.device.createComputePipeline({layout:`auto`,compute:{module:e.device.createShaderModule({code:V(k,this.built)}),entryPoint:`main`}}),this.lightGroup=e.device.createBindGroup({layout:this.lightPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:t.createView()},{binding:2,resource:this.light.createView()}]}),this.lightSource=t);let n=e.encoder.beginComputePass();n.setPipeline(this.lightPipeline),n.setBindGroup(0,this.lightGroup),n.dispatchWorkgroups(1),n.end();return}let[n,r]=this.options.ambient??S,i=this.ambientValues;i.set(n,0),i.set(r,4),i[3]=i[7]=1,e.device.queue.writeTexture({texture:this.light},i,{bytesPerRow:32},[2,1])}environment(e){let t=this.options.sky;if(this.layered!==t&&this.unlayer(),!t||!(`environmentLayer`in t))return;this.deckGroup||=(this.deckPipeline??=e.device.createComputePipeline({layout:`auto`,compute:{module:e.device.createShaderModule({code:V(O,this.built)}),entryPoint:`main`}}),e.device.createBindGroup({layout:this.deckPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:this.volumes.shape.createView()},{binding:2,resource:this.volumes.erosion.createView()},{binding:3,resource:this.volumes.sampler},{binding:4,resource:this.light.createView()},{binding:5,resource:this.deck.createView()},{binding:6,resource:this.deckLight.createView()}]}));let n=e.encoder.beginComputePass();n.setPipeline(this.deckPipeline),n.setBindGroup(0,this.deckGroup),n.dispatchWorkgroups(8,4),n.end(),t.environmentLayer=this.deck,`environmentLightLayer`in t&&(t.environmentLightLayer=this.deckLight),this.layered=t}hookDeck(){let e=this.engine?this.options.sky:void 0;this.decked!==e&&(this.unhookDeck(),e&&(e.deck=this.deckOf),this.decked=e)}unhookDeck(){this.decked?.deck===this.deckOf&&(this.decked.deck=void 0),this.decked=void 0}unlayer(){this.layered&&this.layered.environmentLayer===this.deck&&(this.layered.environmentLayer=void 0),this.layered&&this.layered.environmentLightLayer===this.deckLight&&(this.layered.environmentLightLayer=void 0),this.layered=void 0}draw(e){if(!this.uniform)return;let t=B(this.options);if(R(this.options)&&!t)return;if(t!==this.built&&(this.lightPipeline=this.lightGroup=this.deckPipeline=this.deckGroup=this.lightSource=void 0,this.key=``,this.built=t),this.hookDeck(),!this.write(e)){this.unlayer();return}this.volumes.fill(e.device,e.encoder),this.skyLight(e),this.environment(e);let n=h(e,this.options.depth,`VolumetricClouds`),r=e.descriptor.multisample?.count??1,a=`${e.format}:${r}:${n?.samples??0}:${e.descriptor.depthStencil?.format}`;if(this.key!==a){let t=e.device.createShaderModule({code:V(D(n?g(5,n.samples):``),this.built)});this.pipeline=e.device.createRenderPipeline({layout:`auto`,vertex:{module:t,entryPoint:`vertex`},fragment:{module:t,entryPoint:`fragment`,targets:[{format:e.format,blend:{color:{srcFactor:`one`,dstFactor:`one-minus-src-alpha`,operation:`add`},alpha:{srcFactor:`zero`,dstFactor:`one`,operation:`add`}}}]},multisample:e.descriptor.multisample,...n?{}:{depthStencil:{format:e.descriptor.depthStencil.format,depthCompare:`greater-equal`,depthWriteEnabled:!1}}}),this.key=a,this.bound=void 0}this.bound!==(n?.texture??this.light)&&(this.bind=e.device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:this.volumes.shape.createView()},{binding:2,resource:this.volumes.erosion.createView()},{binding:3,resource:this.volumes.sampler},{binding:4,resource:this.light.createView()},...n?[{binding:5,resource:n.resource}]:[]]}),this.bound=n?.texture??this.light);let o=e.encoder.beginRenderPass({colorAttachments:[{view:e.color,loadOp:`load`,storeOp:`store`}],...n?{}:{depthStencilAttachment:{view:e.depth,depthReadOnly:!0,stencilReadOnly:!0}}});i(o,e),o.setPipeline(this.pipeline),o.setBindGroup(0,this.bind),o.draw(3),o.end()}release(){this.unlayer(),this.unhookDeck(),this.uniform?.destroy(),this.volumes?.dispose(),this.light?.destroy(),this.deck?.destroy(),this.deckLight?.destroy(),this.uniform=this.volumes=this.light=this.deck=this.deckLight=void 0,this.pipeline=this.bind=this.lightPipeline=this.lightGroup=this.deckPipeline=this.deckGroup=void 0,this.bound=this.lightSource=void 0,this.key=``}onDeviceRestored(e){this.release(),this.setup(e)}dispose(){this.disposed||(this.disposed=!0,this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.engine=void 0)}[Symbol.dispose??Symbol()](){this.dispose()}};export{W as t};