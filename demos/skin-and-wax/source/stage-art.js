import {Geometry,PbrMaterial,box} from '@margoengine/core';

function softened(width,height,depth,c){
  const [w,h,d]=[width*.5,height*.5,depth*.5],b=Math.min(c,w*.5,h*.5,d*.5);
  const ring=(y,x,z,round)=>[
    [-x+round,y,z],[x-round,y,z],[x,y,z-round],[x,y,-z+round],
    [x-round,y,-z],[-x+round,y,-z],[-x,y,-z+round],[-x,y,z-round],
  ];
  const loops=[ring(-h,w-b,d-b,b*.45),ring(-h+b,w,d,b),ring(h-b,w,d,b),ring(h,w-b,d-b,b*.45)];
  const vertices=[],normals=[],indices=[];
  const tri=(a,z,o)=>{
    const ux=z[0]-a[0],uy=z[1]-a[1],uz=z[2]-a[2],vx=o[0]-a[0],vy=o[1]-a[1],vz=o[2]-a[2];
    const n=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx],len=Math.hypot(...n)||1;
    const i=vertices.length/3;
    vertices.push(...a,...z,...o);
    for(let j=0;j<3;j++)normals.push(n[0]/len,n[1]/len,n[2]/len);
    indices.push(i,i+1,i+2);
  };
  for(let r=0;r<3;r++)for(let i=0;i<8;i++){
    const j=(i+1)%8;
    const a=loops[r][i],z=loops[r][j],o=loops[r+1][j],s=loops[r+1][i];
    tri(a,z,o);tri(a,o,s);
  }
  for(let i=1;i<7;i++){
    tri(loops[0][0],loops[0][i+1],loops[0][i]);
    tri(loops[3][0],loops[3][i],loops[3][i+1]);
  }
  return new Geometry(vertices,normals,indices);
}

export function buildExhibit(engine){
  const make=(color,roughness=.75,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
  const cloth=make('#37302a',.91),shelf=make('#625547',.69),walnut=make('#473830',.82);
  const stone=make('#6b655a',.84),brass=make('#b58b5e',.43,1),ribs=make('#56635a',.88);
  const wall=make('#3a4942',.87),deep=make('#283630',.94),trim=make('#806d55',.71);
  const floor=make('#372f2c',.82);
  const add=(p,w,h,d,material,r=0)=>engine.createMesh().setGeometry(r?softened(w,h,d,r):box(w,h,d)).setPosition(p).setMaterial(material);
  add([0,-.054,-.017],1.74,.10,.91,walnut,.012);
  add([0,-.105,-.016],1.79,.016,.936,trim);
  add([0,-.131,-.016],1.72,.044,.89,cloth);
  add([0,-.154,.003],2.78,.018,2.83,floor);
  add([0,.34,-.53],2.83,1.30,.091,deep);
  for(let j=-3;j<=3;j++){
    add([j*.319,.384,-.472],.309,.951,.044,wall);
    add([j*.319+.150,.384,-.446],.012,.949,.009,ribs);
  }
  add([0,.145,-.452],2.8,.013,.024,trim);
  add([0,.125,-.465],2.8,.016,.031,wall);
  add([0,.597,-.417],2.6,.037,.12,cloth);
  add([0,.579,-.365],2.56,.009,.067,brass);
  add([0,.569,-.363],2.44,.002,.065,make('#c6b08c',.55));
  for(const [i,x] of [-.437,0,.437].entries()){
    const z=i===1?-.041:-.024;
    add([x,.006,z],.324,.024,.29,cloth,.005);
    add([x,.0175,z],.304,.004,.272,brass);
    add([x,.023,z],.294,.010,.261,i===1?shelf:stone,.0027);
    add([x,.013,z+.1458],.067,.014,.002,brass);
    for(let n=0;n<5;n++)add([x-.016+n*.008,.014,z+.147],.0021,.006,.0018,cloth);
  }
  add([.437,.035,-.050],.112,.017,.090,make('#685b4e',.62));
  add([-.437,.23,-.025],.005,.022,.004,make('#5c3931',.91));
}
