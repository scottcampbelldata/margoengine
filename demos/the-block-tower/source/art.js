import { Geometry,PbrMaterial,box } from '@margoengine/core';
import { baseHeight,beamSize,deckSize } from './layout.js';
import { projectShadows } from './shadows.js';

function chamfer([width,height,depth],b){
  const w=width/2,h=height/2,d=depth/2;
  const rings=[[-h,b],[-h+b,0],[h-b,0],[h,b]].map(([y,inset])=>{
    const x=w-inset,z=d-inset,r=b*.76;
    return [[-x+r,y,-z],[x-r,y,-z],[x,y,-z+r],[x,y,z-r],
      [x-r,y,z],[-x+r,y,z],[-x,y,z-r],[-x,y,-z+r]];
  });
  const vertices=[],normals=[],indices=[];
  function face(points){
    const [a,b,c]=points;
    const u=b.map((n,i)=>n-a[i]),v=c.map((n,i)=>n-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    if(n.reduce((sum,p,i)=>sum+p*a[i],0)<0){
      points=points.slice().reverse();
      for(let i=0;i<3;i++)n[i]=-n[i];
    }
    const length=Math.hypot(...n),start=vertices.length/3;
    for(const point of points){vertices.push(...point);normals.push(...n.map(value=>value/length));}
    for(let i=1;i+1<points.length;i++)indices.push(start,start+i,start+i+1);
  }
  for(let k=1;k<rings.length;k++)for(let i=0;i<8;i++){
    const j=(i+1)%8;
    face([rings[k-1][i],rings[k-1][j],rings[k][j],rings[k][i]]);
  }
  face(rings[0]);face(rings.at(-1));
  return new Geometry(vertices,normals,indices);
}

const material=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const beamMaterial=['#9e6246','#ad7150','#9d5e40','#a87957','#a56b46'].map(color=>material(color,.43));
const cap=material('#66432f',.56);
const lamination=material('#b48360',.53);
const picked=material('#c8a55a',.34);
const selectedBody=material('#c19253',.40);
const silver=material('#b1b6a5',.38,1);
const deckMat=[material('#343d39',.43),material('#57605a',.54)];
const rail=material('#b58a4e',.35,1);
const khaki=material('#575649',.55);
const base=material('#313a34',.39);
const top=material('#5e5f4f',.63);
const foundation=material('#434c47',.72);
const engraving=material('#a1a08c',.54);

function grainLayers(){
  const vertices=[],normals=[],indices=[];
  const x=beamSize[0]/2-.005;
  for(const face of [-1,1])for(const y of [-.018,-.010,.015]){
    const start=vertices.length/3,z=face*(beamSize[2]/2+.00004);
    vertices.push(-x,y,z,x,y+.0003,z,x,y+.00075,z,-x,y+.00052,z);
    for(let i=0;i<4;i++)normals.push(0,0,face);
    for(const i of (face>0?[0,1,2,0,2,3]:[0,2,1,0,3,2]))indices.push(start+i);
  }
  return new Geometry(vertices,normals,indices);
}

export function furnish(engine,entities){
  const add=(geometry,surface,position=[0,0,0],parent=null)=>engine.createMesh().setGeometry(geometry)
    .setMaterial(surface).setPosition(position).setParent(parent);
  const floor=add(box(6,.05,6),foundation,[0,-.104,0]);
  floor.name='Gallery floor';
  const plinth=add(chamfer([.87,.087,.64],.012),base,[0,-.034,0]);
  const bearer=add(chamfer([.84,.031,.613],.007),khaki,[0,.011,0]);
  add(chamfer([.815,.018,.585],.004),top,[0,baseHeight-.009,0]);
  plinth.name='Lacquered base';
  bearer.name='Brass-edged end grain';
  const shadowNodes=[add(null,material('#4a4b40',.63)),add(null,material('#353b36',.72))];
  const edge=box(.774,.002,.0024),side=box(.0024,.002,.545);
  for(const z of [-.272,.272])add(edge,rail,[0,.04,z]);
  for(const x of [-.386,.386])add(side,rail,[x,.04,0]);
  const tick=box(.0016,.001,.008);
  for(let index=-17;index<=17;index++){
    const item=add(tick,engraving,[index*.021,.041,.244]);
    if(index%5===0)item.setScale([1.35,1,1.55]);
  }
  const foot=chamfer([.047,.02,.039],.004);
  for(const x of [-.356,.356])for(const z of [-.239,.239])add(foot,base,[x,-.082,z]);
  const beamGeo=chamfer(beamSize,.0042);
  const grain=grainLayers();
  const capGeo=chamfer([.0016,.041,.025],.0006);
  const inlayGeo=box(.0018,.0024,.017);
  const deckGeo=chamfer(deckSize,.0027);
  const barGeo=box(deckSize[0]-.014,.0013,.002);
  const crossGeo=box(.002,.0013,deckSize[2]-.012);
  const nodes=entities.map(entity=>{
    const deck=entity.slot===null;
    const finish=deck?deckMat[entity.course%2]:beamMaterial[(entity.course*4+entity.slot+6)%beamMaterial.length];
    const object=add(deck?deckGeo:beamGeo,finish,entity.center);
    object.name=deck?'Course '+(entity.course+1)+' diaphragm':'Course '+entity.id+' timber';
    const ends=[];
    if(deck){
      for(const z of [-.106,.106])add(barGeo,rail,[0,deckSize[1]/2+.0002,z],object);
      for(const x of [-.106,.106])add(crossGeo,rail,[x,deckSize[1]/2+.0002,0],object);
    }else for(const sign of [-1,1]){
      const x=sign*(beamSize[0]/2+.0002);
      const end=add(capGeo,cap,[x,0,0],object);
      ends.push(end);
      for(const y of [-.007,.007])add(inlayGeo,silver,[x+sign*.0007,y,0],object);
    }
    if(!deck)add(grain,lamination,[0,0,0],object);
    return {entity,object,ends,finish};
  });
  let marked;
  function mark(entity){
    if(marked){
      marked.object.setMaterial(marked.finish);
      for(const end of marked.ends)end.setMaterial(cap);
    }
    marked=nodes.find(node=>node.entity===entity);
    if(marked){
      marked.object.setMaterial(selectedBody);
      for(const end of marked.ends)end.setMaterial(picked);
    }
  }
  function sync(){
    for(const {entity,object} of nodes)object.setPosition(entity.body?.position??entity.center).setQuaternion(entity.body?.rotation??entity.rotation);
    const projected=projectShadows(nodes.map(item=>item.entity));
    for(let i=0;i<projected.length;i++)shadowNodes[i].setGeometry(projected[i]);
  }
  sync();
  return {mark,sync,swap(next){ for(let i=0;i<nodes.length;i++)nodes[i].entity=next[i]; }};
}
