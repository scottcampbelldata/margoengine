import { box, Geometry, PbrMaterial } from '@margoengine/core';

function spherical(detail = 20) {
  const positions = [], normals = [], indices = [];
  for (let y=0; y<=detail; y++) for (let x=0; x<=detail*2; x++) {
    const b=y*Math.PI/detail, a=x*Math.PI/detail;
    const n=[Math.sin(a)*Math.sin(b),Math.cos(b),Math.cos(a)*Math.sin(b)];
    positions.push(...n); normals.push(...n);
    if(x && y) {
      const p=y*(2*detail+1)+x;
      indices.push(p,p-1,p-2*detail-2,p,p-2*detail-2,p-2*detail-1);
    }
  }
  return new Geometry(positions,normals,indices);
}

function tapered() {
  const positions=[], normals=[], indices=[];
  const low=[[-.5,0,-.5],[.5,0,-.5],[.5,0,.5],[-.5,0,.5]];
  const high=[[-.5,.75,.37],[.5,.72,-.5],[.5,1,.5],[-.5,.81,.5]];
  const faces=[[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7],[4,5,6,7]];
  const points=[...low,...high];
  for(const face of faces) {
    const [a,b,c,d]=face.map(i=>points[i]);
    for(const tri of [[a,b,c],[a,c,d]]) {
      const [p,q,r]=tri, u=q.map((n,i)=>n-p[i]), v=r.map((n,i)=>n-p[i]);
      const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      const length=Math.hypot(...normal), j=positions.length/3;
      positions.push(...p,...q,...r);
      for(let k=0;k<3;k++)normals.push(...normal.map(n=>-n/length));
      indices.push(j,j+2,j+1);
    }
  }
  return new Geometry(positions,normals,indices);
}

function waterMesh() {
  const points=[], normals=[], indices=[];
  const columns=41, rows=25;
  const ripple=(x,z)=>.12*Math.sin(.84*z+.073*x)+.067*Math.sin(.29*z-.21*x)+.04*Math.cos(.45*z+.24*x);
  for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){
    const x=440*(col/(columns-1)-.5), z=82*(row/(rows-1)-.5);
    const y=ripple(x,z), nx=ripple(x-.12,z)-ripple(x+.12,z), nz=ripple(x,z-.12)-ripple(x,z+.12);
    points.push(x,y,z);
    normals.push(nx,.24,nz);
    const i=row*columns+col;
    if(row&&col)indices.push(i,i-1,i-columns-1,i,i-columns-1,i-columns);
  }
  return new Geometry(points,normals,indices);
}

