import { Geometry, PbrMaterial, box } from '@margoengine/core';
import exhibit from './exhibit.json';

const unit=box(1,1,1);
const mat=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const wall=mat('#273c40',.89), caseBack=mat('#263034',.64), iron=mat('#3e4751',.47,1);
const bronze=mat('#9e6e49',.36,1), copper=mat('#bb9472',.29,1), smoked=mat('#695447',.57);
const wax=mat('#d8bd8c',.55), lampGlass=mat('#e9cf97',.22), screw=mat('#8f886f',.21,1);
const lettering=mat('#42363e',.56);

function ring(inner,outer,y){
  function points({width,height,z}){
    const x=width/2, h=height/2;
    return [[-x,y-h,z],[x,y-h,z],[x,y+h,z],[-x,y+h,z]];
  }
  const positions=[],normals=[],indices=[];
  const outside=points(outer),inside=points(inner);
  for(let i=0;i<4;i++){
    const j=(i+1)%4,a=outside[i],b=outside[j],c=inside[j],d=inside[i];
    const [ux,uy,uz]=b.map((v,k)=>v-a[k]),[vx,vy,vz]=d.map((v,k)=>v-a[k]);
    const n=[uy*vz-uz*vy,uz*vx-ux*vz,ux*vy-uy*vx],length=Math.hypot(...n);
    const index=positions.length/3;
    for(const p of [a,b,c,d]){positions.push(...p);normals.push(...n.map(v=>v/length));}
    indices.push(index,index+1,index+2,index,index+2,index+3);
  }
  return new Geometry(positions,normals,indices);
}

function disk(radius,depth){
  const positions=[],normals=[],indices=[],segments=20;
  for(let i=0;i<segments;i++){
    const a=2*Math.PI*i/segments,b=2*Math.PI*(i+1)/segments;
    const n=(a+b)*.5,c=Math.cos(n),s=Math.sin(n);
    const k=positions.length/3, x=Math.cos(a)*radius,y=Math.sin(a)*radius;
    const j=Math.cos(b)*radius,l=Math.sin(b)*radius;
    positions.push(x,y,0,j,l,0,j,l,-depth,x,y,-depth,0,0,0,x,y,0,j,l,0);
    for(let z=0;z<4;z++)normals.push(c,s,0);
    normals.push(0,0,1,0,0,1,0,0,1);
    indices.push(k,k+3,k+2,k,k+2,k+1,k+4,k+5,k+6);
  }
  return new Geometry(positions,normals,indices);
}

export function buildCase(engine){
  const scene=engine.createScene('case');
  const {width,height,centerY,light}=exhibit;
  scene.lighting.direction.set([-.67,.73,.71,3.02]);
  scene.lighting.radiance.set([1,.81,.66,.48]);
  scene.lighting.ambient.set([.80,.99,1]);
  scene.background='#243236';
  function part(name,geom,m,position=[0,0,0],scale=[1,1,1],rotation=[0,0,0]){
    const mesh=scene.createMesh();
    mesh.name=name;
    return mesh.setGeometry(geom).setMaterial(m).setPosition(position).setScale(scale).setRotation(rotation);
  }
  const block=(name,m,x,y,z,w,h,d,rot=[0,0,0])=>part(name,unit,m,[x,y,z],[w,h,d],rot);
  block('Deep green plaster mounting wall',wall,0,.2,-.295,8,5,.20);
  block('Bracket backing',caseBack,0,centerY-.02,-.105,2.06,1.28,.116);
  block('Cartridge back plate',smoked,0,centerY,-.050,1.84,1.124,.070);
  const edges=[
    [{width:2.10,height:1.355,z:-.035},{width:2.07,height:1.324,z:.041},iron],
    [{width:2.07,height:1.324,z:.041},{width:2.013,height:1.268,z:.060},bronze],
    [{width:2.013,height:1.268,z:.060},{width:1.915,height:1.179,z:.060},smoked],
    [{width:1.915,height:1.179,z:.060},{width:1.875,height:1.137,z:.071},copper],
    [{width:1.875,height:1.137,z:.071},{width:width+.005,height:height+.005,z:-.001},iron],
  ];
  for(const [outside,inside,m] of edges)part('Mitred machined housing',ring(inside,outside,centerY),m);
  const bolt=disk(.015,.006);
  for(const x of [-.974,.974])for(const y of [-.502,.699]){
    part('Brass retaining screw',bolt,screw,[x,y,.072]);
    block('Screw slot',lettering,x,y,.072,.020,.0045,.001,[0,0,x<0?.31:-.27]);
  }

  const [lampX,lampY,lampZ]=light;
  block('Upper cantilever foot',caseBack,lampX-.08,.789,-.11,.161,.098,.135);
  block('Waxed bronze light support',bronze,lampX-.085,.840,.172,.036,.039,.56,[.155,0,0]);
  part('Lamp arm pivot',disk(.046,.020),copper,[lampX-.085,.854,.405],[1,1,1],[.1,0,0]);
  block('Cowl rear trim',bronze,lampX,lampY+.020,lampZ-.049,.35,.070,.073,[.31,0,-.028]);
  block('Cowl shade',iron,lampX,lampY+.043,lampZ-.038,.38,.026,.142,[.31,0,-.028]);
  block('Glazed warm strip',lampGlass,lampX,lampY,lampZ,.31,.020,.053,[.31,0,-.028]);

  block('Caption plate support',iron,.415,-.602,-.064,.765,.129,.106);
  block('Warm patinated nameplate',wax,.415,-.602,.003,.707,.074,.025);
  const rivet=disk(.010,.013);
  for(const x of [.092,.737])part('Caption plate rivet',rivet,bronze,[x,-.602,.022]);
  const stamp=[
    '1111011110111001111',
    '0100001100100101000',
    '0100001100100101110',
    '0100001100100101000',
    '0100011110111001111',
  ];
  for(let row=0;row<stamp.length;row++)for(let col=0;col<stamp[row].length;col++){
    if(stamp[row][col]==='1')block('Etched TIDE nameplate',lettering,.329+col*.0092,-.585-row*.008,.017,.0094,.0082,.0007);
  }
  block('Polished tray shelf',caseBack,-.61,-.572,-.041,.69,.046,.188);
  block('Tray metal lip',bronze,-.61,-.557,.056,.706,.010,.018);
  return scene;
}
