
import {Geometry} from '@margoengine/core';

const turn=2*Math.PI;
const pi=Math.PI;
const vector=(x,y,z)=>{
  const length=Math.hypot(x,y,z)||1;
  return [x/length,y/length,z/length];
};
function cross(a,b){
  return [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
}
function face(data,points,normals){
  const offset=data.points.length/3;
  for(const [i,point] of points.entries()){
    data.points.push(...point);
    data.normals.push(...normals[i]);
  }
  for(let i=1;i<points.length-1;i++)data.indices.push(offset,offset+i,offset+i+1);
}
function sheet(){return {points:[],normals:[],indices:[]};}
const build=data=>new Geometry(data.points,data.normals,data.indices);
function contour(x,z,r,y){
  const ring=[];
  for(const [i,vx,vz] of [[0,1,1],[1,-1,1],[2,-1,-1],[3,1,-1]]){
    for(let step=0;step<=6;step++){
      const angle=pi/2*(i+step/6);
      ring.push([vx*(x-r)+r*Math.cos(angle),y,vz*(z-r)+r*Math.sin(angle)]);
    }
  }
  return ring;
}
export function slab(width,depth,height,radius,bevel){
  const data=sheet();
  const ring=[
    [width/2-bevel,depth/2-bevel,radius-bevel,-height/2],
    [width/2,depth/2,radius,-height/2+bevel],
    [width/2,depth/2,radius,height/2-bevel],
    [width/2-bevel,depth/2-bevel,radius-bevel,height/2],
  ].map(row=>contour(...row));
  for(let band=0;band<ring.length-1;band++){
    const a=ring[band],b=ring[band+1];
    for(let i=0;i<a.length;i++){
      const next=(i+1)%a.length, d=a[next][2]-a[i][2], x=a[next][0]-a[i][0];
      const norm=vector(d,(band-1)*Math.hypot(d,x),-x);
      face(data,[a[i],b[i],b[next],a[next]],[norm,norm,norm,norm]);
    }
  }
  face(data,[...ring.at(-1)].reverse(),ring[0].map(()=>[0,1,0]));
  face(data,ring[0],ring[0].map(()=>[0,-1,0]));
  return build(data);
}

function filament(data,axis,radius,sides=9,closed=false){
  const rounds=[];
  const normals=[];
  for(let i=0;i<axis.length;i++){
    const p=axis[i],a=axis[closed?(i+axis.length-1)%axis.length:Math.max(i-1,0)],
      b=axis[closed?(i+1)%axis.length:Math.min(i+1,axis.length-1)];
    const t=vector(b[0]-a[0],b[1]-a[1],b[2]-a[2]);
    const u=vector(...cross(t,Math.abs(t[2])>.93?[0,1,0]:[0,0,1])),v=cross(t,u);
    const row=[],shade=[];
    const thick=typeof radius==='function'?radius(i/(axis.length-1)):radius;
    for(let j=0;j<sides;j++){
      const angle=j*turn/sides;
      const n=u.map((value,k)=>value*Math.cos(angle)+v[k]*Math.sin(angle));
      row.push(p.map((value,k)=>value+n[k]*thick));
      shade.push(n);
    }
    rounds.push(row);
    normals.push(shade);
  }
  const rows=closed?rounds.length:rounds.length-1;
  for(let i=0;i<rows;i++){
    const next=(i+1)%rounds.length;
    for(let j=0;j<sides;j++){
      const k=(j+1)%sides;
      face(data,[rounds[i][j],rounds[i][k],rounds[next][k],rounds[next][j]],
        [normals[i][j],normals[i][k],normals[next][k],normals[next][j]]);
    }
  }
}
const angle=.22,c=Math.cos(angle),s=Math.sin(angle);
export function latticePosition(x,y,z){return [-.64+x*c-z*s,y,-.415+x*s+z*c];}

export function latticeBase(){
  const base=slab(.96,.235,.037,.051,.008), points=[], normals=[];
  for(let i=0;i<base.vertices.length;i+=6){
    const [x,y,z,nx,ny,nz]=base.vertices.subarray(i,i+6);
    points.push(...latticePosition(x,.209+y,z));
    normals.push(nx*c-nz*s,ny,nx*s+nz*c);
  }
  return new Geometry(points,normals,base.indices);
}

function railAxis(radiusX,radiusY,depth,phase=0){
  return Array.from({length:72},(_,i)=>{
    const a=(i/72)*turn+phase;
    return latticePosition(radiusX*Math.cos(a),.655+radiusY*Math.sin(a),
      depth+.034*Math.cos(a*2));
  });
}
export function hoops(){
  const brass=sheet(), seam=sheet();
  filament(brass,railAxis(.637,.387,0),.021,13,true);
  filament(seam,railAxis(.644,.393,.037),.0063,8,true);
  filament(brass,railAxis(.563,.319,0,.009),.0086,10,true);
  return {brass:build(brass),seam:build(seam)};
}
export function reeds(){
  const bright=sheet(), dark=sheet();
  const rows=[
    [-.492,.010],[-.443,.016],[-.373,.009],[-.324,.013],[-.260,.008],[-.234,.0045],[-.195,.0087],
    [-.131,.011],[-.084,.006],[-.055,.005],[.008,.007],[.054,.012],[.111,.005],[.143,.009],[.187,.012],[.247,.007],
    [.280,.005],[.316,.012],[.401,.014],[.454,.008],[.491,.009],
  ];
  for(const [i,[x,radius]] of rows.entries()){
    const yHalf=.324*Math.sqrt(Math.max(0,1-(x/.559)**2));
    const path=Array.from({length:18},(_,j)=>{
      const t=j/17,r=2*t-1;
      const drift=(1-r*r)*(.094*Math.sin(t*pi+.23*i)+.025);
      return latticePosition(x+drift,.655+r*yHalf,.024*Math.sin(2*pi*t+i*.29));
    });
    filament(i%3===0?bright:dark,path,t=>radius*(.76+.24*Math.sin(t*pi)),7);
  }
  // A copper spine threads diagonally through the dark reeds.
  filament(bright,Array.from({length:32},(_,i)=>{
    const t=i/31,x=(2*t-1)*.552;
    const y=.662+.077*Math.sin((t-.19)*pi*2);
    return latticePosition(x,y,.047+.026*Math.sin(pi*t));
  }),.009,8);
  return {bright:build(bright),dark:build(dark)};
}

export function feet(){
  const steel=sheet(),trim=sheet();
  for(const side of [-1,1]){
    const x=side*.35;
    filament(steel,Array.from({length:10},(_,i)=>{
      const t=i/9;
      return latticePosition(x+.028*Math.sin(pi*t)*side,.143+.239*t,-.013-.039*t);
    }),.017,10);
    filament(trim,Array.from({length:10},(_,i)=>{
      const t=i/9;
      return latticePosition(x+side*.065*(1-t),.154+.146*t,.106*(1-t)-.039*t);
    }),.009,8);
  }
  return {steel:build(steel),trim:build(trim)};
}
