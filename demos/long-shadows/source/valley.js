
import {Geometry,PbrMaterial,box} from '@margoengine/core';

export const bounds={x:-2350,z:-4800,width:4700,length:5400};
const tau=2*Math.PI;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const bell=(x,c,size)=>Math.exp(-(((x-c)/size)**2));
const mix=(a,b,t)=>a+(b-a)*t;
const ridge=(x,z,cx,cz,dx,dz,height,phase)=>{
  const across=(x-cx)+.24*(z-cz),depth=(z-cz)-.13*(x-cx);
  const cutoff=Math.abs(across/dx)**1.29+Math.abs(depth/dz)**1.48;
  const spurs=1+.07*Math.sin(across*.016+depth*.005+phase)+.04*Math.sin(across*.031-depth*.017);
  return height*Math.exp(-cutoff)*spurs;
};
const peaks=[[-1060,-975,310,510,680,3],[-1290,-1500,420,540,905,1],
  [730,-1470,330,540,770,5],[1100,-1990,430,620,1190,2],[-650,-2340,390,560,1050,4],
  [205,-2970,390,650,1280,0],[-1090,-3320,520,620,1350,3],[1100,-3890,500,770,1480,1],
  [-2090,-2400,560,780,950,4],[1980,-2750,480,990,910,2]];
function valleyCentre(z){return 115*Math.sin(z*.00155)+26*Math.sin(z*.006);}
export function ground(x,z){
  const bed=9+2.7*Math.sin(z*.0053)-3.6*bell(x,valleyCentre(z),55);
  const h=peaks.reduce((sum,p)=>sum+ridge(x,z,...p),0);
  const rugged=5*Math.sin(x*.054+z*.023)*Math.sin(z*.042-x*.017)+10*Math.sin(x*.009+z*.014)*Math.cos(z*.022)+12*Math.cos(x*.012-z*.015)*Math.cos(x*.021+z*.009);
  const pad=bell(x,0,42)*bell(z,27,108);
  const river=bell(x,valleyCentre(z),20);
  const value=bed+Math.max(0,h+clamp(h/118,0,1)*rugged);
  return mix(value,8.05+1.3*Math.sin(z*.0035),river*.92*(1-pad))*(1-pad)+8.2*pad;
}
export function horizonField(){
  const columns=84,rows=96,heights=new Float32Array(columns*rows);
  for(let row=0;row<rows;row++)for(let col=0;col<columns;col++){
    heights[row*columns+col]=ground(bounds.x+col*bounds.width/(columns-1),bounds.z+row*bounds.length/(rows-1));
  }
  return {cols:columns,rows,heights};
}
const paint=(color,roughness=.91,metalness=0)=>new PbrMaterial({color,roughness,metalness});
const water=paint('#337481',.27,.18),stone=paint('#817c68'),cement=paint('#ac9c79'),
  mortar=paint("#796e5b"), iron=paint("#52453a"), rail=paint('#55595a',.29,.82),sleepers=paint('#51463c'),gravel=paint('#837c68'),
  ochre=paint('#a5633a',.62),steel=paint('#30484f',.43,.45),trainRed=paint('#a73d31',.40),
  trainGlass=paint('#334b57',.30,.18),cream=paint('#ded2aa',.62),pine=paint('#334e47');


