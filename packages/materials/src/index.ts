/// <reference lib="esnext.disposable" preserve="true" />
import type {EngineKernel} from '@margoengine/core';
import {engineRuntime,type Engine} from '@margoengine/core/extension';
import {GLTFAsset,PBRModel,textureTransform,type PreparedGeometry,type PBRRenderState,type TextureTransform} from '@margoengine/gltf-pro';
import {PBRInstances} from '@margoengine/gltf-pro/instancing';
import {readResponse} from '../../shared/loading.js';
export type {TextureTransform} from '@margoengine/gltf-pro';
export {packAtlas,transformUVs,type Atlas,type AtlasOptions} from './atlas.js';
declare const GPUTextureUsage:{TEXTURE_BINDING:number;COPY_DST:number;RENDER_ATTACHMENT:number};
export type RawImage={data:Uint8Array|Uint8ClampedArray;width:number;height:number};
/** ImageData and `{data,width,height}` upload as raw RGBA8 rows (row 0 at UV v=0); other sources use copyExternalImageToTexture. */
export type TextureSource=ImageBitmap|HTMLImageElement|HTMLCanvasElement|OffscreenCanvas|HTMLVideoElement|VideoFrame|ImageData|RawImage;
export type Wrap='repeat'|'clamp'|'mirror';
export type Filter='linear'|'nearest';
export interface TextureOptions {colorSpace?:'srgb'|'linear';wrapS?:Wrap;wrapT?:Wrap;magFilter?:Filter;minFilter?:Filter;mipmaps?:boolean;anisotropy?:number;flipY?:boolean}
interface Slot {texture?:GPUTexture;views:Map<string,GPUTextureView>;sampler:GPUSampler;version:number;time?:number}
const wraps={repeat:'repeat',clamp:'clamp-to-edge',mirror:'mirror-repeat'} as const,maxPixels=16_777_216;
const mipShader=`struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.clip=vec4f(p[i],0,1);o.uv=p[i]*vec2f(0.5,-0.5)+0.5;return o;}
@group(0) @binding(0) var image:texture_2d<f32>;@group(0) @binding(1) var imageSampler:sampler;
@fragment fn fragment(i:Out)->@location(0) vec4f {return textureSample(image,imageSampler,i.uv);}`;
const shared=new WeakMap<GPUDevice,{white:GPUTextureView;normal:GPUTextureView;sampler:GPUSampler;pipelines:Map<string,GPURenderPipeline>}>();
function defaults(device:GPUDevice) {
  let d=shared.get(device);if(d)return d;
  const pixel=(rgba:number[])=>{const texture=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});device.queue.writeTexture({texture},new Uint8Array(rgba),{bytesPerRow:4},[1,1]);return texture.createView();};
  d={white:pixel([255,255,255,255]),normal:pixel([128,128,255,255]),sampler:device.createSampler({magFilter:'linear',minFilter:'linear'}),pipelines:new Map()};shared.set(device,d);return d;
}
const dimensions=(s:any):[number,number]=>[s.videoWidth??s.displayWidth??s.naturalWidth??s.width??0,s.videoHeight??s.displayHeight??s.naturalHeight??s.height??0];
const raw=(s:any):s is RawImage=>s?.data instanceof Uint8Array||s?.data instanceof Uint8ClampedArray;
/** A shareable texture. GPU copies are made lazily per device; video sources re-upload whenever `currentTime` changes, other sources on `update()`. */
export class Texture {
  private version=0;private readonly slots=new Map<GPUDevice,Slot>();
  constructor(readonly source:TextureSource,readonly options:TextureOptions={},private readonly owned=false) {
    const o=options,[w,h]=dimensions(source),pick=(v:unknown,list:readonly string[])=>v===undefined||list.includes(v as string);
    if(!source||typeof source!=='object'||!pick(o.colorSpace,['srgb','linear'])||![o.wrapS,o.wrapT].every(v=>pick(v,['repeat','clamp','mirror']))||![o.magFilter,o.minFilter].every(v=>pick(v,['linear','nearest']))||o.anisotropy!==undefined&&!(Number.isInteger(o.anisotropy)&&o.anisotropy>=1&&o.anisotropy<=16))throw new TypeError('Invalid texture source or options');
    if(raw(source)&&(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||w*h>maxPixels||source.data.length<w*h*4))throw new RangeError('Raw texture data must be RGBA8 of width*height*4 bytes');
  }
  get width():number {return dimensions(this.source)[0];}
  get height():number {return dimensions(this.source)[1];}
  get isVideo():boolean {return typeof (this.source as HTMLVideoElement).videoWidth==='number';}
  /** Re-upload on next use (canvas, raw data or VideoFrame contents changed). */
  update():void {this.version++;}
  /** Frees GPU copies and closes an ImageBitmap created by `loadTexture`. A later use of a still-open source uploads again. */
  dispose():void {for(const slot of this.slots.values())slot.texture?.destroy();this.slots.clear();if(this.owned)(this.source as ImageBitmap).close();}
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
  /** @internal View and sampler for a material slot, or undefined while the source has no pixels (unloaded image or video). */
  bind(device:GPUDevice,srgb:boolean):[GPUTextureView,GPUSampler]|undefined {
    const s=this.source as any,o=this.options,[w,h]=dimensions(s),video=this.isVideo;let slot=this.slots.get(device);
    if(!slot){
      const mips=o.mipmaps??!video,min=o.minFilter??'linear',mag=o.magFilter??'linear',aniso=min==='linear'&&mag==='linear'&&mips?o.anisotropy??1:1;
      slot={views:new Map(),version:-1,sampler:device.createSampler({addressModeU:wraps[o.wrapS??'clamp'],addressModeV:wraps[o.wrapT??'clamp'],magFilter:mag,minFilter:min,mipmapFilter:min,lodMaxClamp:mips?32:0,maxAnisotropy:aniso})};
      this.slots.set(device,slot);device.lost?.then(()=>this.slots.delete(device));
    }
    if(!w||!h||s.readyState<2)return slot.texture?[this.view(slot,srgb),slot.sampler]:undefined;
    if(w>device.limits.maxTextureDimension2D||h>device.limits.maxTextureDimension2D)throw new RangeError('Texture exceeds device limit');
    let t=slot.texture;
    if(!t||t.width!==w||t.height!==h){
      t?.destroy();const format=o.colorSpace?o.colorSpace==='srgb':srgb,levels=o.mipmaps??!video?Math.floor(Math.log2(Math.max(w,h)))+1:1;
      t=slot.texture=device.createTexture({size:[w,h],format:format?'rgba8unorm-srgb':'rgba8unorm',viewFormats:[format?'rgba8unorm':'rgba8unorm-srgb'],mipLevelCount:levels,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
      slot.views.clear();slot.version=-1;
    }
    if(slot.version!==this.version||video&&s.currentTime!==slot.time){
      if(raw(s))device.queue.writeTexture({texture:t},s.data,{bytesPerRow:w*4},[w,h]);
      else device.queue.copyExternalImageToTexture({source:s,flipY:o.flipY??true},{texture:t},[w,h]);
      slot.version=this.version;slot.time=s.currentTime;mipmaps(device,t);
    }
    return [this.view(slot,srgb),slot.sampler];
  }
  private view(slot:Slot,srgb:boolean):GPUTextureView {
    const t=slot.texture!,format=this.options.colorSpace?t.format:srgb?'rgba8unorm-srgb':'rgba8unorm';let view=slot.views.get(format);
    if(!view){view=t.createView({format});slot.views.set(format,view);}return view;
  }
}
function mipmaps(device:GPUDevice,texture:GPUTexture):void {
  if(texture.mipLevelCount<2)return;const d=defaults(device),format=texture.format;let pipeline=d.pipelines.get(format);
  if(!pipeline){const module=device.createShaderModule({code:mipShader});pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format}]}});d.pipelines.set(format,pipeline);}
  const encoder=device.createCommandEncoder(),level=(baseMipLevel:number)=>texture.createView({format,baseMipLevel,mipLevelCount:1});
  for(let i=1;i<texture.mipLevelCount;i++){
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:level(i-1)},{binding:1,resource:d.sampler}]});
    const pass=encoder.beginRenderPass({colorAttachments:[{view:level(i),loadOp:'clear',storeOp:'store',clearValue:{r:0,g:0,b:0,a:0}}]});pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
  }
  device.queue.submit([encoder.finish()]);
}
/** Fetches http(s), blob: or data: image bytes (64 MiB, 4096x4096 pixels at most) into an ImageBitmap the texture owns. */
export async function loadTexture(url:string|URL,{signal,...options}:TextureOptions&{signal?:AbortSignal}={}):Promise<Texture> {
  const target=new URL(url,globalThis.location?.href);if(!['http:','https:','blob:','data:'].includes(target.protocol))throw new TypeError('Texture URL must use HTTP(S), blob: or data:');
  const response=await fetch(target,{signal}),bytes=await readResponse(response,{maxBytes:64*1024*1024,signal,label:'Texture download'});
  const bitmap=await createImageBitmap(new Blob([bytes],{type:response.headers.get('content-type')??''}),{colorSpaceConversion:'none',premultiplyAlpha:'none'});
  try{signal?.throwIfAborted();if(bitmap.width*bitmap.height>maxPixels)throw new RangeError('Texture exceeds decoded size limit');return new Texture(bitmap,options,true);}catch(error){bitmap.close();throw error;}
}

