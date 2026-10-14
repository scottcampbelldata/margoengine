import {Geometry,PbrMaterial,type EngineKernel,type Mesh} from '@margoengine/core';
import {engineRuntime,meshRuntime,type Engine} from '@margoengine/core/extension';
import {GLTFAsset,PBRModel} from '@margoengine/gltf-pro';
import {acesShader} from '../../shared/aces.js';
declare const GPUBufferUsage:{UNIFORM:number;COPY_DST:number;MAP_READ:number};
declare const GPUTextureUsage:{TEXTURE_BINDING:number;COPY_DST:number;COPY_SRC:number;RENDER_ATTACHMENT:number};
declare const GPUMapMode:{READ:number};
export type Vec3=[number,number,number];
/** A core Geometry (with `material`), a core Mesh, or a gltf-pro model (loaded glTF or `@margoengine/materials` mesh), baked in its root's local space. */
export type ImposterSource=Geometry|Mesh|PBRModel;
export interface ImposterOptions {/** Views per side of the octahedral grid, 4-32. Default 12 (144 views). */frames?:number;/** Pixels per view, a power of two 16-1024. Default 128. */frameSize?:number;/** Material for a Geometry source. Default core's PbrMaterial. */material?:PbrMaterial}
/** CPU copy of an atlas for caching: `color` is RGBA8 sRGB albedo with coverage alpha, `normal` raw float16 RGBA (octahedral normal, depth, packed roughness/metalness). */
export interface ImposterData {frames:number;frameSize:number;center:Vec3;radius:number;shading:'core'|'gltf';color:Uint8Array;normal:Uint16Array}

