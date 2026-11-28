import { Geometry,PbrMaterial } from '@margoengine/core';
import { applyMatrix4,boxGeometry,cylinderGeometry,mergeGeometries,torusGeometry } from '@margoengine/geometry';
import { board,gardens,launchLinks } from './navigation.js';

const material=(color,roughness=.66,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const foliage=color=>new PbrMaterial({color,roughness:.88,doubleSided:true});
const palette={
  deck:material('#d3bb9e',.87),deckEast:material('#b8c1b1',.84),sand:material('#b39b84'),
  joints:material('#a39380',.77),eastJoints:material('#92a495'),deckEdge:material('#aea18b'),
  tunnel:material('#41615c',.83),grate:material('#38635d',.78),water:material('#1b696c',.31),
  waterGlint:material('#387f80',.41),channel:material('#365557',.72),
  base:material('#293e45',.88),ledge:material('#476061',.69),rim:material('#6f8884',.57),
  grass:foliage('#53715b'),fern:foliage('#8a9e6d'),gravel:material('#897967',.96),
  rail:material('#dab279',.59,.59),cream:material('#e0ceac',.66),marker:material('#ad5a36',.59),
  asphalt:material('#5b6f6a',.87),warning:material('#a76549'),
  black:material('#2a3a3d',.78),steel:material('#a8aba1',.46,.55),ruby:material('#9c543a',.46),
  gold:material('#d58a49',.47,.18),ink:material('#495b65',.57,.25),teal:material('#43847c',.46,.21),
  shell:material('#cbb697',.62),ceramic:material('#a8c5b3',.51),
};

const unitBox=boxGeometry(1,1,1);
const wrap=g=>new Geometry(g.positions,g.normals,g.indices);
const turn=(sx,sy,sz,x,y,z,yaw)=>{
  const c=Math.cos(yaw),s=Math.sin(yaw);
  return [c*sx,0,-s*sx,0,0,sy,0,0,s*sz,0,c*sz,0,x,y,z,1];
};
const plank=(swatch,size,pos,yaw=0)=>[swatch,unitBox,size,pos,yaw];
const shaped=(swatch,geo,pos=[0,0,0],yaw=0)=>[swatch,geo,[1,1,1],pos,yaw];

function packed(parts){
  const groups=new Map();
  for(const [swatch,geo,[sx,sy,sz],[x,y,z],yaw] of parts){
    const transformed=applyMatrix4(geo,turn(sx,sy,sz,x,y,z,yaw));
    if(!groups.has(swatch))groups.set(swatch,[]);
    groups.get(swatch).push(transformed);
  }
  return [...groups].map(([swatch,meshes])=>[swatch,wrap(mergeGeometries(meshes))]);
}
function mount(engine,surfaces,parent=null){
  return surfaces.map(([swatch,geo])=>engine.createMesh(parent).setGeometry(geo).setMaterial(swatch));
}
const pipe=(r,h,n=20)=>cylinderGeometry(r,r,h,n,1);
const taper=(above,below,h)=>cylinderGeometry(above,below,h,24,1);

function terrace(parts){
  const p=palette,{halfWidth:w,halfDepth:d,gap}=board;
  function slab(swatch,size,pos,yaw){parts.push(plank(swatch,size,pos,yaw));}
  slab(p.base,[12.20,.21,8.06],[0,-.94,0]);
  slab(p.ledge,[12.02,.09,7.92],[0,-.788,0]);
  slab(p.base,[11.93,.08,7.83],[0,-.72,0]);
  slab(p.rim,[11.78,.045,7.70],[0,-.665,0]);
  slab(p.channel,[11.63,.075,7.53],[0,-.610,0]);
  slab(p.water,[1.37,.028,7.40],[0,-.452,0]);
  for(const side of [-1,1]){
    const x=side*(w+gap)*.5,deck=side<0?p.deck:p.deckEast,seam=side<0?p.joints:p.eastJoints;
    slab(p.deckEdge,[w-gap,.53,d*2],[x,-.298,0]);
    slab(side<0?p.sand:p.tunnel,[w-gap+.054,.082,d*2+.054],[x,-.176,0]);
    slab(deck,[w-gap,.068,d*2],[x,-.034,0]);
    slab(p.ledge,[.15,.145,d*2-.06],[side*(gap-.05),-.23,0]);
    slab(p.rim,[.07,.049,d*2-.08],[side*(gap-.024),-.153,0]);
    for(const z of [-2.115,-1.365,-.615,.135,.885,1.635,2.385,3.135]){
      slab(seam,[w-gap-.075,.006,.016],[x,.004,z]);
    }
    for(const xx of [side*1.40,side*2.36,side*3.31,side*4.27,side*5.21]){
      for(let i=0;i<5;i++){
        const z=-2.60+1.425*i+(Math.abs(i%2)*.018);
        slab(seam,[.014,.006,1.36],[xx,.004,z]);
      }
    }
    slab(p.rim,[.064,.023,d*2-.06],[side*(w-.02),.011,0]);
    slab(p.rim,[w-gap-.025,.022,.066],[x,.011,d-.023]);
    for(let j=0;j<17;j++)slab(p.grate,[.105,.025,.17],[side*.49,-.377,-3.44+j*.412]);
    for(const sx of [side*5.72,side*.68]){
      for(const z of [-2.92,-1.5,0,1.5,2.92])
        slab(p.rail,[.022,.039,.105],[sx,-.17,z]);
    }
    for(let j=0;j<3;j++){
      const z=-1.96+j*1.52;
      const x=.11+.09*(j-1);
      slab(p.waterGlint,[.58,.003,.015],[x,-.433,z],.095);
      slab(p.waterGlint,[.34,.003,.012],[x-.16,-.431,z+.28],-.03);
    }
  }
  const [a,b]=board.bridge,z=(a+b)/2;
  slab(p.base,[1.64,.17,b-a],[0,-.112,z]);
  slab(p.rail,[1.68,.042,b-a-.07],[0,-.040,z]);
  slab(p.asphalt,[1.69,.021,b-a-.016],[0,-.010,z]);
  for(const xx of [-.63,-.34,0,.34,.63])slab(p.rim,[.022,.018,b-a-.088],[xx,.012,z]);
  for(const edge of [a+.02,b-.03]){
    slab(p.rail,[1.77,.043,.055],[0,.055,edge]);
    for(const xx of [-.76,0,.76])slab(p.rail,[.044,.29,.047],[xx,.159,edge]);
    slab(p.cream,[1.76,.047,.043],[0,.318,edge]);
  }
  for(const link of launchLinks){
    const z=link.start[2];
    for(const side of [-1,1]){
      const x=side*.957;
      slab(p.asphalt,[.60,.013,.61],[x,.007,z]);
      for(const d of [-1,1])slab(p.marker,[.54,.018,.037],[x,.017,z+d*.284]);
      for(let i=0;i<2;i++){
        const q=x+(i-.5)*.177*link.direction;
        slab(p.rail,[.174,.019,.043],[q,.026,z-.057],link.direction*.74);
        slab(p.rail,[.174,.019,.043],[q,.026,z+.057],-link.direction*.74);
      }
    }
  }

  for(const side of [-1,1]){
    const x=side*4.88,z=-3.96,locker=side<0?p.tunnel:p.channel;
    slab(p.ledge,[1.28,.15,.58],[x,-.085,z+.06]);
    slab(p.rim,[1.30,.031,.57],[x,.004,z+.06]);
    slab(p.base,[1.05,.08,.41],[x,.056,z]);
    slab(locker,[.94,.204,.37],[x,.202,z]);
    slab(p.rail,[.98,.025,.402],[x,.317,z]);
    slab(p.cream,[.77,.017,.34],[x,.338,z]);
    for(let i=0;i<6;i++)slab(p.steel,[.039,.081,.015],[x-.33+i*.126,.225,z+.192]);
    for(const dx of [-.40,.40]){
      slab(p.rim,[.065,.083,.432],[x+dx,.106,z]);
      slab(p.marker,[.028,.023,.019],[x+dx,.275,z+.195]);
    }
  }
}

function planters(parts){
  const p=palette;
  const grassBlade=new Geometry(
    [0,0,0,.046,0,0,.017,.50,.025, .046,0,0,.054,.25,.013,.017,.50,.025],
    [0,0,1,0,0,1,0,0,1,0,0,1,0,0,1,0,0,1],
    [0,1,2,3,4,5]);
  const verts=grassBlade.vertices;
  const positions=[],normals=[];
  for(let i=0;i<verts.length;i+=6){
    positions.push(verts[i],verts[i+1],verts[i+2]);
    normals.push(verts[i+3],verts[i+4],verts[i+5]);
  }
  const blade={positions,normals,uvs:new Float32Array(12),indices:grassBlade.indices};
  for(const {x,z,width,depth} of gardens){
    parts.push(plank(p.ledge,[width,.16,depth],[x,.084,z]));
    parts.push(plank(p.cream,[width+.03,.070,depth+.03],[x,.179,z]));
    parts.push(plank(p.gravel,[width-.10,.024,depth-.09],[x,.224,z]));
    for(const side of [-1,1]){
      parts.push(plank(p.rail,[.045,.047,depth-.035],[x+side*width*.48,.237,z]));
      parts.push(plank(p.rail,[width-.045,.047,.045],[x,.237,z+side*depth*.478]));
    }
    for(let j=0;j<40;j++){
      const cx=x+((j*29%41)/41-.5)*.53,cz=z+((j*17%43)/43-.5)*1.48;
      const h=.40+.79*((j*7%17)/17);
      parts.push([j%3===0?p.fern:p.grass,blade,[1.2,h,.93],[cx,.240,cz],j*2.39996]);
    }
  }
}

function makeCart(){
  const p=palette;
  const body=taper(.225,.209,.097);
  const common=[
    shaped(p.black,taper(.194,.194,.082),[0,.054,0]),
    shaped(p.steel,taper(.206,.195,.035),[0,.168,0]),
    plank(p.black,[.108,.033,.067],[0,.186,.143]),
    plank(p.ceramic,[.074,.013,.009],[0,.197,.178]),
    plank(p.ruby,[.115,.018,.011],[0,.114,-.216]),
    plank(p.rail,[.020,.027,.171],[-.102,.247,-.029]),
    plank(p.rail,[.020,.027,.171],[.102,.247,-.029]),
  ];
  const all={};
  for(const color of ['gold','ink','teal']){
    const casing=color==='gold'?p.gold:color==='teal'?p.ceramic:p.shell;
    const lid=color==='gold'?p.marker:p.cream;
    all[color]=packed([...common,shaped(p[color],body,[0,.105,0]),
      plank(casing,[.207,.114,.159],[0,.232,-.029]),
      plank(lid,[.212,.016,.160],[0,.295,-.029]),
    ]);
  }
  return all;
}

export function buildArt(engine,cartData){
  engine.scene.background='#172b31';
  engine.lighting.direction.set([-3,6,4,3.1]);
  engine.lighting.radiance.set([1,.93,.79,.62]);
  engine.lighting.ambient.set([.78,.95,1.06]);
  const pieces=[];
  terrace(pieces);
  mount(engine,packed(pieces));
  const green=[];
  planters(green);
  const beds=engine.createMesh();
  mount(engine,packed(green),beds);

  const cartMeshes=makeCart();
  const carts=cartData.map(({color})=>{
    const group=engine.createMesh().setScale([.86,.86,.86]);
    mount(engine,cartMeshes[color],group);
    return group;
  });

  const beacon=engine.createMesh();
  const brass=palette.marker;
  const pin=[
    shaped(palette.black,pipe(.28,.030),[0,.018,0]),
    shaped(palette.gold,torusGeometry(.29,.028,8,36),[0,.056,0]),
    shaped(palette.gold,taper(.037,.059,.40),[0,.221,0]),
    shaped(palette.cream,taper(.115,.076,.085),[0,.429,0]),
    shaped(brass,pipe(.125,.043),[0,.477,0]),
  ];
  mount(engine,packed(pin),beacon);
  return {carts,beacon,beds};
}
