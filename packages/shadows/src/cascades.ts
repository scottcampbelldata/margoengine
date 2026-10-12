import type {Camera,Vec3} from '@margoengine/core/extension';
import {finiteVector} from '../../shared/math.js';

export function cascadeSplits(near:number,far:number,lambda=0.5,out=new Float32Array(4)):Float32Array {
  if(!Number.isFinite(near)||!Number.isFinite(far)||!Number.isFinite(lambda)||near<=0||far<=near||lambda<0||lambda>1||out.length!==4)throw new RangeError('Invalid cascade splits');
  for(let i=0;i<4;i++){const t=(i+1)/4;out[i]=lambda*near*(far/near)**t+(1-lambda)*(near+(far-near)*t);}return out;
}
export function fitCascades(camera:Camera,aspect:number,direction:Vec3,resolution:number,splits:Float32Array,matrices=new Float32Array(64),ranges=new Float32Array(4),margin=100,result?:{matrices:Float32Array;ranges:Float32Array}):{matrices:Float32Array;ranges:Float32Array} {
  finiteVector(direction,3,'Shadow direction');
  if(!Number.isFinite(aspect)||aspect<=0||!Number.isInteger(resolution)||resolution<1||splits.length!==4||matrices.length!==64||ranges.length!==4||!Number.isFinite(margin)||margin<0)throw new RangeError('Invalid cascade fit');
  const length=Math.hypot(direction[0],direction[1],direction[2]);if(!length)throw new RangeError('Zero shadow direction');
  const zx=-direction[0]/length,zy=-direction[1]/length,zz=-direction[2]/length,vertical=Math.abs(zy)>0.99;
  let xx=vertical?-zy:zz,xy=vertical?zx:0,xz=vertical?0:-zx;const xl=Math.hypot(xx,xy,xz);xx/=xl;xy/=xl;xz/=xl;
  const yx=zy*xz-zz*xy,yy=zz*xx-zx*xz,yz=zx*xy-zy*xx;
  const fx=camera.target[0]-camera.position[0],fy=camera.target[1]-camera.position[1],fz=camera.target[2]-camera.position[2],fl=Math.hypot(fx,fy,fz);
  if(!fl)throw new RangeError('Invalid shadow camera');
  const tan=Math.tan(camera.fov*Math.PI/360);let start=camera.near;
  for(let i=0;i<4;i++){
    const end=splits[i];if(!Number.isFinite(end)||end<=start)throw new RangeError('Unordered cascade splits');
    const mid=(start+end)/2,px=camera.position[0]+fx/fl*mid,py=camera.position[1]+fy/fl*mid,pz=camera.position[2]+fz/fl*mid;
    // A sphere keeps extents stable under camera rotation; one texel covers snapping error.
    const radius=Math.ceil(Math.hypot(end*tan*aspect,end*tan,end-mid)*16)/16*(1+2/resolution),texel=2*radius/resolution;
    const cx=Math.round((px*xx+py*xy+pz*xz)/texel)*texel,cy=Math.round((px*yx+py*yy+pz*yz)/texel)*texel,cz=Math.round((px*zx+py*zy+pz*zz)/texel)*texel,depth=2*(radius+margin),offset=i*16;
    matrices.fill(0,offset,offset+16);
    matrices[offset]=xx/radius;matrices[offset+4]=xy/radius;matrices[offset+8]=xz/radius;
    matrices[offset+1]=yx/radius;matrices[offset+5]=yy/radius;matrices[offset+9]=yz/radius;
    matrices[offset+2]=zx/depth;matrices[offset+6]=zy/depth;matrices[offset+10]=zz/depth;
    matrices[offset+12]=-cx/radius;matrices[offset+13]=-cy/radius;matrices[offset+14]=0.5-cz/depth;matrices[offset+15]=1;ranges[i]=depth;start=end;
  }
  for(let i=0;i<matrices.length;i++)if(!Number.isFinite(matrices[i]))throw new RangeError('Shadow matrix overflow');
  if(result){result.matrices=matrices;result.ranges=ranges;return result;}return {matrices,ranges};
}
