import { Geometry,PbrMaterial,box } from '@margoengine/core';
import { cylinderGeometry,sphereGeometry } from '@margoengine/geometry';
import { deck,ramp,specimens } from './layout.js';
import { shadows } from './shadows.js';

const paint=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const metals={
  teal:paint('#357774',.35),oxide:paint('#91482f',.39),pewter:paint('#a6b1b6',.31),
  brass:paint('#b29159',.36),bronze:paint('#aa7657',.37),
};
const trim=paint('#8b7758',.39),black=paint('#333b40',.47),steel=paint('#868c87',.48);
const board=paint('#626e6b',.72), slate=paint('#414f53',.62), ground=paint('#25363c',.87);
const dial=paint('#e1ba75',.29),signal=paint('#f8bb74',.40);
const wrap=g=>new Geometry(g.positions,g.normals,g.indices);
const cyl=(r,h,segments=44)=>wrap(cylinderGeometry(r,r,h,segments,1));
const ball=(r,segments=36,rings=18)=>wrap(sphereGeometry(r,segments,rings));

function bevel(size,amount){
  const [x,y,z]=size.map(v=>v/2),positions=[],normals=[],indices=[];
  const ring=(yy,inset)=>{
    const w=x-inset,d=z-inset,r=amount*.71;
    return [[-w+r,yy,-d],[w-r,yy,-d],[w,yy,-d+r],[w,yy,d-r],
      [w-r,yy,d],[-w+r,yy,d],[-w,yy,d-r],[-w,yy,-d+r]];
  };
  const rings=[ring(-y,amount),ring(-y+amount,0),ring(y-amount,0),ring(y,amount)];
  function face(points){
    const [a,b,c]=points,u=b.map((v,i)=>v-a[i]),v=c.map((w,i)=>w-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    if(n.reduce((sum,k,i)=>sum+k*a[i],0)<0){points=points.slice().reverse();for(let i=0;i<3;i++)n[i]=-n[i];}
    const length=Math.hypot(...n),offset=positions.length/3;
    for(const p of points){positions.push(...p);normals.push(n[0]/length,n[1]/length,n[2]/length);}
    for(let i=1;i<points.length-1;i++)indices.push(offset,offset+i,offset+i+1);
  }
  for(let r=1;r<rings.length;r++)for(let i=0;i<8;i++){
    const j=(i+1)%8;
    face([rings[r-1][i],rings[r-1][j],rings[r][j],rings[r][i]]);
  }
  face(rings[0]);face(rings.at(-1));
  return new Geometry(positions,normals,indices);
}

export function furnish(engine){
  const add=(geometry,mat,position=[0,0,0],parent=null)=>engine.createMesh().setGeometry(geometry)
    .setMaterial(mat).setPosition(position).setParent(parent);
  add(box(50,.10,50),ground,[0,-.225,0]);
  add(bevel([2.42,.136,2.21],.026),black,[0,-.105,0]).name='Enameled balance bed';
  add(bevel([2.45,.016,2.24],.004),trim,[0,-.11,0]);
  add(bevel(deck.size,.009),slate,deck.position).name='Landing bed';
  const wedge=add(bevel(ramp.size,.005),board,ramp.position).setRotation([ramp.angle,0,0]);
  wedge.name='Inclined landing plate';
  for(let x=-10;x<=10;x++){
    add(box(x%5===0?.009:.004,.003,.055),x%5===0?dial:trim,[x*.096,.035,.545],wedge);
  }
  for(const x of [-.995,0,.995])add(box(x===0?.011:.019,.002,1.070),trim,[x,.0339,-.014],wedge);
  const bolt=cyl(.016,.013,24);
  for(const x of [-1.075,1.075])for(const z of [-.55,.465]){
    add(bolt,black,[x,.037,z],wedge);
    add(box(.018,.0016,.0033),steel,[x,.044,z],wedge);
  }
  const foot=cyl(.081,.07,36);
  for(const x of [-1,1])for(const z of [-.91,.91])add(foot,black,[x,-.139,z]);
  for(const x of [-.58,.55]){
    add(bevel([.33,.006,.085],.002),black,[x,.004,.86]);
    add(box(.266,.002,.005),dial,[x,.008,.86]);
  }
  const shadeNodes=[add(null,paint('#303e42',.71)),add(null,paint('#4a5a56',.76))];
  const roots=[];
  const markers=[];
  for(const item of specimens){
    const root=add(null,black,item.position).setQuaternion(item.rotation);
    root.name=item.label+' compound root';
    roots.push(root);
    for(const part of item.parts){
      let geometry;
      if(part.shape==='box')geometry=bevel(part.halfExtents.map(v=>v*2),.0065);
      if(part.shape==='cylinder')geometry=cyl(part.radius,part.halfHeight*2);
      if(part.shape==='sphere')geometry=ball(part.radius);
      const mesh=add(geometry,metals[part.finish],part.offset,root);
      mesh.name=item.label+' · '+part.name;
      if(part.rotation)mesh.setQuaternion(part.rotation);
      if(part.shape==='cylinder'){
        for(const sign of [-1,1]){
          add(cyl(part.radius+.0008,.0026),steel,[0,sign*(part.halfHeight-.005),0],mesh);
          add(cyl(part.radius*.72,.003),black,[0,sign*(part.halfHeight+.0003),0],mesh);
        }
      }
    }
    const center=add(ball(.010),signal,[0,0,0],root);
    const arm=.063;
    const bars=[[arm,.0028,.0028],[.0028,arm,.0028],[.0028,.0028,arm]].map(size=>
      add(box(...size),dial,[0,0,0],center));
    markers.push({center,bars});
  }
  function mark(index,measurements){
    for(let i=0;i<markers.length;i++){
      const {center,bars}=markers[i];
      center.setPosition(measurements[i].center);
      center.visible=i===index;
      for(const bar of bars)bar.visible=i===index;
    }
  }
  function shade(bodies,alpha){
    const geometry=shadows(bodies,alpha);
    for(let i=0;i<geometry.length;i++)shadeNodes[i].setGeometry(geometry[i]);
  }
  return {roots,mark,shade};
}
