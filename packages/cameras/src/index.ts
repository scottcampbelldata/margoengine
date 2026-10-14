/// <reference lib="esnext.disposable" preserve="true" />
import type {EngineKernel} from '@margoengine/core';
import type {Camera,Engine,EnginePlugin,Vec3} from '@margoengine/core/extension';

export interface ProjectionOptions {
  /** 'orthographic' (default) or 'perspective'; both accept exactly vertical views. */
  mode?:'orthographic'|'perspective';
  /** Visible world height at zoom 1. Default: the perspective height at the target, 2·distance·tan(fov/2), so dolly controls zoom. */
  height?:number;
  /** three.js OrthographicCamera frustum in view units. When all four are set they replace height and the canvas aspect. */
  left?:number;right?:number;top?:number;bottom?:number;
  /** three.js zoom: divides the frustum about its centre. */
  zoom?:number;
  /** Eye-space clip distances, may be negative. Default: camera.far deep, centred on the target. */
  near?:number;far?:number;
  /** Screen up for exactly vertical views; needs a horizontal component. Default [0,0,-1]: north up looking down. */
  up?:Vec3;
}

export interface FitOptions {
  /** Width / height of the view. Default: the engine canvas (`setup`), else 1. */
  aspect?:number;
  /** Seconds; 0 jumps. Default 0.3, like core's `fitToBoundingBox`. */
  duration?:number;
  /** At least 1. Default 1.1. */
  padding?:number;
}

/** Vertical when the horizontal part of the view direction is at most this fraction of the distance. */
const VERTICAL=1e-9;
type Fit={from:Vec3;to:Vec3;fromTarget:Vec3;toTarget:Vec3;fromZoom:number;toZoom:number;elapsed:number;duration:number};

/**
 * Orthographic projection and exactly vertical views for core's Camera, through its `project` and `up` hooks, so the
 * matrix, culling planes, `engine.pick`, every pass and every `camera.matrix` reader get the same view.
 */
