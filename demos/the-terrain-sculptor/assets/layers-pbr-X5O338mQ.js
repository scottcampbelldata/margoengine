import{n as e,r as t}from"./index-CeHN9f03.js";import{i as n,r}from"./scene-CeUDiJ-H.js";var i=(e,t=`1.0.0`,r=import.meta.url)=>n(e,t,r),a=90,o=0,s=class n{coreRequirement=t(`1.0.0`,import.meta.url);constructor(e,t){this.terrain=e,this.options=t,this.name=`terrain-materials:`+o++,this.disposed=!1,this.entries=[],this.cache=new Map;let n=e?.options?.layers?.length;if(!n||typeof t?.textures!=`function`)throw TypeError(`Invalid terrain materials; pass a Terrain and options with a textures factory`);let r=t.heightBlend??.5,i=t.layers??[];if(!(r>=0&&r<=1)||!Array.isArray(i)||i.length>n||!i.every(e=>(e.normal??1)>=0&&(e.normal??1)<=2&&(e.occlusion??1)>=0&&(e.occlusion??1)<=1&&(e.roughness??1)>=0&&(e.roughness??1)<=2))throw RangeError(`Invalid terrain materials; give heightBlend 0..1 and at most one entry per terrain layer with normal 0..2, occlusion 0..1 and roughness 0..2.`)}static attach(r,a,o){e(r,t(`1.0.0`,import.meta.url));let s=new n(a,o);return i(r).use(s),s}setup(e){if(this.disposed||!e.gpu)throw new r(this.disposed?`disposed`:`unsupported`,`Terrain materials require WebGPU and a live module; attach new TerrainMaterials to a WebGPU engine`);this.owner=e,this.device=e.gpu;let t=this.textures=this.options.textures(this.device),n=this.terrain.options.layers.length;for(let e of[t?.normals,t?.surface])if(!e||e.dimension!==`2d`||!(e.usage&GPUTextureUsage.TEXTURE_BINDING)||e.sampleCount!==1||e.depthOrArrayLayers!==n||![`rgba8unorm`,`rgba16float`].includes(e.format))throw TypeError(`Invalid terrain material textures; return normals and surface as rgba8unorm or rgba16float 2D arrays with ${n} layers, one per terrain layer`);let i=new Float32Array(64),o=8*(this.options.heightBlend??.5);for(let e=0;e<n;e++){let t=this.options.layers?.[e]??{};i.set([t.normal??1,t.occlusion??1,t.roughness??1,o],e*4)}this.rules=this.device.createBuffer({size:256,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.rules,0,i),this.entries=[{binding:a,resource:t.normals.createView({dimension:`2d-array`})},{binding:91,resource:t.surface.createView({dimension:`2d-array`})},{binding:92,resource:{buffer:this.rules}}],this.remove??=this.terrain.addLighting(this)}get surface(){return this.textures?.surface}bindings(){return this.entries}shader(e,t){let n=t+e,i=this.cache.get(n);if(i)return i;let a=`@fragment fn fragment(i:Output)->@location(0) vec4f {`,o=`let n=normalize(i.normal);let base=terrainColor(i.position,n);`,s=`let n=terrainBump(i.position,terrainN);`,c=`let weight=smoothstep(`,u=`let weight=packed[layer/4u][layer%4u];if(weight<=0.0){continue;}`,d=`+base*frame.radiance.w*frame.ambient.rgb`;if([a,d,`total+=weight;`].some(t=>e.split(t).length!==2)||e.includes(o)===e.includes(s)||e.includes(c)===e.includes(u))throw new r(`unsupported`,`Terrain materials need the terrain's own lit shader; attach them before any effect that replaces it`);let f=`i.material.x=terrainPbrRoughness(i.material.x);`,p=l(t),m=(e.includes(`wrap:vec4f`)?p.split(`position*s,`).join(`(position+layerRules[layer].wrap.xyz)*s,`):p)+e.replace(a,`fn terrainPbrShade(terrainIn:Output)->vec4f {var i=terrainIn;`).replace(o,`let terrainN0=normalize(i.normal);let base=terrainColor(i.position,terrainN0);let n=terrainPbrNormal(terrainN0);${f}`).replace(s,`let n=terrainPbrNormal(terrainBump(i.position,terrainN));${f}`).replace(c,`let weight=terrainPbrHeight(position,projection,dx,dy,layer)*smoothstep(`).replace(u,`let painted=packed[layer/4u][layer%4u];if(painted<=0.0){continue;}let weight=painted*terrainPbrHeight(position,projection,dx,dy,layer);`).replace(`total+=weight;`,`total+=weight;terrainPbrLayer(position,projection,dx,dy,layer,weight);`).replace(d,d+`*terrainPbrOcclusion()`);return m+=`\n${a}return terrainPbrShade(i);}\n`,this.cache.size>=16&&this.cache.clear(),this.cache.set(n,m),m}onDeviceRestored(e){this.release(),this.setup(e)}release(){this.textures?.normals.destroy(),this.textures?.surface.destroy(),this.rules?.destroy(),this.textures=this.rules=void 0,this.entries=[]}dispose(){this.disposed||(this.disposed=!0,this.remove?.(),this.remove=void 0,this.owner?.sceneOf(this)?.removePlugin(this.name),this.release(),this.cache.clear(),this.owner=this.device=void 0)}[Symbol.dispose??Symbol()](){this.dispose()}},c=(e,t)=>`
fn ${t}(p:vec3f,q:vec3f,dx:vec3f,dy:vec3f,s:f32,layer:u32)->array<vec4f,3> {
  var r=array<vec4f,3>(vec4f(0),vec4f(0),vec4f(0));
  if(q.x>0.0){r[0]=textureSampleGrad(${e},terrainSampler,p.zy,i32(layer),dx.zy*s,dy.zy*s);}
  if(q.y>0.0){r[1]=textureSampleGrad(${e},terrainSampler,p.xz,i32(layer),dx.xz*s,dy.xz*s);}
  if(q.z>0.0){r[2]=textureSampleGrad(${e},terrainSampler,p.xy,i32(layer),dx.xy*s,dy.xy*s);}
  return r;
}`,l=e=>`
@group(${e}) @binding(${a}) var terrainPbrNormals:texture_2d_array<f32>;
@group(${e}) @binding(91) var terrainPbrSurfaces:texture_2d_array<f32>;
@group(${e}) @binding(92) var<uniform> terrainPbrRules:array<vec4f,16>;
var<private> terrainPbrGradient:vec4f;var<private> terrainPbrSurface:vec3f;var<private> terrainPbrLast:vec4f;
${c(`terrainPbrNormals`,`terrainPbrTriN`)}${c(`terrainPbrSurfaces`,`terrainPbrTriS`)}
fn terrainPbrHeight(position:vec3f,projection:vec3f,dx:vec3f,dy:vec3f,layer:u32)->f32 {
  let s=layerRules[layer].params.x;let t=terrainPbrTriS(position*s,projection,dx,dy,s,layer);
  terrainPbrLast=t[0]*projection.x+t[1]*projection.y+t[2]*projection.z;
  return exp2(terrainPbrRules[layer].w*(terrainPbrLast.a-1.0));
}
fn terrainPbrLayer(position:vec3f,projection:vec3f,dx:vec3f,dy:vec3f,layer:u32,weight:f32) {
  if(weight<=0.0){return;}
  let r=terrainPbrRules[layer];let s=layerRules[layer].params.x;
  let t=terrainPbrTriN(position*s,projection,dx,dy,s,layer);


  var g=vec3f(0);
  if(projection.x>0.0){let m=t[0].xyz*2.0-1.0;let d=vec2f(-m.x,m.y)/max(m.z,0.05);g+=projection.x*vec3f(0.0,d.y,d.x);}
  if(projection.y>0.0){let m=t[1].xyz*2.0-1.0;let d=vec2f(-m.x,m.y)/max(m.z,0.05);g+=projection.y*vec3f(d.x,0.0,d.y);}
  if(projection.z>0.0){let m=t[2].xyz*2.0-1.0;let d=vec2f(-m.x,m.y)/max(m.z,0.05);g+=projection.z*vec3f(d.x,d.y,0.0);}
  terrainPbrGradient+=vec4f(g*r.x*weight,weight);
  terrainPbrSurface+=vec3f(mix(1.0,terrainPbrLast.r,r.y),terrainPbrLast.g*r.z,0.0)*weight;
}
fn terrainPbrNormal(n:vec3f)->vec3f {
  if(terrainPbrGradient.w<=0.00001){return n;}
  let g=terrainPbrGradient.xyz/terrainPbrGradient.w;let surface=g-dot(g,n)*n;let tilted=n-surface;
  return select(n,normalize(tilted),dot(tilted,tilted)>0.0);
}
fn terrainPbrRoughness(fallback:f32)->f32 {
  if(terrainPbrGradient.w<=0.00001){return fallback;}
  return clamp(terrainPbrSurface.y/terrainPbrGradient.w,0.02,1.0);
}
fn terrainPbrOcclusion()->f32 {
  if(terrainPbrGradient.w<=0.00001){return 1.0;}
  return terrainPbrSurface.x/terrainPbrGradient.w;
}
`;export{s as TerrainMaterials};