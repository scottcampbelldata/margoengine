import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {circleGeometry,cylinderGeometry} from '@margoengine/geometry';
import {trail,firstX,endX,radius,checkpoints,roadElevation} from './terrain.js';

const twoPi=Math.PI*2;
const scheme={
  far:'#6a7e9c',low:'#9b85a0',middle:'#ae8a93',near:'#8c675f',foothill:'#9c7167',
  ember:'#e7a580',slate:'#633f4d',clay:'#925851',terra:'#ae6b58',sand:'#be8268',
  cap:'#d7aa8b',line:'#f0c3a3',thin:'#a27061',shadow:'#5b434d',brush:'#8d8d75',plant:'#748475',
  bronze:'#b5b4a3',body:'#dd663b',hot:'#f29860',light:'#ffda92',rack:'#3a4750',
  frame:'#433a3e',tire:'#2c303a',lug:'#4b4c56',rim:'#b9c0bd',hub:'#ca754b',
  glass:'#7cabb7',deepGlass:'#425c71',accent:'#fbc89f',flag:'#e7bc7e',sun:'#f8c39b',
};
const boxUnit=box(1,1,1);
const conv=d=>new Geometry(d.positions,d.normals,d.indices);
const disk=conv(circleGeometry(1,48));
function strip(from,to,z){
  const positions=[],normals=[],indices=[];
  for(const [i,[x,top]] of from.entries()){
    positions.push(x,top,z,x,to[i],z);
    normals.push(0,0,1,0,0,1);
    const j=i*2;
    if(i+1<from.length)indices.push(j,j+1,j+2,j+1,j+3,j+2);
  }
  return new Geometry(positions,normals,indices);
}
function polygon(points,z){
  const coords=[],normals=[],indices=[];
  let sign=0;
  for(let i=0;i<points.length;i++){
    const a=points[i],b=points[(i+1)%points.length];
    sign+=a[0]*b[1]-a[1]*b[0];
    coords.push(a[0],a[1],z);normals.push(0,0,1);
  }
  for(let i=1;i+1<points.length;i++)indices.push(0,sign>0?i:i+1,sign>0?i+1:i);
  return new Geometry(coords,normals,indices);
}
const pseudo=n=>{
  const drift=Math.sin(n*72.413+17.31)*61013.863;
  return drift-Math.floor(drift);
};
function hex(rgb){return '#'+rgb.map(a=>Math.round(a).toString(16).padStart(2,'0')).join('');}