export class CameraProjection implements EnginePlugin, ProjectionOptions {
  readonly name='cameras';
  mode:'orthographic'|'perspective'='orthographic';height?:number;left?:number;right?:number;top?:number;bottom?:number;zoom=1;near?:number;far?:number;up:Vec3=[0,0,-1];
  private camera?:Camera;private worldUp:Vec3=[0,1,0];private canvas?:{width:number;height:number};private animation?:Fit;
  /** Same as `engine.use(new CameraProjection(...))`; returns the CameraProjection. */
  static attach(engine: EngineKernel, options?: ProjectionOptions): CameraProjection {const value = new CameraProjection(options); engine.use(value); return value;}
  constructor(options:ProjectionOptions={}){Object.assign(this,options);}
  setup(engine:Pick<Engine,'camera'>&{canvas?:{width:number;height:number}}):void {this.attach(engine.camera);this.canvas=engine.canvas;}
  /**
   * Frames a box given as `[minX, minY, minZ, maxX, maxY, maxZ]` (`model.bounds`). Perspective: core's
   * `fitToBoundingBox`. Orthographic: keeps the view direction and distance, centres the box and sets `zoom` so the
   * box's projected outline fits (tighter than a bounding sphere). Animated by the engine (`onPreUpdate`).
   */
  fit(bounds:ArrayLike<number>,{aspect=this.canvas?this.canvas.width/this.canvas.height:1,duration=0.3,padding=1.1}:FitOptions={}):void {
    const camera=this.camera;if(!camera)throw new Error('Projection not attached');
    const b=Array.from(bounds),min=b.slice(0,3) as unknown as Vec3,max=b.slice(3) as unknown as Vec3;
    if(b.length!==6||!b.every(Number.isFinite)||min.some((v,i)=>v>max[i])||![aspect,duration,padding].every(Number.isFinite)||aspect<=0||duration<0||padding<1)throw new RangeError('Invalid fit');
    this.animation=undefined;
    if(this.mode==='perspective'){camera.fitToBoundingBox(min,max,{aspect,duration,padding});return;}
    camera.cancelFit();
    const p=camera.position,t=camera.target,back=[0,1,2].map(i=>p[i]-t[i]),length=Math.hypot(...back),f=back.map(v=>-v/length),up=this.screenUp(camera);
    let r=[f[1]*up[2]-f[2]*up[1],f[2]*up[0]-f[0]*up[2],f[0]*up[1]-f[1]*up[0]];const side=Math.hypot(...r);r=r.map(v=>v/side);
    const u=[r[1]*f[2]-r[2]*f[1],r[2]*f[0]-r[0]*f[2],r[0]*f[1]-r[1]*f[0]],half=max.map((v,i)=>(v-min[i])/2),centre=max.map((v,i)=>(v+min[i])/2);
    // Half extents of the box's outline on the view plane.
    const ex=half.reduce((s,v,i)=>s+Math.abs(r[i])*v,0),ey=half.reduce((s,v,i)=>s+Math.abs(u[i])*v,0);
    const frustum=[this.left,this.right,this.top,this.bottom];let zoom:number,offset=[0,0];
    if(frustum.every(v=>v!==undefined)){const [l,rt,top,bottom]=frustum as number[];zoom=Math.min((rt-l)/2/ex,(top-bottom)/2/ey)/padding;offset=[(rt+l)/2,(top+bottom)/2];}
    else zoom=(this.height??2*length*Math.tan(camera.fov*Math.PI/360))/2/Math.max(ey,ex/aspect)/padding;
    if(!(zoom>0&&zoom<Infinity)||!side)throw new RangeError('Invalid fit');
    if(this.near===undefined&&this.far===undefined&&Math.hypot(...half)>=camera.far/2)throw new RangeError('Bounds exceed far');
    const target=centre.map((v,i)=>v-r[i]*offset[0]-u[i]*offset[1]) as unknown as Vec3,position=target.map((v,i)=>v+back[i]) as unknown as Vec3;
    this.animation={from:p,to:position,fromTarget:t,toTarget:target,fromZoom:this.zoom,toZoom:zoom,elapsed:0,duration};this.onPreUpdate(0);
  }
  /** Advances an orthographic `fit`; the engine calls it each frame. Call it yourself after `attach(camera)`. */
  onPreUpdate(delta:number):void {
    const a=this.animation,camera=this.camera;if(!a||!camera)return;
    const k=a.duration?Math.min(1,(a.elapsed+=delta)/a.duration):1,s=k*k*(3-2*k),mix=(x:Vec3,y:Vec3)=>x.map((v,i)=>v+(y[i]-v)*s) as unknown as Vec3;
    camera.position=mix(a.from,a.to);camera.target=mix(a.fromTarget,a.toTarget);this.zoom=a.fromZoom*(a.toZoom/a.fromZoom)**s;if(k===1)this.animation=undefined;
  }
  /** Use without an engine, e.g. on a second Camera. */
  attach(camera:Camera):void {
    if(this.camera)throw new Error('Projection attached');if(camera.project)throw new Error('Camera projection already set');
    this.camera=camera;this.worldUp=camera.up;
    // camera.up is the world up except for exactly vertical views, where it is this.up.
    Object.defineProperty(camera,'up',{configurable:true,enumerable:true,get:()=>this.screenUp(camera),set:(up:Vec3)=>{this.worldUp=up;}});
    camera.project=(out,aspect,webgpu)=>this.project(camera,out,aspect,webgpu);
  }
  dispose():void {
    const camera=this.camera;if(!camera)return;this.camera=undefined;this.animation=undefined;
    Object.defineProperty(camera,'up',{configurable:true,enumerable:true,writable:true,value:this.worldUp});camera.project=undefined;
  }
  declare [Symbol.dispose]: () => void;
  [(Symbol.dispose ?? Symbol()) as symbol](): void {this.dispose();}
  private screenUp(camera:Camera):Vec3 {
    const p=camera.position,t=camera.target,x=p[0]-t[0],y=p[1]-t[1],z=p[2]-t[2];
    if(Math.hypot(x,z)>VERTICAL*Math.hypot(x,y,z))return this.worldUp;
    const u=this.up;if(!(Math.hypot(u[0],u[2])>0)||!Number.isFinite(u[1]))throw new RangeError('Invalid vertical up');return u;
  }
  private project(camera:Camera,P:Float64Array,aspect:number,webgpu:boolean):void {
    const n=camera.near,f=camera.far;
    if(this.mode==='perspective'){const d=n-f,k=1/Math.tan(camera.fov*Math.PI/360);P[0]=k/aspect;P[5]=k;P[10]=webgpu?-n/d:(f+n)/d;P[11]=-1;P[14]=webgpu?-f*n/d:2*f*n/d;return;}
    if(this.mode!=='orthographic')throw new RangeError('Invalid projection mode');
    const p=camera.position,t=camera.target,length=Math.hypot(p[0]-t[0],p[1]-t[1],p[2]-t[2]);
    const bounds=[this.left,this.right,this.top,this.bottom],half=(this.height??2*length*Math.tan(camera.fov*Math.PI/360))/2;
    let [l,r,top,b]=bounds.every(v=>v!==undefined)?bounds as number[]:[-half*aspect,half*aspect,half,-half];
    const near=this.near??length-f/2,far=this.far??length+f/2,dx=(r-l)/(2*this.zoom),dy=(top-b)/(2*this.zoom),cx=(r+l)/2,cy=(top+b)/2;
    l=cx-dx;r=cx+dx;top=cy+dy;b=cy-dy;
    if(![l,r,top,b,near,far,this.zoom].every(Number.isFinite)||this.zoom<=0||r<=l||top<=b||far<=near)throw new RangeError('Invalid projection');
    P[0]=2/(r-l);P[5]=2/(top-b);P[10]=webgpu?1/(far-near):-2/(far-near);P[12]=-(r+l)/(r-l);P[13]=-(top+b)/(top-b);P[14]=webgpu?far/(far-near):-(far+near)/(far-near);P[15]=1;
  }
}