// Octahedral directions with +y at the grid centre and -y at the corners; the sign helper keeps zero on the positive side.
export const octWGSL=`fn lod_sgn(v:vec2f)->vec2f {return select(vec2f(-1.0),vec2f(1.0),v>=vec2f(0.0));}
fn lod_decode(e:vec2f)->vec3f {var n=vec3f(e.x,1.0-abs(e.x)-abs(e.y),e.y);if(n.y<0.0){let f=(1.0-abs(e.yx))*lod_sgn(e);n=vec3f(f.x,n.y,f.y);}return normalize(n);}
fn lod_encode(n:vec3f)->vec2f {let p=n.xz/(abs(n.x)+abs(n.y)+abs(n.z));return select(p,(1.0-abs(p.yx))*lod_sgn(p),n.y<0.0);}
fn lod_basis(d:vec3f)->mat3x3f {let r=normalize(cross(select(vec3f(0.0,1.0,0.0),vec3f(0.0,0.0,1.0),abs(d.y)>0.999),d));return mat3x3f(r,cross(d,r),d);}`;
const sgn=(v:number)=>v>=0?1:-1,cross=(a:Vec3,b:Vec3):Vec3=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],unit=(v:Vec3):Vec3=>{const l=Math.hypot(...v);return [v[0]/l,v[1]/l,v[2]/l];};
export function octDecode(x:number,y:number):Vec3 {const h=1-Math.abs(x)-Math.abs(y);return unit(h<0?[(1-Math.abs(y))*sgn(x),h,(1-Math.abs(x))*sgn(y)]:[x,h,y]);}
export function octEncode(d:Vec3):[number,number] {const s=Math.abs(d[0])+Math.abs(d[1])+Math.abs(d[2]),x=d[0]/s,y=d[2]/s;return d[1]<0?[(1-Math.abs(y))*sgn(x),(1-Math.abs(x))*sgn(y)]:[x,y];}
/** View direction (object centre towards the camera) of atlas tile column i, row j on an n×n grid. */
export const frameDirection=(i:number,j:number,n:number):Vec3=>octDecode(i/(n-1)*2-1,j/(n-1)*2-1);
/** Screen right and up of a view; matches the WGSL `lod_basis`. */
export function frameBasis(d:Vec3):[Vec3,Vec3] {const r=unit(cross(Math.abs(d[1])>0.999?[0,0,1]:[0,1,0],d));return [r,cross(d,r)];}
/** Orthographic clip matrix of one view of the sphere (center, radius): x right, y up, reversed-Z depth with 1 at the camera side. */
export function frameMatrix(d:Vec3,c:Vec3,r:number,out=new Float32Array(16)):Float32Array {
  const [x,y]=frameBasis(d),dot=(a:Vec3)=>a[0]*c[0]+a[1]*c[1]+a[2]*c[2];out.fill(0);
  for(let k=0;k<3;k++){out[k*4]=x[k]/r;out[k*4+1]=y[k]/r;out[k*4+2]=d[k]/(2*r);}
  out[12]=-dot(x)/r;out[13]=-dot(y)/r;out[14]=0.5-dot(d)/(2*r);out[15]=1;return out;
}
/** Early return added to gltf-pro's beauty fragment: albedo (mode 0) or octahedral normal, depth and roughness*32+metalness in 31 steps each (mode 1, exact in float16). */
export function bakeShader(code:string,group:number):string {
  let found=false;const out=code.replace(/@fragment fn fragment\([\s\S]*?let s=surface\(i,front\);/,head=>{found=true;return head+'\n  if(lod_bake.x<2.0){return lod_bake_out(s,i.clip.z);}';});
  if(!found)throw new Error('Imposter baking requires the gltf-pro PBR shader');
  return `@group(${group}) @binding(96) var<uniform> lod_bake:vec4f;\n${octWGSL}\nfn lod_bake_out(s:Surface,z:f32)->vec4f {if(lod_bake.x<0.5){return vec4f(s.base.rgb,1.0);}return vec4f(lod_encode(normalize(s.n)),z*2.0-1.0,round(s.roughness*31.0)*32.0+round(s.metal*31.0));}\n`+out;
}
const mipCode=`struct Out {@builtin(position) clip:vec4f,@location(0) uv:vec2f}
@vertex fn vertex(@builtin(vertex_index) i:u32)->Out {let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));var o:Out;o.clip=vec4f(p[i],0,1);o.uv=p[i]*vec2f(0.5,-0.5)+0.5;return o;}
@group(0) @binding(0) var image:texture_2d<f32>;@group(0) @binding(1) var imageSampler:sampler;
@fragment fn fragment(i:Out)->@location(0) vec4f {return textureSample(image,imageSampler,i.uv);}`;
function mipmaps(device:GPUDevice,texture:GPUTexture):void {
  const format=texture.format,module=device.createShaderModule({code:mipCode}),pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format}]}});
  const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'}),encoder=device.createCommandEncoder(),level=(baseMipLevel:number)=>texture.createView({baseMipLevel,mipLevelCount:1});
  for(let i=1;i<texture.mipLevelCount;i++){
    const pass=encoder.beginRenderPass({colorAttachments:[{view:level(i),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});
    pass.setPipeline(pipeline);pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:level(i-1)},{binding:1,resource:sampler}]}));pass.draw(3);pass.end();
  }
  device.queue.submit([encoder.finish()]);
}
/** A static gltf-pro copy of a core geometry and material (80-byte vertices), set up without registering a draw pass. */
function coreModel(engine:Engine,g:Geometry,material:PbrMaterial):PBRModel {
  const v=g.vertices,count=v.length/6,out=new Float32Array(count*20),d=material.data;
  for(let i=0;i<count;i++){const s=i*6,o=i*20,l=Math.hypot(v[s+3],v[s+4],v[s+5]);out[o]=v[s];out[o+1]=v[s+1];out[o+2]=v[s+2];out[o+3]=1;if(l){out[o+4]=v[s+3]/l;out[o+5]=v[s+4]/l;out[o+6]=v[s+5]/l;}else out[o+5]=1;out.fill(1,o+16,o+20);}
  const doc={asset:{version:'2.0'},nodes:[{mesh:0}],meshes:[{primitives:[{material:0}]}],materials:[{pbrMetallicRoughness:{baseColorFactor:[d[0],d[1],d[2],1],roughnessFactor:d[4],metallicFactor:d[5]},doubleSided:d[6]===1}]};
  const model=new PBRModel(engine,new GLTFAsset(doc,[]),[],[[{vertices:out,indices:g.indices}]]);
  try{model.setup(engine);}catch(error){model.dispose();throw error;}return model;
}
const keys=['x','y','z','qx','qy','qz','qw','sx','sy','sz'] as const;

/**
 * Octahedral imposter atlas: `frames`² orthographic views of an object over the whole sphere of directions, baked on the
 * GPU into albedo + coverage and normal + depth + roughness/metalness. Use it as the last level of a `LODSystem` level list.
 */
