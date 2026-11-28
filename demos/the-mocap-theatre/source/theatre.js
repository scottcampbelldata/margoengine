import {Geometry,PbrMaterial,box} from '@margoengine/core';

const TAU=2*Math.PI;
function grid(columns,rows,sample){
  const points=[],indices=[],normals=[];
  for(let y=0;y<=rows;y++)for(let x=0;x<=columns;x++)points.push(...sample(x/columns,y/rows));
  for(let y=0;y<rows;y++)for(let x=0;x<columns;x++){
    const a=y*(columns+1)+x,b=a+1,c=a+columns+1,d=c+1;
    indices.push(a,b,c,b,d,c);
  }
  for(let y=0;y<=rows;y++)for(let x=0;x<=columns;x++){
    const u=x/columns,v=y/rows,a=sample(u-.0002,v),b=sample(u+.0002,v),c=sample(u,v-.0002),d=sample(u,v+.0002);
    const h=b.map((value,i)=>value-a[i]),k=d.map((value,i)=>value-c[i]);
    const n=[h[1]*k[2]-h[2]*k[1],h[2]*k[0]-h[0]*k[2],h[0]*k[1]-h[1]*k[0]];
    const length=Math.hypot(...n)||1;normals.push(...n.map(value=>value/length));
  }
  return new Geometry(points,normals,indices);
}
function floorRing(radiusX,radiusZ,width){
  return grid(88,1,(u,v)=>[(radiusX-width*v)*Math.cos(u*TAU),0,(radiusZ-width*v)*Math.sin(u*TAU)]);
}
function curtain(side){
  return grid(90,24,(u,v)=>{
    const drift=.07*(1-v)**2+.30*Math.exp(-Math.pow((v-.20)*6,2));
    const ribs=.052*Math.sin(TAU*(u*9-.4*v))+.012*Math.sin(TAU*(u*19+.3*v));
    const x=side*(1.97+1.05*u+drift),y=.01+3.12*v,z=-.38+ribs*(1-.30*v)-.29*u;
    return [x,y,z];
  });
}


function archRibbon(radialWidth){
  return grid(72,2,(u,v)=>{
    const a=Math.PI*u,r=1-v*radialWidth;
    return [.815*r*Math.cos(a),1.07+1.08*r*Math.sin(a),v*.025];
  });
}

export function theatre(engine){
  const cube=box(),mats=new Map();
  function surface(color,roughness=.72){
    const key=color+'-'+roughness;
    if(!mats.has(key))mats.set(key,new PbrMaterial({color,roughness}));
    return mats.get(key);
  }
  function add(name,geometry,position,color,dimensions=[1,1,1],roughness){
    const mesh=engine.createMesh().setGeometry(geometry).setMaterial(surface(color,roughness));
    mesh.name=name;
    return mesh.setPosition(position).setScale(dimensions);
  }
  const block=(name,position,dimensions,color,roughness)=>add(name,cube,position,color,dimensions,roughness);
  block('Wine-black plaster cyc', [0,1.70,-1.71],[8,4.75,.29],'#34292f');
  block('Blackened central splint', [0,1.25,-1.533],[.095,3.67,.039],'#291e27');
  const outerArch=archRibbon(.065),innerArch=archRibbon(.017);
  const chamber=grid(78,14,(u,v)=>{
    const x=(u-.5)*1.52,room=Math.sqrt(Math.max(0,1-(x/.77)**2));
    return [x,v*(1.067+room*1.04),-.056-.043*room*Math.sin(Math.PI*v)];
  });
  for(const side of [-1,1]){
    const x=side*.975,cold=side<0;
    add('Recessed velvet alcove',chamber,[x,0,-1.450],cold?'#314247':'#533639');
    add('Turned stage arch',outerArch,[x,0,-1.46],cold?'#698989':'#a77b60',[1,1,1],.63);
    add('Engraved inner arch',innerArch,[x,0,-1.415],cold?'#99b3a7':'#d4a983',[.90,.974,1],.51);
    for(const p of [-1,1]){
      block('Pilaster face',[x+p*.783,.53,-1.44],[.054,1.084,.062],cold?'#698989':'#a77b60');
      block('Pilaster groove',[x+p*.741,.542,-1.407],[.012,1.066,.022],cold?'#99b3a7':'#d4a983');
      block('Pilaster foot',[x+p*.77,.044,-1.434],[.104,.089,.07],cold?'#4e6d72':'#7d5451');
    }
    block('Side light housing',[x,.18,-1.393],[.350,.07,.039],cold?'#354e52':'#583e3e');
    block('Side light lens',[x,.189,-1.367],[.274,.011,.012],cold?'#a4c4be':'#dfb990',.45);
  }
  for(const side of [-1,1]){
    block('Plaster wing',[side*2.48,1.35,-1.42],[1.04,4.11,.21],'#231f28');
    block('Beveled proscenium upright',[side*2.27,1.30,-1.25],[.106,3.67,.21],'#997356');
    block('Edge of trim',[side*2.192,1.30,-1.28],[.013,3.67,.084],'#bf9870');
    add('Gathered theatre wing',curtain(side),[0,0,0],'#68292e',[1,1,1],.91);
    block('Curtain weight',[side*2.21,.018,-.27],[.32,.031,.18],'#471c1f');
    for(const x of [.35,.53,.71,.89]){
      block('Warm wall slat',[side*(1.03+x),1.44,-1.50],[.035,3.0,.052],'#6d4743');
    }
  }
  block('Stage floor',[0,-.07,.06],[6.42,.139,4.10],'#573c39',.65);
  const floor=['#7b6152','#7d6354','#795e52','#765f53','#7b604f','#785d52','#7d6455'];
  for(let i=0;i<24;i++){
    const x=(i-11.5)*.254;
    block('Rehearsal floor board',[x,-.012,.19],[.250,.026,4.23],floor[i%floor.length],.60);
  }
  const ringA=floorRing(.73,.57,.018),ringB=floorRing(.80,.63,.011);
  add('Warm performer mark',ringA,[.92,.002,0],'#dcad79');
  add('Warm performer perimeter',ringB,[.92,.003,0],'#a16e50');
  add('Capture circle',ringA,[-.99,.002,0],'#7bafb2');
  add('Capture circle perimeter',ringB,[-.99,.003,0],'#688788');
  block('Needle brass centerline',[.002,.003,-.056],[.018,.007,2.08],'#af8170');
  for(let row=0;row<7;row++){
    const z=.73-row*.214;
    block('Floor index', [.010,.007,z],[row===3?.139:.086,.008,.012],'#cb9d8f');
  }
  block('Rehearsal stage apron',[0,-.037,1.82],[5.1,.083,.10],'#3b2d34');
  for(const x of [-1.96,-1.51,-.74,0,.74,1.51,1.96]){
    block('Footlight housing',[x,.008,1.79],[.107,.036,.074],'#563a35');
    block('Footlight lens',[x,.030,1.785],[.077,.018,.046],'#f3cc95',.43);
  }
}
