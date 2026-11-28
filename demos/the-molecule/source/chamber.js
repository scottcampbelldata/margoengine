import {Geometry, PbrMaterial} from '@margoengine/core';

const tau=2*Math.PI;
function turn(profile, sides=112) {
  const coordinates=[],normals=[],indices=[];
  for(let j=1;j<profile.length;j++){
    const [r0,y0]=profile[j-1], [r1,y1]=profile[j];
    const dr=r1-r0, dy=y1-y0, l=Math.hypot(dr,dy), offset=coordinates.length/3;
    for(let i=0;i<sides;i++){
      const theta=i*tau/sides, x=Math.cos(theta), z=Math.sin(theta);
      coordinates.push(r0*x,y0,r0*z,r1*x,y1,r1*z);
      normals.push(x*dy/l,-dr/l,z*dy/l,x*dy/l,-dr/l,z*dy/l);
    }
    for(let i=0;i<sides;i++){
      const a=offset+i*2, b=offset+((i+1)%sides)*2;
      if(r0)indices.push(a,a+1,b);
      if(r1)indices.push(b,a+1,b+1);
    }
  }
  return new Geometry(coordinates,normals,indices);
}

function tickMesh(count, y, r, long, short, width, offset=0) {
  const p=[],n=[],indices=[];
  for(let i=0;i<count;i++){
    const angle=(i+offset)*tau/count;
    const major=i%6===0, d=major?width:width*.65;
    const a=i*4, inner=r-(major?long:short);
    for(const [radius,t] of [[inner,angle+d],[r,angle+d],[r,angle-d],[inner,angle-d]]) {
      p.push(radius*Math.cos(t),y,radius*Math.sin(t));
      n.push(0,1,0);
    }
    indices.push(a,a+1,a+2,a,a+2,a+3);
  }
  return new Geometry(p,n,indices);
}

function backdrop() {
  const p=[],n=[],ix=[],sides=128;
  // The cyclorama curves from a flat floor into a vertical wall. A shared
  // normal at each row makes the transition continuous under the studio light.
  const profile=[[0,-1.396],[4.7,-1.396],[5.62,-1.396],[6.12,-1.35],[6.65,-1.18],
    [7.12,-.89],[7.51,-.49],[7.80,0],[7.96,.57],[8.04,1.20],[8.07,1.90],
    [8.08,2.80],[8.08,4.20],[8.08,7.60]];
  for(let j=0;j<profile.length;j++){
    const [r,y]=profile[j];
    const a=profile[Math.max(0,j-1)], b=profile[Math.min(profile.length-1,j+1)];
    const dr=b[0]-a[0], dy=b[1]-a[1], length=Math.hypot(dr,dy);
    for(let i=0;i<sides;i++){
      const angle=tau*i/sides, x=Math.cos(angle), z=Math.sin(angle);
      p.push(r*x,y,r*z);
      n.push(-x*dy/length,dr/length,-z*dy/length);
      if(!j)continue;
      const c=(j-1)*sides+i, d=(j-1)*sides+(i+1)%sides;
      if(j>1)ix.push(c,d,c+sides);
      ix.push(d,d+sides,c+sides);
    }
  }
  return new Geometry(p,n,ix);
}

export const wallColor='#102824';
export function createChamber(engine) {
  engine.scene.background=wallColor;
  engine.lighting.direction.set([-.54,.75,.38,2.75]);
  engine.lighting.radiance.set([1,.91,.76,.53]);
  engine.lighting.ambient.set([.65,.85,.76]);
  const material=(color,roughness=.6,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const platform=[];
  const create=(name,geometry,paint,plinth=true)=>{
    const mesh=engine.createMesh().setGeometry(geometry).setMaterial(paint);
    mesh.name=name;
    if(plinth)platform.push(mesh);
    return mesh;
  };
  const floor=material('#152b29',.92);
  const base=material('#233632',.39,.40);
  const charcoal=material('#162c28',.57,.26);
  const silver=material('#537166',.37,.48);
  const bronze=material('#957851',.37,.51);
  const lab=material('#7c9b66',.51,.20);
  const phosphor=material('#b4d788',.41,.28);
  const bed=material('#314b3f',.68,.12);
  const ringMesh=(r0,r1,y)=>turn([[r1,y],[r0,y]],144);
  create('Dark enamel chamber',backdrop(),floor,false);

  // A shallow baked contact halo matches the physical circular foot.
  for(let i=0;i<13;i++){
    const alpha=.58*(1-i/13)**2;
    const color='#'+[21,43,41].map(v=>Math.round(v*(1-alpha)).toString(16).padStart(2,'0')).join('');
    create('Platform contact '+i,ringMesh(i===0?0:1.28+.048*(i-1),1.28+.048*i,-1.395),material(color,.92));
  }
  create('Turntable lower base',turn([[0,-1.391],[1.26,-1.391],[1.37,-1.373],
    [1.42,-1.340],[1.43,-1.298],[1.42,-1.264],[1.396,-1.239],[1.356,-1.224],[0,-1.224]]),base);
  create('Inlaid chassis seam',turn([[1.408,-1.343],[1.425,-1.337],[1.427,-1.322],[1.428,-1.316]]),bronze);
  create('Knurled upper collar',turn([[1.34,-1.242],[1.381,-1.223],[1.386,-1.185],[1.38,-1.166],[1.355,-1.144]]),silver);
  create('Instrument rim',turn([[1.39,-1.189],[1.397,-1.177],[1.399,-1.159],[1.394,-1.143],
    [1.369,-1.123],[1.323,-1.119],[0,-1.119]]),charcoal);
  create('Diffuse contact inner well',ringMesh(0,1.18,-1.1186),bed);
  for(const [r,w] of [[1.365,.002],[1.202,.004],[1.095,.003],[.865,.002],[.545,.002]]) {
    create('Concentric scale marking',ringMesh(r-w,r+w,-1.118),r>1.1?bronze:lab);
  }
  create('Brass instrument graduations',tickMesh(120,-1.1174,1.339,.063,.028,.0024,0),bronze);
  create('Radial indicator slots',tickMesh(24,-1.1173,1.128,.052,.031,.0035,.12),lab);
  create('Inner graduations',tickMesh(48,-1.1169,.819,.044,.019,.0018,.10),silver);

  const bezel=turn([[0,-.024],[.035,-.024],[.043,-.020],[.048,-.012],[.049,.009],[.039,.020],
    [.032,.024],[0,.024]],25);
  const lens=turn([[0,0],[.023,0],[.027,.002],[.023,.007],[0,.008]],25);
  for(const theta of [Math.PI*.18,Math.PI*.68,Math.PI*1.18,Math.PI*1.68]){
    const x=1.02*Math.cos(theta), z=1.02*Math.sin(theta);
    create('Recessed calibration bezel',bezel,base).setPosition([x,-1.112,z]);
    create('Calibration window',lens,phosphor).setPosition([x,-1.089,z]);
  }
  // Two nested rings set a consistent instrument boundary without hiding the structure.
  const collar=turn([[1.445,-1.380],[1.455,-1.370],[1.457,-1.358],[1.453,-1.353]],164);
  create('Outer graphite thread',collar,silver);
  return {setClose(value){for(const mesh of platform)mesh.visible=!value;}};
}
