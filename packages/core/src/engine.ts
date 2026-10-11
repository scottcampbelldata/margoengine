import { TransformStore } from './kernel.js';
import { Camera, type CameraOptions, type Vec3 } from './camera.js';
import { Geometry, PbrMaterial, finite } from './geometry.js';
import { GPURenderer, GLRenderer, type Renderer, type Batch } from './renderer.js';
import { FrameGraph, type EnginePlugin } from './plugin.js';

export interface EngineOptions { capacity?: number; backend?: 'auto'|'webgpu'|'webgl2'; camera?: CameraOptions }
export type FrameCallback = (engine: Engine, delta: number) => void;
const positionFields=['x','y','z'] as const,scaleFields=['sx','sy','sz'] as const;
const owners=new WeakMap<EnginePlugin,Engine>();

export class VectorRef {
  constructor(private readonly mesh: Mesh, private readonly kind: 'position'|'rotation'|'scale') {}
  private get(axis: number): number {
    this.mesh.check();
    return this.kind==='rotation'?this.mesh.euler[axis]:this.mesh.engine.store.transforms[(this.kind==='scale'?scaleFields:positionFields)[axis]][this.mesh.id];
  }
  private set(axis: number, value: number): void {
    this.mesh.check(); if(typeof value!=='number'||!Number.isFinite(Math.fround(value)) || this.kind==='scale' && Math.fround(value)===0)throw new RangeError('Invalid transform value');
    if(this.kind==='rotation'){this.mesh.euler[axis]=value;this.mesh.syncRotation();}
    else this.mesh.engine.store.transforms[(this.kind==='scale'?scaleFields:positionFields)[axis]][this.mesh.id]=value;
  }
  get x():number{return this.get(0);} set x(v:number){this.set(0,v);}
  get y():number{return this.get(1);} set y(v:number){this.set(1,v);}
  get z():number{return this.get(2);} set z(v:number){this.set(2,v);}
}

export class Mesh {
  name='';
  readonly position=new VectorRef(this,'position');
  readonly rotation=new VectorRef(this,'rotation');
  readonly scale=new VectorRef(this,'scale');
  readonly euler:Float32Array;
  readonly matrix: Float32Array;
  geometry: Geometry|null=null;
  material=new PbrMaterial();
  constructor(readonly engine: Engine, readonly id: number) { this.matrix=engine.store.matrices.subarray(id*16,id*16+16);this.euler=engine.store.rotations.subarray(id*3,id*3+3); }
  get visible():boolean {this.check();return this.engine.store.hidden[this.id]===0;}
  set visible(value:boolean){this.check();if(typeof value!=='boolean')throw new TypeError('Visibility must be boolean');this.engine.store.hidden[this.id]=+!value;}
  check():void { if(this.engine.disposed||this.engine.meshes.get(this.id)!==this)throw new Error('Mesh is disposed'); }
  setPosition(value: Vec3):this {this.check();finite(value,3,'Position');this.position.x=value[0];this.position.y=value[1];this.position.z=value[2];return this;}
  setScale(value: Vec3):this {this.check();finite(value,3,'Scale');if(value.some(v=>Math.fround(v)===0))throw new RangeError('Scale must be nonzero');this.scale.x=value[0];this.scale.y=value[1];this.scale.z=value[2];return this;}
  setRotation(value: Vec3):this {this.check();finite(value,3,'Rotation');for(let i=0;i<3;i++)this.euler[i]=value[i];this.syncRotation();return this;}
  syncRotation():void {
    const sx=Math.sin(this.euler[0]/2),cx=Math.cos(this.euler[0]/2),sy=Math.sin(this.euler[1]/2),cy=Math.cos(this.euler[1]/2),sz=Math.sin(this.euler[2]/2),cz=Math.cos(this.euler[2]/2),t=this.engine.store.transforms,id=this.id;
    t.qx[id]=sx*cy*cz+cx*sy*sz;t.qy[id]=cx*sy*cz-sx*cy*sz;t.qz[id]=cx*cy*sz+sx*sy*cz;t.qw[id]=cx*cy*cz-sx*sy*sz;
  }
  setQuaternion(value: readonly number[]):this {
    this.check();finite(value,4,'Quaternion');const length=Math.hypot(...value);if(!length)throw new RangeError('Quaternion must be nonzero');
    const [x,y,z,w]=value.map(v=>v/length),t=this.engine.store.transforms,id=this.id;
    t.qx[id]=x;t.qy[id]=y;t.qz[id]=z;t.qw[id]=w;
    this.euler[1]=Math.asin(Math.max(-1,Math.min(1,2*(x*z+w*y))));
    this.euler[0]=Math.atan2(2*(w*x-y*z),1-2*(x*x+y*y));this.euler[2]=Math.atan2(2*(w*z-x*y),1-2*(y*y+z*z));return this;
  }
  setParent(parent: Mesh|null):this {
    this.check();parent?.check();if(parent&&parent.engine!==this.engine)throw new TypeError('Parent belongs to another engine');
    let depth=0;
    for(let id=parent?.id??-1;id!==-1;id=this.engine.store.parents[id]) { if(id===this.id)throw new Error('Hierarchy cycle');if(++depth>=64)throw new RangeError('Hierarchy is limited to 64 levels'); }
    this.engine.store.parents[this.id]=parent?.id??-1;return this;
  }
  setGeometry(geometry: Geometry|null):this {
    this.check();if(geometry!==null&&!(geometry instanceof Geometry))throw new TypeError('Expected Geometry');if(geometry===this.geometry)return this;
    if(geometry)this.engine.retain(geometry);
    const previous=this.geometry;this.geometry=geometry;
    const bounds=this.engine.store.bounds;bounds.fill(0,this.id*4,this.id*4+4);if(geometry)bounds.set(geometry.bounds,this.id*4);
    if(previous)this.engine.release(previous);return this;
  }
  setMaterial(material: PbrMaterial):this {this.check();if(!(material instanceof PbrMaterial))throw new TypeError('Expected PbrMaterial');this.material=material;return this;}
  dispose():void {if(this.engine.meshes.get(this.id)===this)this.engine.remove(this);}
}

