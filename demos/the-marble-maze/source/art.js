import { Geometry,PbrMaterial,box } from '@margoengine/core';
import { cylinderGeometry,sphereGeometry } from '@margoengine/geometry';
import { ballStart,deck,depth,goal,opening,pivot,radius,rails,start,tray,width } from './layout.js';

const paint=(color,roughness=.67,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const colors={
  ground:paint('#303f43',.86), ceramic:paint('#243f41',.33), rim:paint('#385653',.35),
  lacquer:paint('#67412c',.37), oil:paint('#9e6c43',.41), endgrain:paint('#6b422b',.63),
  strap:paint('#ba8454',.55), deck:paint('#cd9f64',.73), inset:paint('#9e7249'),
  dark:paint('#29302d',.58), brass:paint('#c69e5f',.31,.25), gold:paint('#f0ce91',.34,.14),
  teal:paint('#1a6e73',.24,.04), sea:paint('#45a5a5',.28), milk:paint('#c4d2b4',.34),
  shadow:paint('#a37852'), shadowEdge:paint('#b78b56'),
};
const shape=g=>new Geometry(g.positions,g.normals,g.indices);
const cyl=(a,b,h,n=40)=>shape(cylinderGeometry(a,b,h,n,1));

function bevel(size,amount){
  const [x,y,z]=size.map(v=>v/2),positions=[],normals=[],indices=[];
  function ring(yy,inset){
    const w=x-inset,d=z-inset,r=amount*.72;
    return [[-w+r,yy,-d],[w-r,yy,-d],[w,yy,-d+r],[w,yy,d-r],
      [w-r,yy,d],[-w+r,yy,d],[-w,yy,d-r],[-w,yy,-d+r]];
  }
  const rings=[ring(-y,amount),ring(-y+amount,0),ring(y-amount,0),ring(y,amount)];
  function face(points){
    const [a,b,c]=points,u=b.map((v,i)=>v-a[i]),v=c.map((w,i)=>w-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    if(n.reduce((sum,k,i)=>sum+k*a[i],0)<0){points=points.slice().reverse();for(let i=0;i<3;i++)n[i]=-n[i];}
    const length=Math.hypot(...n),offset=positions.length/3;
    for(const p of points){positions.push(...p);normals.push(...n.map(value=>value/length));}
    for(let i=1;i<points.length-1;i++)indices.push(offset,offset+i,offset+i+1);
  }
  for(let r=1;r<rings.length;r++)for(let i=0;i<8;i++){
    const j=(i+1)%8;
    face([rings[r-1][i],rings[r-1][j],rings[r][j],rings[r][i]]);
  }
  face(rings[0]);face(rings.at(-1));
  return new Geometry(positions,normals,indices);
}

function woodGrain(offset,size,phase,density){
  const [x,y,z]=offset,[w,h,d]=size;
  const positions=[],normals=[],indices=[];
  const edge=y+h/2+.00018,rowCount=Math.max(1,Math.floor(d*density));
  for(let stripe=0;stripe<rowCount;stripe++){
    const band=z+(stripe+.5)*d/rowCount-d/2;
    const seed=phase+stripe*7.113;
    const length=w*(.33+.65*(.5+.5*Math.sin(seed*22.23)));
    const left=x-w/2+(w-length)*(.51+.49*Math.sin(seed*9.13));
    const sectionCount=18,offset=positions.length/3;
    for(let j=0;j<=sectionCount;j++){
      const walk=j/sectionCount,xx=left+length*walk;
      const wave=Math.sin(xx*9.21+seed)*.17+Math.sin(xx*22.4+seed)*.23;
      const zz=band+wave*d/rowCount;
      const strand=(.00018+.00065*Math.abs(Math.sin(seed*103.7)))*Math.sin(Math.PI*walk);
      positions.push(xx,edge,zz-strand,xx,edge,zz+strand);
      normals.push(0,1,0,0,1,0);
      const k=offset+j*2;
      if(j<sectionCount)indices.push(k,k+1,k+2,k+1,k+3,k+2);
    }
  }
  return new Geometry(positions,normals,indices);
}

function marbleInlay(phase,width){
  const positions=[],normals=[],indices=[];
  for(let i=0;i<=104;i++){
    const arc=i/104*Math.PI*2,z=.25*Math.sin(arc*2+phase)+.18*Math.cos(arc*3);
    for(const sign of [-1,1]){
      const y=z+sign*(width+.018*Math.cos(arc*3+phase));
      const level=Math.sqrt(1-y*y);
      const n=[level*Math.cos(arc),y,level*Math.sin(arc)];
      positions.push(...n.map(v=>v*(radius+.00028)));
      normals.push(...n);
    }
    const k=i*2;
    if(i<104)indices.push(k,k+1,k+2,k+1,k+3,k+2);
  }
  return new Geometry(positions,normals,indices);
}

function shadowBand(outer,inner){
  const positions=[],normals=[],indices=[];
  for(let i=0;i<=80;i++){
    const arc=i/80*Math.PI*2;
    for(const r of [outer,inner]){
      positions.push(r*Math.cos(arc),0,r*.825*Math.sin(arc));
      normals.push(0,1,0);
    }
    const k=i*2;
    if(i<80)indices.push(k,k+1,k+2,k+1,k+3,k+2);
  }
  return new Geometry(positions,normals,indices);
}

export function furnish(engine){
  const mesh=(geo,mat,position=[0,0,0],parent=null)=>engine.createMesh()
    .setGeometry(geo).setMaterial(mat).setPosition(position).setParent(parent);
  const slab=(size,chamfer,mat,pos,parent)=>mesh(bevel(size,chamfer),mat,pos,parent);
  const boxAt=(size,mat,pos,parent)=>mesh(box(...size),mat,pos,parent);
  const ringMaterial=paint('#385450',.74);
  boxAt([100,.1,100],colors.ground,[0,-.21,0]);

  for(let i=0;i<13;i++){
    const fraction=i/12,r=.79-fraction*.23;
    const smooth=fraction*fraction*(3-2*fraction);
    const value=[48,63,67].map((channel,j)=>Math.round(channel-smooth*[20,24,24][j]).toString(16).padStart(2,'0'));
    mesh(shadowBand(r,i===12?0:r-.23/12),paint('#'+value.join(''),.86),[.069,-.158,-.050]);
  }
  slab([1.119,.098,.939],.022,colors.ceramic,[0,-.10,0]);
  slab([1.099,.014,.919],.004,colors.rim,[0,-.053,0]);
  for(const [i,part] of tray.entries()){
    boxAt(part.size,i===0?colors.dark:colors.ceramic,part.offset);
  }
  mesh(cyl(.043,.096,.150),colors.ceramic,[0,.0675,0]);
  mesh(cyl(.079,.071,.013),colors.brass,[0,.019,0]);
  slab([.232,.008,.052],.002,colors.brass,[0,-.037,.458]);
  for(let i=0;i<9;i++){
    boxAt([.002,.002,.024-.0025*Math.abs(i-4)],colors.dark,[(i-4)*.013,-.031,.459]);
  }

  const board=mesh(null,colors.deck,pivot);
  board.name='Lacquered tilting maze and through-aperture';
  const grain=['#c39964','#c79b67','#ba8d59'].map(color=>paint(color,.81));
  for(const [index,strip] of deck.entries()){
    boxAt(strip.size,colors.deck,strip.offset,board);
    for(let layer=0;layer<grain.length;layer++){
      mesh(woodGrain(strip.offset,strip.size,index*19.7+layer*3.17,34),grain[layer],[0,layer*.000025,0],board);
    }
  }
  for(const rail of rails){
    const {size,offset:p,transverse,outer}=rail;
    slab(size,outer?.004:.0029,outer?colors.lacquer:colors.oil,p,board);
    const x=transverse?size[0]-.020:.0028,z=transverse?.0028:size[2]-.020;
    boxAt([x,.0008,z],outer?colors.brass:colors.strap,[p[0],size[1]+.00035,p[2]],board);
    const strip=transverse?[size[0]-.008,.0009,.006]:[.006,.0009,size[2]-.008];
    if(!outer)for(const direction of [-1,1]){
      const sx=p[0]+(transverse?0:direction*.0102);
      const sz=p[2]+(transverse?direction*.0102:0);
      boxAt(strip,colors.inset,[sx,.00039,sz],board);
    }
  }
  for(const sign of [-1,1]){
    slab([width+.076,.052,.034],.007,colors.lacquer,[0,-.001,sign*(depth/2+.019)],board);
    slab([.034,.052,depth+.025],.007,colors.lacquer,[sign*(width/2+.019),-.001,0],board);
    for(const y of [-.002,.012]){
      boxAt([width+.057,.0019,.035],colors.strap,[0,y,sign*(depth/2+.018)],board);
      boxAt([.035,.0019,depth+.025],colors.strap,[sign*(width/2+.018),y,0],board);
    }
  }
  const pin=cyl(.0082,.0082,.0036,26);
  for(const x of [-width/2+.018,width/2-.018])for(const z of [-depth/2,depth/2]){
    mesh(pin,colors.gold,[x,.074,z],board);
    boxAt([.008,.0008,.0016],colors.endgrain,[x,.0762,z],board).setRotation([0,.35,0]);
  }

  const hx=opening/2+ .0038;
  for(const sign of [-1,1]){
    slab([opening+.014,.006,.007],.0015,colors.brass,[goal[0],.0032,goal[1]+sign*hx],board);
    slab([.007,.006,opening+.005],.0015,colors.brass,[goal[0]+sign*hx,.0032,goal[1]],board);
    boxAt([opening,.013,.003],colors.endgrain,[goal[0],-.010,goal[1]+sign*(hx-.002)],board);
    boxAt([.003,.013,opening],colors.endgrain,[goal[0]+sign*(hx-.002),-.010,goal[1]],board);
  }
  const [sx,sz]=start;
  mesh(cyl(.044,.044,.0005,4),ringMaterial,[sx,.00055,sz],board);
  mesh(cyl(.038,.038,.0005,4),colors.gold,[sx,.00084,sz],board);
  mesh(cyl(.034,.034,.0005,4),colors.deck,[sx,.00118,sz],board);
  const shadowNodes=[
    mesh(cyl(.035,.035,.00035,36),colors.shadowEdge,[sx,.00074,sz],board).setScale([1.15,1,.84]),
    mesh(cyl(.028,.028,.00035,36),colors.shadow,[sx,.00092,sz],board).setScale([1.12,1,.82]),
  ];
  const marble=mesh(shape(sphereGeometry(radius,40,24)),colors.teal,ballStart);
  marble.name='Spinning glass marble';
  mesh(marbleInlay(.27,.051),colors.sea,[0,0,0],marble);
  mesh(marbleInlay(1.55,.021),colors.milk,[0,0,0],marble);
  function shade([x,y,z]){
    const a=x+.009,b=z-.008;
    const over=Math.abs(a-goal[0])<hx+.034&&Math.abs(b-goal[1])<hx+.034;
    for(const [i,node] of shadowNodes.entries()){
      node.setPosition([a,over||y<=0?-.21:.00137+i*.00023,b]);
    }
  }
  shade([sx,radius,sz]);
  return {board,marble,shade};
}
