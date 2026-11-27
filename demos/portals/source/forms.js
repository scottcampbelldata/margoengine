export const aperture={radius:.923,spring:1.835,bottom:.048,depth:.073};
const halfTurn=Math.PI;
export const openings=[{x:-1.28,yaw:-.238},{x:1.28,yaw:.231}];

function subtract(a,b){return a.map((v,k)=>v-b[k]);}
function cross(a,b){return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];}
function unit(vector){const length=Math.hypot(...vector);return vector.map(value=>value/length);}

export class Forms {
  positions=[];
  normals=[];
  indices=[];
  constructor(transform=point=>point,limit){
    this.transform=transform;
    this.limit=limit;
  }
  face(a,b,c,d){
    const points=(d?[a,b,c,d]:[a,b,c]).map(this.transform);
    const normal=unit(cross(subtract(points[1],points[0]),subtract(points[2],points[0])));
    const vertices=this.limit===undefined?points:this.clip(points);
    if(vertices.length<3)return;
    const index=this.positions.length/3;
    for(const point of vertices){
      this.positions.push(...point);
      this.normals.push(...normal);
    }
    for(let i=1;i<vertices.length-1;i++)this.indices.push(index,index+i,index+i+1);
  }
  clip(points){
    const vertices=[],z=this.limit;
    let prior=points.at(-1);
    for(const current of points){
      const inside=current[2]<=z,priorInside=prior[2]<=z;
      if(inside!==priorInside){
        const t=(z-prior[2])/(current[2]-prior[2]);
        vertices.push([prior[0]+(current[0]-prior[0])*t,prior[1]+(current[1]-prior[1])*t,z]);
      }
      if(inside)vertices.push(current);
      prior=current;
    }
    return vertices;
  }
  box(x,y,z,w,h,d,yaw=0){
    const c=Math.cos(yaw),s=Math.sin(yaw);
    const points=Array.from({length:8},(_,i)=>{
      const lx=((i&1)-.5)*w,lz=(((i>>2)&1)-.5)*d;
      return [x+lx*c+lz*s,y+(((i>>1)&1)-.5)*h,z-lx*s+lz*c];
    });
    for(const face of [[4,5,7,6],[1,0,2,3],[0,4,6,2],[5,1,3,7],[6,7,3,2],[0,1,5,4]]){
      this.face(...face.map(i=>points[i]));
    }
  }
  lathe(origin,profile,sides=48){
    const point=([radius,height],angle)=>[
      origin[0]+radius*Math.cos(angle),origin[1]+height,origin[2]+radius*Math.sin(angle),
    ];
    for(let k=1;k<profile.length;k++)for(let i=0;i<sides;i++){
      const a=i*2*halfTurn/sides,b=(i+1)*2*halfTurn/sides;
      const low=profile[k-1],high=profile[k];
      this.face(point(low,a),point(high,a),point(high,b),point(low,b));
    }
  }
  loop(center,radius,tube,phase,tilt,segments=58,sides=10){
    const c=Math.cos(tilt),s=Math.sin(tilt),cp=Math.cos(phase),sp=Math.sin(phase);
    const vertex=(a,b)=>{
      const r=radius+tube*Math.cos(b),x=r*Math.cos(a),y=r*Math.sin(a),z=tube*Math.sin(b);
      const yp=y*c-z*s,zp=y*s+z*c;
      return [center[0]+x*cp-yp*sp,center[1]+x*sp+yp*cp,center[2]+zp];
    };
    for(let i=0;i<segments;i++)for(let k=0;k<sides;k++){
      const a=i*2*halfTurn/segments,an=(i+1)*2*halfTurn/segments;
      const b=k*2*halfTurn/sides,bn=(k+1)*2*halfTurn/sides;
      this.face(vertex(a,b),vertex(an,b),vertex(an,bn),vertex(a,bn));
    }
  }
}

export function arch(radius,bottom=aperture.bottom,spring=aperture.spring){
  const path=[[-radius,bottom],[radius,bottom]];
  for(let i=0;i<=32;i++){
    const angle=i*halfTurn/32;
    path.push([radius*Math.cos(angle),spring+radius*Math.sin(angle)]);
  }
  return path;
}

export function archFace(forms,x,radius,z){
  const path=arch(radius);
  const center=[x,aperture.spring*.60,z];
  for(let i=0;i<path.length;i++){
    const a=path[i],b=path[(i+1)%path.length];
    forms.face(center,[x+a[0],a[1],z],[x+b[0],b[1],z]);
  }
  return forms;
}

export function archTrim(forms,x,inner,outer,zInn,zOut,base=aperture.bottom){
  const a=arch(inner,base),b=arch(outer,base-.018);
  const point=(p,z)=>[x+p[0],p[1],z];
  for(let i=0;i<a.length;i++){
    const j=(i+1)%a.length;
    forms.face(point(a[i],zInn),point(b[i],zOut),point(b[j],zOut),point(a[j],zInn));
  }
}

export function roomTransform(originX,yaw){
  const c=Math.cos(yaw),s=Math.sin(yaw);
  return ([x,y,z])=>[originX+c*x+s*z,y,-s*x+c*z-.13];
}
