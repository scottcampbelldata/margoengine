import{M as e,O as t,j as n}from"./index-OO1e78gK.js";import{n as r,r as i}from"./errors-D8rc8kzg-DREbrEsS.js";import{n as a,t as o}from"./surface-effects-B8wNNEcQ-BIsK3E9V.js";var s=(e,n=`1.0.0`,r=import.meta.url)=>t(e,n,r),c=0,l=(e,t,n,i)=>{if(!Number.isFinite(e)||e<t||e>n)throw r(`Water banks ${i} must be a finite number from ${t} to ${n}`,`geometry`);return e};function u(e){return`
struct BanksFrame {place:vec4f,rings:vec4f,error:vec4f}
@group(0) @binding(${e}) var<uniform> banks:BanksFrame;
@group(0) @binding(${e+1}) var banksGround:texture_2d<f32>;


fn banksGroundAt(xz:vec2f)->f32 {
 let uv=(xz-banks.place.xy)/banks.place.zw;
 if(banks.error.z<0.5||any(uv<vec2f(0))||any(uv>vec2f(1))){return -1e30;}
 let size=vec2i(textureDimensions(banksGround));let pixel=uv*vec2f(size-vec2i(1));let lo=vec2i(floor(pixel));
 let hi=min(lo+vec2i(1),size-vec2i(1));let t=fract(pixel);
 let a=mix(textureLoad(banksGround,lo,0).r,textureLoad(banksGround,vec2i(hi.x,lo.y),0).r,t.x);
 let b=mix(textureLoad(banksGround,vec2i(lo.x,hi.y),0).r,textureLoad(banksGround,hi,0).r,t.x);
 return mix(a,b,t.y);
}



fn banksSlack(xz:vec2f)->f32 {
 if(banks.error.z<0.5){return 0.0;}
 let size=vec2f(textureDimensions(banksGround));
 let texel=max(banks.place.z/max(size.x-1.0,1.0),banks.place.w/max(size.y-1.0,1.0));
 let d=max(abs(xz.x-banks.rings.x),abs(xz.y-banks.rings.y));
 let level=max(0.0,ceil(log2(max(d,0.001)/(banks.rings.w*0.5*banks.rings.z))));
 return clamp((banks.rings.z*exp2(level+1.0)-texel)*banks.error.x,0.0,banks.error.y);
}


fn banksPull(p:vec3f)->vec3f {
 let s=banksSlack(p.xz);let rise=frame.eye.y-p.y;
 if(s<=0.0||rise<=0.0){return p;}
 return p+(frame.eye.xyz-p)*min(s/rise,0.5);
}
fn banksDry(xz:vec2f,level:f32)->bool {return banksGroundAt(xz)>=level;}
`}var d=`var clip=frame.camera*vec4f(v.position,1);`,f=`@vertex fn vertex(@location(0) grid:vec2f`,p=`if(dry`,m=class t{coreRequirement=e(`1.0.0`,import.meta.url);constructor(e){if(this.name=`water:banks-${c++}`,this.values=new Float32Array(12),this.resources=[],this.disposed=!1,!e?.surface||typeof e.surface.onDispose!=`function`)throw i(`state`,`Water banks need a Water surface; pass options.surface`);if(typeof e.heightmap!=`function`)throw r(`Water banks heightmap must be a function returning an r32float texture`,`geometry`);let t=(e,t,n)=>{if(!Array.isArray(e)||e.length!==2)throw r(`Water banks ${n} must be [x, z]`,`geometry`);return[l(e[0],t,1e7,n),l(e[1],t,1e7,n)]},n=t(e.origin,-1e7,`origin`),a=t(e.size,0,`size`);if(!(a[0]>0&&a[1]>0&&a[0]<=1e5&&a[1]<=1e5))throw r(`Water banks size must be above 0 and at most 100,000 on each axis`,`geometry`);let o=l(e.resolution??64,8,256,`resolution`),s=e.cell??1;if(!(Number.isFinite(s)&&s>0&&s<=1e5))throw r(`Water banks cell must be above 0 and at most 100,000`,`geometry`);this.centre=e.centre===void 0||e.centre===`camera`?`camera`:t(e.centre,-1e7,`centre`),this.surface=e.surface,this.heightmap=e.heightmap,this.values.set([n[0],n[1],a[0],a[1],0,0,s,o,l(e.slope??.25,0,10,`slope`),l(e.limit??2,0,100,`limit`)])}static attach(r,i){n(r,e(`1.0.0`,import.meta.url));let a=new t(i);return s(r).use(a),a}setup(e){if(this.live(),this.engine)throw i(`attached`,`Water banks already attached; create another WaterBanks`,`state`);if(!e.gpu)throw i(`unsupported`,`Water banks need WebGPU or the full WebGL2 compatibility layer`,`webgpu`);if(!e.hasPlugin(this.surface.name))throw i(`state`,`Attach the Water surface to this engine before WaterBanks`);if(o.get(this.surface)?.some(e=>e.key===`banks`))throw i(`attached`,`Water already has banks; change the attached one`,`state`);this.engine=e,this.uniform=e.gpu.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.fallback=e.gpu.createTexture({size:[1,1],format:`r32float`,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),this.resources=[{buffer:this.uniform},this.fallback.createView()],this.remove=a(this.surface,{key:`banks`,vertex:!1,count:2,shader:(e,t)=>{if(e.split(d).length!==2||e.split(f).length!==2||e.split(p).length!==2)throw i(`unsupported`,`Water banks need a bounded Water surface (horizon false) from the same water package version`);return e.replace(f,u(t)+`
@vertex fn vertex(@location(0) grid:vec2f`).replace(d,`var clip=frame.camera*vec4f(banksPull(v.position),1);`).replace(p,`if(banksDry(i.xz,i.world.y)){discard;}
 if(dry`)},prepare:e=>this.prepare(e)}),this.removeDispose=this.surface.onDispose(()=>this.dispose())}prepare(e){if(e.device!==this.engine?.gpu)throw i(`state`,`Water banks and Water must use the same engine; attach both to one engine`);let t=this.heightmap();t!==this.ground?.texture&&(this.ground=t?{texture:t,view:t.createView()}:void 0,this.resources=[this.resources[0],this.ground?.view??this.fallback.createView()]);let n=this.centre===`camera`?[e.camera.position[0],e.camera.position[2]]:this.centre;return this.values[4]=n[0],this.values[5]=n[1],this.values[10]=+!!this.ground,e.device.queue.writeBuffer(this.uniform,0,this.values),this.resources}onDeviceRestored(e){this.release(),this.engine=void 0,this.setup(e)}live(){if(this.disposed)throw i(`disposed`,`Water banks disposed; create another WaterBanks`)}release(){this.remove?.(),this.removeDispose?.(),this.remove=this.removeDispose=void 0,this.uniform?.destroy(),this.fallback?.destroy(),this.uniform=this.fallback=this.ground=void 0,this.resources=[]}dispose(){this.disposed||(this.disposed=!0,this.engine?.sceneOf(this)?.removePlugin(this.name),this.release(),this.engine=void 0)}[Symbol.dispose??Symbol()](){this.dispose()}};export{m as WaterBanks};