export const fixedDelta=1/180;
export const ballR=.0155;
export const surface=.026;
export const start=[.229,surface+ballR,.455];
export const batLength=.121;
export const kickPosition=[-.260,.045,.129];
export const pivots=[
  {p:[-.153,.052,.355],yaw:-.36,sign:1},
  {p:[.153,.052,.355],yaw:Math.PI+.36,sign:-1}
];
export const bumpers=[
  {p:[-.157,.061,-.363],radius:.057,score:150},
  {p:[-.116,.061,-.245],radius:.055,score:100},
  {p:[.112,.061,-.196],radius:.054,score:100}
];
export const guides=[
  {a:[-.286,-.523],b:[-.286,.531],kind:'outer'},
  {a:[.287,-.476],b:[.287,.536],kind:'outer'},
  {a:[-.243,-.548],b:[.172,-.548],kind:'outer'},
  {a:[-.286,-.482],b:[-.243,-.548],kind:'outer'},
  {a:[.169,-.543],b:[.287,-.389],kind:'turn'},
  {a:[.176,-.273],b:[.176,.465],kind:'lane'},
  {a:[-.230,.204],b:[-.177,.345],kind:'sling'},
  {a:[.145,.310],b:[.155,.151],kind:'sling'},
  {a:[-.223,.524],b:[-.101,.524],kind:'drain'},
  {a:[.097,.524],b:[.174,.524],kind:'drain'}
];
export function guidePose(a,b,kind){
  const dx=b[0]-a[0], dz=b[1]-a[1];
  const length=Math.hypot(dx,dz);
  const height=kind==='outer'?.057:.032;
  const width=kind==='sling'?.022:.012;
  return {p:[(a[0]+b[0])/2,surface+height/2,(a[1]+b[1])/2],
    size:[length,height,width],yaw:Math.atan2(-dz,dx)};
}
export const yawQuat=yaw=>[0,Math.sin(yaw*.5),0,Math.cos(yaw*.5)];
export function batLocal(yaw){
  return [Math.cos(yaw)*batLength*.5,0,-Math.sin(yaw)*batLength*.5];
}
