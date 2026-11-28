import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {cellCenter,cellPolygon} from '@margoengine/tilemap/hex';
import {cells,extentX,extentZ,grid,sites,tileAt} from './model.js';

const palette={
  water:'#3897a6',trail:'#d8bc8c',grass:'#8fa271',forest:'#648d70',
  slate:'#95928b',highStone:'#b9b19d',snow:'#eee4cc',tree:'#407558',bark:'#695340',
  wake:'#79aeb0',shore:'#c2aa84',slat:'#b19d79',chalk:'#dce3cb',
  copper:'#ce7850',glass:'#4c9c88',gold:'#f2c87b',route:'#ffe592',ink:'#313f41',
  jacket:'#d77c4a',marker:'#faf1ce',ridge:'#7b817e',
};
const surface={w:'water',p:'trail',g:'grass',f:'forest',m:'slate',s:'highStone'};
const [cx,cz]=cellCenter(grid,0,0);
const hex=cellPolygon(grid,0,0).map(([x,z])=>[x-cx,z-cz]);
const square=[[-.5,-.5],[.5,-.5],[.5,.5],[-.5,.5]];
const decagon=Array.from({length:12},(_,n)=>{
  const angle=n*Math.PI/6;
  return [Math.sin(angle)*.5,-Math.cos(angle)*.5];
});

function geometry(){
  const positions=[],normals=[],indices=[];
  function triangle(a,b,c){
    const ab=b.map((value,k)=>value-a[k]),ac=c.map((value,k)=>value-a[k]);
    const cross=[ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]];
    const norm=Math.hypot(...cross);
    if(norm<1e-9)return;
    const start=positions.length/3;
    positions.push(...a,...b,...c);
    const normal=cross.map(x=>x/norm);
    for(let i=0;i<3;i++)normals.push(...normal);
    indices.push(start,start+1,start+2);
  }
  return {triangle,mesh:()=>new Geometry(positions,normals,indices)};
}
function profile(polygon,levels,{bottom=true,top=true}={}){
  const {triangle,mesh}=geometry();
  const rings=levels.map(([y,size,dx=0,dz=0])=>polygon.map(([x,z])=>[x*size+dx,y,z*size+dz]));
  const last=rings.at(-1),first=rings[0];
  for(let i=0;i<polygon.length;i++){
    const j=(i+1)%polygon.length;
    for(let h=1;h<rings.length;h++){
      const lo=rings[h-1],hi=rings[h];
      triangle(lo[i],hi[i],hi[j]);triangle(lo[i],hi[j],lo[j]);
    }
    if(bottom)triangle(first[0],first[i],first[j]);
    if(top)triangle(last[0],last[j],last[i]);
  }
  return mesh();
}
function fog(hexValue,stage){
  if(stage===2)return hexValue;
  const base=hexValue.slice(1).match(/../g).map(v=>Number.parseInt(v,16));
  const design=stage===1?[92,116,120]:[60,79,91];
  const keep=stage===1?.57:.13;
  return '#'+base.map((v,i)=>Math.round(v*keep+design[i]*(1-keep)).toString(16).padStart(2,'0')).join('');
}
function seeded(n){
  let x=Math.imul(n+311,0x45d9f3b);
  x=Math.imul(x^(x>>>16),0x45d9f3b);
  return ((x^(x>>>16))>>>0)/4294967296;
}