export type Shading='standard'|'basic'|'normal'|'matcap';
export type Blending='normal'|'additive'|'multiply'|'none';
type Color=string|readonly number[];
/**
 * Physical options (three.js MeshPhysicalMaterial names, glTF KHR_materials_* meaning; gltf-pro's physical shader draws
 * them, so a mesh and the same glTF material render alike). Any of them makes the material physical, fixed at
 * construction; `transmission` makes it transmissive (drawn after opaque meshes). Values stay live.
 */
export interface PhysicalOptions {
  /** KHR_materials_clearcoat: layer strength and roughness, 0-1. */
  clearcoat?:number;clearcoatRoughness?:number;
  /** KHR_materials_sheen: sheen colour (default black: none) and roughness 0-1. */
  sheenColor?:Color;sheenRoughness?:number;
  /** KHR_materials_specular: dielectric specular strength 0-1 and F0 colour. */
  specularIntensity?:number;specularColor?:Color;
  /** KHR_materials_ior: index of refraction, >= 1 (default 1.5). */
  ior?:number;
  /** KHR_materials_transmission: share of light passing through, 0-1. Refracts the scene with `@margoengine/materials/transmission`; otherwise the background shows through tinted. */
  transmission?:number;
  /** KHR_materials_volume: thickness in mesh units (0 = thin-walled, no refraction), and the colour white light reaches after `attenuationDistance` world units inside. */
  thickness?:number;attenuationColor?:Color;attenuationDistance?:number;
}
export interface MaterialOptions extends PhysicalOptions {
  shading?:Shading;color?:Color;opacity?:number;roughness?:number;metalness?:number;emissive?:Color;
  map?:Texture|null;metalRoughnessMap?:Texture|null;normalMap?:Texture|null;normalScale?:number;aoMap?:Texture|null;aoMapIntensity?:number;emissiveMap?:Texture|null;matcap?:Texture|null;
  transparent?:boolean;alphaTest?:number;doubleSided?:boolean;blending?:Blending;depthWrite?:boolean;depthTest?:boolean;
  /** UV offset/scale/rotation for every map but `matcap` (KHR_texture_transform semantics), e.g. an atlas region. */
  uvTransform?:TextureTransform;
}
export type MapSlot='map'|'metalRoughnessMap'|'normalMap'|'aoMap'|'emissiveMap';
const slots=['map','metalRoughnessMap','normalMap','aoMap','emissiveMap','matcap'] as const,names=['baseMap','mrMap','normalMap','aoMap','emissiveMap','matcap'];
const unit=(v:unknown,label:string)=>{if(typeof v!=='number'||!(v>=0&&v<=1))throw new RangeError('Material '+label+' must be in [0, 1]');return v;};
// glTF extension of each physical option (the exported material names them).
const extensions:Record<keyof PhysicalOptions,string>={clearcoat:'clearcoat',clearcoatRoughness:'clearcoat',sheenColor:'sheen',sheenRoughness:'sheen',specularIntensity:'specular',specularColor:'specular',ior:'ior',transmission:'transmission',thickness:'volume',attenuationColor:'volume',attenuationDistance:'volume'};
const linear=(c:Color,label:string):number[]=>{
  const v=typeof c==='string'?/^#[0-9a-f]{6}$/i.test(c)?[1,3,5].map(i=>{const x=parseInt(c.slice(i,i+2),16)/255;return x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4;}):[]:Array.isArray(c)?[...c]:[];
  if(v.length<3||v.length>4)throw new TypeError('Invalid material '+label);v.forEach(x=>unit(x,label));return v;
};
const outputs:Record<Exclude<Shading,'standard'>,string>={
  basic:'return vec4f(mat_out(s.base.rgb+s.emissive),alpha);',
  normal:'return vec4f(normalize((f.view*vec4f(s.n,0)).xyz)*0.5+0.5,alpha);',
  matcap:'let e=normalize(-(f.view*vec4f(i.position,1)).xyz);let n=normalize((f.view*vec4f(s.n,0)).xyz);let x=normalize(vec3f(e.z,0,-e.x));let m=textureSample(mat_matcap,mat_matcapS,vec2f(dot(x,n),dot(cross(e,x),n))*0.495+0.5).rgb;return vec4f(mat_out(s.base.rgb*m),alpha);'
};
const encode='fn mat_out(c:vec3f)->vec3f {if(f.settings.w>0.5){return c;}let x=clamp(c,vec3f(0),vec3f(1));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}';
const patched=new Map<string,Map<string,string>>();
/** Rewrites gltf-pro's beauty shader to multiply in this package's maps (group 2, bindings 32-43) and, for non-standard shading, return early. */
export function materialShader(source:string,group:number,shading:Shading):string {
  let cache=patched.get(source);const key=shading+group,cached=cache?.get(key);if(cached)return cached;let count=0;
  let code=source.replace(/textureSample\((baseMap|mrMap|aoMap|emissiveMap),(\w+),(uv\(i,f\.coords[AB]\.[xyzw]\))\)/g,(_,map,sampler,uv)=>{count++;return `(textureSample(mat_${map},mat_${map}S,${uv})*textureSample(${map},${sampler},${uv}))`;})
    .replace(/textureSample\(normalMap,normalSampler,(uv\(i,f\.coordsA\.z\))\)\.xyz\*2-1/,(_,uv)=>{count++;return `textureSample(mat_normalMap,mat_normalMapS,${uv}).xyz*2-1+0*textureSample(normalMap,normalSampler,${uv}).xyz`;});
  if(shading!=='standard')code=code.replace(/@fragment fn fragment\([^{]*\{\s*let s=surface\(i,front\);/,head=>{count++;return `${head}\n  let alpha=select(1.0,s.base.a,f.settings.x>1.5);\n  if(f.coordsB.w<0.5){${outputs[shading]}}`;});
  if(count!==(shading==='standard'?5:6))throw new Error('Materials require the standard gltf-pro PBR shader');
  const declarations=names.slice(0,shading==='matcap'?6:5).map((name,i)=>`@group(${group}) @binding(${32+i*2}) var mat_${name}:texture_2d<f32>;\n@group(${group}) @binding(${33+i*2}) var mat_${name}S:sampler;`).join('\n');
  const output=declarations+'\n'+(shading==='basic'||shading==='matcap'?encode+'\n':'')+code;
  if(!cache)patched.set(source,cache=new Map());cache.set(key,output);return output;
}
/** Live values: color/emissive arrays, scalar setters and map assignments apply on the next frame to every mesh using the material. Shading and render state are fixed. */
export class Material {
  readonly shading:Shading;readonly color:number[];readonly emissive:number[];readonly blending:Blending;readonly depthWrite?:boolean;readonly depthTest:boolean;
  /** gltf-pro layout: [roughness, metalness, normalScale, aoMapIntensity] and [alphaMode, alphaTest, doubleSided, 0]. */
  readonly factors:number[];readonly settings:number[];private blend:boolean;
  /** gltf-pro layout: two rows per map slot (offset*rotation*scale), in `MapSlot` order. */
  readonly uvt:number[]=[];
  map:Texture|null;metalRoughnessMap:Texture|null;normalMap:Texture|null;aoMap:Texture|null;emissiveMap:Texture|null;matcap:Texture|null;
  /** Physical materials only, gltf-pro layout: [clearcoat, clearcoatRoughness, 1, transmission, specularColor rgb, specularIntensity, sheenColor rgb, sheenRoughness], and [0, ior, 0, 0]. */
  readonly physical?:number[];readonly ext?:number[];
  /** Transmissive materials only, gltf-pro layout: [thickness, transmittance per world unit rgb]. */
  readonly volume?:number[];
  /** glTF extensions (`KHR_materials_<name>`) the physical options use. */
  readonly extensions:readonly string[];
  private attenuation=[1,1,1,Infinity];private readonly tinted=[0,0,0];
  constructor(o:MaterialOptions={}) {
    const shading=o.shading??'standard',blending=o.blending??'normal';
    if(!['standard','basic','normal','matcap'].includes(shading)||!['normal','additive','multiply','none'].includes(blending)||[o.transparent,o.doubleSided,o.depthWrite,o.depthTest].some(v=>v!==undefined&&typeof v!=='boolean')||o.normalScale!==undefined&&!Number.isFinite(o.normalScale))throw new TypeError('Invalid material options');
    for(const slot of slots)if(o[slot]!=null&&!(o[slot] instanceof Texture))throw new TypeError('Material '+slot+' must be a Texture');
    this.shading=shading;this.blending=blending;this.depthWrite=o.depthWrite;this.depthTest=o.depthTest??true;this.blend=o.transparent??false;
    this.color=linear(o.color??[1,1,1],'color');if(this.color.length===3)this.color.push(unit(o.opacity??1,'opacity'));this.emissive=linear(o.emissive??[0,0,0],'emissive').slice(0,3);
    this.factors=[unit(o.roughness??1,'roughness'),unit(o.metalness??0,'metalness'),o.normalScale??1,unit(o.aoMapIntensity??1,'aoMapIntensity')];
    this.settings=[0,unit(o.alphaTest??0,'alphaTest'),+(o.doubleSided??false),0];this.sync();this.setUVTransform(o.uvTransform??null);
    this.map=o.map??null;this.metalRoughnessMap=o.metalRoughnessMap??null;this.normalMap=o.normalMap??null;this.aoMap=o.aoMap??null;this.emissiveMap=o.emissiveMap??null;this.matcap=o.matcap??null;
    const used=(Object.keys(extensions) as (keyof PhysicalOptions)[]).filter(k=>o[k]!==undefined);this.extensions=[...new Set(used.map(k=>extensions[k]))];
    if(!used.length)return;if(shading!=='standard')throw new TypeError('Physical options need standard shading');
    this.physical=[0,0,1,0,1,1,1,1,0,0,0,0];this.ext=[0,1.5,0,0];if(o.transmission!==undefined)this.volume=[0,1,1,1];
    Object.assign(this,Object.fromEntries(used.map(k=>[k,o[k]])));
  }
  private set(i:number,v:number,label:string):void {if(!this.physical)throw new TypeError(`Material ${label} needs a physical option at construction`);this.physical[i]=unit(v,label);}
  private setColor(i:number,c:Color,label:string):void {const v=linear(c,label);for(let k=0;k<3;k++)this.set(i+k,v[k],label);}
  private setVolume(i:number,v:number,label:string):void {
    if(!this.volume)throw new TypeError(`Material ${label} needs transmission at construction`);if(!(v>=0&&(v<Infinity||i===4)))throw new RangeError(`Material ${label} must be a finite number >= 0`);
    if(i)this.attenuation[i-1]=v;else this.volume[0]=v;const [r,g,b,d]=this.attenuation;this.volume[1]=r**(1/d);this.volume[2]=g**(1/d);this.volume[3]=b**(1/d);
  }
  get clearcoat():number {return this.physical?.[0]??0;} set clearcoat(v:number) {this.set(0,v,'clearcoat');}
  get clearcoatRoughness():number {return this.physical?.[1]??0;} set clearcoatRoughness(v:number) {this.set(1,v,'clearcoatRoughness');}
  get transmission():number {return this.physical?.[3]??0;} set transmission(v:number) {if(!this.volume)throw new TypeError('Material transmission needs transmission at construction');this.set(3,v,'transmission');}
  get specularColor():number[] {return this.physical?.slice(4,7)??[1,1,1];} set specularColor(c:Color) {this.setColor(4,c,'specularColor');}
  get specularIntensity():number {return this.physical?.[7]??1;} set specularIntensity(v:number) {this.set(7,v,'specularIntensity');}
  get sheenColor():number[] {return this.physical?.slice(8,11)??[0,0,0];} set sheenColor(c:Color) {this.setColor(8,c,'sheenColor');}
  get sheenRoughness():number {return this.physical?.[11]??0;} set sheenRoughness(v:number) {this.set(11,v,'sheenRoughness');}
  get ior():number {return this.ext?.[1]??1.5;} set ior(v:number) {if(!this.ext)throw new TypeError('Material ior needs a physical option at construction');if(!(v>=1&&v<Infinity))throw new RangeError('Material ior must be a finite number >= 1');this.ext[1]=v;}
  get thickness():number {return this.volume?.[0]??0;} set thickness(v:number) {this.setVolume(0,v,'thickness');}
  get attenuationColor():number[] {return this.attenuation.slice(0,3);} set attenuationColor(c:Color) {const v=linear(c,'attenuationColor');for(let k=0;k<3;k++)this.setVolume(k+1,v[k],'attenuationColor');}
  get attenuationDistance():number {return this.attenuation[3];} set attenuationDistance(v:number) {if(!(v>0))throw new RangeError('Material attenuationDistance must be > 0');this.setVolume(4,v,'attenuationDistance');}
  get transmissive():boolean {return !!this.volume;}
  /** @internal gltf-pro's tinted-blend constant when no transmission pass refracts: color x transmission x volume attenuation. */
  get tint():number[]|undefined {if(!this.volume)return undefined;for(let k=0;k<3;k++)this.tinted[k]=this.color[k]*this.physical![3]*this.volume[k+1]**this.volume[0];return this.tinted;}
  get roughness():number {return this.factors[0];} set roughness(v:number) {this.factors[0]=unit(v,'roughness');}
  get metalness():number {return this.factors[1];} set metalness(v:number) {this.factors[1]=unit(v,'metalness');}
  get normalScale():number {return this.factors[2];} set normalScale(v:number) {if(!Number.isFinite(v))throw new RangeError('Invalid normalScale');this.factors[2]=v;}
  get aoMapIntensity():number {return this.factors[3];} set aoMapIntensity(v:number) {this.factors[3]=unit(v,'aoMapIntensity');}
  get opacity():number {return this.color[3];} set opacity(v:number) {this.color[3]=unit(v,'opacity');}
  get alphaTest():number {return this.settings[1];} set alphaTest(v:number) {this.settings[1]=unit(v,'alphaTest');this.sync();}
  get transparent():boolean {return this.blend;} set transparent(v:boolean) {this.blend=!!v;this.sync();}
  get doubleSided():boolean {return this.settings[2]===1;} set doubleSided(v:boolean) {this.settings[2]=+!!v;}
  /** Live: sets one map slot's UV transform, or every slot's without `slot`; null restores the identity. */
  setUVTransform(t:TextureTransform|null,slot?:MapSlot):this {
    const i=slot===undefined?-1:slots.indexOf(slot);if(i>4||slot!==undefined&&i<0)throw new TypeError('Invalid UV transform slot');
    const rows=textureTransform(t??{});for(let k=0;k<5;k++)if(i<0||k===i)this.uvt.splice(k*8,8,...rows);return this;
  }
  /** True when the beauty pipeline needs blending or depth overrides. */
  get customState():boolean {return this.blending!=='normal'||this.depthWrite!==undefined||!this.depthTest;}
  private sync():void {this.settings[0]=this.blend?2:this.settings[1]>0?1:0;}
  /** gltf-pro beauty shader patch; subclasses (such as `@margoengine/shader`'s NodeMaterial) may extend it. */
  shader(source:string,group:number):string {return materialShader(source,group,this.shading);}
  /** @internal gltf-pro LightingEffect bindings for one device; `engine` is the drawing engine. */
  bindings(device:GPUDevice,_engine?:Engine):GPUBindGroupEntry[] {
    const d=defaults(device),entries:GPUBindGroupEntry[]=[];
    for(let i=0;i<(this.shading==='matcap'?6:5);i++){const bound=this[slots[i]]?.bind(device,i===0||i>=4)??[i===2?d.normal:d.white,d.sampler];entries.push({binding:32+i*2,resource:bound[0]},{binding:33+i*2,resource:bound[1]});}
    return entries;
  }
}

/** Any CPU geometry with three.js UV orientation; `@margoengine/geometry` output fits directly. Colors are RGB or RGBA, floats 0-1 or bytes. */
export interface MeshGeometry {positions:ArrayLike<number>;normals:ArrayLike<number>;uvs?:ArrayLike<number>;indices?:ArrayLike<number>;tangents?:ArrayLike<number>;colors?:ArrayLike<number>}
const packed=new WeakMap<object,PreparedGeometry>();
/** Packs once per geometry object into gltf-pro's 80-byte vertex (position, normal, tangent, UV0=UV1, color). Later edits to the object are not seen. */
export function packGeometry(g:MeshGeometry):PreparedGeometry {
  let out=packed.get(g);if(out)return out;
  const {positions:p,normals:n,uvs,tangents:t,colors:c}=g??{} as MeshGeometry,count=p?.length/3,width=c?c.length/count:0,scale=c instanceof Uint8Array||c instanceof Uint8ClampedArray?1/255:1;
  if(!Number.isInteger(count)||count<3||count>1_000_000||n?.length!==count*3||uvs&&uvs.length!==count*2||t&&t.length!==count*4||c&&width!==3&&width!==4)throw new RangeError('Mismatched mesh geometry attributes');
  const v=new Float32Array(count*20);
  for(let i=0,o=0;i<count;i++,o+=20){
    const length=Math.hypot(n[i*3],n[i*3+1],n[i*3+2]),tl=t?Math.hypot(t[i*4],t[i*4+1],t[i*4+2]):0;if(!length)throw new RangeError('Mesh normals must be non-zero');
    for(let k=0;k<3;k++){v[o+k]=p[i*3+k];v[o+4+k]=n[i*3+k]/length;if(tl)v[o+8+k]=t![i*4+k]/tl;}
    v[o+3]=1;if(tl)v[o+11]=t![i*4+3]<0?-1:1;
    if(uvs){v[o+12]=v[o+14]=uvs[i*2];v[o+13]=v[o+15]=uvs[i*2+1];}
    for(let k=0;k<4;k++)v[o+16+k]=c&&k<width?c[i*width+k]*scale:1;
  }
  out={vertices:v,indices:g.indices?Uint32Array.from(g.indices):Uint32Array.from({length:count},(_,i)=>i)};packed.set(g,out);return out;
}
interface Entry {model:PBRModel;material:Material;order:number}
const blends:Record<Blending,GPUBlendState|null|undefined>={normal:undefined,none:null,
  additive:{color:{srcFactor:'src-alpha',dstFactor:'one'},alpha:{srcFactor:'one',dstFactor:'one'}},multiply:{color:{srcFactor:'zero',dstFactor:'src'},alpha:{srcFactor:'zero',dstFactor:'src-alpha'}}};
const queues=new WeakMap<Engine,Set<Entry>>(),late=(m:Material)=>m.transparent||m.transmissive;
let serial=0;
/** One pass per engine draws every material mesh: opaque then transparent, each by renderOrder; transparent meshes back to front. */
function queue(runtime:Engine):Set<Entry> {
  let set=queues.get(runtime);if(set)return set;const entries=set=new Set<Entry>(),name='materials:'+serial++,distance=new Map<Entry,number>();
  runtime.use({name,setup(){},dispose(){queues.delete(runtime);},registerPasses(graph){graph.add({name,order:1,execute:c=>{
    if(c.backend!=='webgpu')return;const eye=c.camera.position;
    for(const e of entries){const m=e.model.primitives[0].node.matrix;distance.set(e,Math.hypot(eye[0]-m[12],eye[1]-m[13],eye[2]-m[14]));}
    const list=[...entries].sort((a,b)=>{const t=+late(a.material)-+late(b.material);return t||a.order-b.order||(late(a.material)?distance.get(b)!-distance.get(a)!:0);});distance.clear();
    for(const e of list)e.model.draw(c,'beauty',c.color,c.depth);
  }});}});
  queues.set(runtime,set);return set;
}
/** A materials mesh: the gltf-pro model plus the live `material` it draws with (read by @margoengine/exporters `exportModel`). */
export type MaterialMesh=PBRModel&{readonly material:Material};
/**
 * Creates a gltf-pro `PBRModel` for one geometry and material. Move it with `model.root`, remove it with `model.destroy()`.
 * It works with `shadows.add`, `clustered.add` and `ssao.add` like a loaded glTF. Textures are not disposed with the model.
 */
export function createMesh(engine:EngineKernel,geometry:MeshGeometry,material:Material,{renderOrder=0}:{renderOrder?:number}={}):MaterialMesh {
  if(!(material instanceof Material)||!Number.isFinite(renderOrder))throw new TypeError('Invalid material mesh');
  const runtime=engineRuntime(engine),m=material,set=queue(runtime);
  const doc={asset:{version:'2.0'},nodes:[{mesh:0}],meshes:[{primitives:[{material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:m.color,roughnessFactor:m.factors[0],metallicFactor:m.factors[1]},emissiveFactor:m.emissive,alphaMode:['OPAQUE','MASK','BLEND'][m.settings[0]],alphaCutoff:m.settings[1],doubleSided:m.doubleSided,...m.physical&&{extensions:Object.fromEntries(m.extensions.map(e=>['KHR_materials_'+e,{}]))}}]};
  const model=new PBRModel(engine,new GLTFAsset(doc,[]),[],[[packGeometry(geometry)]]);
  const g=model.primitives[0].material;Object.assign(g,{base:m.color,emission:m.emissive,factors:m.factors,settings:m.settings,uvt:m.uvt});
  // Physical: gltf-pro's factor-only variant (five maps), live arrays, and the tinted-blend constant read every frame.
  if(m.physical){Object.assign(g,{physical:m.physical,ext:m.ext,volume:m.volume,maps:g.maps.slice(0,5)});Object.defineProperty(g,'tint',{get:()=>m.tint});}
  if(m.customState)g.renderState={blend:blends[m.blending],depthWrite:m.depthWrite,depthCompare:m.depthTest?undefined:'always'} satisfies PBRRenderState;
  model.addLighting({shader:(code,group)=>m.shader(code,group),bindings:()=>m.bindings(runtime.gpu!,runtime)});
  const entry:Entry={model,material:m,order:renderOrder};model.registerPasses=()=>{};
  try{runtime.use(model);}catch(error){model.dispose();throw error;}
  set.add(entry);model.onDispose(()=>set.delete(entry));return Object.defineProperty(model,'material',{value:m}) as MaterialMesh;
}
/** A materials mesh drawn as `instances.count` instances in one draw call (three.js InstancedMesh); `instances` holds each one's matrix, tint and UV transform. */
export type InstancedMesh=MaterialMesh&{readonly instances:PBRInstances};
/**
 * `createMesh` for `capacity` copies in one instanced draw: `mesh.instances.setMatrixAt(i, m)`, `setColorAt`, `setUVTransformAt`
 * (an atlas region), `count`. Instance matrices are relative to `mesh.root`. Works with shadows, clustered, IBL, fog and SSAO.
 */
export function createInstancedMesh(engine:EngineKernel,geometry:MeshGeometry,material:Material,capacity:number,options:{renderOrder?:number}={}):InstancedMesh {
  const instances=new PBRInstances(capacity),model=createMesh(engine,geometry,material,options);
  model.primitives[0].instances=instances;return Object.defineProperty(model,'instances',{value:instances}) as InstancedMesh;
}
