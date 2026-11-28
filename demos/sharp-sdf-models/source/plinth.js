const stride=9;
export function display(){
  const values=[];
  const vertex=(p,n,kind,a=1,b=0)=>[...p,...n,kind,a,b];
  const tri=(a,b,c)=>values.push(...a,...b,...c);
  const side=(a,b,c,d,n,kind)=>{tri(vertex(a,n,kind),vertex(b,n,kind),vertex(c,n,kind));tri(vertex(a,n,kind),vertex(c,n,kind),vertex(d,n,kind));};
  const top=[0,1,0];
  side([-9,-.124,-9],[-9,-.124,9],[9,-.124,9],[9,-.124,-9],top,0);
  const floorEnd=values.length/stride;

  function surround(levels){
    const loops=levels.map(([y,x,z,r])=>{
      const ring=[];
      for(let q=0;q<4;q++)for(let j=0;j<=9;j++){
        const a=(q+j/9)*Math.PI/2;
        const cx=Math.cos(a),cz=Math.sin(a);
        const x0=Math.sign(Math.cos((q+.5)*Math.PI/2))*(x-r);
        const z0=Math.sign(Math.sin((q+.5)*Math.PI/2))*(z-r);
        ring.push([x0+cx*r,y,z0+cz*r,cx,cz]);
      }
      return ring;
    });
    for(let j=0;j<loops.length-1;j++){
      const low=loops[j],high=loops[j+1];
      const dy=levels[j+1][0]-levels[j][0],dx=levels[j][1]-levels[j+1][1];
      const l=Math.hypot(dy,dx);
      const kind=levels[j+1][4];
      const at=p=>vertex(p.slice(0,3),[p[3]*dy/l,dx/l,p[4]*dy/l],kind);
      for(let i=0;i<low.length;i++){
        const k=(i+1)%low.length;
        tri(at(low[i]),at(high[i]),at(high[k]));
        tri(at(low[i]),at(high[k]),at(low[k]));
      }
    }
    const last=loops.at(-1),y=levels.at(-1)[0],kind=levels.at(-1)[4];
    for(let i=0;i<last.length;i++)tri(vertex([0,y,0],top,kind),vertex(last[(i+1)%last.length].slice(0,3),top,kind),vertex(last[i].slice(0,3),top,kind));
  }
  surround([[-.124,.455,.439,.057,1.0],[-.111,.486,.469,.070,1.0],[-.088,.491,.474,.074,1.05],
    [-.083,.488,.471,.072,1.25],[-.077,.485,.466,.069,1.25],[-.063,.479,.460,.066,1.0],
    [-.017,.479,.460,.066,1.0],[-.006,.463,.445,.060,1.05],[-.001,.454,.436,.059,1.12]]);
  for(let i=-14;i<=14;i++){
    const x=i*.021,n=[0,0,1],t=i%4===0,h=t?.012:.007;
    side([x-.0008,-.050-h,.461],[x+.0008,-.050-h,.461],[x+.0008,-.050,.461],[x-.0008,-.050,.461],n,t?1.54:1.44);
  }

  for(const x of [-.424,.424])for(const z of [-.388,.388]){
    const center=[x,.003,z],radius=.010;
    for(let i=0;i<20;i++){
      const a=i*Math.PI/10,b=(i+1)*Math.PI/10;
      const p=[x+radius*Math.cos(a),.003,z+radius*Math.sin(a)];
      const q=[x+radius*Math.cos(b),.003,z+radius*Math.sin(b)];
      tri(vertex(center,top,1.57),vertex(q,top,1.57),vertex(p,top,1.57));
    }
    side([x-.006,.0032,z-.0008],[x-.006,.0032,z+.0008],
      [x+.006,.0032,z+.0008],[x+.006,.0032,z-.0008],top,1.0);
  }
  return {vertices:new Float32Array(values),floorEnd};
}
