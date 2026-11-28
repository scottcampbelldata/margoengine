import {coralGeometry} from '@margoengine/procedural/coral';
import {marchingCubes} from '@margoengine/procedural/marching-cubes';

const blend=(a,b,k)=>{
  const h=Math.max(k-Math.abs(a-b),0)/k;
  return Math.min(a,b)-h*h*k*.25;
};
const clip=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
const mix=(a,b,f)=>a+(b-a)*f;
function rng(seed){
  let s=seed>>>0;
  return ()=>((s=(Math.imul(1664525,s)+1013904223)>>>0)/4294967296);
}
function coralPlan(seed,bend){
  const roll=rng(seed),stems=[];
  function grow(base,direction,length,thickness,taper,born,time){
    const heading=[direction[0]+bend*.32,direction[1],direction[2]+bend*.059];
    const inv=1/Math.hypot(...heading);
    const end=base.map((v,i)=>v+heading[i]*length*inv);
    const mid=base.map((v,i)=>mix(v,end[i],.57));
    const pth=mix(thickness,taper,.57);
    stems.push({base,end:mid,thickness,taper:pth,born,time:time*.57});
    stems.push({base:mid,end,thickness:pth,taper,born:born+time*.57,time:time*.43});
    return {end,mid};
  }
  const stalk=grow([0,-.04,0],[.01,1,.08],.93,.31,.177,.02,.28,0).end;
  const heading=roll()*Math.PI*2;
  for(let i=0;i<7;i++){
    const phi=heading+(i/7)*Math.PI*2+(roll()-.5)*.26;

    const outward=[Math.cos(phi),1.115+roll()*.49,Math.sin(phi)];
    const start=stalk.map((v,k)=>k===1?mix(.39,v,.51+roll()*.44):v*.85);
    const born=Math.max(.23+(i%3)*.037,.035+.28*(start[1]+.04)/.93);
    const large=grow(start,outward,.91+roll()*.42,.129,.074,born,.42,1);
    for(const [n,base] of [large.mid,large.end].entries()){
      const alpha=phi+(n===0?-1:1)*(.46+roll()*.68),kick=.68+roll()*.34;
      const startAt=born+(n===0?.255:.436);
      const smaller=grow(base,[Math.cos(alpha)*.82,1.32,Math.sin(alpha)*.82],kick,.075,.034,startAt,.24,2);
      for(let tip=0;tip<2;tip++){
        const dir=alpha+(tip===0?-1:1)*(.49+roll()*.28);
        grow(tip===0?smaller.mid:smaller.end,[Math.cos(dir)*.48,1.35,Math.sin(dir)*.48],
          .29+roll()*.22,.047,.034,startAt+(tip===0?.153:.255),.18,3);
      }
    }
  }
  const peak=grow(stalk,[.20,1,-.24],1.12,.137,.059,.312,.54,1);
  grow(peak.mid,[-.56,.81,.18],.64,.076,.027,.633,.25,2);
  grow(peak.end,[.26,1,.28],.39,.056,.037,.868,.20,3);
  return stems;
}
function activePlan(seed,age,bend){
  return coralPlan(seed,bend).flatMap(s=>{
    const life=clip((age-s.born)/s.time);
    if(life<=0)return [];
    const vector=s.end.map((v,i)=>(v-s.base[i])*life);
    const radius=s.thickness*(.42+.58*Math.sqrt(life)),target=mix(s.thickness,s.taper,life)*(.53+.47*Math.sqrt(life));
    return [{...s,vector,radius,target,inverse:1/vector.reduce((sum,c)=>sum+c*c,0)}];
  });
}
function branchSurface(seed,age,bend){
  const stems=activePlan(seed,age,bend);
  const min=[Infinity,-.06,Infinity],max=[-Infinity,.2,-Infinity];
  for(const part of stems)for(const i of [0,1,2]){
    const q=part.base[i],v=q+part.vector[i],pad=part.radius+.046;
    if(i!==1)min[i]=Math.min(min[i],q-pad,v-pad);
    max[i]=Math.max(max[i],q+pad,v+pad);
  }
  const density=(x,y,z)=>{
    let distance=.4;
    for(const s of stems){
      const [dx,dy,dz]=s.vector,ox=x-s.base[0],oy=y-s.base[1],oz=z-s.base[2];
      const t=clip((ox*dx+oy*dy+oz*dz)*s.inverse);
      const radius=mix(s.radius,s.target,t);
      const xx=ox-dx*t,yy=oy-dy*t,zz=oz-dz*t;
      const square=xx*xx+yy*yy+zz*zz;
      if(square<(radius+distance+.048)**2)distance=blend(distance,Math.sqrt(square)-radius,.047);
    }
    const pores=.0056*Math.sin(x*41+Math.sin(z*26))*Math.cos(y*54-z*9)*Math.sin(z*37+x*8);
    return Math.max(-y,distance+pores);
  };
  const extent=max.map((m,i)=>m-min[i]),major=Math.max(...extent);
  const resolution=extent.map(n=>Math.max(12,Math.round(n/major*73)));
  const field=marchingCubes(density,{resolution,bounds:[min,max]});
  if(!field)throw Error('The current colony could not be sampled.');
  const positions=new Float32Array(field.vertices.length/2),normals=new Float32Array(field.vertices.length/2);
  for(let i=0;i<positions.length;i+=3){
    positions.set(field.vertices.subarray(i*2,i*2+3),i);
    normals.set(field.vertices.subarray(i*2+3,i*2+6),i);
  }
  return {positions,normals,indices:field.indices,stems:stems.length,height:max[1]};
}
export function growth(age,bend){return branchSurface(1907,age,bend);}
export function samples(){
  return [
    coralGeometry({form:'table',seed:663,diameter:3.56,resolution:54}),
    coralGeometry({form:'brain',seed:1007,diameter:2.42,resolution:61}),
    coralGeometry({form:'branching',seed:289,diameter:1.69,resolution:52}),
  ];
}
