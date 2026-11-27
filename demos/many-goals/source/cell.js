import { Geometry,PbrMaterial,box } from '@margoengine/core';
import { contacts,links,weights } from './fixture.mjs';

function spindle(profile,segments=40) {
  const p=[],n=[],ix=[];
  for (let k=0; k<profile.length-1; k++) {
    const [r0,z0]=profile[k], [r1,z1]=profile[k+1];
    const dr=r1-r0,dz=z1-z0,length=Math.hypot(dr,dz);
    const base=p.length/3;
    for(let j=0;j<=segments;j++){
      const angle=j*Math.PI*2/segments,x=Math.cos(angle),y=Math.sin(angle);
      p.push(r0*x,r0*y,z0,r1*x,r1*y,z1);
      n.push(dz*x/length,dz*y/length,-dr/length,dz*x/length,dz*y/length,-dr/length);
      if(j<segments) {
        const a=base+j*2;
        ix.push(a,a+2,a+1,a+2,a+3,a+1);
      }
    }
  }
  return new Geometry(p,n,ix);
}

function beveledPrism(outline,depth,bevel) {
  const rings=[[-depth*.5,1-bevel],[-depth*.5+.015,1],[depth*.5-.015,1],[depth*.5,1-bevel]];
  const cx=outline.reduce((v,p)=>v+p[0],0)/outline.length;
  const cy=outline.reduce((v,p)=>v+p[1],0)/outline.length;
  const points=rings.map(([z,s])=>outline.map(([x,y])=>[cx+(x-cx)*s,cy+(y-cy)*s,z]));
  const pos=[],normal=[],indices=[];
  function triangle(a,b,c) {
    const u=b.map((v,i)=>v-a[i]),v=c.map((x,i)=>x-a[i]);
    const q=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    const length=Math.hypot(...q), n=q.map(value=>value/length), index=pos.length/3;
    pos.push(...a,...b,...c);
    normal.push(...n,...n,...n);
    indices.push(index,index+1,index+2);
  }
  for(let k=0;k<points.length-1;k++) {
    for(let j=0;j<outline.length;j++){
      const next=(j+1)%outline.length;
      const current=points[k], upper=points[k+1];
      triangle(current[j],current[next],upper[j]);
      triangle(upper[j],current[next],upper[next]);
    }
  }
  const back=points[0], front=points.at(-1);
  for(let j=1;j<outline.length-1;j++){
    triangle(back[0],back[j+1],back[j]);
    triangle(front[0],front[j],front[j+1]);
  }
  return new Geometry(pos,normal,indices);
}

const cylinder=(radius,depth,sides)=>{
  const edge=Math.min(depth*.25,radius*.15);
  return spindle([[0,-depth/2],[radius-edge,-depth/2],[radius,-depth/2+edge],
    [radius,depth/2-edge],[radius-edge,depth/2],[0,depth/2]],sides);
};
const ring=(inside,outside,depth)=>spindle([[inside,-depth/2],[outside,-depth/2],
  [outside,depth/2],[inside,depth/2],[inside,-depth/2]],48);

function ticks() {
  const p=[],n=[],ix=[];
  for(let i=0;i<69;i++){
    const x=-1.69+i*.051,w=i%5===0?.0033:.0016,length=i%5===0?.061:.024,id=p.length/3;
    p.push(x,.324,.61,x+w,.324,.61,x+w,.324,.61-length,x,.324,.61-length);
    n.push(0,1,0,0,1,0,0,1,0,0,1,0);
    ix.push(id,id+1,id+2,id,id+2,id+3);
  }
  return new Geometry(p,n,ix);
}