export class Imposter {
  readonly frames:number;readonly frameSize:number;readonly center:Vec3=[0,0,0];radius=1;readonly shading:'core'|'gltf';disposed=false;
  /** @internal */ color?:GPUTexture;/** @internal */ normal?:GPUTexture;/** @internal */ uniform?:GPUBuffer;/** @internal */ device?:GPUDevice;
  private source?:Geometry|PBRModel;private material:PbrMaterial;private data?:ImposterData;
  private constructor(private readonly engine:Engine,source:ImposterSource|undefined,data:ImposterData|undefined,{frames=12,frameSize=128,material}:ImposterOptions) {
    if(!Number.isInteger(frames)||frames<4||frames>32||!Number.isInteger(Math.log2(frameSize))||frameSize<16||frameSize>1024)throw new RangeError('Imposter frames 4-32, frameSize a power of two 16-1024');
    if(material!==undefined&&!(material instanceof PbrMaterial))throw new TypeError('Expected a PbrMaterial');
    this.frames=frames;this.frameSize=frameSize;this.material=material??new PbrMaterial();this.data=data;
    if(source instanceof Geometry||source instanceof PBRModel)this.source=source;
    else if(source){const mesh=meshRuntime(source);mesh.check();if(!mesh.geometry)throw new TypeError('Imposter mesh needs a geometry');this.source=mesh.geometry;if(!material)this.material=mesh.material;}
    else if(!data)throw new TypeError('Expected an imposter source');
    this.shading=data?data.shading:this.source instanceof PBRModel?'gltf':'core';
  }
  /** Bakes now (WebGPU). Keep the source alive, or keep `export()` data, if the device may be lost: the atlas is rebuilt from it. */
  static bake(engine:EngineKernel,source:ImposterSource,options:ImposterOptions={}):Imposter {const i=new Imposter(engineRuntime(engine),source,undefined,options);i.ready();return i;}
  /** Restores an atlas saved with `export()`, without the source. */
  static fromData(engine:EngineKernel,data:ImposterData):Imposter {
    const size=data?.frames*data?.frameSize,ok=data&&data.color instanceof Uint8Array&&data.normal instanceof Uint16Array&&data.color.length===size*size*4&&data.normal.length===size*size*4&&['core','gltf'].includes(data.shading)&&data.radius>0&&data.center?.length===3&&data.center.every(Number.isFinite);
    if(!ok)throw new TypeError('Invalid imposter data');const i=new Imposter(engineRuntime(engine),undefined,data,data);i.center.splice(0,3,...data.center);i.radius=data.radius;i.ready();return i;
  }
  get size():number {return this.frames*this.frameSize;}
  /** @internal Brings the atlas onto the engine's current device (re-bake or re-upload after a device restore); false if nothing can be drawn. */
  ready():boolean {
    const device=this.engine.gpu;if(this.disposed||!device)return false;if(this.device===device)return !!this.color;
    this.release();this.device=device;
    if(this.source instanceof PBRModel&&this.source.disposed)this.source=undefined;
    if(!this.data&&!this.source)return false;
    const size=this.size;if(size>device.limits.maxTextureDimension2D)throw new RangeError('Imposter atlas exceeds device limit');
    this.color=device.createTexture({size:[size,size],format:'rgba8unorm-srgb',mipLevelCount:Math.max(1,Math.log2(this.frameSize)-2),usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC|GPUTextureUsage.RENDER_ATTACHMENT});
    this.normal=device.createTexture({size:[size,size],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.COPY_SRC});
    this.uniform=device.createBuffer({size:32,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    if(this.data){device.queue.writeTexture({texture:this.color},this.data.color as Uint8Array<ArrayBuffer>,{bytesPerRow:size*4},[size,size]);device.queue.writeTexture({texture:this.normal},this.data.normal as Uint16Array<ArrayBuffer>,{bytesPerRow:size*8},[size,size]);}
    else this.bake(device,this.source!);
    mipmaps(device,this.color);
    device.queue.writeBuffer(this.uniform,0,new Float32Array([...this.center,this.radius,this.frames,size,+(this.shading==='gltf'),this.frameSize]));
    return true;
  }
  private bake(device:GPUDevice,source:Geometry|PBRModel):void {
    const e=this.engine,store=e.store,n=this.frames,fs=this.frameSize,temp=source instanceof Geometry,model=source instanceof Geometry?coreModel(e,source,this.material):source;
    const id=meshRuntime(model.root).id,t=store.transforms,saved=keys.map(k=>t[k][id]),parent=store.parents[id],hidden=store.hidden[id],scratch:Array<GPUTexture|GPUBuffer>=[];let remove=()=>{};
    try {
      // Bake in the root's local space: unparented, identity transform, visible.
      keys.forEach((k,i)=>{t[k][id]=+(i>=6);});store.parents[id]=-1;store.hidden[id]=0;store.tick(false);
      const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity],points:number[]=[];
      for(const p of model.primitives){const m=p.node.matrix,v=p.vertices;for(let i=0;i<v.length;i+=20)for(let r=0;r<3;r++){const x=m[r]*v[i]+m[4+r]*v[i+1]+m[8+r]*v[i+2]+m[12+r];points.push(x);min[r]=Math.min(min[r],x);max[r]=Math.max(max[r],x);}}
      const c=this.center;for(let r=0;r<3;r++)c[r]=(min[r]+max[r])/2;let radius=0;for(let i=0;i<points.length;i+=3)radius=Math.max(radius,Math.hypot(points[i]-c[0],points[i+1]-c[1],points[i+2]-c[2]));
      this.radius=radius*1.01||1e-3;
      const target=(format:GPUTextureFormat)=>{const texture=device.createTexture({size:[fs,fs],format,usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.COPY_SRC});scratch.push(texture);return texture;};
      const albedo=target('rgba8unorm-srgb'),normal=target('rgba16float'),depth=target('depth32float'),views=[albedo,normal,depth].map(texture=>texture.createView());
      const modes=[0,1].map(mode=>{const buffer=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});scratch.push(buffer);device.queue.writeBuffer(buffer,0,new Float32Array([mode,0,0,0]));return buffer;});let mode=0;
      remove=model.addLighting({owner:e,shader:bakeShader,bindings:()=>[{binding:96,resource:{buffer:modes[mode]}}]});
      const camera={matrix:new Float32Array(16),position:[0,0,1],target:[0,0,0]},context:any={backend:'webgpu',device,camera,descriptor:{multisample:{count:1},depthStencil:{format:'depth32float'}}};
      const clearDepth={view:views[2],depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'} as const;
      for(let j=0;j<n;j++)for(let i=0;i<n;i++){
        frameMatrix(frameDirection(i,j,n),c,this.radius,camera.matrix);const encoder=context.encoder=device.createCommandEncoder();
        encoder.beginRenderPass({colorAttachments:[0,1].map(k=>({view:views[k],loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]})),depthStencilAttachment:clearDepth}).end();
        mode=0;context.format='rgba8unorm-srgb';model.draw(context,'beauty',views[0],views[2]);
        encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:clearDepth}).end();
        mode=1;context.format='rgba16float';model.draw(context,'beauty',views[1],views[2]);
        for(const [from,to] of [[albedo,this.color!],[normal,this.normal!]])encoder.copyTextureToTexture({texture:from},{texture:to,origin:[i*fs,j*fs]},[fs,fs]);
        device.queue.submit([encoder.finish()]);
      }
    } finally {
      remove();keys.forEach((k,i)=>{t[k][id]=saved[i];});store.parents[id]=parent;store.hidden[id]=hidden;store.tick(false);
      for(const resource of scratch)resource.destroy();if(temp)model.dispose();
    }
  }
  /** Reads the atlas back for caching (IndexedDB, a file); `Imposter.fromData` restores it without baking. */
  async export():Promise<ImposterData> {
    if(!this.ready())throw new Error('Imposter has no atlas');const device=this.device!,size=this.size;
    const read=async(texture:GPUTexture,bytes:number)=>{
      const row=Math.ceil(size*bytes/256)*256,buffer=device.createBuffer({size:row*size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();
      try{encoder.copyTextureToBuffer({texture},{buffer,bytesPerRow:row},[size,size]);device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
        const mapped=new Uint8Array(buffer.getMappedRange()),out=new Uint8Array(size*size*bytes);for(let y=0;y<size;y++)out.set(mapped.subarray(y*row,y*row+size*bytes),y*size*bytes);buffer.unmap();return out;}
      finally{buffer.destroy();}
    };
    const color=await read(this.color!,4),normal=await read(this.normal!,8);
    return {frames:this.frames,frameSize:this.frameSize,center:[...this.center],radius:this.radius,shading:this.shading,color,normal:new Uint16Array(normal.buffer)};
  }
  private release():void {this.color?.destroy();this.normal?.destroy();this.uniform?.destroy();this.color=this.normal=this.uniform=undefined;this.device=undefined;}
  dispose():void {this.disposed=true;this.release();this.source=this.data=undefined;}
}

/** Draws one atlas: camera-facing quads that reproject the three nearest views (one depth parallax step each), blend them, relight and write per-pixel depth. */
export const imposterShader=`${acesShader}
${octWGSL}
struct Frame {camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,options:vec4f}
struct Atlas {center:vec4f,grid:vec4f}
@group(0) @binding(0) var<uniform> frame:Frame;
@group(0) @binding(1) var<storage,read> instances:array<mat4x4f>;
@group(0) @binding(2) var colorMap:texture_2d<f32>;
@group(0) @binding(3) var normalMap:texture_2d<f32>;
@group(0) @binding(4) var colorSampler:sampler;
@group(0) @binding(5) var<uniform> atlas:Atlas;
struct Out {@builtin(position) clip:vec4f,@location(0) p:vec3f,@location(1) @interpolate(flat) eye:vec3f,@location(2) @interpolate(flat) a:vec4f,@location(3) @interpolate(flat) b:vec2f,@location(4) @interpolate(flat) w:vec3f,@location(5) @interpolate(flat) id:u32}
struct Pixel {@location(0) color:vec4f,@builtin(frag_depth) depth:f32}
fn lod_cell(p:vec3f,c:vec3f,r:f32,b:mat3x3f)->vec2f {let l=(p-c)/r;return vec2f(dot(l,b[0]),-dot(l,b[1]))*0.5+0.5;}
fn srgb(c:vec3f)->vec3f {let x=clamp(c,vec3f(0.0),vec3f(1.0));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
@vertex fn vertex(@builtin(vertex_index) v:u32,@builtin(instance_index) id:u32)->Out {
 let m=instances[id];let c=atlas.center.xyz;let r=atlas.center.w;let n=atlas.grid.x;
 let c0=cross(m[1].xyz,m[2].xyz);let eye=transpose(mat3x3f(c0,cross(m[2].xyz,m[0].xyz),cross(m[0].xyz,m[1].xyz)))*(frame.eye.xyz-m[3].xyz)/dot(m[0].xyz,c0);
 // Quad on the sphere's camera-side tangent plane, half-size r: covers the projected sphere for any distance beyond it.
 let view=normalize(eye-c);let basis=lod_basis(view);let corner=vec2f(f32(v&1u),f32(v>>1u))*2.0-1.0;let p=c+view*r+(basis[0]*corner.x+basis[1]*corner.y)*r;
 let g=clamp((lod_encode(view)*0.5+0.5)*(n-1.0),vec2f(0.0),vec2f(n-1.0));let base=min(floor(g),vec2f(n-2.0));let f=g-base;
 var o:Out;o.clip=frame.camera*(m*vec4f(p,1.0));o.p=p;o.eye=eye;o.id=id;o.b=base+vec2f(0.0,1.0);
 if(f.x+f.y<1.0){o.a=vec4f(base,base+vec2f(1.0,0.0));o.w=vec3f(1.0-f.x-f.y,f.x,f.y);}
 else{o.a=vec4f(base+vec2f(1.0),base+vec2f(1.0,0.0));o.w=vec3f(f.x+f.y-1.0,1.0-f.y,1.0-f.x);}
 return o;
}
@fragment fn fragment(i:Out)->Pixel {
 let c=atlas.center.xyz;let r=atlas.center.w;let n=atlas.grid.x;let size=vec2f(textureDimensions(normalMap));let ray=i.p-i.eye;
 let tiles=array<vec2f,3>(i.a.xy,i.a.zw,i.b);let weights=array<f32,3>(i.w.x,i.w.y,i.w.z);let levels=f32(textureNumLevels(colorMap))-1.0;
 // Everything is blended by the view weights (no single "best" view), so nothing switches abruptly while the camera turns.
 var acc=vec4f(0.0);var normal=vec3f(0.0,1e-5,0.0);var along=0.0;var surface=vec2f(0.0);
 for(var k=0;k<3;k++){
  // Reproject the pixel's ray onto view k's plane through the centre.
  let d=lod_decode(tiles[k]/(n-1.0)*2.0-1.0);let basis=lod_basis(d);let denom=select(dot(ray,d),-0.000001,abs(dot(ray,d))<0.000001);
  let start=dot(c-i.eye,d)/denom;let centre=lod_cell(i.eye+ray*start,c,r,basis);
  // Mip level from that smooth coordinate; clamp half a texel of the coarser level sampled, so trilinear filtering never
  // reads a neighbouring view's texels.
  let texels=(tiles[k]+centre)/n*size;let lod=clamp(log2(max(length(dpdx(texels)),length(dpdy(texels)))),0.0,levels);let half=exp2(ceil(lod))*0.5/atlas.grid.w;
  // One parallax step: this view's depth there moves the point along the ray onto its surface, so the three views agree.
  let first=textureLoad(normalMap,vec2i(clamp((tiles[k]+clamp(centre,vec2f(half),vec2f(1.0-half)))/n*size,vec2f(0.0),size-1.0)),0);
  let cell=lod_cell(i.eye+ray*(start+first.z*r/denom),c,r,basis);let at=(tiles[k]+clamp(cell,vec2f(half),vec2f(1.0-half)))/n;
  let sample=textureSampleLevel(colorMap,colorSampler,at,lod)*f32(all(abs(cell-0.5)<vec2f(0.5)));let nd=textureLoad(normalMap,vec2i(clamp(at*size,vec2f(0.0),size-1.0)),0);
  let weight=weights[k]*sample.a;acc+=weights[k]*sample;normal+=lod_decode(nd.xy)*weight;
  // View k's surface point on this pixel's ray (depth nd.z in radius units along d); the weights sum to alpha.
  let packed=floor(nd.w/32.0);along+=(start+nd.z*r/denom)*weight;surface+=vec2f(packed,nd.w-packed*32.0)*weight;
 }
 // Views that still disagree (silhouettes) cross-fade over alpha 0.25-0.75 instead of a hard cut at 0.5, where whole regions
 // would switch at once as the weights pass it: alpha-to-coverage under MSAA, a per-pixel dither threshold at 1x.
 let alpha=acc.a;let coverage=clamp((alpha-0.5)/max(fwidth(alpha),0.5)+0.5,0.0,1.0);
 if(coverage<=select(fract(52.9829189*fract(dot(i.clip.xy,vec2f(0.06711056,0.00583715)))),0.0,frame.options.y>0.5)){discard;}
 let m=instances[i.id];let world=(m*vec4f(i.eye+ray*(along/max(alpha,0.000001)),1.0)).xyz;let clip=frame.camera*vec4f(world,1.0);
 let albedo=acc.rgb/max(alpha,0.0001);let rm=surface/max(alpha,0.000001)/31.0;let rough=clamp(rm.x,0.045,1.0);let metal=clamp(rm.y,0.0,1.0);
 let nn=normalize(mat3x3f(cross(m[1].xyz,m[2].xyz),cross(m[2].xyz,m[0].xyz),cross(m[0].xyz,m[1].xyz))*normalize(normal)*sign(dot(m[0].xyz,cross(m[1].xyz,m[2].xyz))));
 let v=normalize(frame.eye.xyz-world);let l=normalize(frame.light.xyz);let h=(v+l)/max(length(v+l),0.0001);
 let nl=clamp(dot(nn,l),0.0,1.0);let nv=clamp(dot(nn,v),0.0001,1.0);let nh=clamp(dot(nn,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
 let a=rough*rough;let a2=a*a;let d=a2/(3.14159265*pow(nh*nh*(a2-1.0)+1.0,2.0));let g=2.0*nv/(nv+sqrt(a2+(1.0-a2)*nv*nv))*2.0*nl/max(nl+sqrt(a2+(1.0-a2)*nl*nl),0.0001);
 let f0=mix(vec3f(0.04),albedo,metal);let fresnel=f0+(1.0-f0)*pow(1.0-vh,5.0);
 let direct=((1.0-fresnel)*(1.0-metal)*albedo/3.14159265+d*g*fresnel/max(4.0*nl*nv,0.0001))*nl*frame.radiance.rgb*frame.light.w;
 var color:vec3f;
 // Match the source's renderer: gltf-pro (hemisphere fill, ACES) or core (flat ambient, Reinhard).
 if(atlas.grid.z>0.5){color=direct+(albedo*(1.0-metal)+f0*0.5)*mix(vec3f(0.35,0.3,0.25),vec3f(1.0),clamp(nn.y*0.5+0.5,0.0,1.0))*frame.radiance.w;if(frame.options.x<0.5){color=srgb(aces(max(color,vec3f(0.0))/0.6));}}
 else{color=direct+albedo*(1.0-metal)*frame.radiance.w;if(frame.options.x<0.5){color=srgb(color/(1.0+color));}}
 return Pixel(vec4f(color,coverage),clamp(clip.z/clip.w,0.0,1.0));
}`;
