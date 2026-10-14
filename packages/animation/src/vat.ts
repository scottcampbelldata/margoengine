import type {Engine,EnginePlugin,FrameGraph,PassContext} from '@margoengine/core/extension';
import type {Animation} from './index.js';
import {invert} from '../../shared/math.js';
import {acesShader} from '../../shared/aces.js';
import {multiplyMatrices} from '@margoengine/math/mat4';
declare const GPUBufferUsage:{UNIFORM:number;STORAGE:number;VERTEX:number;INDEX:number;COPY_DST:number};
declare const GPUTextureUsage:{TEXTURE_BINDING:number;COPY_DST:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;

/** Rows `start`..`start + frames` hold the clip at `duration * row / frames`; a looping clip's last row equals its first. */
export interface VATClip {name:string;start:number;frames:number;duration:number;loop:boolean}
/** Baked vertex animation: per row and vertex two rgba32float texels (model-root-space position, normal), wrapped at `width`. */
export interface VATData {vertexCount:number;rows:number;width:number;texels:Float32Array;indices:Uint32Array;/** UV0 in three.js orientation (v up), like `@margoengine/materials` textures. */uvs:Float32Array;clips:VATClip[]}
export interface VATBakeOptions {/** Rows per second. Default 30. */fps?:number;/** Clip names or indices. Default: all. */clips?:readonly (string|number)[]}
/** Texture width VAT data wraps at (any WebGPU device takes 8192 rows of it). */
export const VAT_WIDTH=2048;
/** Texel (x, y) of a baked row's vertex: k 0 is position, 1 is normal. The shader computes the same. */
export function vatTexel(row:number,vertex:number,k:number,vertexCount:number,width=VAT_WIDTH):[number,number] {const i=(row*vertexCount+vertex)*2+k;return [i%width,Math.floor(i/width)];}

/**
 * Bakes clips of a skinned and/or morphed glTF (an `Animation`) on the CPU into one vertex animation texture, all
 * primitives merged in the model root's space. Skinning and morphs follow the GPU deformation pass. The animation's
 * clip, time and playing state are restored afterwards.
 */
export function bakeVAT(animation:Animation,{fps=30,clips}:VATBakeOptions={}):VATData {
  const model=animation.model,doc=model.asset.doc,store=model.root.engine.store,asset=model.asset;
  const ids=(clips??animation.clips.map((_,i)=>i)).map(c=>typeof c==='string'?animation.clips.findIndex(x=>x.name===c):c);
  if(!(fps>0&&fps<=1000)||!ids.length||ids.some(i=>!animation.clips[i]))throw new RangeError('Invalid VAT fps or clips');
  const parts=model.primitives.map(p=>{
    const def=p.definition,s=doc.nodes[p.nodeIndex].skin===undefined?null:doc.skins[doc.nodes[p.nodeIndex].skin],joints:number[]=s?.joints??[];
    return {p,count:p.vertices.length/20,joints,deltas:(def.targets??[]).map((t:any)=>[t.POSITION,t.NORMAL].map(a=>a===undefined?null:asset.accessor(a,'VEC3'))),
      bind:s?.inverseBindMatrices===undefined?new Float32Array(joints.length*16).map((_,i)=>+(i%16%5===0)):asset.accessor(s.inverseBindMatrices,'MAT4'),
      ids:s?asset.accessor(def.attributes.JOINTS_0,'VEC4'):null,weights:s?asset.accessor(def.attributes.WEIGHTS_0,'VEC4'):null,palette:new Float32Array(Math.max(1,joints.length)*16)};
  });
  const vertexCount=parts.reduce((n,x)=>n+x.count,0),frames=ids.map(i=>Math.max(1,Math.ceil(animation.clips[i].duration*fps))),rows=frames.reduce((n,f)=>n+f+1,0);
  const height=Math.ceil(rows*vertexCount*2/VAT_WIDTH);if(height>8192)throw new RangeError('VAT data exceeds 8192 texture rows');
  const texels=new Float32Array(VAT_WIDTH*height*4),uvs=new Float32Array(vertexCount*2),indices:number[]=[];
  for(let k=0,base=0;k<parts.length;base+=parts[k++].count){const v=parts[k].p.vertices;for(let i=0;i<parts[k].count;i++){uvs[(base+i)*2]=v[i*20+12];uvs[(base+i)*2+1]=1-v[i*20+13];}for(const i of parts[k].p.indices)indices.push(base+i);}
  const saved={clip:animation.clip,time:animation.time,playing:animation.playing},root=new Float32Array(16),joint=new Float32Array(16),m=new Float64Array(12),work=new Float64Array(52);
  let row=0;
  try {
    ids.forEach((clip,c)=>{
      const duration=animation.clips[clip].duration;animation.play(clip);
      for(let r=0;r<=frames[c];r++,row++){
        animation.seek(duration*r/frames[c]);store.tick(false);if(!invert(root,model.root.matrix,0,work))throw new Error('Singular VAT model root');
        let o=row*vertexCount*8;
        for(const x of parts){
          const {p,joints,palette,ids:j,weights:w}=x,v=p.vertices;
          if(joints.length)for(let i=0;i<joints.length;i++){multiplyMatrices(model.nodes[joints[i]].matrix,x.bind.subarray(i*16,i*16+16),joint);multiplyMatrices(root,joint,palette.subarray(i*16,i*16+16));}
          else multiplyMatrices(root,p.node.matrix,palette);
          for(let i=0;i<x.count;i++,o+=8){
            let px=v[i*20],py=v[i*20+1],pz=v[i*20+2],nx=v[i*20+4],ny=v[i*20+5],nz=v[i*20+6];
            for(let t=0;t<x.deltas.length;t++){const [dp,dn]=x.deltas[t],wt=p.weights[t];if(dp){px+=dp[i*3]*wt;py+=dp[i*3+1]*wt;pz+=dp[i*3+2]*wt;}if(dn){nx+=dn[i*3]*wt;ny+=dn[i*3+1]*wt;nz+=dn[i*3+2]*wt;}}
            // Blended joint matrix (columns 0-3, rows 0-2), weights normalized like the GPU pass.
            if(j){m.fill(0);const sum=w![i*4]+w![i*4+1]+w![i*4+2]+w![i*4+3];for(let q=0;q<4;q++){const b=j[i*4+q]*16,f=w![i*4+q]/sum;for(let e=0;e<12;e++)m[e]+=palette[b+e+(e/3|0)]*f;}}
            else for(let e=0;e<12;e++)m[e]=palette[e+(e/3|0)];
            const X=m[0]*px+m[3]*py+m[6]*pz+m[9],Y=m[1]*px+m[4]*py+m[7]*pz+m[10],Z=m[2]*px+m[5]*py+m[8]*pz+m[11];
            // Cofactor matrix times the determinant's sign: correct normals under non-uniform and mirrored scale.
            const ax=m[4]*m[8]-m[5]*m[7],ay=m[5]*m[6]-m[3]*m[8],az=m[3]*m[7]-m[4]*m[6],bx=m[7]*m[2]-m[8]*m[1],by=m[8]*m[0]-m[6]*m[2],bz=m[6]*m[1]-m[7]*m[0],cx=m[1]*m[5]-m[2]*m[4],cy=m[2]*m[3]-m[0]*m[5],cz=m[0]*m[4]-m[1]*m[3];
            const sign=Math.sign(m[0]*ax+m[1]*ay+m[2]*az),Nx=(ax*nx+bx*ny+cx*nz)*sign,Ny=(ay*nx+by*ny+cy*nz)*sign,Nz=(az*nx+bz*ny+cz*nz)*sign,l=Math.hypot(Nx,Ny,Nz);
            texels[o]=X;texels[o+1]=Y;texels[o+2]=Z;texels[o+3]=1;texels[o+4]=Nx/l;texels[o+5]=Ny/l;texels[o+6]=Nz/l;
          }
        }
      }
    });
  } finally {animation.play(saved.clip);animation.seek(saved.time);animation.playing=saved.playing;store.tick(false);}
  for(let i=0;i<rows*vertexCount*8;i++)if(!Number.isFinite(texels[i]))throw new RangeError('VAT bake produced non-finite vertices (check skin weights)');
  let start=0;
  return {vertexCount,rows,width:VAT_WIDTH,texels,indices:Uint32Array.from(indices),uvs,
    clips:ids.map((i,c)=>{const clip={name:animation.clips[i].name,start,frames:frames[c],duration:animation.clips[i].duration,loop:animation.options.loop??true};start+=frames[c]+1;return clip;})};
}

/** Instance layout (24 floats): world matrix, then clip, time offset (s), speed, 0, then UV offset.xy and scale.xy. */
export const VAT_STRIDE=24;
export interface VATInstance {matrix?:ArrayLike<number>;clip?:number;offset?:number;speed?:number;/** Atlas region (offset and scale; no rotation). */uvTransform?:{offset?:readonly number[];scale?:readonly number[]}}
/** Anything with `@margoengine/materials` Texture's `bind`. */
export interface VATMap {bind(device:GPUDevice,srgb:boolean):[GPUTextureView,GPUSampler]|undefined}
export interface VATCrowdOptions {color?:readonly number[];map?:VATMap|null;roughness?:number;metalness?:number}

export const vatShader=/* wgsl */`${acesShader}
struct Frame {camera:mat4x4f,eye:vec4f,light:vec4f,radiance:vec4f,base:vec4f,options:vec4f,vat:vec4f}
struct Instance {m:mat4x4f,p:vec4f,uv:vec4f}
@group(0) @binding(0) var<uniform> f:Frame;
@group(0) @binding(1) var<storage,read> instances:array<Instance>;
@group(0) @binding(2) var<storage,read> clips:array<vec4f>;
@group(0) @binding(3) var vat:texture_2d<f32>;
@group(0) @binding(4) var map:texture_2d<f32>;
@group(0) @binding(5) var mapSampler:sampler;
struct Out {@builtin(position) clip:vec4f,@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) uv:vec2f}
fn texel(row:u32,v:u32,k:u32)->vec4f {let i=(row*u32(f.vat.x)+v)*2u+k;let w=u32(f.vat.y);return textureLoad(vat,vec2u(i%w,i/w),0);}
@vertex fn vertex(@location(0) uv:vec2f,@builtin(vertex_index) v:u32,@builtin(instance_index) id:u32)->Out {
 let s=instances[id];let c=clips[u32(s.p.x)];var t=(f.options.x*s.p.z+s.p.y)/max(c.z,0.000001);
 t=select(clamp(t,0.0,1.0),fract(t),c.w>0.5);let x=t*c.y;let a=min(floor(x),c.y-1.0);let w=x-a;let r=u32(c.x+a);
 let p=mix(texel(r,v,0u),texel(r+1u,v,0u),w).xyz;let n=mix(texel(r,v,1u),texel(r+1u,v,1u),w).xyz;
 let m=s.m;let c0=cross(m[1].xyz,m[2].xyz);let world=m*vec4f(p,1.0);
 var o:Out;o.clip=f.camera*world;o.position=world.xyz;o.normal=mat3x3f(c0,cross(m[2].xyz,m[0].xyz),cross(m[0].xyz,m[1].xyz))*n*sign(dot(m[0].xyz,c0));o.uv=s.uv.xy+uv*s.uv.zw;return o;
}
fn srgb(c:vec3f)->vec3f {let x=clamp(c,vec3f(0.0),vec3f(1.0));return select(x*12.92,1.055*pow(x,vec3f(1.0/2.4))-0.055,x>=vec3f(0.0031308));}
// gltf-pro's lighting: GGX key light, hemisphere fill, ACES + sRGB unless the target is HDR.
@fragment fn fragment(i:Out,@builtin(front_facing) front:bool)->@location(0) vec4f {
 let albedo=(f.base*textureSample(map,mapSampler,i.uv)).rgb;let rough=f.options.z;let metal=f.options.w;
 let nn=normalize(i.normal)*select(-1.0,1.0,front);let v=normalize(f.eye.xyz-i.position);let l=normalize(f.light.xyz);let h=(v+l)/max(length(v+l),0.0001);
 let nl=clamp(dot(nn,l),0.0,1.0);let nv=clamp(dot(nn,v),0.0001,1.0);let nh=clamp(dot(nn,h),0.0,1.0);let vh=clamp(dot(v,h),0.0,1.0);
 let a=rough*rough;let a2=a*a;let d=a2/(3.14159265*pow(nh*nh*(a2-1.0)+1.0,2.0));let g=2.0*nv/(nv+sqrt(a2+(1.0-a2)*nv*nv))*2.0*nl/max(nl+sqrt(a2+(1.0-a2)*nl*nl),0.0001);
 let f0=mix(vec3f(0.04),albedo,metal);let fresnel=f0+(1.0-f0)*pow(1.0-vh,5.0);
 var color=((1.0-fresnel)*(1.0-metal)*albedo/3.14159265+d*g*fresnel/max(4.0*nl*nv,0.0001))*nl*f.radiance.rgb*f.light.w
  +(albedo*(1.0-metal)+f0*0.5)*mix(vec3f(0.35,0.3,0.25),vec3f(1.0),clamp(nn.y*0.5+0.5,0.0,1.0))*f.radiance.w;
 if(f.vat.z<0.5){color=srgb(aces(max(color,vec3f(0.0))/0.6));}
 return vec4f(color,1.0);
}`;
let serial=0;
/**
 * Draws any number of copies of baked VAT data in one instanced call: each instance has its own matrix, clip, time
 * offset, speed and atlas region, and the CPU does no per-instance work per frame (instance data uploads only when
 * changed). Opaque, no shadows, SSAO or environment lighting; the GPU clips off-screen instances (no CPU culling).
 */
export class VATCrowd implements EnginePlugin {
  readonly name='vat:'+serial++;
  /** Seconds since added; instance time is `time * speed + offset`. */
  time=0;readonly color:number[];roughness:number;metalness:number;map:VATMap|null;
  private data=new Float32Array(VAT_STRIDE*16);private n=0;private dirty=true;private engine?:Engine;private device?:GPUDevice;private gpu?:{vat:GPUTexture;uvs:GPUBuffer;index:GPUBuffer;frame:GPUBuffer;clips:GPUBuffer;instances?:GPUBuffer;white:GPUTexture;blank:[GPUTextureView,GPUSampler]};
  private pipeline?:GPURenderPipeline;private key='';private group?:GPUBindGroup;private bound:unknown[]=[];private readonly frame=new Float32Array(40);
  constructor(readonly vat:VATData,{color=[1,1,1,1],map=null,roughness=0.6,metalness=0}:VATCrowdOptions={}) {
    if(!(vat?.texels instanceof Float32Array)||!vat.clips?.length||color.length!==4||!(roughness>=0&&roughness<=1&&metalness>=0&&metalness<=1))throw new TypeError('Invalid VAT crowd');
    this.color=[...color];this.roughness=roughness;this.metalness=metalness;this.map=map;
  }
  get count():number {return this.n;}
  /** Adds an instance (identity matrix, clip 0, offset 0, speed 1, whole texture by default) and returns its index. */
  add(instance:VATInstance={}):number {
    if(this.n*VAT_STRIDE===this.data.length){const grown=new Float32Array(this.data.length*2);grown.set(this.data);this.data=grown;}
    this.data.set([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1,0,0,1,0,0,0,1,1],this.n*VAT_STRIDE);this.n++;
    try{this.set(this.n-1,instance);}catch(error){this.n--;throw error;}return this.n-1;
  }
  /** Changes the given fields of one instance. */
  set(index:number,{matrix,clip,offset,speed,uvTransform}:VATInstance):this {
    if(!(Number.isInteger(index)&&index>=0&&index<this.n)||clip!==undefined&&!(Number.isInteger(clip)&&clip>=0&&clip<this.vat.clips.length)||matrix!==undefined&&matrix.length!==16)throw new RangeError('Invalid VAT instance');
    const o=index*VAT_STRIDE,d=this.data;if(matrix)d.set(matrix,o);if(clip!==undefined)d[o+16]=clip;if(offset!==undefined)d[o+17]=offset;if(speed!==undefined)d[o+18]=speed;
    if(uvTransform){d.set(uvTransform.offset??[0,0],o+20);d.set(uvTransform.scale??[1,1],o+22);}
    for(let i=o;i<o+VAT_STRIDE;i++)if(!Number.isFinite(d[i]))throw new RangeError('Invalid VAT instance');this.dirty=true;return this;
  }
  /** Drops the last `count - n` instances. */
  truncate(n:number):void {if(!(Number.isInteger(n)&&n>=0&&n<=this.n))throw new RangeError('Invalid VAT count');this.n=n;}
  setup(engine:Engine):void {this.engine=engine;}
  onPreUpdate(delta:number):void {this.time+=delta;}
  registerPasses(graph:FrameGraph):void {graph.add({name:this.name,order:1,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});}
  private resources(device:GPUDevice) {
    if(this.device===device&&this.gpu)return this.gpu;this.release();this.device=device;const v=this.vat;
    const buffer=(data:Float32Array|Uint32Array,usage:number)=>{const b=device.createBuffer({size:Math.max(16,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(b,0,data as Float32Array<ArrayBuffer>);return b;};
    const vat=device.createTexture({size:[v.width,v.texels.length/v.width/4],format:'rgba32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture:vat},v.texels as Float32Array<ArrayBuffer>,{bytesPerRow:v.width*16},[v.width,v.texels.length/v.width/4]);
    const white=device.createTexture({size:[1,1],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});device.queue.writeTexture({texture:white},new Uint8Array([255,255,255,255]),{bytesPerRow:4},[1,1]);
    return this.gpu={vat,white,blank:[white.createView(),device.createSampler()],uvs:buffer(v.uvs,GPUBufferUsage.VERTEX),index:buffer(v.indices,GPUBufferUsage.INDEX),
      frame:device.createBuffer({size:160,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),clips:buffer(Float32Array.from(v.clips.flatMap(c=>[c.start,c.frames,c.duration,+c.loop])),GPUBufferUsage.STORAGE)};
  }
  private draw(c:Context):void {
    const e=this.engine;if(!this.n||!e)return;const device=c.device,g=this.resources(device),samples=c.descriptor.multisample?.count??1,depth=c.descriptor.depthStencil!.format;
    if(!g.instances||g.instances.size<this.n*VAT_STRIDE*4){g.instances?.destroy();g.instances=device.createBuffer({size:this.data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});this.dirty=true;}
    if(this.dirty){device.queue.writeBuffer(g.instances,0,this.data,0,this.n*VAT_STRIDE);this.dirty=false;}
    const f=this.frame;f.set(c.camera.matrix);f.set(c.camera.position,16);f.set(e.lighting.direction,20);f.set(e.lighting.radiance,24);f.set(this.color,28);
    f[32]=this.time;f[34]=Math.min(1,Math.max(0.045,this.roughness));f[35]=this.metalness;f[36]=this.vat.vertexCount;f[37]=this.vat.width;f[38]=+(c.format==='rgba16float');device.queue.writeBuffer(g.frame,0,f);
    const key=c.format+samples+depth;
    if(this.key!==key){
      const module=device.createShaderModule({code:vatShader});this.key=key;
      this.pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex',buffers:[{arrayStride:8,attributes:[{shaderLocation:0,offset:0,format:'float32x2'}]}]},fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},
        primitive:{cullMode:'back'},depthStencil:{format:depth,depthWriteEnabled:true,depthCompare:'greater-equal'},multisample:{count:samples}});
    }
    const [view,sampler]=this.map?.bind(device,true)??g.blank,bound=[this.pipeline,g.instances,view,sampler];
    if(!this.group||bound.some((x,i)=>x!==this.bound[i])){this.bound=bound;this.group=device.createBindGroup({layout:this.pipeline!.getBindGroupLayout(0),entries:[g.frame,g.instances,g.clips].map((buffer,binding)=>({binding,resource:{buffer}} as GPUBindGroupEntry)).concat({binding:3,resource:g.vat.createView()},{binding:4,resource:view},{binding:5,resource:sampler})});}
    const pass=c.encoder.beginRenderPass({colorAttachments:[{view:c.color,loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:c.depth,depthLoadOp:'load',depthStoreOp:'store',stencilReadOnly:true}});
    pass.setPipeline(this.pipeline!);pass.setBindGroup(0,this.group);pass.setVertexBuffer(0,g.uvs);pass.setIndexBuffer(g.index,'uint32');pass.drawIndexed(this.vat.indices.length,this.n);pass.end();
    e.stats.drawCalls++;e.stats.visible+=this.n;
  }
  private release():void {const g=this.gpu;if(g)for(const r of [g.vat,g.white,g.uvs,g.index,g.frame,g.clips,g.instances])r?.destroy();this.gpu=this.pipeline=this.group=undefined;this.key='';this.bound=[];this.device=undefined;}
  onDeviceRestored():void {this.release();this.dirty=true;}
  dispose():void {this.release();this.engine=undefined;}
}