export function makeCell(engine) {
  engine.scene.background='#3b3039';
  engine.lighting.direction.set([-.51,.73,.45,3.15]);
  engine.lighting.radiance.set([1,.90,.82,1.02]);
  engine.lighting.ambient.set([.80,.83,.98]);
  const material=(color,roughness=.64)=>new PbrMaterial({color,roughness});
  const deck=material('#484559',.88);
  const backing=material('#493442',.93);
  const rail=material('#564d63',.74);
  const pin=material('#8d8394',.42);
  const ink=material('#443245',.74);
  const enamel=material('#e2ceba',.46);
  const dark=material('#4e3e52',.50);
  const burgundy=material('#7c4b68',.53);
  const marks=material('#b9a49e',.82);
  const emphasis=material('#ead8b5',.52);
  const put=(geo,mat,position,name,parent)=>{
    const mesh=engine.createMesh(parent??null).setGeometry(geo).setMaterial(mat).setPosition(position);
    mesh.name=name;
    return mesh;
  };
  const block=(size,mat,position,name,parent)=>put(box(...size),mat,position,name,parent);
  const panelWidth=3.7;
  const plinth=beveledPrism([[-1.85,.09],[1.85,.09],[1.85,.30],[-1.85,.30]],1.31,.045);
  put(plinth,deck,[.02,0,.02],'Metrology bench');
  block([3.65,.028,1.28],rail,[.02,.306,.02],'Bench datum');
  block([3.65,1.97,.16],backing,[.02,1.26,-.70],'Inspection shield');
  block([3.66,.037,.045],rail,[.02,2.21,-.592],'Upper rail');
  block([3.66,.025,.050],rail,[.02,.56,-.602],'Lower rail');
  put(ticks(),marks,[0,0,0],'Table scale');
  for(let i=0;i<16;i++){
    const x=-1.76+i*(panelWidth-.16)/15;
    block([.008,1.64,.009],i%5===0?rail:backing,[x,1.36,-.611],'Backplate scribe '+i);
  }

  const mountain=cylinder(.27,.13);
  put(mountain,dark,[-1.40,.352,0],'Robot mounting flange').setRotation([Math.PI/2,0,0]);
  const riser=beveledPrism([[-.22,0],[.22,0],[.16,.16],[-.16,.16]],.29,.14);
  put(riser,burgundy,[-1.40,.373,0],'Shoulder mount');
  const jointSize=[.141,.117,.093,.080];
  const joints=links.map((span,i)=>{
    const node=engine.createMesh();
    node.name='Hinge '+(i+1);
    const width=jointSize[i]*.73;
    const beam=beveledPrism([[.027,-width],[span*.73,-width*.73],[span-.03,-width*.36],[span-.03,width*.39],
      [span*.71,width*.71],[.02,width]],i<2?.155:.132,.078);
    put(beam,dark,[0,0,0],'Link spar '+(i+1),node);
    const skin=beveledPrism([[.11,-width*.71],[span*.67,-width*.49],[span-.105,-width*.23],
      [span-.076,width*.18],[span*.61,width*.59],[.083,width*.63]],.06,.075);
    put(skin,enamel,[0,0,.066],'Ivory cover '+(i+1),node);
    const bearing=cylinder(jointSize[i],.17);
    put(bearing,burgundy,[0,0,0],'Bearing case '+(i+1),node);
    put(cylinder(jointSize[i]*.77,.032),pin,[0,0,.096],'Machined bearing face '+(i+1),node);
    put(ring(jointSize[i]*.56,jointSize[i]*.72,.004),dark,[0,0,.114],'Bearing seal '+(i+1),node);
    put(cylinder(jointSize[i]*.35,.02,12),dark,[0,0,.12],'Keyed cap '+(i+1),node);
    const screw=cylinder(.010,.008,12);
    for(let k=0;k<4;k++){
      const angle=k*Math.PI*.5+.35,r=jointSize[i]*.69;
      put(screw,ink,[r*Math.cos(angle),r*Math.sin(angle),.117],'Cap screw',node);
    }
    return node;
  });
  const caps=contacts.map(({color})=>material(color,.43));
  const anchors=[[1,.24,-.15],[2,.32,.115],[3,links[3],0]];
  for(const [i,[arm,x,y]] of anchors.entries()){
    const parent=joints[arm];
    if(y) block([.045,Math.abs(y),.076],dark,[x,y*.5,.091],'Probe bracket',parent);
    put(cylinder(.043,.09),dark,[x,y,.095],'Tool collar',parent);
    put(cylinder(.024,.018),caps[i],[x,y,.134],'Contact tip '+(i+1),parent);
  }

  const targetOuter=ring(.044,.059,.014);
  const priorityOuter=ring(.073,.081,.008);
  const centerPin=cylinder(.014,.026,24);
  const targetSleeve=cylinder(.091,.046);
  const targets=contacts.map(({name},i)=>{
    const node=engine.createMesh();
    node.name='Goal carriage '+name;
    put(box(.143,.143,.087),ink,[0,0,-.255],'Fixture block',node);
    put(targetSleeve,dark,[0,0,-.192],'Bushing body',node);
    put(targetOuter,caps[i],[0,0,.016],'Goal reticle',node);
    put(centerPin,caps[i],[0,0,-.019],'Datum pip',node);
    const halo=put(priorityOuter,emphasis,[0,0,.018],'Highest-weight reticle',node);
    const dashes=Array.from({length:11},()=>put(box(.023,.010,.008),caps[i],[0,0,0],'Error dash'));
    return {node,halo,dashes};
  });
  const update=(poses,positions,choice)=>{
    for(const [i,node] of joints.entries()){
      const p=poses[i];
      node.setPosition(p.position).setRotation([0,0,2*Math.atan2(p.rotation[2],p.rotation[3])]);
    }
    for(const [i,fixture] of targets.entries()){
      const target=positions[i], actual=poses[contacts[i].frame].position;
      fixture.node.setPosition(target);
      fixture.halo.setScale(weights[choice][i]===28?[1,1,1]:[.001,.001,.001]);
      const dx=target[0]-actual[0],dy=target[1]-actual[1],length=Math.hypot(dx,dy);
      const count=Math.min(fixture.dashes.length,Math.floor(length/.037));
      for(const [k,beam] of fixture.dashes.entries()){
        const t=count?(k+.75)/(count+1):0;
        beam.setPosition([actual[0]+dx*t,actual[1]+dy*t,.169])
          .setRotation([0,0,Math.atan2(dy,dx)])
          .setScale(k<count?[1,1,1]:[.001,.001,.001]);
      }
    }
  };
  return {update};
}