function terrain(){
  const columns=134,rows=142,positions=[],normals=[],indices=[];
  for(let row=0;row<=rows;row++)for(let col=0;col<=columns;col++){
    const u=2*(col/columns)-1,v=row/rows,w=2*v-1;
    const x=(Math.sign(u)*Math.abs(u)**1.24)*bounds.width*.5;
    const z=bounds.z+bounds.length*(.5+Math.sign(w)*Math.abs(w)**1.12*.5);
    const y=ground(x,z),step=4;
    const nx=ground(x-step,z)-ground(x+step,z),nz=ground(x,z-step)-ground(x,z+step),length=Math.hypot(nx,2*step,nz);
    positions.push(x,y,z);normals.push(nx/length,2*step/length,nz/length);
    if(row&&col){
      const d=row*(columns+1)+col,c=d-1,b=d-columns-1,a=b-1;
      indices.push(a,c,b,b,c,d);
    }
  }
  return {positions:Float32Array.from(positions),normals:Float32Array.from(normals),indices:Uint32Array.from(indices)};
}
const surfaces={water,stone,cement,rail,sleepers,gravel,ochre,steel,trainRed,mortar,iron,trainGlass,cream,pine};
function group(){
  const byMaterial=new Map();
  function append(mat,g,x,y,z,rotation=0){
    if(!byMaterial.has(mat))byMaterial.set(mat,{positions:[],normals:[],indices:[]});
    const batch=byMaterial.get(mat),first=batch.positions.length/3,data=g.vertices;
    const c=Math.cos(rotation),s=Math.sin(rotation);
    for(let i=0;i<data.length;i+=6){
      batch.positions.push(x+c*data[i]+s*data[i+2],y+data[i+1],z+c*data[i+2]-s*data[i]);
      batch.normals.push(c*data[i+3]+s*data[i+5],data[i+4],c*data[i+5]-s*data[i+3]);
    }
    for(const index of g.indices)batch.indices.push(first+index);
  }
  return {append,block(mat,sizes,at,rotation){append(mat,box(...sizes),...at,rotation);},
    bake(castMaterials=[]){
      return [...byMaterial].map(([mat,b])=>({name:Object.keys(surfaces).find(key=>surfaces[key]===mat),cast:castMaterials.includes(mat),
        positions:Float32Array.from(b.positions),normals:Float32Array.from(b.normals),indices:Uint32Array.from(b.indices)}));
    }};
}
function arch(span,base,rise,width){
  const p=[],n=[],indices=[],segments=28;
  const front=-width/2,back=width/2,top=base+rise+4.4;
  function quad(a,b,c,d,normal){
    const first=p.length/3;p.push(...a,...b,...c,...d);
    for(let i=0;i<4;i++)n.push(...normal);
    indices.push(first,first+1,first+2,first,first+2,first+3);
  }
  const half=span/2;
  for(let i=0;i<segments;i++){
    const ax=half*(2*i/segments-1),bx=half*(2*(i+1)/segments-1);
    const ay=base+rise*Math.sqrt(Math.max(0,1-(ax/half)**2)),by=base+rise*Math.sqrt(Math.max(0,1-(bx/half)**2));
    quad([ax,ay,front],[bx,by,front],[bx,top,front],[ax,top,front],[0,0,-1]);
    quad([ax,top,back],[bx,top,back],[bx,by,back],[ax,ay,back],[0,0,1]);
    const d=Math.hypot(bx-ax,by-ay);
    quad([ax,ay,back],[bx,by,back],[bx,by,front],[ax,ay,front],[(by-ay)/d,-(bx-ax)/d,0]);
  }
  return new Geometry(p,n,indices);
}
function pineShape(){
  const p=[],n=[],ix=[],levels=[[0,.23],[1.3,.17],[1.95,.94],[2.21,.23],[3.1,.72],[3.35,.14],[3.92,.47],[5.03,0]];
  for(let i=0;i<levels.length;i++){
    const [y,r]=levels[i];
    for(let j=0;j<=7;j++){
      const t=j*tau/7,c=Math.cos(t),s=Math.sin(t);
      p.push(r*c,y,r*s);n.push(c,.24,s);
      if(i&&j){
        const k=i*8+j;ix.push(k-9,k-1,k,k-9,k,k-8);
      }
    }
  }
  return new Geometry(p,n,ix);
}
export function preparePass(){
  const props=[];
  const shore=group();
  for(let j=0;j<56;j++){
    const z=40-j*12,x=valleyCentre(z)+12;
    if(z>-100)continue;
    const y=ground(x,z)+.20;
    const next=valleyCentre(z-12)+12;
    shore.block(water,[12.2,.08,12.8],[x,y,z],Math.atan2(x-next,12));
  }
  props.push(...shore.bake());
  const yard=group(),add=(...parts)=>yard.block(...parts);
  add(gravel,[20,.45,122],[0,8.84,10]);
  add(cement,[7.5,.40,60],[-5.8,9.17,19]);
  add(stone,[.57,1.3,58],[-9.20,8.82,18]);
  add(cream,[.11,.025,56],[-2.2,9.40,19]);
  for(const dx of [-.73,.73])add(rail,[.073,.13,116],[dx,9.25,10]);
  for(let j=0;j<142;j++){
    const z=61-j*.72;
    add(sleepers,[2.45,.14,.22],[0,9.118,z]);
  }
  for(let j=0;j<20;j++){
    const z=40-j*2.86, height=1.18;
    add(steel,[.075,height,.075],[-9.05,9.34+height*.5,z]);
    add(steel,[.05,.045,2.83],[-9.05,10.43,z-1.41]);
    add(steel,[.036,.038,2.83],[-9.05,9.98,z-1.41]);
  }
  for(let i=0;i<4;i++){
    const z=13-i*8.1;
    add(steel,[.15,4.4,.15],[3.3,11.25,z]);
    add(rail,[3.8,.11,.12],[1.47,13.32,z]);
    add(ochre,[.31,.38,1.31],[3.26,11.22,z]);
    add(steel,[.05,.05,8.2],[.43,13.26,z-4.06]);
  }
  add(ochre,[3.5,.20,8.6],[-6.0,12.30,22]);
  for(let i=0;i<21;i++)add(iron,[3.61,.045,.062],[-6,12.414,17.85+i*.41]);
  add(iron,[.12,.16,8.7],[-7.76,12.31,22]);
  add(cream,[.13,.16,8.67],[-4.24,12.31,22]);
  for(let i=0;i<27;i++)add(mortar,[7.42,.009,.018],[-5.8,9.374,47.2-i*2.1]);
  for(const x of [-7.60,-4.33])for(const z of [18,26])add(steel,[.12,2.9,.12],[x,10.84,z]);
  add(stone,[2.30,.21,.55],[-6.69,9.88,23.5]);
  props.push(...yard.bake([steel,ochre,rail]));
  // The lower masonry crossing is modelled with curved soffits and independent pier footings.
  const span=group(),deckZ=-575,pierBase=16,bridgeLevel=47;
  for(let i=-4;i<=4;i++){
    const x=43+i*26;
    span.block(stone,[4.4,30,7.4],[x-13,pierBase,deckZ]);
    span.append(cement,arch(26,23,19,6.2),x,0,deckZ);
    span.block(stone,[4.7,.31,7.7],[x-13,20.6,deckZ]);
  }
  span.block(stone,[240,2.8,7.2],[43,bridgeLevel+.7,deckZ]);
  for(const z of [-578.52,-571.48])span.block(cement,[240,.71,.24],[43,bridgeLevel+2.17,z]);
  for(const z of [-575.73,-574.27])span.block(rail,[240,.11,.11],[43,bridgeLevel+2.24,z]);
  props.push(...span.bake([stone,cement]));
  const train=group();
  for(let car=0;car<3;car++){
    const x=7.6+car*17.35;
    train.block(trainRed,[16.7,2.82,2.62],[x,50.75,deckZ]);
    train.block(cream,[15.2,.20,2.78],[x,52.2,deckZ]);
    train.block(steel,[16.6,.46,2.43],[x,49.35,deckZ]);
    for(const side of [-1,1])for(let window=-3;window<=3;window++){
      train.block(trainGlass,[1.52,.87,.039],[x+window*2.02,51.20,deckZ+side*1.316]);
    }
    for(const side of [-1,1])train.block(cream,[16.65,.1,.05],[x,50.46,deckZ+side*1.321]);
  }
  props.push(...train.bake([trainRed,cream]));
  const trees=group(),tree=pineShape();
  for(let i=0;i<180;i++){
    const ux=Math.sin(i*83.187+2)*43758.55,uz=Math.sin(i*12.929+5)*28411.33;
    const x=(ux-Math.floor(ux)-.5)*1250,z=-80-(uz-Math.floor(uz))*930;
    const y=ground(x,z);
    if(y<19||y>270||Math.abs(z-deckZ)<8)continue;
    trees.append(pine,tree,x,y,z,ux*.03);
  }
  props.push(...trees.bake());
  return {terrain:terrain(),field:horizonField(),props};
}

export function installProps(engine,props){
  const casters=[];
  for(const {name,cast,positions,normals,indices} of props){
    const mesh=engine.createMesh().setGeometry(new Geometry(positions,normals,indices)).setMaterial(surfaces[name]);
    if(cast)casters.push(mesh);
  }
  return casters;
}
