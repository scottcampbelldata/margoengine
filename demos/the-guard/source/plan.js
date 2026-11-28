export const stations=[
  {id:'west',label:'West arch',point:[-3.67,.89,.23],stop:[-3.05,0,.21],tone:493.88},
  {id:'archive',label:'North wall',point:[2.05,.89,-3.03],stop:[1.94,0,-2.31],tone:587.33},
  {id:'east',label:'East bench',point:[3.58,.89,2.46],stop:[2.87,0,2.23],tone:698.46},
];
export const start=[-3.46,0,1.72];
export const patrol=[
  [-3.42,0,.19],[-3.06,0,-2.73],[1.13,0,-2.66],[3.05,0,-1.35],[2.92,0,2.68],[-2.52,0,2.95],
];
const corners=[[-1.91,0,-1.86],[1.91,0,-1.86],[1.91,0,1.70],[-1.91,0,1.70]];
const island={minX:-1.50,maxX:1.50,minZ:-1.49,maxZ:1.34};
export const distance=(a,b)=>Math.hypot(a[0]-b[0],a[2]-b[2]);
export function corridor(from,to,box=island){
  let t0=0,t1=1;
  for(const [axis,lower,upper] of [[0,box.minX,box.maxX],[2,box.minZ,box.maxZ]]){
    const v=to[axis]-from[axis];
    if(Math.abs(v)<1e-7){
      if(from[axis]<lower||from[axis]>upper)return true;
      continue;
    }
    const a=(lower-from[axis])/v,b=(upper-from[axis])/v;
    t0=Math.max(t0,Math.min(a,b));t1=Math.min(t1,Math.max(a,b));
    if(t0>t1)return true;
  }
  return false;
}
export const occupied=([x,,z])=>x>=island.minX&&x<=island.maxX&&z>=island.minZ&&z<=island.maxZ;
export function sightLine(a,b){
  return Math.min(a[1],b[1])>2.17||corridor(a,b,{minX:-1.27,maxX:1.27,minZ:-1.15,maxZ:1.15});
}
export function routeTo(from,to){
  if(corridor(from,to))return [to];
  const points=[from,to,...corners],cost=points.map(()=>Infinity),previous=points.map(()=>-1),done=new Set();
  cost[0]=0;
  while(done.size<points.length){
    let at=-1;
    for(let i=0;i<points.length;i++)if(!done.has(i)&&(at<0||cost[i]<cost[at]))at=i;
    if(at===1||!Number.isFinite(cost[at]))break;
    done.add(at);
    for(let i=0;i<points.length;i++){
      if(i===at||done.has(i)||!corridor(points[at],points[i]))continue;
      const next=cost[at]+distance(points[at],points[i]);
      if(next<cost[i]){cost[i]=next;previous[i]=at;}
    }
  }
  if(previous[1]<0)throw new Error('The selected gallery location is outside the walkable route.');
  const route=[];
  for(let i=1;i!==0;i=previous[i])route.unshift(points[i]);
  return route;
}