export function buildArt(engine){
  const cube=box(),slab=profile(hex,[[0,.944],[.1,1],[.85,1],[1,.907]]);
  const plank=profile(square,[[0,.969],[.065,1],[.91,1],[1,.959]]);
  const lowDisc=profile(decagon,[[0,.89],[.15,1],[.87,1],[1,.88]]);
  const pin=profile(decagon,[[0,.92],[.05,1],[.9,.81],[1,.78]]);
  const crown=profile(hex,[[0,.27],[.09,1],[.38,.66],[.46,.77],[1,.017]]);
  const cliff=profile(hex,[[0,.96],[.22,.82,.035],[.56,.62,-.045,.07],[1,.04,-.17,.15]]);
  const lowerCliff=profile(hex,[[0,.96],[.22,.82,.035],[.56,.62,-.045,.07]],{top:false});
  const summit=profile(hex,[[0,.62,-.045,.07],[.43,.37,-.09,.08],[1,.04,-.17,.15]],{bottom:false});
  const dome=profile(decagon,[[0,1],[.25,.95],[.58,.79],[.85,.50],[1,.05]]);
  const materials=new Map(),groups=new Map();
  const paint=(key,stage=2,rough=.69)=>{
    const id=key+'/'+stage+'/'+rough;
    let material=materials.get(id);
    if(!material){
      material=new PbrMaterial({color:fog(palette[key]??key,stage),roughness:rough,doubleSided:false});
      materials.set(id,material);
    }
    return material;
  };
  function add(name,shape,key,position,scale,tile,rough=.69){
    const stage=tile?0:2;
    const item=engine.createMesh().setGeometry(shape).setMaterial(paint(key,stage,rough));
    item.name=name;item.position.set(...position);item.scale.set(...scale);
    if(tile){
      let group=groups.get(tile.key);
      if(!group){group={stage,items:[]};groups.set(tile.key,group);}
      group.items.push({item,key,rough});
    }
    return item;
  }
  function frame(name,shape,key,x,y,z,sx,sy,sz,rough){
    return add(name,shape,key,[x,y,z],[sx,sy,sz],null,rough);
  }
  frame('Backdrop',cube,'#253b41',0,-.59,0,200,.1,200);
  frame('Survey tray · underside',plank,'#546366',0,-.52,0,extentX+.52,.21,extentZ+.56);
  frame('Survey tray · edged seam',plank,'#b08760',0,-.34,0,extentX+.65,.11,extentZ+.66);
  frame('Survey tray · interior',plank,'#404f50',0,-.23,0,extentX+.47,.17,extentZ+.49);
  for(const x of [-1,1])for(const z of [-1,1]){
    frame('Corner stud',lowDisc,'#bb9769',x*(extentX/2+.08),-.063,z*(extentZ/2+.09),.10,.025,.10);
  }
  for(let n=0;n<6;n++){
    const width=.29+n*.04;
    frame('Front edge inlay',cube,n%2?'#486164':'#648181',-extentX/2+1.9+n*1.44,-.263,(extentZ+.65)*.498,width,.008,.035);
  }
  for(let index=0;index<cells.length;index++){
    const tile=cells[index],{x,z,kind,elevation,coord}=tile;
    add('Hex '+tile.key,slab,surface[kind],[x,-.075,z],[.987,elevation+.075,.987],tile,kind==='w'?.34:.76);
    if(kind==='w'){
      for(let n=0;n<3;n++){
        const ripple=add('etched wave',plank,n%2?'wake':'water',
          [x+(seeded(index*4+n)-.5)*.37,elevation+.001,z+(n-1)*.134],[.16+.12*seeded(index*3+n),.004,.012],tile,.56);
        ripple.rotation.y=(seeded(index+n*31)-.5)*.24;
      }
    }
    if(kind==='g'||kind==='p'){
      const marks=kind==='g'?3:2;
      for(let n=0;n<marks;n++){
        const ox=(seeded(index+33*n)-.5)*.64,oz=(seeded(index+19*n+141)-.5)*.58;
        add('relief fleck',plank,kind==='p'?'shore':'forest',[x+ox,elevation+.002,z+oz],[.06,.005,.014],tile);
      }
    }
    if(kind==='f'){
      for(let n=0;n<4;n++){
        const angle=n*Math.PI*.5+seeded(index)*.91,dx=Math.cos(angle)*.25,dz=Math.sin(angle)*.27;
        const height=.20+.13*seeded(71*index+n);
        add('cedar bole',pin,'bark',[x+dx,elevation,z+dz],[.047,height*.47,.047],tile);
        const tree=add('cedar crown',crown,n===1?'forest':'tree',[x+dx,elevation+.035,z+dz],[.23,height,.23],tile);
        tree.rotation.y=n*.81;
      }
    }
    if(kind==='m'||kind==='s'){
      const turn=coord[0]*.2+coord[1]*1.23;
      const relief=(kind==='s'?.73:.46)+seeded(index)*.22;
      const capped=kind==='s'||seeded(index)>.53;
      add('talus',cliff,'ridge',[x-.205,elevation-.008,z+.14],[.49,relief*.54,.59],tile).rotation.y=turn+.63;
      add('folded ridge',capped?lowerCliff:cliff,'highStone',[x+.035,elevation-.012,z-.04],[.79,relief,.81],tile).rotation.y=turn;
      if(capped){
        add('summit plaster',summit,'snow',[x+.035,elevation-.012+relief*.56,z-.04],[.79,relief*.44,.81],tile).rotation.y=turn;
      }
    }
  }
  function monument(site,parts){
    const tile=tileAt(site.cell);
    const {x,z,elevation}=tile;
    for(const [name,shape,key,dx,y,dz,sx,sy,sz] of parts){
      add(name,shape,key,[x+dx,elevation+y,z+dz],[sx,sy,sz],tile);
    }
  }
  monument(sites.harbor,[
    ['Harbor pier',plank,'slat',-.23,.014,.09,.41,.064,.21],
    ['Harbor rail',cube,'ink',-.28,.092,.186,.32,.024,.022],
    ['Harbor rail',cube,'ink',-.28,.092,-.008,.32,.024,.022],
  ]);
  monument(sites.beacon,[
    ['Beacon stone base',lowDisc,'slat',0,.016,0,.42,.07,.42],
    ['Beacon tower',pin,'chalk',0,.08,0,.25,.35,.25],
    ['Beacon band',lowDisc,'copper',0,.217,0,.23,.045,.23],
    ['Beacon gallery',lowDisc,'ink',0,.403,0,.28,.042,.28],
    ['Beacon lens',lowDisc,'gold',0,.443,0,.157,.077,.157],
    ['Beacon cap',dome,'copper',0,.52,0,.249,.104,.249],
    ['Beacon finial',pin,'chalk',0,.616,0,.032,.061,.032],
  ]);
  monument(sites.summit,[
    ['Observatory plinth',plank,'slat',0,.017,0,.56,.075,.49],
    ['Observatory drums',pin,'chalk',0,.075,0,.43,.25,.43],
    ['Copper dome',dome,'glass',0,.30,0,.46,.225,.46],
    ['Telescope slot',plank,'ink',.02,.36,.168,.078,.098,.040],
    ['Entry porch',plank,'copper',0,.095,.225,.14,.118,.135],
  ]);
  for(const n of [0,1,2,3]){
    const tile=tileAt([1,7]),angle=n*Math.PI*.5;
    const needle=frame('Chart rose',plank,n?'#799595':'#d2ba83',tile.x+Math.sin(angle)*.14,.069,tile.z-Math.cos(angle)*.14,.017,.007,.37);
    needle.rotation.y=-angle;
  }
  const roverPad=frame('Survey marker · plinth',lowDisc,'ink',0,0,0,.39,.055,.39);
  const rover=frame('Survey marker · brass',pin,'jacket',0,0,0,.24,.15,.24,.38);
  const visor=frame('Survey marker · face',plank,'marker',0,0,0,.14,.072,.025,.37);
  const bead=frame('Survey marker · cap',dome,'gold',0,0,0,.237,.10,.236,.47);
  let overlays=[];
  return {
    fog(visible,history){
      for(const [key,group] of groups){
        const stage=visible.has(key)?2:history.has(key)?1:0;
        if(stage===group.stage)continue;
        group.stage=stage;
        for(const {item,key,rough} of group.items)item.material=paint(key,stage,rough);
      }
    },
    path(steps){
      for(const item of overlays)item.dispose();
      overlays=[];
      for(let i=1;i<steps.length;i++){
        const a=tileAt(steps[i-1]),b=tileAt(steps[i]);
        for(const t of [.33,.64]){
          const x=a.x+(b.x-a.x)*t,z=a.z+(b.z-a.z)*t;
          const y=Math.max(a.elevation,b.elevation)+.019;
          const mark=engine.createMesh().setGeometry(lowDisc).setMaterial(paint('route'));
          mark.name='Route inlay';mark.position.set(x,y,z);mark.scale.set(.105,.022,.105);
          overlays.push(mark);
        }
      }
      const target=steps.length>1&&tileAt(steps.at(-1));
      if(target){
        const mark=engine.createMesh().setGeometry(slab).setMaterial(paint('route'));
        mark.name='Destination';mark.position.set(target.x,target.elevation+.011,target.z);
        mark.scale.set(.25,.027,.25);overlays.push(mark);
      }
    },
    token(x,y,z){
      roverPad.position.set(x,y+.013,z);
      rover.position.set(x,y+.058,z);
      visor.position.set(x,y+.116,z+.106);
      bead.position.set(x,y+.188,z);
    },
  };
}