export function makeLandscape(engine){
  const mats=new Map();
  function material(value){
    const color=scheme[value]??value;
    if(!mats.has(color))mats.set(color,new PbrMaterial({color,roughness:.87,metalness:0,doubleSided:false}));
    return mats.get(color);
  }
  function piece(color,geometry,position=[0,0,0],root=null){
    return engine.createMesh(root).setGeometry(geometry).setMaterial(material(color)).setPosition(position);
  }
  function rect(color,p,scale,root=null){
    return piece(color,boxUnit,p,root).setScale(scale);
  }
  function shape(color,vertices,z,root=null){return piece(color,polygon(vertices,z),[0,0,0],root);}
  function link(segment,a,b,z,width){
    const dx=b[0]-a[0],dy=b[1]-a[1];
    segment.setPosition([(a[0]+b[0])/2,(a[1]+b[1])/2,z]).setScale([Math.hypot(dx,dy),width,.009]);
    segment.rotation.z=Math.atan2(dy,dx);
  }
  const sky=engine.createMesh(),distant=[],scenery=[];
  const rise=[{low:[229,164,139],high:[128,143,170],from:-7,to:5},
    {low:[128,143,170],high:[61,83,124],from:5,to:13}];
  for(const layer of rise){
    const count=35,diff=(layer.to-layer.from)/count;
    for(let i=0;i<count;i++){
      const t=(i+.5)/count,color=hex(layer.low.map((c,j)=>c+(layer.high[j]-c)*t));
      rect(color,[0,layer.from+(i+.5)*diff,-25],[193,diff+.0004,.012],sky);
    }
  }
  piece('sun',disk,[4.0,.95,-21],sky).setScale([1.63,1.63,1]);
  // Natural layered distance from long low ridges, then blockier broken rock faces.
  const layers=[
    {color:'far',depth:-17,height:-1.2,amp:.59,seed:2.4,parallax:.73},
    {color:'low',depth:-14,height:-2.75,amp:.76,seed:7.9,parallax:.56},
    {color:'middle',depth:-10,height:-3.38,amp:.82,seed:13.3,parallax:.37},
    {color:'near',depth:-7,height:-4.53,amp:.74,seed:18.4,parallax:.20}
  ];
  for(const level of layers){
    const ridge=Array.from({length:820},(_,i)=>{
      const x=-31+i*.285,s=level.seed;
      const broad=Math.sin(x*.181+s)+.49*Math.sin(x*.45+s*1.71)+.39*Math.cos(x*.082+s*.76);
      const fracture=.37*Math.max(-.35,Math.sin(x*.776+s))+.10*Math.sin(x*2.107+s);
      return [x,level.height+level.amp*(broad+fracture)];
    });
    const plate=piece(level.color,strip(ridge,ridge.map(()=>-18),level.depth));
    distant.push({plate,parallax:level.parallax});
  }
  for(let i=0;i<32;i++){
    const x=-29+i*7.2,y=-.5+3.25*pseudo(i*4+12),w=2.5+pseudo(i*17)*4.0;
    const hue=i%4===0?'#d9a4a0':'#c297aa';
    const patch=shape(hue,[[x,y],[x+w*.35,y+.13],[x+w*.88,y+.11],[x+w,y],[x+w*.61,y-.027]],-19);
    scenery.push(patch);
  }
  const surface=trail.map(([x,y])=>[x,-y]);
  const horizon=(depth,frequency,amp)=>surface.map(([x,y])=>y-depth+amp*Math.sin(x*frequency+depth*1.4));
  const horizons=[surface.map(([,y])=>y),horizon(.21,.53,.038),horizon(.66,.78,.08),
    horizon(1.02,.37,.115),horizon(1.61,.49,.18),horizon(2.63,.32,.21),surface.map(()=>-21)];
  for(const [n,color] of ['cap','sand','terra','clay','slate','shadow'].entries()){
    const top=surface.map(([x],i)=>[x,horizons[n][i]]);
    piece(color,strip(top,horizons[n+1],n*.003));
  }
  piece('line',strip(surface,surface.map(([,y],i)=>y-.043-.004*Math.sin(i*.34)),.027));
  // Rock seams and small shrubs are batched into each color as original silhouettes.
  const debris=new Map();
  function add(color,a,b,c,z){
    const data=debris.get(color)??{positions:[],normals:[],indices:[]};
    const n=data.positions.length/3;
    const area=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
    for(const p of [a,b,c]){data.positions.push(...p,z);data.normals.push(0,0,1);}
    data.indices.push(n,area>0?n+1:n+2,area>0?n+2:n+1);
    debris.set(color,data);
  }
  for(let i=0;i<495;i++){
    const x=firstX+.37*i+(.16*pseudo(i)),y=-roadElevation(x);
    if(x>endX||x<firstX+.5)continue;
    const u=pseudo(i*11),depth=.24+u*2.45,scale=.04+u*.08;
    add(i%5===0?'shadow':'thin',[x,y-depth],[x+.15+u*.26,y-depth+.04],[x+scale,y-depth-.125],.035);
    if(i%7===0){
      const root=y-.021;
      for(let j=0;j<5;j++){
        const spread=(j-2)*.102,top=root+.105+.21*pseudo(i*13+j);
        add(j%2?'brush':'plant',[x-.024,root],[x+.024,root],[x+spread,top],-.032);
      }
    }
  }
  for(const x of checkpoints){
    const y=-roadElevation(x);
    rect('frame',[x,y+.51,-.197],[.065,1.08,.033]);
    shape('flag',[[x,y+.62],[x+.58,y+.74],[x,y+.95]],-.17);
    rect('thin',[x,y+.11,-.17],[.18,.22,.055]);
  }
  for(const [color,d] of debris){
    piece(color,new Geometry(d.positions,d.normals,d.indices));
  }

  const chassis=engine.createMesh();
  shape('frame',[[-1.56,.006],[-1.38,-.28],[1.04,-.28],[1.55,-.10],[1.45,.23],[-1.27,.24]],.146,chassis);
  shape('body',[[-1.59,.052],[-1.39,.37],[-.82,.47],[.52,.44],[1.42,.315],[1.51,.12],[1.22,-.08],[-1.34,-.083]],.209,chassis);
  shape('hot',[[-1.40,.35],[-.90,.458],[.46,.45],[1.38,.324],[1.07,.278],[-.83,.29]],.233,chassis);
  shape('rack',[[-.91,.425],[-.57,.995],[.297,.982],[.78,.45]],.210,chassis);
  shape('glass',[[-.742,.446],[-.502,.879],[.215,.875],[.595,.46]],.223,chassis);
  shape('deepGlass',[[-.523,.873],[.18,.875],[.30,.76],[-.605,.75]],.225,chassis);
  shape('accent',[[-.713,.487],[-.542,.821],[-.436,.786],[-.562,.486]],.228,chassis);
  for(const [a,b] of [[[-.9,.428],[-.56,.99]],[[-.56,.99],[.297,.982]],[[.297,.982],[.78,.45]],[[-.034,.92],[-.06,.44]]]){
    link(rect('rack',[0,0,0],[1,1,1],chassis),a,b,.250,.046);
  }
  for(const [x,y,size,color] of [[1.465,.195,.14,'light'],[-1.455,.215,.125,'flag'],[0,.124,1.62,'accent']]){
    rect(color,[x,y,.236],[size,.069,.039],chassis);
  }
  for(let i=0;i<5;i++)rect('frame',[-1.22+i*.061,.189,.238],[.027,.077,.014],chassis);
  rect('rack',[-.026,-.11,.244],[1.72,.096,.037],chassis);
  const bar=rect('bronze',[.18,.18,.252],[.26,.036,.021],chassis);
  bar.rotation.z=-.06;

  const meshes=Array.from({length:2},()=>{
    const root=engine.createMesh();
    const rubber=piece('tire',conv(cylinderGeometry(radius,radius,.181,48)),[0,0,.38],root);
    rubber.rotation.x=Math.PI/2;
    piece('rim',disk,[0,0,.484],root).setScale([.259,.259,1]);
    piece('frame',disk,[0,0,.488],root).setScale([.225,.225,1]);
    piece('hub',disk,[0,0,.505],root).setScale([.109,.109,1]);
    for(let i=0;i<7;i++){
      const angle=i/7*twoPi;
      const spoke=rect('rim',[.142*Math.cos(angle),.142*Math.sin(angle),.501],[.151,.038,.021],root);
      spoke.rotation.z=angle;
    }
    for(let i=0;i<22;i++){
      const angle=i/22*twoPi;
      const lug=rect('lug',[(radius-.016)*Math.cos(angle),(radius-.016)*Math.sin(angle),.45],[.072,.049,.028],root);
      lug.rotation.z=angle+Math.PI/2;
    }
    const coil=Array.from({length:9},()=>rect('bronze',[0,0,0],[1,1,1]));
    const shaft=rect('rack',[0,0,0],[1,1,1]);
    return {root,coil,shaft};
  });
  function backdrop(cameraX,cameraY){
    sky.setPosition([cameraX*.92,cameraY*.36,0]);
    for(const {plate,parallax} of distant)plate.position.x=cameraX*parallax;
    for(const cloud of scenery)cloud.position.x=cameraX*.70;
  }
  function stage(cameraX,cameraY){
    backdrop(cameraX,cameraY);
    chassis.position.x=-9999;
    for(const wheel of meshes){
      wheel.root.position.x=-9999;
      wheel.shaft.position.x=-9999;
      for(const coil of wheel.coil)coil.position.x=-9999;
    }
  }
  function draw(state,cameraX,cameraY){
    backdrop(cameraX,cameraY);
    chassis.setPosition([state.p[0],-state.p[1],0]);chassis.rotation.z=-state.angle;
    for(const [i,wheel] of state.wheels.entries()){
      const bundle=meshes[i];
      const a=[wheel.hard[0],-wheel.hard[1]],b=[wheel.center[0],-wheel.center[1]];
      bundle.root.setPosition([b[0],b[1],0]);bundle.root.rotation.z=-wheel.spin;
      link(bundle.shaft,a,b,.318,.071);
      const points=Array.from({length:10},(_,j)=>{
        const t=j/9;
        return [a[0]+(b[0]-a[0])*t+(j%2===0?-.049:.049),a[1]+(b[1]-a[1])*t];
      });
      for(const [j,coil] of bundle.coil.entries())link(coil,points[j],points[j+1],.336,.032);
    }
  }
  return {draw,stage};
}
