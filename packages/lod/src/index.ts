import {Geometry,type Mesh} from '@margoengine/core';
import {meshRuntime,type Engine,type EnginePlugin,type FrameGraph,type PassContext} from '@margoengine/core/extension';
import {Imposter,imposterShader} from './imposter.js';
export {Imposter,octEncode,octDecode,frameDirection,frameBasis,frameMatrix,bakeShader,type ImposterData,type ImposterOptions,type ImposterSource,type Vec3} from './imposter.js';
declare const GPUBufferUsage:{UNIFORM:number;STORAGE:number;COPY_DST:number};
type Context=Extract<PassContext,{backend:'webgpu'}>;

/** What a level shows: a core Mesh or a model with a `root` Mesh (gltf-pro, materials), toggled through `visible`; a core Geometry swapped onto the anchor; an Imposter; or null (nothing). */
export type LODObject=Mesh|{readonly root:Mesh}|Geometry|Imposter|null;
/** `distance` (world units from the camera to the anchor) or `screen` (bounding-sphere height as a fraction of the viewport height); every level of one LOD uses the same one. Level 0's value is ignored. */
export interface LODLevel {object:LODObject;distance?:number;screen?:number;/** Fraction the switch distance shrinks by while this level is shown (three.js LOD semantics). */hysteresis?:number}
export interface LODOptions {/** Local bounding radius for `screen` levels and imposter culling. Default: from a Geometry, Mesh or Imposter level. */radius?:number}
export interface LODSystemOptions {/** Default hysteresis per level. Default 0.1. */hysteresis?:number;/** Multiplies every evaluated distance: above 1 switches to coarser levels sooner (a quality knob). Default 1. */bias?:number}
/** Most levels per LOD. */
export const MAX_LEVELS=8;

/** One registered object; `level` is the index shown (-1 before the first frame). */
export class LOD {
  /** @internal */ constructor(private readonly system:LODSystem,/** @internal */ public index:number,readonly anchor:Mesh,readonly levels:readonly LODLevel[]) {}
  get level():number {return this.system.levelOf(this);}
  /** Stops managing the object; the level shown stays shown. */
  remove():void {this.system.remove(this);}
}
interface Atlas {imposter:Imposter;users:number;data:Float32Array;count:number;buffer?:GPUBuffer;group?:GPUBindGroup;texture?:GPUTexture;pipeline?:GPURenderPipeline}
const target=(o:Mesh|{readonly root:Mesh})=>'root' in o?o.root:o;
let serial=0;

/**
 * Level of detail for many objects at once. Every frame (before the transform tick) one loop over packed arrays picks
 * each object's level from its anchor's world position, with hysteresis, and only touches objects whose level changed;
 * it allocates nothing. Imposter levels draw as one instanced call per atlas after the opaque passes.
 */
export class LODSystem implements EnginePlugin {
  readonly name='lod:'+serial++;
  hysteresis:number;bias:number;
  private engine?:Engine;private count=0;private dirty=false;
  private ids=new Int32Array(0);private counts=new Uint8Array(0);private current=new Int8Array(0);private screen=new Uint8Array(0);private swaps=new Uint8Array(0);private radius=new Float32Array(0);
  private thresholds=new Float32Array(0);private bands=new Float32Array(0);private slots=new Int16Array(0);private levelSlots=new Int16Array(0);
  private anchors:Mesh[]=[];private objects:LODObject[][]=[];private handles:LOD[]=[];private atlases:Atlas[]=[];private readonly keepers=new Map<Geometry,Mesh>();
  private uniform?:GPUBuffer;private sampler?:GPUSampler;private pipeline?:GPURenderPipeline;private format?:string;private samples=0;private depthFormat?:string;private readonly frame=new Float32Array(32);
  private readonly color:GPURenderPassColorAttachment={view:undefined!,loadOp:'load',storeOp:'store'};
  private readonly depth:GPURenderPassDepthStencilAttachment={view:undefined!,depthLoadOp:'load',depthStoreOp:'store',stencilReadOnly:true};
  private readonly descriptor:GPURenderPassDescriptor={colorAttachments:[this.color],depthStencilAttachment:this.depth};
  constructor({hysteresis=0.1,bias=1}:LODSystemOptions={}) {if(!(hysteresis>=0&&hysteresis<1)||!(bias>0&&bias<Infinity))throw new RangeError('Invalid LOD options');this.hysteresis=hysteresis;this.bias=bias;}
  setup(engine:Engine):void {this.engine=engine;}
  registerPasses(graph:FrameGraph):void {graph.add({name:this.name,order:1.5,execute:c=>{if(c.backend==='webgpu')this.draw(c);}});}
  onPreUpdate():void {this.update();}
  get size():number {return this.count;}

