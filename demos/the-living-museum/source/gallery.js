import { box, Geometry, PbrMaterial } from '@margoengine/core';

export const rooms={minX:-7.4,maxX:7.4,minZ:-5.8,maxZ:6.1};
export const displays=[
  {x:-4.12,z:-1.35,w:2.66,d:2.15,height:1.2},
  {x: .36,z:-2.11,w:3.16,d:2.17,height:2.3},
  {x: 4.60,z:-1.05,w:2.40,d:2.20,height:1.3},
];
export const partitions=[
  {x: .05,z:1.12,w:3.25,d:.23,height:2.45},
  {x:5.66,z:2.96,w:.23,d:2.75,height:2.45},
  {x:-6.75,z:2.16,w:.29,d:2.50,height:2.45},
];
export const blocked=[...displays,...partitions];

const pbr=(color,roughness=.70,metalness=0)=>new PbrMaterial({color,roughness,metalness});
function piece(engine,geometry,material,position,rotation) {
  const mesh=engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(position);
  if(rotation)mesh.setRotation(rotation);
  return mesh;
}
function shape(sections,sides,sample) {
  const pos=[], normals=[], idx=[];
  for(let j=0;j<=sections;j++)for(let i=0;i<=sides;i++){
    const {p,n}=sample(j/sections,i/sides);
    pos.push(...p);
    normals.push(...n);
    if(j&&i){
      const a=j*(sides+1)+i, b=a-sides-1;
      idx.push(a,b,b-1,a,b-1,a-1);
    }
  }
  return new Geometry(pos,normals,idx);
}
const tau=2*Math.PI;
function orbit(major,tube){
  return shape(59,16,(i,j)=>{
    const a=tau*i,b=tau*j;
    const x=Math.cos(a),y=Math.sin(a),c=Math.cos(b),s=Math.sin(b);
    return {p:[x*(major+tube*c),y*(major+tube*c),tube*s],n:[x*c,y*c,s]};
  });
}
function stratum(r,h, phase=0) {
  return shape(24,12,(i,j)=>{
    const az=tau*i,y=Math.cos(Math.PI*j),mid=Math.sin(Math.PI*j);
    const rad=r*(1+.13*Math.sin(az*5+phase)*mid+.08*Math.cos(az*9)) * mid;
    const x=Math.cos(az),z=Math.sin(az);
    return {p:[x*rad,y*h,z*rad],n:[x*mid,y,z*mid]};
  });
}

export function buildGallery(engine){
  const plaster=pbr('#505c63'), basalt=pbr('#353f53',.74), grout=pbr('#343d45'), oak=pbr('#947a52',.60), bronze=pbr('#b67d47',.29,.75);
  const brass=pbr('#b6a36d',.34,.8), linen=pbr('#b3a495',.85), grail=pbr('#c3b097',.42);
  const floor=box(15.2,.17,12.5);
  piece(engine,floor,grout,[0,-.089,.15]);
  const floorSlabs=['#586366','#526064','#647175','#5c6b6d','#4d5b5c'].map(v=>pbr(v,.58));
  const tile=box(1.183,.024,1.183);
  for(let z=0;z<10;z++)for(let x=0;x<12;x++){
    piece(engine,tile,floorSlabs[(x*19+z*17+x*z)%floorSlabs.length],[(x-5.5)*1.20,-.015,(z-4.5)*1.20+.13]);
  }
  piece(engine,box(15.2,3.1,.25),plaster,[0,1.55,-5.98]);
  piece(engine,box(.24,3.1,12.35),plaster,[-7.50,1.55,.17]);
  for(const wall of partitions){
    piece(engine,box(wall.w,wall.height,wall.d),basalt,[wall.x,wall.height/2,wall.z]);
    piece(engine,box(wall.w+.02,.075,wall.d+.02),oak,[wall.x,wall.height-.037,wall.z]);
  }

  const wallDado=box(14.8,.075,.045);
  for(const y of [.12,2.6])piece(engine,wallDado,oak,[0,y,-5.82]);
  for(const x of [-5.8,-2.9,0,2.9,5.8]){
    piece(engine,box(.14,2.6,.055),pbr('#43545b'),[x,1.34,-5.82]);
    piece(engine,box(1.84,.66,.04),linen,[x,2.1,-5.80]);
    piece(engine,box(1.73,.55,.046),pbr('#4e554e'),[x,2.1,-5.76]);
    for(let slat=0;slat<9;slat++){
      const height=.13+.28*Math.sin((slat+2)*1.37)**2;
      piece(engine,box(.073,height,.018),brass,[x-0.68+slat*.17,2.03,-5.725]);
    }
  }
  for(const display of displays){
    piece(engine,box(display.w,.19,display.d),basalt,[display.x,.095,display.z]);
    piece(engine,box(display.w*.89,.76,display.d*.89),plaster,[display.x,.55,display.z]);
    piece(engine,box(display.w*.93,.06,display.d*.93),oak,[display.x,.96,display.z]);
    piece(engine,box(.37,.022,.20),brass,[display.x-.60,.995,display.z+.68],[0,.05,0]);
  }
  const rings=[{major:.810,tube:.087,turn:[.21,.17,-.27],m:bronze},{major:.62,tube:.045,turn:[.64,-.35,.61],m:brass},
    {major:.44,tube:.067,turn:[-.27,.51,.25],m:bronze}];
  for(const item of rings)piece(engine,orbit(item.major,item.tube),item.m,[.36,1.89,-2.11],item.turn);
  for(let i=0;i<11;i++){
    const phase=i*.68, y=.985+i*.085;
    piece(engine,stratum(.58-i*.021,.10,phase),i%3===1?grail:linen,
      [-4.12+Math.cos(phase)*.18,y,-1.35+Math.sin(phase)*.15],[.08*Math.sin(phase),.13*i,.07*i]);
  }
  const crystals=[[-.28,.15,.52,.14],[-.13,-.25,.67,.12],[.04,.12,.92,.15],[.24,-.10,.58,.13],[.39,.18,.44,.12]];
  const mineral=pbr('#5da1a4',.28,.26);
  for(const [x,z,height,r] of crystals)
    piece(engine,stratum(r,height*.6,x*3),mineral,[4.60+x,1+height*.42,-1.05+z],[x*.61,0,z*.7]);

  // Brass tactile route strip in the floor and a short, visible rail around the rear sculpture.
  const studs=box(.055,.012,.15);
  for(let i=0;i<31;i++)piece(engine,studs,brass,[-6.7+i*.442,.004,4.96]);
  for(const x of [-2.22,2.37]){
    piece(engine,box(.075,.87,.075),brass,[x,.43,-4.18]);
    piece(engine,box(.09,.02,.12),bronze,[x,.026,-4.18]);
  }
  piece(engine,box(4.61,.034,.033),bronze,[.075,.865,-4.18]);
}

export const lighting=[
  ...displays.map(({x,z},i)=>({position:[x,3.76,z+.58],direction:[0,-.98,-.16],innerAngle:.29,outerAngle:.67,
    color:i===2?[.61,.82,1]:[1,.81,.50],range:5.8,intensity:33})),
  ...[-6,-3,0,3,6].map(x=>({position:[x,3.03,-5.29],direction:[0,-.76,-.65],innerAngle:.18,outerAngle:.62,color:[.99,.74,.40],range:4,intensity:12})),
  {position:[-.5,3.66,4.7],range:10,color:[.63,.75,1],intensity:23},
  {position:[4.78,3.21,4.88],range:7,color:[.53,.76,1],intensity:16},
  {position:[-5,3.19,4.32],range:7,color:[1,.78,.58],intensity:14},
];
