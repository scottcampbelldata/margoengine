export const bays = [
  {id:'A', center:[-.398,-.357]},
  {id:'B', center:[ .398,-.357]},
  {id:'C', center:[-.398, .357]},
  {id:'D', center:[ .398, .357]},
];

export const countPerBay = 56;
export const count = countPerBay * bays.length;
export const radius = .026;
export const pitch = .073;
export const floor = .164;
export const mass = .036;
export const impulse = .055;
export const frequency = 60;
const points = [];

for(let row=-5;row<=5;row++){
  for(let col=-5;col<=5;col++){
    const x=pitch*(col+row*.5),z=pitch*row*Math.sqrt(3)*.5;
    points.push({x,z,r2:x*x+z*z});
  }
}
points.sort((a,b)=>a.r2-b.r2||a.z-b.z||a.x-b.x);
const seeds=points.slice(0,countPerBay);
const offX=seeds.reduce((sum,p)=>sum+p.x,0)/countPerBay;
const offZ=seeds.reduce((sum,p)=>sum+p.z,0)/countPerBay;
export const pellets = bays.flatMap(({center:[cx,cz]},bay)=>seeds.map(({x,z,r2},index)=>{
  const lift=.029+.027*(1+Math.sin(index*1.941+bay*.82))+.015*bay;
  return {bay,x:x-offX+cx,z:z-offZ+cz,radial:Math.sqrt(r2),y:floor+radius+lift,
    shade:index<7?2:r2>.049?1:0};
}));
export const links = [];
for(let i=0;i<count;i++){
  const a=pellets[i];
  for(let j=i+1;j<(a.bay+1)*countPerBay;j++){
    const b=pellets[j];
    if(Math.abs(Math.hypot(a.x-b.x,a.z-b.z)-pitch)<1e-5)links.push([i,j]);
  }
}
