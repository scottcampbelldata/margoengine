export const width=.456;
export const directions=[[1,0],[0,1],[-1,0],[0,-1]];
const radians=Math.PI/180;
const vertices=[
  [0,width/Math.sqrt(3)],
  [-width*.5,-width/(2*Math.sqrt(3))],
  [width*.5,-width/(2*Math.sqrt(3))],
];

function rotate([x,y],cosine,sine) { return [x*cosine-y*sine,x*sine+y*cosine]; }
function dot(a,b) { return a[0]*b[0]+a[1]*b[1]; }

function support(direction) {
  let chosen=vertices[0], far=dot(chosen,direction);
  const candidates=[...vertices];
  for(const [x,y] of vertices) {
    const p=[x+width*direction[0],y+width*direction[1]];
    if(vertices.every(([a,b])=>(p[0]-a)**2+(p[1]-b)**2<=width*width+1e-13)) candidates.push(p);
  }
  for(const p of candidates) {
    const height=dot(p,direction);
    if(height>far) { chosen=p; far=height; }
  }
  return chosen;
}

export function camOutline(subdivisions=78) {
  return vertices.flatMap((start,i)=>{
    const origin=vertices[(i+2)%3];
    const a=Math.atan2(start[1]-origin[1],start[0]-origin[0]);
    return Array.from({length:subdivisions},(_,j)=>{
      const t=a+j*Math.PI/(3*subdivisions);
      return [origin[0]+width*Math.cos(t),origin[1]+width*Math.sin(t)];
    });
  });
}

export function drivePose(degrees) {
  const angle=degrees*radians;
  const c=Math.cos(angle),s=Math.sin(angle);
  const extremes=directions.map((direction)=>rotate(support(rotate(direction,c,-s)),c,s));
  const center=[width*.5-extremes[0][0],width*.5-extremes[1][1]];
  const contacts=extremes.map(([x,y])=>[x+center[0],y+center[1]]);
  return {angle,center,contacts};
}
