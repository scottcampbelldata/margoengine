export const bounds=[-4.5,4.5,-2.7,2.7,0,0];
export const dims=[65,39,1];
export const defaultSeed=[-3.58,.27,0];
export const duration=7.2;
export const maxSpeed=2.75;
export const stops=['#123246','#215e75','#3bc3b6','#ebce8e','#ee7f65'];

function vortex(x,y,cx,cy,circulation,core){
  const dx=x-cx,dy=y-cy;
  const r2=dx*dx+dy*dy;
  const scale=circulation*(r2<1e-8?1/(core*core):-Math.expm1(-r2/(core*core))/r2);
  return [-dy*scale,dx*scale];
}
export function velocity(x,y,t){
  const phase=2*Math.PI*t/duration;
  const a=vortex(x,y,-1.46+.53*Math.sin(phase),-.58+.34*Math.cos(phase),1.19,.62);
  const b=vortex(x,y,1.26+.50*Math.cos(phase),.59+.29*Math.sin(phase),-1.06,.56);
  const c=vortex(x,y,3.39,-1.54,.32,.59);
  const shear=.83+.125*Math.tanh(y*1.15);
  return [shear+a[0]+b[0]+c[0],a[1]+b[1]+c[1]];
}
export function snapshot(time){
  const [nx,ny]=dims;
  const u=new Float32Array(nx*ny),v=new Float32Array(nx*ny);
  for(let j=0;j<ny;j++){
    const y=bounds[2]+(bounds[3]-bounds[2])*j/(ny-1);
    for(let i=0;i<nx;i++){
      const x=bounds[0]+(bounds[1]-bounds[0])*i/(nx-1),at=j*nx+i;
      const xy=velocity(x,y,time);
      u[at]=xy[0];
      v[at]=xy[1];
    }
  }
  return {time,u,v};
}
export function temporalGrid(){
  return {bounds,dims,frames:Array.from({length:13},(_,i)=>snapshot(i*duration/12))};
}
