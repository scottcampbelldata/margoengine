const tau=Math.PI*2;
const unit=v=>v.map(x=>x/Math.hypot(...v));
const axis=(d,x)=>Array.from({length:3},(_,i)=>i===d?x:0);
const point=(...vectors)=>[0,1,2].map(i=>vectors.reduce((n,p)=>n+p[i],0));

function build(emit){
  const data=[],indices=[];
  function polygon(corners,normal){
    const first=data.length/6;
    corners.forEach((p,i)=>data.push(...p,...(Array.isArray(normal[i])?normal[i]:normal)));
    for(let i=1;i<corners.length-1;i++)indices.push(first,first+i,first+i+1);
  }
  emit(polygon);
  return {data,indices};
}
export function panel(bevel){
  const edge=.5-bevel;
  return build(face=>{
    for(let direction=0;direction<3;direction++)for(const side of [-1,1]){
      const a=(direction+1)%3,b=(direction+2)%3;
      const points=[[-1,-1],[1,-1],[1,1],[-1,1]].map(([u,v])=>
        point(axis(direction,side*.5),axis(a,u*edge),axis(b,v*edge)));
      face(points,axis(direction,side));
    }
    if(!bevel)return;
    for(let direction=0;direction<3;direction++)for(const u of [-1,1])for(const v of [-1,1]){
      const a=(direction+1)%3,b=(direction+2)%3;
      const make=(s,x,y)=>point(axis(direction,s*edge),axis(a,u*x),axis(b,v*y));
      face([make(-1,.5,edge),make(1,.5,edge),make(1,edge,.5),make(-1,edge,.5)],
        unit(point(axis(a,u),axis(b,v))));
    }
    for(const x of [-1,1])for(const y of [-1,1])for(const z of [-1,1]){
      face([[x*.5,y*edge,z*edge],[x*edge,y*.5,z*edge],[x*edge,y*edge,z*.5]],unit([x,y,z]));
    }
  });
}
export function cylinder(steps=24,flutes=0){
  const profile=theta=>.5-.022*flutes*(1-Math.cos(theta*12));
  const at=(angle,h)=>[Math.cos(angle)*profile(angle),h,Math.sin(angle)*profile(angle)];
  const normal=angle=>unit([Math.cos(angle),0,Math.sin(angle)]);
  return build(face=>{
    for(let i=0;i<steps;i++){
      const a=i*tau/steps,b=(i+1)*tau/steps;
      const na=normal(a),nb=normal(b);
      face([at(a,-.5),at(b,-.5),at(b,.5),at(a,.5)],[na,nb,nb,na]);
      face([[0,.5,0],at(a,.5),at(b,.5)],[0,1,0]);
      face([[0,-.5,0],at(b,-.5),at(a,-.5)],[0,-1,0]);
    }
  });
}
export function arch(steps=32){
  const curve=(a,r,z)=>[r*Math.cos(a),r*Math.sin(a),z];
  return build(face=>{
    for(let i=0;i<steps;i++){
      const a=i*Math.PI/steps,b=(i+1)*Math.PI/steps;
      const na=[Math.cos(a),Math.sin(a),0],nb=[Math.cos(b),Math.sin(b),0];
      const inside=.963;
      face([curve(a,inside,-.5),curve(b,inside,-.5),curve(b,inside,.5),curve(a,inside,.5)],
        [na.map(x=>-x),nb.map(x=>-x),nb.map(x=>-x),na.map(x=>-x)]);
      face([curve(a,1,-.5),curve(b,1,-.5),curve(b,1,.5),curve(a,1,.5)],[na,nb,nb,na]);
      for(const z of [-.5,.5])face([curve(a,inside,z),curve(b,inside,z),curve(b,1,z),curve(a,1,z)],[0,0,z*2]);
    }
    for(const a of [0,Math.PI])face([curve(a,.963,-.5),curve(a,1,-.5),curve(a,1,.5),curve(a,.963,.5)],[0,-1,0]);
  });
}
export function medallion(steps=40){
  const at=(theta,r,z)=>[r*Math.cos(theta),r*Math.sin(theta),z];
  return build(face=>{
    for(let i=0;i<steps;i++){
      const a=i*tau/steps,b=(i+1)*tau/steps;
      const na=[Math.cos(a),Math.sin(a),0],nb=[Math.cos(b),Math.sin(b),0];
      face([[0,0,.5],at(a,.5,.5),at(b,.5,.5)],[0,0,1]);
      face([at(a,.50,.5),at(b,.50,.5),at(b,.50,-.5),at(a,.50,-.5)],[na,nb,nb,na]);
      face([[0,0,-.5],at(b,.5,-.5),at(a,.5,-.5)],[0,0,-1]);
    }
  });
}
