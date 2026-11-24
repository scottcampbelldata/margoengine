// Independent float64 oracle from the documented contour equations. Test code only, not a runtime CPU scaler.
export function xbrCell(texel, x, y, qx, qy, factor) {
  const e=texel(x,y), sum=[0,0,0,0]; let coverage=0;
  const same=(a,b)=>a.every((v,k)=>v===b[k]);
  const distance=(a,b)=>a.reduce((s,v,k)=>s+Math.abs(v-b[k])*[3,6,1,10][k],0);
  for(const [sx,sy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) {
    const at=(dx,dy)=>texel(x+sx*dx,y+sy*dy), f=at(1,0),h=at(0,1),i=at(1,1);
    if(same(e,f)||same(e,h)||(same(f,h)&&same(f,at(-1,0))&&same(f,at(0,-1))))continue;
    const along=4*distance(f,h)+distance(e,at(1,-1))+distance(e,at(-1,1))+distance(i,at(2,0))+distance(i,at(0,2));
    const across=4*distance(e,i)+distance(h,at(-1,0))+distance(f,at(0,-1))+distance(h,at(1,2))+distance(f,at(2,1));
    if(along>=across)continue;
    const df=distance(e,f), dh=distance(e,h), c=df===dh?f.map((v,k)=>(v+h[k])/2):df<dh?f:h;
    const u=sx>0?qx:1-qx,v=sy>0?qy:1-qy;
    const horizontal=distance(h,at(2,1)),vertical=distance(f,at(1,2));
    const edge=2*horizontal<vertical?u*0.5+v-1.25:2*vertical<horizontal?u+v*0.5-1.25:u+v-1.5;
    const weight=Math.max(0,Math.min(1,edge*factor+0.5));
    c.forEach((v,k)=>sum[k]+=v*weight);coverage+=weight;
  }
  return e.map((v,k)=>(v*Math.max(0,1-coverage)+sum[k])/Math.max(1,coverage));
}
