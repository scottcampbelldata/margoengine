import { Geometry, PbrMaterial } from '@margoengine/core';
import { bridge, layout, length, pitch, platforms, risers, rise, sample, spiral, stair, terrace, tile } from './route.js';

const tau = 2*Math.PI;
const materials = {
  floor: palettes('#344145',.64), floorBands:palettes('#586360',.59),
  wall:palettes('#394c4e',.79), wallShade:palettes('#2d3a42',.80),
  column:palettes('#6d7971',.64), pale:palettes('#aab3a3',.74),
  dark:palettes('#232e35',.63), deck:palettes('#3d555b',.69),
  bevel:palettes('#455d61',.46), track:palettes('#5d7779',.47),
  brass:palettes('#bd9d68',.40,.78), copper:palettes('#a47850',.33,.72),
  stair:palettes('#81573e',.60), beam:palettes('#566f70',.45,.32),
  inset:palettes('#2a414c',.46), light:palettes('#b2b6a0',.46),
};
function palettes(color,roughness,metalness=0){return {color,roughness,metalness};}
const cross=(u,v)=>[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
const dot=(u,v)=>u.reduce((sum,a,i)=>sum+a*v[i],0);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const average=(a,b)=>a.map((v,i)=>(v+b[i])*.5);

class Form {
  pos=[];
  n=[];
  idx=[];

  face(vertices,aim) {
    const [a,b,c]=vertices;
    let normal=cross(sub(b,a),sub(c,a));
    const size=Math.hypot(...normal);
    if(size<1e-9)return;
    const flipped=dot(normal,aim)<0;
    normal=normal.map(v=>v/size*(flipped?-1:1));
    const start=this.pos.length/3;
    for(const vertex of vertices) {
      this.pos.push(...vertex);
      this.n.push(...normal);
    }
    for(let i=1;i<vertices.length-1;i++){
      this.idx.push(start,start+(flipped?i+1:i),start+(flipped?i:i+1));
    }
  }

  block(at,dim,bevel=0){
    const [x,y,z]=at, [sx,sy,sz]=dim;
    const r=Math.min(bevel,sx*.18,sy*.20,sz*.17);
    const b=r? r*.67:0;
    const cuts=r ? [[-sy/2,r],[-sy/2+r,0],[sy/2-r,0],[sy/2,r]] : [[-sy/2,0],[sy/2,0]];
    const rings=cuts.map(([h,s])=>{
      const a=sx/2-s,d=sz/2-s;
      const rim=b?[[-a+b,-d],[a-b,-d],[a,-d+b],[a,d-b],[a-b,d],[-a+b,d],[-a,d-b],[-a,-d+b]]
        :[[-a,-d],[a,-d],[a,d],[-a,d]];
      return rim.map(([u,v])=>[x+u,y+h,z+v]);
    });
    const k=rings[0].length;
    for(let i=1;i<rings.length;i++){
      for(let j=0;j<k;j++){
        const a=rings[i-1][j], b=rings[i-1][(j+1)%k];
        const m=average(a,b);
        this.face([a,b,rings[i][(j+1)%k],rings[i][j]],[m[0]-x,0,m[2]-z]);
      }
    }
    this.face(rings[0],[0,-1,0]);
    this.face(rings.at(-1),[0,1,0]);
  }

  rail(a,b,edge,sides=6) {
    const dir=sub(b,a);
    const length=Math.hypot(...dir);
    const n=dir.map(v=>v/length);
    const base=Math.abs(n[1])>.88?[1,0,0]:[0,1,0];
    const v=cross(base,n);
    const norm=Math.hypot(...v);
    const u=v.map(x=>x/norm);
    const w=cross(n,u);
    const rims=[a,b].map(p=>Array.from({length:sides},(_,i)=>{
      const angle=tau*i/sides;
      return p.map((x,k)=>x+edge*(Math.cos(angle)*u[k]+Math.sin(angle)*w[k]));
    }));
    for(let i=0;i<sides;i++) {
      const j=(i+1)%sides;
      const dir=sub(average(rims[0][i],rims[0][j]),a);
      this.face([rims[0][i],rims[0][j],rims[1][j],rims[1][i]],dir);
    }
    this.face(rims[0],n.map(v=>-v));
    this.face(rims[1],n);
  }

  annulus(x,y,z,inside,outside,start=0,stop=tau,segments=64){
    const radial=(angle,r)=>[x+Math.cos(angle)*r,y,z+Math.sin(angle)*r];
    for(let i=0;i<segments;i++){
      const a=start+(stop-start)*i/segments,b=start+(stop-start)*(i+1)/segments;
      this.face([radial(a,inside),radial(a,outside),radial(b,outside),radial(b,inside)],[0,1,0]);
    }
  }

  geometry(){return new Geometry(this.pos,this.n,this.idx);}
}

function gallery(f){
  f.floor.block([0,-.604,0],[37,.21,31],.03);
  for(let i=-5;i<=5;i++){
    const x=i*3.17;
    f.floorBands.block([x,-.496,0],[.025,.011,30],.002);
  }
  f.wall.block([0,3.89,-8.50],[28.7,8.84,.52],.076);
  f.wallShade.block([0,4.04,-8.17],[28.38,4.98,.117],.031);
  f.dark.block([0,3.20,-8.105],[28.56,.16,.09],.023);
  f.bevel.block([0,-.090,-8.08],[28.65,.18,.21],.025);
  f.light.block([0,7.21,-8.16],[28.72,.11,.11],.019);
  for(let i=-5;i<=5;i++) {
    const x=i*2.62;
    f.column.block([x,3.67,-7.96],[.45,8.31,.44],.066);
    f.pale.block([x,7.23,-7.79],[.54,.195,.49],.029);
    f.bevel.block([x,6.12,-7.765],[.085,1.88,.045],.008);
    f.brass.block([x,1.79,-7.716],[.068,1.29,.029],.004);
    if(i<5){
      f.dark.block([x+1.31,4.98,-8.104],[2.06,2.38,.045],.019);
      for(const dy of [-.86,0,.86]){
        f.beam.block([x+1.31,4.98+dy,-8.073],[1.94,.044,.05],.009);
      }
    }
  }
  for(const x of [-14.16,14.16]) {
    f.wall.block([x,3.805,.04],[.56,8.70,17.45],.067);
    f.wallShade.block([x-Math.sign(x)*.306,2.32,.14],[.072,3.69,17.22],.020);
    f.brass.block([x-Math.sign(x)*.35,-.16,0],[.021,.29,17.03],.005);
  }
  for(const x of [-12.8,12.8]){
    for(const z of [-5.8,-1.79,2.22,6.23]){
      f.pale.block([x,.01,z],[.72,.91,.68],.07);
      f.brass.block([x,.476,z],[.79,.075,.76],.022);
      f.dark.block([x,.752,z],[.21,.50,.21],.028);
      f.light.block([x,1.028,z],[.24,.053,.26],.010);
    }
  }
  // Back-wall display cases with bronze stand-offs and abstract machined exhibits.
  for(const sign of [-1,1]){
    const x=sign*10.7,z=-6.94;
    f.bevel.block([x,-.035,z],[1.88,.91,1.08],.083);
    f.pale.block([x,.427,z],[1.85,.09,1.07],.022);
    for(let i=0;i<7;i++){
      const q=x+(i-3)*.152;
      const h=.30+.52*(1-Math.abs(i-3)/5);
      f.brass.rail([q,.47,z],[q+.050,h+.47,z-.06],.063,8);
    }
  }
}

function podium(f){
  const center=1.18;
  f.dark.block([center,-.353,0],[18.84,.267,10.75],.14);
  f.brass.block([center,-.215,0],[18.76,.051,10.66],.019);
  f.bevel.block([center,-.135,0],[18.69,.110,10.58],.052);
  f.deck.block([center,-.052,0],[18.59,.102,10.49],.034);
  const rMin=4.18;
  f.inset.annulus(spiral.x,.001,spiral.z,.016,rMin,0,tau,128);
  f.brass.annulus(spiral.x,.004,spiral.z,rMin-.015,rMin+.006,0,tau,152);
  f.bevel.annulus(spiral.x,.003,spiral.z,.105,.458,0,tau,60);
  f.copper.annulus(spiral.x,.004,spiral.z,.408,.431,0,tau,60);
  for(let i=0;i<24;i++){
    const q=tau*i/24;
    f.brass.annulus(spiral.x,.004,spiral.z,i%3===0?4.108:4.14,4.167,q-.0019,q+.0019,1);
  }
  for(const {center,half,zone} of platforms().slice(1)){
    f[zone===2?'stair':'bevel'].block(center,half.map(v=>v*2),.004);
    if(zone===2){
      f.brass.block([center[0],center[1]+half[1]-.0007,center[2]-half[2]+.012],
        [1.88*half[0],.003,.019],.001);
    }
  }
  const d0=bridge.z0+.08,d1=bridge.z1-.05,n=10;
  for(const x of [bridge.x-.398,bridge.x+.398]){
    f.brass.rail([x,rise-.029,d0],[x,rise-.029,d1],.024);
    f.beam.rail([x,.039,d0],[x,.039,d1],.026);
    for(let i=0;i<n;i++){
      const a=d0+(d1-d0)*i/n, b=d0+(d1-d0)*(i+1)/n;
      const zig=i%2===0;
      f.beam.rail([x,zig?.041:rise-.049,a],[x,zig?rise-.049:.041,b],.020);
      f.brass.rail([x,.048,b],[x,rise-.040,b],.013);
    }
  }
  for(const z of [bridge.z0+.114,bridge.z1-.11]){
    f.dark.block([bridge.x,.060,z],[.83,.124,.17],.008);
    f.bevel.block([bridge.x,.146,z],[.81,.044,.21],.007);
  }
  const halfX=(terrace.x1-terrace.x0)/2,halfZ=(terrace.z1-terrace.z0)/2;
  const midX=(terrace.x0+terrace.x1)/2,midZ=(terrace.z0+terrace.z1)/2;
  f.dark.block([midX,.081,midZ],[2*halfX-.12,.163,2*halfZ-.12],.067);
  f.copper.block([midX,rise-.045,midZ],[2*halfX-.06,.039,2*halfZ-.06],.010);
  for(let j=0;j<49;j++){
    f.brass.block([-6.88+j*.33,-.073,5.252],[j%5===0?.034:.014,j%5===0?.058:.036,.009],.002);
  }
  f.brass.block([-3.85,-.126,5.258],[3.18,.016,.009],.002);
  f.inset.block([6.32,-.085,5.258],[2.37,.096,.029],.013);
  f.brass.block([6.32,-.131,5.28],[2.28,.012,.014],.002);
}

function course(f){
  const square=({x,y,z,yaw},side,high)=>[x+Math.cos(yaw)*side,y+high,z-Math.sin(yaw)*side];
  for(let i=0;i<layout.length;i+=3){
    const a=layout[i], b=layout[Math.min(layout.length-1,i+3)];
    if(a.y!==b.y||i===layout.length-1)continue;
    const h=.006,a0=square(a,-.050,h),a1=square(a,.050,h);
    const b0=square(b,-.050,h),b1=square(b,.050,h);
    f.track.face([a0,a1,b1,b0],[0,1,0]);
    const edges=[[-.063,-.060],[.060,.063]];
    for(const [u,v] of edges){
      f.beam.face([square(a,u,h+.001),square(a,v,h+.001),square(b,v,h+.001),square(b,u,h+.001)],[0,1,0]);
    }
  }
  const a=layout[layout.length-1];
  f.copper.annulus(a.x,a.y+.008,a.z,.075,.087,0,tau,32);
  const p=sample(0);
  f.copper.annulus(p.x,p.y+.009,p.z,.075,.082,0,tau,28);
}

const sequence=[
  '#dce0b9','#c7d5aa','#95baab','#72a6a8','#5090a5','#5684ab','#7b81aa',
  '#aa7d95','#bd927d','#d5a371','#dabc7e',
];
function choose(i,zone){
  if(i===0)return 11;
  if(zone===2)return 10;
  if(zone===3)return 0;
  if(zone===4)return (Math.floor(i/26)%3===0?2:1);
  if(zone===1)return 9;
  return Math.floor(i/112)%11;
}

export function buildGallery(engine,shadows) {
  const f=Object.fromEntries(Object.keys(materials).map(k=>[k,new Form()]));
  gallery(f);
  podium(f);
  course(f);
  const pieces=[];
  for(const [name,form] of Object.entries(f)){
    if(!form.idx.length)continue;
    const mesh=engine.createMesh().setGeometry(form.geometry()).setMaterial(new PbrMaterial(materials[name]));
    pieces.push(mesh);
    if(shadows && ['column','pale','dark','bevel','stair','beam'].includes(name))shadows.add(mesh,{static:true});
  }
  const shape=new Form();
  shape.block([0,0,0],[tile.width,tile.height,tile.thick],.0037);
  const geometry=shape.geometry();
  const coats=[...sequence,'#d08350'].map(color=>new PbrMaterial({color,roughness:.29,metalness:0}));
  const piecesOfCourse=[];
  function tileAt(index,position,rotation) {
    const mesh=engine.createMesh().setGeometry(geometry).setMaterial(coats[choose(index,layout[index].zone)])
      .setPosition(position).setQuaternion(rotation);
    piecesOfCourse.push(mesh);
    if(shadows)shadows.add(mesh);
    return mesh;
  }
  return {pieces,piecesOfCourse,tileAt,length,pitch};
}