  /** Registers an object. `anchor` gives the world transform (and receives Geometry levels); level objects are usually its children. */
  add(anchor:Mesh,levels:readonly LODLevel[],{radius}:LODOptions={}):LOD {
    const e=this.engine;if(!e)throw new Error('Use the LOD system on an engine first');const mesh=meshRuntime(anchor);mesh.check();if(mesh.engine!==e)throw new TypeError('Anchor belongs to another engine');
    const n=levels?.length,screen=levels?.[1]?.screen!==undefined;if(!Number.isInteger(n)||n<1||n>MAX_LEVELS)throw new RangeError('LOD needs 1-8 levels');
    if(this.count===this.ids.length)this.grow(Math.max(16,this.count*2));
    const i=this.count,b=i*MAX_LEVELS;let previous=0,swap=false;
    for(let l=0;l<n;l++){
      const {object,distance,screen:size,hysteresis=this.hysteresis}=levels[l];
      if(!(object===null||object instanceof Geometry||object instanceof Imposter||typeof (object as Mesh)?.visible==='boolean'||typeof (object as {root:Mesh})?.root?.visible==='boolean'))throw new TypeError('Invalid LOD level object');
      const value=l===0?0:screen?1/(size as number):distance as number;
      if(l>0&&(screen?distance!==undefined||!(size!>0&&size!<=1e6):size!==undefined||!(distance!>=0&&distance!<Infinity))||!(value>=previous)||!(hysteresis>=0&&hysteresis<1))throw new RangeError('LOD levels need increasing distances or decreasing screen sizes');
      previous=value;this.thresholds[b+l]=value;this.bands[b+l]=hysteresis;this.levelSlots[b+l]=object instanceof Imposter?this.atlas(object):-1;
      if(object instanceof Geometry){swap=true;if(!this.keepers.has(object)){const keeper=e.createMesh().setGeometry(object);keeper.visible=false;this.keepers.set(object,keeper);}}
      else if(object&&!(object instanceof Imposter))target(object).visible=false;
    }
    const sized=levels.find(l=>l.object instanceof Geometry||l.object instanceof Imposter||(l.object as any)?.geometry instanceof Geometry)?.object as any;
    const r=radius??(sized instanceof Imposter?sized.radius:sized instanceof Geometry?sized.bounds[3]:sized?.geometry?.bounds[3]??mesh.geometry?.bounds[3]??1);if(!(r>0&&r<Infinity))throw new RangeError('Invalid LOD radius');
    this.ids[i]=mesh.id;this.counts[i]=n;this.current[i]=-1;this.screen[i]=+screen;this.swaps[i]=+swap;this.radius[i]=r;this.slots[i]=-1;
    const handle=new LOD(this,i,anchor,[...levels]);this.anchors[i]=anchor;this.objects[i]=handle.levels.map(l=>l.object);this.handles[i]=handle;this.count++;this.dirty=true;return handle;
  }
  /** @internal */ levelOf(lod:LOD):number {return this.handles[lod.index]===lod?this.current[lod.index]:-1;}
  /** @internal */ remove(lod:LOD):void {
    const i=lod.index;if(this.handles[i]!==lod)return;const last=--this.count,b=i*MAX_LEVELS,lb=last*MAX_LEVELS;
    for(let l=0;l<this.counts[i];l++)if(this.levelSlots[b+l]>=0)this.atlases[this.levelSlots[b+l]].users--;
    for(const a of [this.ids,this.counts,this.current,this.screen,this.swaps,this.radius,this.slots])a[i]=a[last];
    for(const a of [this.thresholds,this.bands,this.levelSlots])a.copyWithin(b,lb,lb+MAX_LEVELS);
    this.anchors[i]=this.anchors[last];this.objects[i]=this.objects[last];this.handles[i]=this.handles[last];this.handles[i].index=i;
    this.anchors.length=this.objects.length=this.handles.length=last;lod.index=-1;
  }
  private grow(size:number):void {
    const copy=<T extends Int32Array|Uint8Array|Int8Array|Float32Array|Int16Array>(a:T,stride=1):T=>{const out=new (a.constructor as any)(size*stride);out.set(a);return out;};
    this.ids=copy(this.ids);this.counts=copy(this.counts);this.current=copy(this.current);this.screen=copy(this.screen);this.swaps=copy(this.swaps);this.radius=copy(this.radius);this.slots=copy(this.slots);
    this.thresholds=copy(this.thresholds,MAX_LEVELS);this.bands=copy(this.bands,MAX_LEVELS);this.levelSlots=copy(this.levelSlots,MAX_LEVELS);
  }
  private atlas(imposter:Imposter):number {
    let s=this.atlases.findIndex(a=>a.imposter===imposter);if(s<0){s=this.atlases.length;this.atlases.push({imposter,users:0,data:new Float32Array(0),count:0});}
    const a=this.atlases[s];if(++a.users*16>a.data.length){const data=new Float32Array(Math.max(256,a.data.length*2));data.set(a.data);a.data=data;}return s;
  }

