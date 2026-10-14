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

/** Vertical when the horizontal part of the view direction is below this fraction; the camera is nudged to half of it. */
const VERTICAL=1e-9;
type Update=Camera['update'];

/**
 * Orthographic projection and exactly vertical views for core's Camera. It replaces the camera's own `update`, so the
 * matrix, culling planes, `engine.pick`, every pass and every `camera.matrix` reader get the same view.
 */
export class CameraProjection implements EnginePlugin, ProjectionOptions {
  readonly name='cameras';
  mode:'orthographic'|'perspective'='orthographic';height?:number;left?:number;right?:number;top?:number;bottom?:number;zoom=1;near?:number;far?:number;up:Vec3=[0,0,-1];
  private camera?:Camera;
  private readonly view=new Float64Array(16);private readonly projection=new Float64Array(16);
  constructor(options:ProjectionOptions={}){Object.assign(this,options);}
  setup(engine:Pick<Engine,'camera'>):void {this.attach(engine.camera);}
  /** Use without an engine, e.g. on a second Camera. */
  attach(camera:Camera):void {
    if(this.camera)throw new Error('Projection attached');if(Object.hasOwn(camera,'update'))throw new Error('Camera update already replaced');
    const original=camera.update;this.camera=camera;
    camera.update=(aspect,webgpu)=>this.apply(camera,aspect,webgpu,original);
  }
  dispose():void {if(this.camera)delete (this.camera as Partial<Camera>).update;this.camera=undefined;}
  private apply(camera:Camera,aspect:number,webgpu:boolean,original:Update):void {
    const p=camera.position,t=camera.target;if(![...p,...t].every(Number.isFinite))throw new RangeError('Camera position');
    let zx=p[0]-t[0],zy=p[1]-t[1],zz=p[2]-t[2];const length=Math.hypot(zx,zy,zz);if(!length)throw new RangeError('Camera at target');
    zx/=length;zy/=length;zz/=length;const horizontal=Math.hypot(zx,zz),vertical=horizontal<=VERTICAL;
    if(this.mode!=='perspective'&&this.mode!=='orthographic')throw new RangeError('Invalid projection mode');
    if(this.mode==='perspective'&&!vertical){original.call(camera,aspect,webgpu);return;}
    if(!Number.isFinite(aspect)||aspect<=0)throw new RangeError('Invalid projection');
    let xx,xy=0,xz,eye:Vec3=p;
    if(vertical){
      const u=this.up,uh=Math.hypot(u[0],u[2]),s=zy>0?1:-1;if(!(uh>0)||!Number.isFinite(u[1]))throw new RangeError('Invalid vertical up');
      // Keep position/target readers (shared viewMatrix, controls, cascades) a hair off vertical, on the side whose limit is this up.
      if(!horizontal)camera.position=[p[0]-s*u[0]/uh*length*VERTICAL/2,p[1],p[2]-s*u[2]/uh*length*VERTICAL/2];
      zx=zz=0;zy=s;xx=-s*u[2]/uh;xz=s*u[0]/uh;eye=[t[0],t[1]+s*length,t[2]];
    } else {xx=zz/horizontal;xz=-zx/horizontal;}
    const yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx,v=this.view,P=this.projection;
    v[0]=xx;v[1]=yx;v[2]=zx;v[3]=0;v[4]=xy;v[5]=yy;v[6]=zy;v[7]=0;v[8]=xz;v[9]=yz;v[10]=zz;v[11]=0;
    v[12]=-xx*eye[0]-xy*eye[1]-xz*eye[2];v[13]=-yx*eye[0]-yy*eye[1]-yz*eye[2];v[14]=-zx*eye[0]-zy*eye[1]-zz*eye[2];v[15]=1;P.fill(0);
    if(this.mode==='perspective'){
      const n=camera.near,f=camera.far,d=n-f,k=1/Math.tan(camera.fov*Math.PI/360);
      if(![camera.fov,n,f].every(Number.isFinite)||camera.fov<=0||camera.fov>=180||n<=0||f<=n)throw new RangeError('Invalid projection');
      P[0]=k/aspect;P[5]=k;P[10]=webgpu?-n/d:(f+n)/d;P[11]=-1;P[14]=webgpu?-f*n/d:2*f*n/d;
    } else {
      const bounds=[this.left,this.right,this.top,this.bottom],half=(this.height??2*length*Math.tan(camera.fov*Math.PI/360))/2;
      let [l,r,top,b]=bounds.every(v=>v!==undefined)?bounds as number[]:[-half*aspect,half*aspect,half,-half];
      const n=this.near??length-camera.far/2,f=this.far??length+camera.far/2,dx=(r-l)/(2*this.zoom),dy=(top-b)/(2*this.zoom),cx=(r+l)/2,cy=(top+b)/2;
      l=cx-dx;r=cx+dx;top=cy+dy;b=cy-dy;
      if(![l,r,top,b,n,f,this.zoom].every(Number.isFinite)||this.zoom<=0||r<=l||top<=b||f<=n)throw new RangeError('Invalid projection');
      P[0]=2/(r-l);P[5]=2/(top-b);P[10]=webgpu?1/(f-n):-2/(f-n);P[12]=-(r+l)/(r-l);P[13]=-(top+b)/(top-b);P[14]=webgpu?f/(f-n):-(f+n)/(f-n);P[15]=1;
    }
    const m=camera.matrix;
    for(let c=0;c<4;c++)for(let row=0;row<4;row++)m[c*4+row]=P[row]*v[c*4]+P[4+row]*v[c*4+1]+P[8+row]*v[c*4+2]+P[12+row]*v[c*4+3];
    if(!m.every(Number.isFinite))throw new RangeError('Camera matrix');
    // Same extraction as core, so engine culling (store.planes copies camera.planes after update) follows this frustum.
    for(let plane=0;plane<6;plane++){
      const row=plane>>1,sign=plane%2===0?1:-1;let length2=0;
      for(let c=0;c<4;c++){const value=plane===4&&webgpu?m[c*4+2]:m[c*4+3]+sign*m[c*4+row];camera.planes[plane*4+c]=value;if(c<3)length2+=value*value;}
      const norm=Math.sqrt(length2);if(!norm)throw new RangeError('Invalid frustum');for(let c=0;c<4;c++)camera.planes[plane*4+c]/=norm;
    }
  }
}

