import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {roundedBoxGeometry} from '@margoengine/geometry/extras';
import {stations} from './brain.js';

const colors={
  frame:'#46352a',rim:'#a2845c',edge:'#8e7354',bed:'#756a45',island:'#76815a',
  path:'#ceb48c',stone:'#b5a185',chalk:'#d9c6a4',mortar:'#8b8060',slate:'#4f6667',
  slateHigh:'#6d8882',base:'#626a57',oak:'#614530',maple:'#a26840',cool:'#315d62',
  water:'#529b9a',foam:'#a1c0ae',net:'#e4d0a2',straw:'#aa7750',tile:'#824534',
  leaf:'#51623a',sprig:'#778548',gilt:'#a6a055',shade:'#3e5138',apple:'#b1714e',
  lift:'#709781',shadow:'#6d7052',honey:'#eaad68',
};
const materials=new Map();
function finish(ref,roughness=.75,metalness=0){
  const color=colors[ref]??ref,key=[color,roughness,metalness].join('/');
  if(!materials.has(key))materials.set(key,new PbrMaterial({color,roughness,metalness}));
  return materials.get(key);
}
function append(batch,g,x,y,z,sx,sy,sz,angle=0){
  const n=batch.pos.length/3,s=Math.sin(angle),c=Math.cos(angle);
  for(let i=0;i<g.vertices.length;i+=6){
    const a=g.vertices[i]*sx,b=g.vertices[i+1]*sy,d=g.vertices[i+2]*sz;
    batch.pos.push(x+c*a+s*d,y+b,z-s*a+c*d);
    const ux=g.vertices[i+3]/sx,uy=g.vertices[i+4]/sy,uz=g.vertices[i+5]/sz,m=Math.hypot(ux,uy,uz);
    batch.normal.push((c*ux+s*uz)/m,uy/m,(c*uz-s*ux)/m);
  }
  for(const index of g.indices)batch.indices.push(n+index);
}
function polar(radius,height,segments=18){
  const p=[0,height,0],normal=[0,1,0],index=[];
  for(let i=0;i<segments;i++){
    const th=2*Math.PI*i/segments;
    p.push(radius*Math.cos(th),height,radius*Math.sin(th));normal.push(0,1,0);
    index.push(0,1+(i+1)%segments,1+i);
  }
  return new Geometry(p,normal,index);
}
function prism(sides,bottom,top,height){
  const p=[],n=[],ind=[];
  for(let i=0;i<=sides;i++){
    const theta=i*2*Math.PI/sides,c=Math.cos(theta),s=Math.sin(theta),q=(bottom-top)/height,k=Math.hypot(1,q);
    p.push(bottom*c,0,bottom*s,top*c,height,top*s);
    n.push(c/k,q/k,s/k,c/k,q/k,s/k);
    const j=i*2;
    if(i<sides)ind.push(j,j+1,j+3,j,j+3,j+2);
  }
  return new Geometry(p,n,ind);
}
function crown(){
  const p=[],n=[],ix=[],vertical=6,around=14;
  for(let y=0;y<=vertical;y++){
    const a=Math.PI*y/vertical,r=Math.sin(a),h=Math.cos(a);
    for(let j=0;j<=around;j++){
      const phi=2*Math.PI*j/around,c=Math.cos(phi),s=Math.sin(phi);
      const l=1+r*(.10*Math.sin(3*phi+a)+.06*Math.cos(5*phi-a));
      p.push(r*c*l,h*(1+.03*c),r*s*l);n.push(r*c,h,r*s);
      const i=y*(around+1)+j;
      if(y<vertical&&j<around)ix.push(i,i+1,i+around+2,i,i+around+2,i+around+1);
    }
  }
  return new Geometry(p,n,ix);
}
const cube=box(1,1,1),foliage=crown(),round=polar(1,0,28),octagon=polar(1,0,8);
const trunk=prism(8,.11,.055,.79);
const ceramic=prism(20,.25,.22,.10);
const bowl=prism(16,.64,.55,.28);
const peg=prism(16,.055,.039,.28);
function easedBox(width,height,depth,radius){
  const mesh=roundedBoxGeometry(width,height,depth,2,radius);
  return new Geometry(mesh.positions,mesh.normals,mesh.indices);
}
function ribbon(p1,p2,width,y){
  const dx=p2[0]-p1[0],dz=p2[2]-p1[2],length=Math.hypot(dx,dz);
  return {x:(p1[0]+p2[0])*.5,y,z:(p1[2]+p2[2])*.5,sx:width,sy:.008,sz:length,th:Math.atan2(dx,dz)};
}
const node=(engine,g,m)=>engine.createMesh().setGeometry(g).setMaterial(m);
export function makeBoard(engine,people){
  const layers=new Map();
  function solid(g,name,x,y,z,sx=1,sy=1,sz=1,angle=0,rough=.76,metal=0){
    const storage=finish(name,rough,metal);
    if(!layers.has(storage))layers.set(storage,{pos:[],normal:[],indices:[]});
    append(layers.get(storage),g,x,y,z,sx,sy,sz,angle);
  }
  function beam(name,x,y,z,w,h,d,angle=0,rough=.76){
    solid(cube,name,x,y,z,w,h,d,angle,rough);
  }
  const floor=(name,x,z,width,depth,height=-.046)=>{
    beam(name,x,height,z,width,.082,depth);
  };
  const rng=seed=>((Math.imul(seed+23478,7521049)>>>4)%50029)/50029;

  solid(easedBox(13.66,.68,10.81,.145),'frame',0,-.69,-.13,1,1,1,0,.53);
  solid(easedBox(13.41,.16,10.58,.066),'rim',0,-.301,-.13,1,1,1,0,.48);
  solid(easedBox(13.13,.28,10.28,.045),'bed',0,-.207,-.13);
  floor('island',0,-.55,12.87,9.08);
  floor('path',-.08,.59,10.42,.80,-.019);
  floor('path',.11,-1.32,9.69,.71,-.020);
  floor('path',.12,2.39,9.97,.72,-.020);
  for(const x of [-4.09,-2.05,.01,2.20,4.21])floor('path',x,.45,.67,4.02,-.019);
  floor('path',.10,-2.42,.79,2.37,-.020);
  floor('path',-3.15,-1.83,.72,1.53,-.019);
  floor('path',4.35,-1.72,.72,1.44,-.019);
  for(let i=0;i<23;i++){
    const x=-5.08+i*.45;
    beam(i%5?'mortar':'chalk',x,.021,.594,.018,.005,.747);
    beam(i%4?'mortar':'chalk',x+.043,.021,2.39,.015,.005,.666);
  }
  for(let i=0;i<12;i++)beam(i%4?'mortar':'chalk',.11,.022,-3.08+i*.236,.767,.005,.013);
  for(const x of [-4.1,-2.04,.012,2.2,4.21]){
    for(const z of [-1.15,-.86,-.56,-.26,.05,.347,.836,1.12,1.42,1.72,2.01]){
      beam('mortar',x,.025,z,.616,.004,.009);
    }
  }

  floor('cool',0,4.26,12.87,1.42,-.070);
  floor('water',0,4.24,12.47,1.16,-.054);
  for(let i=0;i<48;i++){
    const x=(rng(i*17)-.5)*12.1,z=3.76+rng(i*31)*.97;
    beam(i%3===0?'foam':'water',x,-.010,z,.12+.53*rng(i*43),.004,.011);
  }
  for(const z of [3.52,5.02]){
    for(let i=0;i<31;i++){
      const x=-6.27+i*.413;
      beam(i%6===0?'chalk':'stone',x,.014,z,.405,.138,.192);
    }
  }
  for(let i=0;i<10;i++){
    const z=3.47+.173*i;
    beam(i%3?'oak':'maple',.02,.117,z,1.05,.129,.163,0,.65);
  }
  for(const x of [-.50,.54]){
    beam('oak',x,.30,4.27,.066,.074,1.77);
    for(const z of [3.46,3.83,4.23,4.64,5.02])beam('maple',x,.178,z,.081,.299,.095);
  }
  for(let i=0;i<18;i++){
    const x=-5.9+i*.697;
    beam(i%3?'stone':'chalk',x,.14,-4.91,.68,.28,.28);
    beam('slateHigh',x,.30,-4.91,.68,.07,.36,0,.49);
  }
  for(const x of [-5.62,5.62]){
    for(let i=0;i<10;i++){
      const z=-2.77+i*.61;
      beam(i%4?'stone':'chalk',x,.11,z,.24,.22,.55);
    }
  }
  const planted=(x,z,seed,size=1)=>{
    solid(round,'shadow',x+.22,.006,z+.11,.78*size,1,.61*size);
    solid(trunk,'oak',x,0,z,size,size,size);
    for(let j=0;j<6;j++){
      const angle=j*2.399+seed*.17;
      const dx=Math.cos(angle)*.36*size,dz=Math.sin(angle)*.36*size;
      const mass=.42+rng(seed*12+j)*.20;
      solid(foliage,['leaf','shade','sprig','gilt','lift','sprig'][j],
        x+dx,.75*size+(.12+rng(j+seed)*.48)*size,z+dz,mass*size,mass*.81*size,mass*size,angle);
      if(j%2===0)solid(foliage,'apple',x+dx*2, .90*size+(rng(seed+j)-.5)*.36,z+dz*2,
        .064*size,.066*size,.069*size,angle);
    }
  };
  for(let i=0;i<20;i++){
    const row=Math.floor(i/5),col=i%5;
    const x=-2.63+col*1.26+.21*(row%2),z=-4.43+row*.355;
    if(row===3&&(col===2||col===3))continue;
    planted(x,z,i+1,.65+.15*rng(i*37));
  }
  planted(5.01,-3.98,57,1.42);
  planted(-4.96,-1.55,61,1.00);
  planted(4.92,2.67,53,1.19);
  planted(-4.31,2.86,95,.86);
  for(let i=0;i<16;i++){
    const x=-5.20+i*.65,z=i%2?-4.53:-4.70;
    solid(foliage,i%3?'leaf':'sprig',x,.17,z,.33,.18,.29,i*.77);
  }
  for(const x of [-3.68,3.76]){
    for(let i=0;i<8;i++)beam('maple',x,.27,-2.84-i*.26,.061,.55,.06);
    beam('oak',x,.30,-3.75,.061,.05,1.96);
    beam('oak',x,.46,-3.75,.063,.05,1.96);
  }
  for(const x of [-.48,.71]){
    beam('oak',x,.40,-3.21,.11,.81,.13);
    beam('maple',x,.84,-3.21,.18,.085,.19);
  }
  beam('oak',.113,.78,-3.21,1.25,.091,.071);
  beam('maple',.11,.20,-3.44,1.04,.35,.052);
  for(let i=0;i<8;i++)beam('straw',-.35+i*.127,.28,-3.404,.025,.39,.022);
  for(const x of [-1.11,1.13]){
    const z=-2.47;
    beam('bed',x,.018,z,1.04,.061,.66);
    for(let i=0;i<10;i++){
      const px=x-.43+i*.09;
      solid(foliage,i%2?'sprig':'gilt',px,.072,z+(i%3-1)*.139,.065,.060,.07,i);
    }
    beam('chalk',x,.065,z-.35,1.15,.15,.066);
    beam('chalk',x,.065,z+.35,1.15,.15,.066);
  }

  for(const [u,z,variety] of [[-3.08,-.39,0],[-1.03,-.37,1],[1.10,1.47,2],[3.22,1.47,3],[-1.07,1.47,4]]){
    beam('bed',u,.015,z,1.12,.055,.77);
    for(const edge of [-.38,.38])beam('stone',u,.052,z+edge,1.10,.096,.032);
    for(const x of [-.554,.554])beam('stone',u+x,.052,z,.035,.095,.77);
    for(let row=0;row<3;row++)for(let i=0;i<7;i++){
      const seed=variety*33+row*7+i;
      const leaf=.042+.035*rng(seed*11);
      const x=u-.47+i*.155,z0=z+(row-1)*.215;
      solid(foliage,['lift','gilt','sprig'][row],x,.077+leaf,z0,leaf,.073+rng(seed*13)*.04,leaf,seed*.72);
    }
  }

  function barrel(x,z,r=.53){
    solid(round,'shadow',x+.15,.007,z+.1,r*1.29,1,r*1.07);
    solid(bowl,'mortar',x,.025,z,r/.64,1,r/.64,0,.79);
    solid(bowl,'chalk',x,.255,z,r/.7,.23,r/.7);
    solid(round,'water',x,.32,z,r*.72,1,r*.72,0,.30);
    solid(round,'foam',x-.13,.322,z-.05,.068,1,.044);
  }
  barrel(2.6,.81,.46);
  const sx=2.61,sz=.48;
  beam('oak',sx,.49,sz,.109,.87,.104);
  beam('slate',sx,.82,sz+.075,.228,.103,.114);
  beam('stone',sx-.01,.745,sz+.159,.074,.133,.055);
  const well=stations.find(s=>s.id==='cistern');
  barrel(well.x,well.z,.31);

  function roofing(name,x,y,z,wide,deep,rise){
    const p=[],n=[],idx=[];
    for(const side of [-1,1]){
      const i=p.length/3,edgeZ=z+side*deep*.5,r=Math.hypot(rise,deep*.5);
      p.push(x-wide*.5,y+rise,z,x+wide*.5,y+rise,z,x+wide*.5,y,edgeZ,x-wide*.5,y,edgeZ);
      for(let j=0;j<4;j++)n.push(0,deep*.5/r,side*rise/r);
      idx.push(...(side>0?[i,i+2,i+1,i,i+3,i+2]:[i,i+1,i+2,i,i+2,i+3]));
      for(let slat=0;slat<Math.floor(wide/.135);slat++){
        const px=x-wide*.5+.05+slat*.135;
        beam(name==='tile'?'straw':'slateHigh',px,y-.012,edgeZ,.051,.057,.051,0,.62);
      }
    }
    solid(new Geometry(p,n,idx),name,0,0,0,1,1,1,0,.67);
    beam(name==='tile'?'tile':'slateHigh',x,y+rise+.025,z,wide+.055,.063,.085);
  }
  const bakeryX=-4.42,bakeryZ=1.72;
  solid(easedBox(1.62,.16,1.27,.028),'slateHigh',bakeryX,.08,bakeryZ);
  beam('chalk',bakeryX,.49,bakeryZ,1.46,.82,1.12);
  beam('oak',bakeryX,.44,bakeryZ+.564,.48,.65,.023);
  beam('tile',bakeryX,.24,bakeryZ+.575,.29,.096,.017);
  for(const x of [bakeryX-.53,bakeryX+.53]){
    beam('mortar',x,.54,bakeryZ+.571,.232,.285,.026);
    beam('cool',x,.55,bakeryZ+.590,.162,.188,.026);
    beam('chalk',x,.55,bakeryZ+.606,.192,.028,.028);
  }
  roofing('tile',bakeryX,.91,bakeryZ,1.74,1.40,.35);
  beam('stone',bakeryX+.47,1.187,bakeryZ-.24,.24,.52,.25);
  beam('tile',bakeryX+.47,1.497,bakeryZ-.24,.29,.087,.29);
  beam('oak',bakeryX,.81,bakeryZ+.593,1.52,.082,.051);
  beam('maple',bakeryX+.38,.304,bakeryZ+.88,.51,.084,.23);
  for(let i=0;i<5;i++)solid(foliage,'honey',bakeryX+.19+i*.09,.381,bakeryZ+.88,.059,.038,.066,i*.5);

  const arbor=stations.find(s=>s.id==='arbor');
  const ax=arbor.x,az=arbor.z;
  floor('stone',ax,az,1.65,1.32,-.026);
  for(const dx of [-.69,.69])for(const dz of [-.48,.51]){
    beam('stone',ax+dx,.083,az+dz,.173,.153,.16);
    beam('oak',ax+dx,.532,az+dz,.086,.91,.09);
    beam('maple',ax+dx,.95,az+dz,.14,.13,.146);
  }
  beam('oak',ax,.93,az-.50,1.61,.106,.105);
  beam('oak',ax,.93,az+.52,1.61,.106,.104);
  roofing('slate',ax,1.02,az,1.70,1.31,.36);
  for(const z of [-.17,.21]){
    beam('maple',ax,.27,az+z,1.18,.078,.16);
    for(const x of [ax-.45,ax+.46])beam('oak',x,.139,az+z,.12,.272,.11);
  }
  for(const dx of [-.57,.55]){
    solid(foliage,'sprig',ax+dx,.99,az-.43,.28,.24,.28);
    solid(foliage,'gilt',ax+dx-.11,.90,az-.35,.27,.18,.21);
  }
  for(const station of stations){
    const s=station.slots.length;
    for(let index=0;index<s;index++){
      const [dx,dz]=station.slots[index],x=station.x+dx,z=station.z+dz;
      solid(octagon,'chalk',x,.032,z,.18,1,.18);
      solid(octagon,'mortar',x,.035,z,.111,1,.111);
    }
  }

  for(const [material,batch] of layers){
    node(engine,new Geometry(batch.pos,batch.normal,batch.indices),material);
  }
  const active=people.map(person=>{
    const stem=node(engine,peg,finish(person.color,.50,.32));
    const foot=node(engine,ceramic,finish(person.color,.46,.14));
    const cap=node(engine,round,finish('#f1e1b9',.53));
    const halo=node(engine,round,finish(person.color,.57));
    return {stem,foot,cap,halo};
  });
  const routeMaterial=finish('#8b482b',.61);
  const route=node(engine,new Geometry([],[],[]),routeMaterial);
  const leading=node(engine,cube,routeMaterial);
  let lastRoute='';
  function drawRoute(person){
    const points=person.route, key=person.name+'-'+points.map(p=>p.join(',')).join(';');
    const first=points[0];
    if(first){
      const p=ribbon(person.position,first,.052,.054);
      leading.setPosition([p.x,p.y,p.z]).setScale([p.sx,p.sy,Math.max(.001,p.sz)]);
      leading.rotation.y=p.th;
    }else leading.setPosition([0,-5,0]);
    if(key===lastRoute)return;
    lastRoute=key;
    const batch={pos:[],normal:[],indices:[]};
    for(let i=0;i+1<points.length;i++){
      const p=ribbon(points[i],points[i+1],.052,.054);
      if(p.sz>.02)append(batch,cube,p.x,p.y,p.z,p.sx,p.sy,p.sz,p.th);
    }
    route.setGeometry(new Geometry(batch.pos,batch.normal,batch.indices));
  }
  return {draw(village,person){
    drawRoute(person);
    for(const [index,p] of village.people.entries()){
      const [x,,z]=p.position,{stem,foot,cap,halo}=active[index];
      const scale=p===person?1.17:1;
      stem.setPosition([x,.16,z]).setScale([scale,scale,scale]);
      foot.setPosition([x,.039,z]).setScale([scale,scale,scale]);
      cap.setPosition([x,.425*scale,z]).setScale([.048*scale,1,.048*scale]);
      const ring=p.phase==='Using'?.36:.32;
      halo.setPosition([x,.037,z]).setScale([ring,1,ring]);
    }
  }};
}
