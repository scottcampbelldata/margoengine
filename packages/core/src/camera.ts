import { finite } from './geometry.js';
export type Vec3 = readonly [number,number,number];
export interface CameraOptions { fov?: number; position?: Vec3; target?: Vec3; near?: number; far?: number }

export class Camera {
  fov: number; near: number; far: number;
  position: Vec3; target: Vec3;
  readonly matrix = new Float32Array(16);
  readonly planes = new Float32Array(24);
  private fit?:{position:Vec3;target:Vec3;elapsed:number;duration:number;from:Vec3;fromTarget:Vec3};
  private readonly view = new Float64Array(16);
  private readonly projection = new Float64Array(16);
  constructor({fov=60,position=[0,2,5],target=[0,0,0],near=0.1,far=1000}: CameraOptions = {}) {
    this.fov=fov; this.position=position; this.target=target; this.near=near; this.far=far;
  }
  update(aspect: number, webgpu: boolean): void {
    finite(this.position,3,'Camera position'); finite(this.target,3,'Camera target');
    if (!Number.isFinite(aspect)||!Number.isFinite(this.fov)||!Number.isFinite(this.near)||!Number.isFinite(this.far) || aspect <= 0 || this.fov <= 0 || this.fov >= 180 || this.near <= 0 || this.far <= this.near) throw new RangeError('Invalid camera projection');
    let zx=this.position[0]-this.target[0], zy=this.position[1]-this.target[1], zz=this.position[2]-this.target[2];
    const length=Math.hypot(zx,zy,zz); if (!length) throw new RangeError('Camera position equals target');
    zx/=length; zy/=length; zz/=length;
    const horizontal=Math.hypot(zx,zz); if (!horizontal) throw new RangeError('Camera is parallel to Y up');
    const xx=zz/horizontal, xz=-zx/horizontal, yx=zy*xz, yy=zz*xx-zx*xz, yz=-zy*xx, p=this.position;
    const v=this.view;v[0]=xx;v[1]=yx;v[2]=zx;v[4]=0;v[5]=yy;v[6]=zy;v[8]=xz;v[9]=yz;v[10]=zz;v[12]=-xx*p[0]-xz*p[2];v[13]=-yx*p[0]-yy*p[1]-yz*p[2];v[14]=-zx*p[0]-zy*p[1]-zz*p[2];v[15]=1;
    const f=1/Math.tan(this.fov*Math.PI/360), d=this.near-this.far, projection=this.projection;
    projection.fill(0); projection[0]=f/aspect; projection[5]=f; projection[10]=webgpu?-this.near/d:(this.far+this.near)/d; projection[11]=-1; projection[14]=webgpu?-this.far*this.near/d:2*this.far*this.near/d;
    const m=this.matrix;
    for (let c=0;c<4;c++) for (let r=0;r<4;r++) m[c*4+r]=projection[r]*v[c*4]+projection[4+r]*v[c*4+1]+projection[8+r]*v[c*4+2]+projection[12+r]*v[c*4+3];
    finite(m,16,'Camera matrix');
    for (let plane=0;plane<6;plane++) {
      const row=plane>>1, sign=plane%2===0?1:-1; let length2=0;
      for (let c=0;c<4;c++) { const value=plane===4&&webgpu?m[c*4+2]:m[c*4+3]+sign*m[c*4+row]; this.planes[plane*4+c]=value; if(c<3) length2+=value*value; }
      const norm=Math.sqrt(length2); if (!norm) throw new RangeError('Degenerate camera frustum');
      for (let c=0;c<4;c++) this.planes[plane*4+c]/=norm;
    }
  }
  fitToBoundingBox(min:Vec3,max:Vec3,{aspect=1,duration=0.3,padding=1.1}:{aspect?:number;duration?:number;padding?:number}={}):void {
    finite(min,3,'Bounds');finite(max,3,'Bounds');if(min.some((v,i)=>v>max[i])||![aspect,duration,padding,this.fov,this.near,this.far].every(Number.isFinite)||aspect<=0||duration<0||padding<1||this.fov<=0||this.fov>=180||this.near<=0||this.far<=this.near)throw new RangeError('Invalid camera fit');
    const target:Vec3=min.map((v,i)=>(v+max[i])/2) as unknown as Vec3,radius=Math.max(this.near*2,Math.hypot(...max.map((v,i)=>(v-min[i])/2))),angle=Math.atan(Math.tan(this.fov*Math.PI/360)*Math.min(1,aspect)),distance=radius*padding/Math.sin(angle),direction=this.position.map((v,i)=>v-this.target[i]),length=Math.hypot(...direction);
    if(!length||distance+radius>=this.far)throw new RangeError('Bounds exceed camera frustum');const position=target.map((v,i)=>v+direction[i]/length*distance) as unknown as Vec3;
    this.fit={position,target,elapsed:0,duration,from:this.position,fromTarget:this.target};this.advance(0);
  }
  advance(delta:number):void {if(!this.fit)return;const f=this.fit,t=f.duration?Math.min(1,(f.elapsed+=delta)/f.duration):1,s=t*t*(3-2*t);this.position=f.from.map((v,i)=>v+(f.position[i]-v)*s) as unknown as Vec3;this.target=f.fromTarget.map((v,i)=>v+(f.target[i]-v)*s) as unknown as Vec3;if(t===1)this.fit=undefined;}
  cancelFit():void {this.fit=undefined;}
}
