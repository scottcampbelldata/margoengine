export const length=.42;
export const width=.24;
export const gap=.001;
export const viscosity=.080;
export const pressureDrop=420;
export const centerX=.010;
export const minDiameter=48;
export const maxDiameter=158;
export const baseline=gap**2/(12*viscosity)*pressureDrop/length;
export const unobstructed=baseline*width*gap;

const nx=84,nz=48,size=nx*nz,step=length/nx;
const conductivity=gap**2/(12*viscosity);
const seedCount=18;

function makeSystem(radius){
  const active=new Uint8Array(size);
  const east=new Int16Array(size).fill(-1),west=new Int16Array(size).fill(-1);
  const north=new Int16Array(size).fill(-1),south=new Int16Array(size).fill(-1);
  const diagonal=new Float64Array(size),source=new Float64Array(size);
  for(let row=0;row<nz;row++)for(let col=0;col<nx;col++){
    const x=(col+.5)*step-length/2,z=(row+.5)*step-width/2;
    active[col+row*nx]=+(Math.hypot(x-centerX,z)>=radius);
  }
  for(let row=0;row<nz;row++)for(let col=0;col<nx;col++){
    const i=col+row*nx;
    if(!active[i])continue;
    let count=0;
    if(col===0){count+=2;source[i]=2;}
    else if(active[i-1]){west[i]=i-1;count++;}
    if(col===nx-1)count+=2;
    else if(active[i+1]){east[i]=i+1;count++;}
    if(row===0||!active[i-nx])north[i]=-1;
    else{north[i]=i-nx;count++;}
    if(row<nz-1&&active[i+nx]){south[i]=i+nx;count++;}
    diagonal[i]=count;
  }
  return {active,east,west,north,south,diagonal,source};
}

function multiply({diagonal,east,west,north,south},x,out){
  for(let i=0;i<size;i++){
    let value=diagonal[i]*x[i];
    if(east[i]>=0)value-=x[east[i]];
    if(west[i]>=0)value-=x[west[i]];
    if(north[i]>=0)value-=x[north[i]];
    if(south[i]>=0)value-=x[south[i]];
    out[i]=value;
  }
}

function potential(system){
  const {active,diagonal,source}=system;
  const x=new Float64Array(size),r=new Float64Array(size);
  const d=new Float64Array(size),ad=new Float64Array(size);
  for(let i=0;i<size;i++)if(active[i])x[i]=1-((i%nx)+.5)/nx;
  multiply(system,x,ad);
  let score=0;
  for(let i=0;i<size;i++){
    if(!active[i])continue;
    r[i]=source[i]-ad[i];
    d[i]=r[i]/diagonal[i];
    score+=r[i]*d[i];
  }
  let iteration=0;
  while(score>1e-18&&iteration++<600){
    multiply(system,d,ad);
    let product=0;
    for(let i=0;i<size;i++)product+=ad[i]*d[i];
    const alpha=score/product;
    let next=0;
    for(let i=0;i<size;i++){
      if(!active[i])continue;
      x[i]+=alpha*d[i];r[i]-=alpha*ad[i];
      next+=r[i]*r[i]/diagonal[i];
    }
    const beta=next/score;
    for(let i=0;i<size;i++)if(active[i])d[i]=r[i]/diagonal[i]+beta*d[i];
    score=next;
  }
  if(!Number.isFinite(score)||score>1e-18)throw new Error('Plate-gap pressure solve did not converge.');
  return {pressure:x,iteration};
}

function faces(system,pressure){
  const pitch=nx+1,u=new Float64Array(pitch*nz),v=new Float64Array(nx*(nz+1));
  const {active}=system;
  const metersPerSecond=conductivity*pressureDrop/step;
  for(let row=0;row<nz;row++)for(let face=0;face<=nx;face++){
    const i=row*nx+face;
    let delta=0;
    if(face===0)delta=2*(1-pressure[i]);
    else if(face===nx)delta=2*pressure[i-1];
    else if(active[i-1]&&active[i])delta=pressure[i-1]-pressure[i];
    u[row*pitch+face]=delta*metersPerSecond;
  }
  for(let row=1;row<nz;row++)for(let col=0;col<nx;col++){
    const i=row*nx+col;
    if(active[i]&&active[i-nx])v[i]=(pressure[i-nx]-pressure[i])*metersPerSecond;
  }
  const psi=new Float64Array(pitch*(nz+1));
  let maxSpeed=0,maxResidual=0;
  for(let row=0;row<nz;row++)for(let col=0;col<=nx;col++){
    const f=row*pitch+col;
    psi[f+pitch]=psi[f]+u[f]*step;
    if(col===nx||!active[row*nx+col])continue;
    const south=row*nx+col;
    const speed=Math.hypot(.5*(u[f]+u[f+1]),.5*(v[south]+v[south+nx]));
    maxSpeed=Math.max(maxSpeed,speed);
    maxResidual=Math.max(maxResidual,Math.abs(u[f+1]-u[f]+v[south+nx]-v[south])*step*gap);
  }
  return {u,psi,maxSpeed,maxResidual};
}

function traces({u,psi},radius){
  const pitch=nx+1;
  const lanes=[];
  for(let k=0;k<seedCount;k++){
    const row=(.035+.93*k/(seedCount-1))*nz;
    const below=Math.floor(row)*pitch;
    const value=psi[below]+(psi[below+pitch]-psi[below])*(row%1);
    const x=new Float64Array(pitch),z=new Float64Array(pitch),time=new Float64Array(pitch);
    let previous;
    for(let face=0;face<=nx;face++){
      let j=0;
      while(j<nz-1&&psi[(j+1)*pitch+face]<value)j++;
      const lo=psi[j*pitch+face],hi=psi[(j+1)*pitch+face];
      const f=hi>lo?Math.max(0,Math.min(1,(value-lo)/(hi-lo))):.5;
      x[face]=face*step-length/2;
      z[face]=(j+f)*step-width/2;
      if(Math.abs(x[face]-centerX)<radius+.001){
        const clearance=Math.sqrt((radius+.001)**2-(x[face]-centerX)**2);
        if(Math.abs(z[face])<clearance)z[face]=Math.sign(z[face])*clearance;
      }
      const speed=Math.max(baseline*.04,u[j*pitch+face]);
      if(face>0)time[face]=time[face-1]+2*step/(speed+previous);
      previous=speed;
    }
    lanes.push({x,z,time,duration:time[nx]});
  }
  return lanes;
}

export function solve(input){
  const diameter=Math.max(minDiameter,Math.min(maxDiameter,input));
  const radius=diameter*.0005;
  const system=makeSystem(radius);
  const {pressure,iteration}=potential(system);
  const field=faces(system,pressure);
  const inletFlow=field.psi[nz*(nx+1)]*gap;
  const outletFlow=field.psi[nz*(nx+1)+nx]*gap;
  return {diameter,radius,inletFlow,outletFlow,iteration,maxSpeed:field.maxSpeed,
    maxResidual:field.maxResidual,lanes:traces(field,radius)};
}

export function sample(lane,t){
  const target=Math.max(0,Math.min(lane.duration,t));
  let a=0,b=lane.time.length-1;
  while(b-a>1){
    const middle=(b+a)>>1;
    if(lane.time[middle]<target)a=middle;
    else b=middle;
  }
  const weight=(target-lane.time[a])/(lane.time[b]-lane.time[a]);
  return [lane.x[a]+(lane.x[b]-lane.x[a])*weight,lane.z[a]+(lane.z[b]-lane.z[a])*weight];
}