export function buildRiver(engine,yaw) {
  const cube=box(1,1,1), sphere=spherical(), pinnacle=tapered(), water=waterMesh();
  const ground=engine.createMesh().setRotation([0,yaw,0]);
  const material=(color,roughness=.76)=>new PbrMaterial({color,roughness});
  const bank=material('#52614a'), river=material('#6e7c81',.17), grass=material('#515c47');
  const pavement=material('#8d8272'), deck=material('#a4a1a0'), sandstone=material('#a59686');
  const buildings=['#57697a','#718699','#8b9899','#7190a2','#8b8076'].map(color=>material(color,.47));
  const windowMats=['#b9c2c0','#768993','#303f54','#9d8e76'].map(color=>material(color,.36));
  const glazing=material('#536b7e',.32), seams=material('#b5bbc0'), point=material('#d9b898');
  const shrub=[material('#3d5241'),material('#536248'),material('#5d6f50')];
  function place(name,shape,mat,x,y,z,w,h,l) {
    const m=engine.createMesh(ground);
    m.name=name;
    m.setGeometry(shape).setMaterial(mat).setPosition([x,y,z]).setScale([w,h,l]);
    return m;
  }
  const block=(name,mat,x,y,z,w,h,l)=>place(name,cube,mat,x,y,z,w,h,l);

  block('Trinity floodplain',grass,0,-5,185,1760,10,930);
  place('Trinity current',water,river,-47,.26,78,1,1,1);
  block('Far levee',bank,-20,1.20,121,600,2.4,18);
  block('Far bike path',pavement,-20,2.46,120,580,.15,2.8);
  block('Near limestone embankment',sandstone,-20,.59,37,630,1.18,10);
  block('Promenade',pavement,-52,1.22,32,465,.11,6.2);
  for(let i=0;i<26;i++){
    const x=(i-13)*22;
    block('Retaining wall joint',bank,x,1.05,41,.19,.63,2.0);
  }
  for(let i=0;i<31;i++){
    const x=(i-15)*22;
    const y=3.2+2*Math.sin(i*1.71)**2, z=145+37*Math.sin(i*1.57)**2;
    place('River bank tree',sphere,shrub[i%3],x,y,z,4+(i%5),y,3+(i%6));
  }
  for(let i=0;i<9;i++){
    const z=52+i*10, x=-104+z*.39;
    block('Viaduct column',deck,x,4.3,z,1.6,8.6,2.2);
    block('Column head',sandstone,x,8.8,z,5.5,.70,2.2);
  }
  block('Crossing deck',pavement,-69,9.8,90,7.5,1.17,148).setRotation([0,.36,0]);
  block('North parapet',deck,-65.4,10.55,89,.44,.54,148).setRotation([0,.36,0]);

  const towers=[
    [-272,385,34,70,33],[-238,314,24,59,24],[-186,395,47,120,40],
    [-150,330,32,82,34],[-119,377,41,108,43],[-68,328,32,103,34],[-49,425,44,146,42],
    [20,455,48,172,45],[56,345,35,118,29],[83,299,22,78,26],[119,403,51,144,39],
    [172,348,34,94,34],[204,410,37,115,35],[243,335,38,78,37],
    [-124,265,25,27,26],[25,293,29,35,31],[143,255,33,42,29],[177,307,22,53,26],
  ];
  towers.forEach(([x,z,w,h,l],i)=>{
    const mat=buildings[i%buildings.length];
    block('Tower mass',mat,x,h/2,z,w,h,l);
    block('Mechanical penthouse',mat,x,h+2.4,z,w*.59,4.8,l*.56);
    block('Roof coping',seams,x,h+.4,z,w+.7,.78,l+.7);
    for(let floor=6;floor<h-2;floor+=4.5){
      block('Curtain wall floor',glazing,x,floor,z-l/2-.26,w*.85,.77,.62);
      block('Return facade floor',glazing,x+w/2+.23,floor,z,.47,.67,l*.91);
      for(let column=0;column<7;column++){
        if ((floor*4+column*7+i*19)%9>3) continue;
        const ox=(column-3)*w*.118;
        block('Window light',windowMats[(i+column)%4],x+ox,floor+.03,z-l/2-.64,w*.105,.66,.25);
      }
    }
    for(let k=-3;k<=3;k++){
      block('Facade mullion',mat,x+k*w*.115,h*.50,z-l/2-.61,.42,h*.96,.34);
    }
  });

  block('Plaza tower',buildings[1],-107,106,470,54,212,55);
  block('Plaza stepped crown',buildings[1],-107,220,470,40,16,43);
  block('Plaza upper parapet',glazing,-107,230.6,470,31,5.3,33);
  for(let y=9;y<213;y+=4.4)block('Plaza strip',glazing,-107,y,442,52,.9,1);
  for(let i=-4;i<=4;i++)block('Plaza exterior fin',seams,-107+i*6,106,440.8,.54,200,.76);
  for(let i=-1;i<=1;i+=2)block('Plaza perimeter line',point,-107+i*26,109,441.2,.72,207,.84);
  place('Chiseled glass tower',pinnacle,buildings[3],-222,0,476,79,202,64);

  block('Observation tower shaft',sandstone,141,63,278,10,126,10);
  block('Observation tower deck',glazing,141,121,278,24,8.1,19);
  place('Observation sphere',sphere,glazing,141,135,278,15.5,15.5,15.5);
  for(let latitude=-2;latitude<=2;latitude++){
    const b=latitude*.33;
    for(let i=0;i<20;i++){
      const a=i*Math.PI/10+latitude*.13;
      place('Observation sphere node',sphere,point,141+15.6*Math.cos(a)*Math.cos(b),135+15.6*Math.sin(b),278+15.6*Math.sin(a)*Math.cos(b),.66,.66,.66);
    }
  }
}