  /** Picks every object's level. Runs automatically before each frame; call it yourself only without `engine.render`. */
  update():void {
    const e=this.engine;if(!e)return;
    if(this.dirty){e.store.tick(false);this.dirty=false;}
    for(let s=0;s<this.atlases.length;s++)this.atlases[s].imposter.ready();
    // Screen levels use the camera's clip matrix: w is view depth in perspective and 1 in orthographic, and the y row's
    // length is the projection's y scale, so orthographic zoom (e.g. @margoengine/cameras) changes levels as expected.
    const m=e.store.matrices,p=e.camera.position,ex=p[0],ey=p[1],ez=p[2],c=e.camera.matrix,yScale=Math.hypot(c[1],c[5],c[9])||1/Math.tan(e.camera.fov*Math.PI/360),bias=this.bias,ids=this.ids,counts=this.counts,current=this.current,thresholds=this.thresholds,bands=this.bands;
    for(let i=0;i<this.count;i++){
      const o=ids[i]*16,dx=m[o+12]-ex,dy=m[o+13]-ey,dz=m[o+14]-ez;let v=Math.sqrt(dx*dx+dy*dy+dz*dz)*bias;
      if(this.screen[i]){const sx=m[o]*m[o]+m[o+1]*m[o+1]+m[o+2]*m[o+2],sy=m[o+4]*m[o+4]+m[o+5]*m[o+5]+m[o+6]*m[o+6],sz=m[o+8]*m[o+8]+m[o+9]*m[o+9]+m[o+10]*m[o+10];const w=c[3]||c[7]||c[11]||c[15]?Math.abs(c[3]*m[o+12]+c[7]*m[o+13]+c[11]*m[o+14]+c[15]):v/bias;v=bias*w/(yScale*this.radius[i]*Math.sqrt(Math.max(sx,sy,sz)));}
      // three.js LOD: the shown level's threshold drops by its hysteresis, so small camera moves never flip levels back and forth.
      const n=counts[i],shown=current[i],b=i*MAX_LEVELS;let next=0;
      for(let l=1;l<n;l++){let t=thresholds[b+l];if(l===shown)t-=t*bands[b+l];if(v>=t)next=l;else break;}
      if(next!==shown)this.show(i,shown,next);
    }
  }
  private show(i:number,from:number,to:number):void {
    const objects=this.objects[i],a=from<0?null:objects[from],b=objects[to],anchor=this.anchors[i];
    if(a&&!(a instanceof Geometry)&&!(a instanceof Imposter))target(a).visible=false;
    if(b instanceof Geometry)anchor.setGeometry(b);
    else{if(this.swaps[i]&&anchor.geometry)anchor.setGeometry(null);if(b&&!(b instanceof Imposter))target(b).visible=true;}
    this.current[i]=to;this.slots[i]=this.levelSlots[i*MAX_LEVELS+to];
  }

