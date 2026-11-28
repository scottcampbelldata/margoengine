const tau=Math.PI*2;
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const subtract=(a,b)=>a.map((x,i)=>x-b[i]);
const unit=v=>v.map(x=>x/Math.hypot(...v));
const dot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0);
const cross=([x,y,z],[a,b,c])=>[y*c-z*b,z*a-x*c,x*b-y*a];

export const ribbons=[
  {rows:326,ring:64,phase:0,depth:-.43,width:.39},
  {rows:326,ring:64,phase:.127,depth:-.03,width:.36},
  {rows:326,ring:64,phase:.244,depth:.41,width:.33},
  {rows:393,ring:30,phase:.064,depth:-.66,width:.103},
  {rows:393,ring:30,phase:.177,depth:.67,width:.089},
];

function angles(t,ribbon){
  return -Math.PI/2-.175+ribbon.phase+t*tau*1.045+.108*Math.sin(t*tau);
}
export function center(t,ribbon){
  const a=angles(t,ribbon);
  const r=2.31-1.51*t+.22*Math.sin(t*Math.PI)+.088*Math.sin(3*a+.60);
  const x=r*Math.cos(a)*1.115+.40*t;
  const y=2.49+r*Math.sin(a)*.925+.09*Math.sin(t*tau-.3);
  const z=ribbon.depth+.63*t*Math.sin(a+.35)+.39*Math.sin(a+.5);
  return [x,y,z];
}

function section(t,ribbon){
  const o=center(t,ribbon),a=angles(t,ribbon);
  const tangent=unit(subtract(center(t+.00015,ribbon),center(t-.00015,ribbon)));
  const spoke=[Math.cos(a),Math.sin(a),-.18];
  const along=dot(spoke,tangent);
  const lateral=unit(spoke.map((x,i)=>x-tangent[i]*along));
  const normal=cross(tangent,lateral);
  const note=.31+.71*Math.sin(t*tau-.56+ribbon.phase*2.3);
  const u=lateral.map((x,i)=>x*Math.cos(note)+normal[i]*Math.sin(note));
  const v=cross(tangent,u);
  const taper=Math.pow(Math.max(0,Math.sin(Math.PI*t)),.59);
  const point=Math.pow(clamp(1-t,0,1),.16);
  const w=ribbon.width*(.32+.75*taper)*point+.007;
  const height=(.042+.036*taper)*(ribbon.width>.18?1:.56);
  return {o,u,v,w,height,tangent};
}
function ribbonPosition(k,s,st,ribbon){
  const a=k*tau/ribbon.ring,rx=Math.cos(a),ry=Math.sin(a);
  const plate=Math.sign(rx)*Math.pow(Math.abs(rx),.73);
  const thickness=Math.sign(ry)*Math.pow(Math.abs(ry),.53);
  const flutes=1+.27*Math.cos(plate*12.1+.6*Math.sin(s*tau))+.20*Math.sin(s*57*tau+plate*1.6);
  return st.o.map((x,i)=>x+st.u[i]*st.w*plate+st.v[i]*st.height*thickness*flutes);
}
export function buildMeridian(){
  const count=ribbons.reduce((sum,{rows,ring})=>sum+(rows+1)*ring+2,0);
  const indexCount=ribbons.reduce((sum,{rows,ring})=>sum+(rows+1)*ring*6,0);
  const positions=new Float32Array(count*3),normals=new Float32Array(count*3),indices=new Uint32Array(indexCount);
  let start=0,write=0;
  for(const ribbon of ribbons){
    const {rows,ring}=ribbon;
    const cap0=start+(rows+1)*ring,cap1=cap0+1;
    for(let row=0;row<=rows;row++){
      const t=row/rows,st=section(t,ribbon);
      for(let col=0;col<ring;col++)positions.set(ribbonPosition(col,t,st,ribbon),(start+row*ring+col)*3);
    }
    function index(row,col){return start+row*ring+(col+ring)%ring;}
    const p=(row,col)=>positions.subarray(index(row,col)*3,index(row,col)*3+3);
    for(let row=0;row<=rows;row++)for(let col=0;col<ring;col++){
      const v=subtract(p(row,col+1),p(row,col-1));
      const t=subtract(p(Math.min(rows,row+1),col),p(Math.max(0,row-1),col));
      const a=index(row,col),b=index(row,col+1);
      normals.set(unit(cross(v,t)),a*3);
      if(row<rows){
        const c=index(row+1,col),d=index(row+1,col+1);
        indices[write++]=a;indices[write++]=b;indices[write++]=d;
        indices[write++]=a;indices[write++]=d;indices[write++]=c;
      }
      if(row===0){indices[write++]=cap0;indices[write++]=b;indices[write++]=a;}
      if(row===rows){indices[write++]=cap1;indices[write++]=a;indices[write++]=b;}
    }
    positions.set(center(0,ribbon),cap0*3);
    normals.set(section(0,ribbon).tangent.map(x=>-x),cap0*3);
    positions.set(center(1,ribbon),cap1*3);
    normals.set(section(1,ribbon).tangent,cap1*3);
    start=cap1+1;
  }
  return {positions,normals,indices};
}