export class Engine {
  readonly frameGraph=new FrameGraph();
  readonly meshes=new Map<number,Mesh>();
  readonly camera: Camera;
  readonly lighting={direction:new Float32Array([3,5,4,3]),radiance:new Float32Array([1,1,1,0.15])};
  readonly stats={visible:0,drawCalls:0};
  disposed=false;
  onError: (error: unknown)=>void = error=>{if(typeof reportError==='function')reportError(error);else console.error(error);};
  private readonly batches=new Map<Geometry,Batch & {references:number}>();
  private readonly checkedMaterials=new WeakMap<PbrMaterial,number>();
  private materialFrame=0;
  private readonly free:number[]=[];
  private next=0;
  private revision=0;
  private readonly callbacks=new Set<FrameCallback>();
  private raf: number|null=null;
  private last=0;
  private running=false;
  private readonly frameOptions={delta:0};
  private disposing=false;
  private readonly plugins=new Map<string,EnginePlugin>();
  private recovery?:Promise<void>;

  static async create(canvas: HTMLCanvasElement, options: EngineOptions={}):Promise<Engine> {
    if(!canvas||typeof canvas.getContext!=='function')throw new TypeError('Expected canvas');
    const backend=options.backend??'auto';if(!['auto','webgpu','webgl2'].includes(backend))throw new TypeError('Unknown backend');
    const store=await TransformStore.create(options.capacity??1024);let renderer:Renderer|undefined,fallbackReason:string|null=null;
    try {
      if(backend!=='webgl2')try{renderer=await GPURenderer.create(canvas);}catch(error){if(backend==='webgpu')throw error;fallbackReason=String(error);}
      renderer??=new GLRenderer(canvas);return new Engine(canvas,store,renderer,options.camera,fallbackReason);
    }catch(error){renderer?.dispose();store.dispose();throw error;}
  }
  private constructor(readonly canvas:HTMLCanvasElement,readonly store:TransformStore,private renderer:Renderer,camera:CameraOptions|undefined,readonly fallbackReason:string|null){this.camera=new Camera(camera);this.watchDevice();}
  private watchDevice():void {this.renderer.onLost=()=>{if(!this.disposed&&!this.disposing)void this.rebootDevice().catch(error=>this.onError(error));};}
  rebootDevice():Promise<void> {
    if(this.disposed||this.disposing)return Promise.reject(new Error('Engine is disposed'));
    if(this.backend!=='webgpu')return Promise.reject(new Error('Device reboot requires WebGPU'));
    if(this.recovery)return this.recovery;
    this.recovery=(async()=>{const previous=this.renderer,next=await GPURenderer.create(this.canvas);
      if(this.disposed||this.disposing){next.dispose();return;}
      try{for(const geometry of this.batches.keys())next.add(geometry,this.store.capacity);}
      catch(error){next.dispose(false);throw error;}
      this.renderer=next;this.watchDevice();previous.dispose(false);
      for(const plugin of this.plugins.values())plugin.onDeviceRestored?.(this);
    })().finally(()=>{this.recovery=undefined;});return this.recovery;
  }
  get backend():'webgpu'|'webgl2'{return this.renderer.backend;}
  get gpu():GPUDevice|null{return this.renderer.gpu??null;}
  hasPlugin(name:string):boolean{return this.plugins.has(name);}
  use(plugin:EnginePlugin):this {
    if(this.disposed||this.disposing)throw new Error('Engine is disposed');
    if(!plugin.name||this.plugins.has(plugin.name)||owners.has(plugin)||typeof plugin.setup!=='function')throw new TypeError('Invalid, attached or duplicate plugin');
    try{this.frameGraph.withOwner(plugin.name,()=>{plugin.setup(this);plugin.registerPasses?.(this.frameGraph);});this.plugins.set(plugin.name,plugin);owners.set(plugin,this);}
    catch(error){this.frameGraph.removeOwner(plugin.name);try{plugin.dispose?.();}catch{}throw error;}return this;
  }
  removePlugin(name:string):void {const plugin=this.plugins.get(name);if(!plugin)return;this.frameGraph.removeOwner(name);this.plugins.delete(name);owners.delete(plugin);plugin.dispose?.();}
  createMesh(parent:Mesh|null=null):Mesh {
    if(this.disposed||this.disposing)throw new Error('Engine is disposed');parent?.check();if(parent&&parent.engine!==this)throw new TypeError('Parent belongs to another engine');
    const id=this.free.pop()??this.next++;if(id>=this.store.capacity){this.next=this.store.capacity;throw new RangeError('Entity capacity exhausted');}
    const t=this.store.transforms;for(const key of ['x','y','z','qx','qy','qz'] as const)t[key][id]=0;for(const key of ['qw','sx','sy','sz'] as const)t[key][id]=1;
    this.store.parents[id]=-1;this.store.constrained[id]=0;this.store.hidden[id]=0;this.store.rotations.fill(0,id*3,id*3+3);const mesh=new Mesh(this,id);this.meshes.set(id,mesh);this.revision++;this.store.active[id]=1;
    try{return mesh.setParent(parent);}catch(error){mesh.dispose();throw error;}
  }
  remove(mesh:Mesh):void {
    mesh.check();for(const child of this.meshes.values())if(this.store.parents[child.id]===mesh.id)this.store.parents[child.id]=-1;
    if(mesh.geometry)this.release(mesh.geometry);this.meshes.delete(mesh.id);this.revision++;this.store.active[mesh.id]=0;this.store.visible[mesh.id]=0;this.free.push(mesh.id);
  }
  retain(geometry:Geometry):void {
    let batch=this.batches.get(geometry);
    if(!batch){const instances=new Float32Array(this.store.capacity*24);if(!this.recovery)this.renderer.add(geometry,this.store.capacity);batch={geometry,instances,count:0,references:0};this.batches.set(geometry,batch);}
    batch.references++;
  }
  release(geometry:Geometry):void {const batch=this.batches.get(geometry)!;if(--batch.references===0){this.renderer.remove(geometry);this.batches.delete(geometry);}}
  private readonly collect=(mesh:Mesh):void=>{
    if(mesh.geometry&&this.store.visible[mesh.id]) {
      if(this.checkedMaterials.get(mesh.material)!==this.materialFrame){const material=mesh.material.data;finite(material,8,'Material');
      for(let i=0;i<8;i++)if(material[i]<0||material[i]>1)throw new RangeError('Invalid material values');
      if(material[3]!==1||material[4]<Math.fround(0.045)||material[6]!==0&&material[6]!==1)throw new RangeError('Invalid material values');this.checkedMaterials.set(mesh.material,this.materialFrame);}
      const batch=this.batches.get(mesh.geometry)!,offset=batch.count++*24;
      batch.instances.set(mesh.matrix,offset);batch.instances.set(mesh.material.data,offset+16);batch.instances[offset+23]=mesh.id;this.stats.visible++;
    }
  };
  render({culling=true,delta=0}: {culling?:boolean;delta?:number}={}):void {
    if(this.disposed||this.disposing)throw new Error('Engine is disposed');
    if(!Number.isFinite(delta)||delta<0||delta>1)throw new RangeError('Frame delta must be 0..1 seconds');
    for(const plugin of this.plugins.values())plugin.onPreUpdate?.(delta);
    const width=Math.max(1,Math.min(4096,Math.round(this.canvas.clientWidth*(globalThis.devicePixelRatio??1))||this.canvas.width)),height=Math.max(1,Math.min(4096,Math.round(this.canvas.clientHeight*(globalThis.devicePixelRatio??1))||this.canvas.height));
    if(this.canvas.width!==width)this.canvas.width=width;if(this.canvas.height!==height)this.canvas.height=height;
    this.camera.advance(delta);this.camera.update(this.canvas.width/this.canvas.height,this.backend==='webgpu');this.store.planes.set(this.camera.planes);this.store.tick(culling);
    for(const batch of this.batches.values())batch.count=0;this.stats.visible=0;this.stats.drawCalls=0;
    this.materialFrame++;finite(this.lighting.direction,4,'Light');finite(this.lighting.radiance,4,'Radiance');
    if(!Math.hypot(this.lighting.direction[0],this.lighting.direction[1],this.lighting.direction[2])||this.lighting.direction[3]<0||this.lighting.radiance.some(v=>v<0))throw new RangeError('Invalid lighting');
    this.meshes.forEach(this.collect);
    for(const batch of this.batches.values())if(batch.count)this.stats.drawCalls++;
    if(!this.recovery)this.renderer.render(this.camera,this.lighting,this.batches.values(),this.frameGraph,delta);
  }
  async pick(x:number,y:number):Promise<Mesh|null> {
    if(![x,y].every(Number.isFinite))throw new RangeError('Invalid pick coordinates');if(this.disposed||this.disposing)throw new Error('Engine is disposed');if(this.backend!=='webgpu')throw new Error('GPU picking requires WebGPU');if(x<0||y<0||x>=this.canvas.clientWidth||y>=this.canvas.clientHeight||this.recovery)return null;
    this.render();const renderer=this.renderer as GPURenderer,revision=this.revision,id=await renderer.pick(this.camera,this.lighting,this.batches.values(),this.frameGraph,x*this.canvas.width/this.canvas.clientWidth,y*this.canvas.height/this.canvas.clientHeight);
    return id!==null&&this.renderer===renderer&&this.revision===revision?this.meshes.get(id)??null:null;
  }
  onFrame(callback:FrameCallback):()=>void {this.callbacks.add(callback);return()=>{this.callbacks.delete(callback);};}
  start():void {if(this.disposed||this.disposing)throw new Error('Engine is disposed');if(this.running)return;this.running=true;this.last=0;this.raf=requestAnimationFrame(this.frame);}
  private readonly frame=(time:number):void=>{
    this.raf=null;if(this.disposed||!this.running)return;
    const delta=this.last?Math.min((time-this.last)/1000,0.1):0;this.last=time;
    try{for(const callback of this.callbacks)callback(this,delta);this.frameOptions.delta=delta;if(!this.disposed)this.render(this.frameOptions);}catch(error){this.stop();this.onError(error);return;}
    if(!this.disposed&&this.running)this.raf=requestAnimationFrame(this.frame);
  };
  stop():void {this.running=false;if(this.raf!==null)cancelAnimationFrame(this.raf);this.raf=null;this.last=0;}
  dispose():void {
    if(this.disposed||this.disposing)return;this.disposing=true;this.stop();let failed=false,failure:unknown;
    const cleanup=(run:()=>void)=>{try{run();}catch(error){if(!failed){failed=true;failure=error;}}};
    for(const name of this.plugins.keys())cleanup(()=>this.removePlugin(name));
    for(const mesh of this.meshes.values())cleanup(()=>mesh.dispose());
    this.callbacks.clear();cleanup(()=>this.renderer.dispose());cleanup(()=>this.store.dispose());this.disposed=true;
    if(failed)throw failure;
  }
}