  private draw(c:Context):void {
    const atlases=this.atlases;if(!atlases.length)return;const e=this.engine!,m=e.store.matrices,hidden=e.store.hidden,parents=e.store.parents,planes=c.camera.planes;let total=0;
    for(let s=0;s<atlases.length;s++)atlases[s].count=0;
    for(let i=0;i<this.count;i++){
      const s=this.slots[i];if(s<0)continue;let shown=true;for(let p=this.ids[i];p>=0;p=parents[p])if(hidden[p]){shown=false;break;}
      if(!shown)continue;const a=atlases[s],imp=a.imposter,o=this.ids[i]*16,k=imp.center;
      // Frustum cull the transformed bounding sphere.
      const x=m[o]*k[0]+m[o+4]*k[1]+m[o+8]*k[2]+m[o+12],y=m[o+1]*k[0]+m[o+5]*k[1]+m[o+9]*k[2]+m[o+13],z=m[o+2]*k[0]+m[o+6]*k[1]+m[o+10]*k[2]+m[o+14];
      const r=imp.radius*Math.sqrt(Math.max(m[o]*m[o]+m[o+1]*m[o+1]+m[o+2]*m[o+2],m[o+4]*m[o+4]+m[o+5]*m[o+5]+m[o+6]*m[o+6],m[o+8]*m[o+8]+m[o+9]*m[o+9]+m[o+10]*m[o+10]));
      let inside=true;for(let q=0;q<24;q+=4)if(planes[q]*x+planes[q+1]*y+planes[q+2]*z+planes[q+3]<-r){inside=false;break;}
      if(!inside)continue;const d=a.count++*16,data=a.data;for(let j=0;j<16;j++)data[d+j]=m[o+j];total++;
    }
    if(!total)return;const device=c.device,samples=c.descriptor.multisample?.count??1;
    if(!this.uniform){this.uniform=device.createBuffer({size:128,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});this.sampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear'});}
    const f=this.frame;f.set(c.camera.matrix);f.set(c.camera.position,16);f.set(e.lighting.direction,20);f.set(e.lighting.radiance,24);f[28]=+(c.format==='rgba16float');f[29]=+(samples>1);
    device.queue.writeBuffer(this.uniform,0,f);
    const depthFormat=c.descriptor.depthStencil!.format;
    if(!this.pipeline||c.format!==this.format||samples!==this.samples||depthFormat!==this.depthFormat){
      const module=device.createShaderModule({code:imposterShader});this.format=c.format;this.samples=samples;this.depthFormat=depthFormat;
      this.pipeline=device.createRenderPipeline({layout:'auto',vertex:{module,entryPoint:'vertex'},fragment:{module,entryPoint:'fragment',targets:[{format:c.format}]},primitive:{topology:'triangle-strip'},
        depthStencil:{format:depthFormat,depthWriteEnabled:true,depthCompare:'greater-equal'},multisample:{count:samples,alphaToCoverageEnabled:samples>1}});
    }
    this.color.view=c.color;this.depth.view=c.depth;const pass=c.encoder.beginRenderPass(this.descriptor);pass.setPipeline(this.pipeline!);
    for(let s=0;s<atlases.length;s++){
      const a=atlases[s],imp=a.imposter;if(!a.count||!imp.ready())continue;
      if(!a.buffer||a.buffer.size<a.data.byteLength){a.buffer?.destroy();a.buffer=device.createBuffer({size:a.data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});a.group=undefined;}
      // Rebuild the bind group when the pipeline, instance buffer or atlas textures change (resize, device restore).
      if(!a.group||a.texture!==imp.color||a.pipeline!==this.pipeline){a.texture=imp.color;a.pipeline=this.pipeline;a.group=device.createBindGroup({layout:this.pipeline!.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:a.buffer}},{binding:2,resource:imp.color!.createView()},{binding:3,resource:imp.normal!.createView()},{binding:4,resource:this.sampler!},{binding:5,resource:{buffer:imp.uniform!}}]});}
      device.queue.writeBuffer(a.buffer,0,a.data,0,a.count*16);pass.setBindGroup(0,a.group);pass.draw(4,a.count);
    }
    pass.end();
  }
  private release():void {this.uniform?.destroy();for(const a of this.atlases){a.buffer?.destroy();a.buffer=a.group=a.texture=a.pipeline=undefined;}this.uniform=this.sampler=this.pipeline=undefined;}
  onDeviceRestored():void {this.release();}
  /** Removes the keeper meshes and GPU resources; level objects keep their current visibility. Imposters are not disposed. */
  dispose():void {
    this.release();for(const keeper of this.keepers.values())keeper.dispose();this.keepers.clear();
    for(const h of this.handles)h.index=-1;this.anchors=[];this.objects=[];this.handles=[];this.atlases=[];this.count=0;this.engine=undefined;
  }
}
