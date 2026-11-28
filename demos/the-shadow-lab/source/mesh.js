import { Geometry, box, PbrMaterial } from '@margoengine/core';

const sub = (a,b) => a.map((x,i)=>x-b[i]);
const normal = v => {const n=Math.hypot(...v);return v.map(x=>x/n);};
const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const unitBox=box(1,1,1);
export const material=(color,roughness=.66,metalness=0)=>new PbrMaterial({color,roughness,metalness});

export class Surface {
  positions=[];
  normals=[];
  indices=[];
  face(a,b,c,d) {
    const n=normal(cross(sub(b,a),sub(c,a))), i=this.positions.length/3;
    for(const v of d?[a,b,c,d]:[a,b,c]){
      this.positions.push(...v);this.normals.push(...n);
    }
    this.indices.push(i,i+1,i+2);
    if(d)this.indices.push(i,i+2,i+3);
  }
  cylinder(a,b,r1,r2,sides=9) {
    const axis=normal(sub(b,a));
    const u=normal(cross(axis,Math.abs(axis[1])<.9?[0,1,0]:[0,0,1])), v=cross(axis,u);
    const circle=(p,r,i)=>{
      const angle=i*Math.PI*2/sides;
      return p.map((x,j)=>x+r*(u[j]*Math.cos(angle)+v[j]*Math.sin(angle)));
    };
    for(let i=0;i<sides;i++){
      const s=circle(a,r1,i),t=circle(a,r1,i+1),u=circle(b,r2,i),v=circle(b,r2,i+1);
      this.face(s,t,v,u);
      this.face(a,t,s);
      this.face(b,u,v);
    }
  }
  geometry(){return new Geometry(this.positions,this.normals,this.indices);}
}

export function lathe(profile, sides=56){
  const positions=[],normals=[],indices=[];
  for(let row=0;row<profile.length;row++){
    const [y,r]=profile[row], [lo,hi]=[profile[Math.max(0,row-1)],profile[Math.min(profile.length-1,row+1)]];
    const [rn,yn]=normal([hi[0]-lo[0],lo[1]-hi[1]]);
    for(let i=0;i<=sides;i++){
      const angle=i*2*Math.PI/sides, x=Math.cos(angle),z=Math.sin(angle);
      positions.push(r*x,y,r*z);
      normals.push(rn*x,yn,rn*z);
      if(row&&i){
        const j=row*(sides+1)+i,k=j-sides-1;
        indices.push(j,j-1,k-1,j,k-1,k);
      }
    }
  }
  return new Geometry(positions,normals,indices);
}

export function workshop(engine){
  const mesh=(name,geometry,mat,position=[0,0,0],scale=[1,1,1])=>{
    const object=engine.createMesh();
    object.name=name;
    return object.setGeometry(geometry).setMaterial(mat).setPosition(position).setScale(scale);
  };
  const beam=(name,mat,x,y,z,w,h,d)=>mesh(name,unitBox,mat,[x,y,z],[w,h,d]);
  return {mesh,beam};
}

export function noiseGenerator(seed){
  return ()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
}
