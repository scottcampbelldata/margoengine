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

/** Vertical when the horizontal part of the view direction is at most this fraction of the distance. */
const VERTICAL=1e-9;

/**
 * Orthographic projection and exactly vertical views for core's Camera, through its `project` and `up` hooks, so the
 * matrix, culling planes, `engine.pick`, every pass and every `camera.matrix` reader get the same view.
 */
export class CameraProjection implements EnginePlugin, ProjectionOptions {
  readonly name='cameras';
  mode:'orthographic'|'perspective'='orthographic';height?:number;left?:number;right?:number;top?:number;bottom?:number;zoom=1;near?:number;far?:number;up:Vec3=[0,0,-1];
  private camera?:Camera;private worldUp:Vec3=[0,1,0];
  constructor(options:ProjectionOptions={}){Object.assign(this,options);}
  setup(engine:Pick<Engine,'camera'>):void {this.attach(engine.camera);}
  /** Use without an engine, e.g. on a second Camera. */
  attach(camera:Camera):void {
    if(this.camera)throw new Error('Projection attached');if(camera.project)throw new Error('Camera projection already set');
    this.camera=camera;this.worldUp=camera.up;
    // camera.up is the world up except for exactly vertical views, where it is this.up.
    Object.defineProperty(camera,'up',{configurable:true,enumerable:true,get:()=>this.screenUp(camera),set:(up:Vec3)=>{this.worldUp=up;}});
    camera.project=(out,aspect,webgpu)=>this.project(camera,out,aspect,webgpu);
  }
  dispose():void {
    const camera=this.camera;if(!camera)return;this.camera=undefined;
    Object.defineProperty(camera,'up',{configurable:true,enumerable:true,writable:true,value:this.worldUp});camera.project=undefined;
  }
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
