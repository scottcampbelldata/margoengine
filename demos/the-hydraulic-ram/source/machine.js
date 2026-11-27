import { applyMatrix4 } from '@margoengine/geometry/utils';
import { createMesh,Material,MatcapMaterial } from '@margoengine/materials';
import { box,lighting,line,merge,round,studio,tube,turn } from './craft.js';
import { chamberVolume } from './cycle.js';

const chamberX=.148;
const floor=.228;
const glassRadius=.0500;
const crown=floor+chamberVolume/(Math.PI*glassRadius**2);
const center=.143;
const wasteX=-.226;
const inlet=[[-.565,center,0],[-.091,center,0],[-.012,center,0]];
const delivery=[[.158,.209,0],[.218,.209,0],[.269,.209,0],[.290,.215,0],[.302,.231,0],[.302,.318,0],
  [.304,.362,0],[.317,.392,0],[.351,.404,0],[.410,.406,0],[.523,.406,0]];

function front(shape,[x,y,z]){
  return applyMatrix4(shape,[1,0,0,0,0,0,1,0,0,-1,0,0,x,y,z,1]);
}

function stand(add,mats){
  add(studio(),mats.studio,'Soft olive cyclorama','floor');
  add(box(1.241,.033,.443,[-.006,.008,0],.014),mats.base,'Brushed graphite rig skid','static');
  add(box(1.224,.012,.425,[-.006,.029,0],.0055),mats.coat,'Inset green mount plate','static');
  const mounts=[];
  const bright=[];
  const dark=[];
  const detail=[];
  for(const x of [-.556,.527]){
    for(const z of [-.174,.174]){
      dark.push(round(.027,.009,[x,-.012,z],20));
      bright.push(round(.014,.0040,[x,.037,z],18));
      detail.push(box(.015,.0015,.0019,[x,.0393,z],.00046,.19));
    }
  }
  for(const x of [-.439,-.034,.192,.314]){
    mounts.push(box(.094,.074,.123,[x,.075,-.012],.008));
    mounts.push(box(.148,.010,.162,[x,.042,-.012],.0033));
    for(const z of [-.069,.069])bright.push(round(.0068,.005,[x,.049,z],13));
  }
  mounts.push(box(.075,.300,.073,[.321,.191,-.059],.007));
  mounts.push(box(.120,.018,.117,[.321,.045,-.058],.005));
  mounts.push(box(.088,.012,.101,[.320,.355,-.022],.003));
  bright.push(box(.169,.0033,.031,[-.399,.037,.166],.004));
  for(let i=0;i<14;i++){
    const length=i%4===0?.012:.0068;
    detail.push(box(.0017,.0011,length,[-.463+i*.010,.039,.166+length*.11],.00045));
  }
  add(merge(mounts),mats.coat,'Pipe cradles and riser foot braces','static');
  add(merge(bright),mats.gold,'Corner studs, machined adhesive plate and fasteners');
  add(merge(dark),mats.base,'Rubber skid feet','static');
  add(merge(detail),mats.base,'Screw slots and machined witness marks');
}

function galleries(add,mats){
  const cast=[];
  const copper=[];
  const plastic=[];
  const tees=[];
  cast.push(box(.240,.109,.130,[.035,.114,-.006],.024));
  cast.push(front(round(.060,.112,[0,0,0],34),[.030,.144,-.002]));
  cast.push(box(.170,.028,.166,[.032,.069,-.006],.010));
  copper.push(turn([[.025,0],[.046,0],[.052,.006],[.050,.023],[.038,.030],[.027,.032]],[-.114,center,0],-Math.PI/2,26));
  copper.push(turn([[.022,0],[.031,0],[.033,.005],[.033,.016],[.022,.023]],[-.567,center,0],-Math.PI/2,30));
  copper.push(turn([[.022,0],[.030,0],[.035,.005],[.035,.017],[.027,.023]],[.502,.406,0],-Math.PI/2,30));
  tees.push(turn([[.023,0],[.038,0],[.040,.010],[.040,.025],[.028,.030]],[-.293,center,0],-Math.PI/2,32));
  tees.push(turn([[.021,0],[.032,0],[.034,.009],[.034,.025],[.026,.031]],[.393,.406,0],-Math.PI/2,36));
  tees.push(turn([[.020,0],[.038,0],[.040,.009],[.038,.024],[.027,.031]],[chamberX,.150,0],0,34));
  for(const x of [-.029,.112]){
    for(const z of [-.057,.057]){
      plastic.push(round(.010,.011,[x,.190,z],14));
    }
  }
  add(merge(cast),mats.coat,'Olive cast ram body and mounting shoe','static');
  add(merge(copper),mats.gold,'Feed and discharge unions');
  add(merge(tees),mats.steel,'Threaded ends and service collars','static');
  add(merge(plastic),mats.gold,'Main casting bolt heads');
  add(tube(inlet,.024,36),mats.glass,'Clear drive pipe shell');
  add(tube(inlet,.019,32),mats.water,'Water in the upstream drive pipe');
  add(tube(delivery,.024,32),mats.glass,'Curved glass delivery pipe');
  add(tube(delivery,.0185,26),mats.water,'Water in the discharge riser');
  const ring=front(turn([[.035,0],[.050,0],[.055,.003],[.055,.009],[.050,.013],[.036,.013],[.035,0]],
    [0,0,0],0,48),[.030,.148,.060]);
  add(ring,mats.gold,'Machined brass port around the pressure window');
  const bolts=[];
  for(let i=0;i<7;i++){
    const a=2*Math.PI*i/7;
    bolts.push(front(round(.0042,.0041,[0,0,0],14),[.030+.047*Math.sin(a),.148+.047*Math.cos(a),.074]));
  }
  add(merge(bolts),mats.steel,'Pressure-window machine screws');
  add(front(round(.035,.004,[0,0,0],48),[.030,.148,.077]),mats.glass,'Inspection window over the common pressure chamber');
  add(front(round(.032,.0038,[0,0,0],46),[.030,.148,.071]),mats.pulse,'Common chamber water behind the window');
}

function valves(add,mats){
  const pockets=[];
  const seats=[];
  const drain=[];
  function housing(x,bottom,height,radius){
    pockets.push(turn([[radius-.002,0],[radius+.003,0],[radius+.004,.004],
      [radius+.004,height-.006],[radius+.002,height],[radius-.002,height]], [x,bottom,0],0,42));
    for(const y of [bottom,bottom+height]){
      seats.push(turn([[radius-.005,-.005],[radius+.007,-.005],[radius+.010,-.001],
        [radius+.010,.005],[radius+.006,.008],[radius-.005,.008]], [x,y,0],0,42));
    }
  }
  housing(wasteX,.159,.128,.030);
  housing(chamberX,.172,.052,.026);
  add(merge(pockets),mats.glass,'Two transparent valve sight chambers');
  add(merge(seats),mats.gold,'Valve cage flanges and seats');
  const waste=add(merge([
    round(.023,.006,[0,0,0],26),
    round(.006,.078,[0,.032,0],20),
    round(.016,.011,[0,.066,0],26),
  ]),mats.brassRed,'Gravity-weighted waste poppet');
  const delivery=add(merge([
    round(.019,.005,[0,0,0],32),
    round(.0052,.025,[0,.011,0],14),
    round(.009,.0038,[0,.025,0],16),
  ]),mats.steel,'Independent one-way delivery disk');
  const trap=[-.319,.064,.095];
  drain.push(box(.195,.018,.192,trap,.010));
  drain.push(box(.200,.028,.014,[trap[0],trap[1]+.020,trap[2]-.096],.004));
  drain.push(box(.019,.031,.192,[trap[0]-.097,trap[1]+.018,trap[2]],.005));
  drain.push(box(.019,.031,.192,[trap[0]+.097,trap[1]+.018,trap[2]],.005));
  const exit=[[-.238,.177,.004],[-.275,.172,.004],[-.309,.162,.004],[-.345,.154,.004],[-.358,.153,.004]];
  add(merge(drain),mats.coat,'Sectioned waste catch tray','static');
  add(box(.173,.003,.169,[trap[0],trap[1]+.022,trap[2]],.001),mats.water,'Water already in the waste tray');
  add(tube(exit,.021,28),mats.gold,'Waste discharge spout');
  return sample=>{
    waste.root.setPosition([wasteX,.201+.023*(1-sample.gate),0]);
    delivery.root.setPosition([chamberX,.186+.014*Math.min(1,sample.check/.0005),0]);
  };
}

function tank(add,mats){
  const body=turn([[glassRadius,floor],[glassRadius+.005,floor],[glassRadius+.005,crown],
    [glassRadius+.003,crown+.003],[glassRadius,crown+.003],[glassRadius,floor]], [chamberX,0,0],0,58);
  add(body,mats.glass,'Pressure-rated air vessel with visible wall thickness');
  const cap=[];
  cap.push(turn([[.049,0],[.059,0],[.064,.005],[.064,.013],[.061,.020],[.054,.027],
    [.038,.036],[.020,.040],[.015,.046],[0,.047]], [chamberX,crown-.002,0],0,48));
  cap.push(turn([[.043,0],[.061,0],[.065,.007],[.064,.017],[.060,.021],[.049,.021]],
    [chamberX,floor-.015,0],0,52));
  add(merge(cap),mats.steel,'Machined pressure vessel end caps');
  const rings=[];
  for(const y of [floor+.009,crown-.005]){
    rings.push(turn([[.054,-.004],[.057,-.004],[.058,-.001],[.058,.002],[.055,.005],[.054,.005]],
      [chamberX,y,0],0,44));
  }
  add(merge(rings),mats.gold,'Brass retaining hoops');
  const internal=add(turn([[.0001,0],[glassRadius-.0009,0],[glassRadius-.0009,.998],
    [glassRadius-.0014,1],[.0001,1]],[0,0,0],0,44),mats.water,'Water sealed under the entrained air');
  const line=add(turn([[.048,-.0003],[.0498,.0001],[.0488,.0011],[.0463,.0004]],[0,0,0],0,50),mats.meniscus,'Level of the chamber water');
  return water=>{
    const depth=water/(Math.PI*glassRadius**2);
    internal.root.setPosition([chamberX,floor,0]);
    internal.root.setScale([1,depth,1]);
    line.root.setPosition([chamberX,floor+depth,0]);
  };
}

function movingWater(add,mats){
  const width=.006;
  const bead=turn([[0,-.010],[.0026,-.008],[.0031,0],[.0021,.008],[0,.010]],
    [0,0,0],-Math.PI/2,10);
  const paths=[
    [line(inlet),.0207,7,6.9e-5,mats.spark],
    [line([[chamberX,.162,0],[chamberX,.214,0]]),.020,4,3.3e-5,mats.spark],
    [line(delivery),.0206,7,4.6e-5,mats.meniscus],
    [line([[-.358,.153,.004],[-.385,.141,.040],[-.400,.117,.073],[-.409,.084,.092]]),.002,5,5.5e-5,mats.waste],
  ];
  const sets=paths.map(([route,z,n,lim,mat])=>({
    route,z,lim,
    marks:Array.from({length:n},()=>add(bead,mat,'Visible flow tracer')),
  }));
  const phases=[.1,.3,.2,.35];
  return (sample,delta)=>{
    const rates=[sample.q,sample.check,sample.delivered,sample.waste];
    for(const [i,{route,z,lim,marks}] of sets.entries()){
      const speed=rates[i];
      phases[i]=((phases[i]+delta*speed/lim*.38)%1+1)%1;
      for(const [k,mesh] of marks.entries()){
        const u=(phases[i]+(k+.24)/marks.length)%1;
        const {p,a}=route(u);
        mesh.root.visible=Math.abs(speed)>lim && u>.045 && u<.958;
        mesh.root.setPosition([p[0],p[1]+(k%2-.5)*width*.49,p[2]+z]);
        mesh.root.setRotation([0,0,a+(speed<0?Math.PI:0)]);
        mesh.root.setScale([.65+Math.min(1.12,Math.abs(speed)*1600),.66,.60]);
      }
    }
  };
}

export function buildRam(engine,shadows){
  const maps=lighting();
  const mats={
    studio:new Material({color:'#e4e9dc',roughness:.87}),
    base:new Material({color:'#344143',roughness:.65}),
    coat:new Material({color:'#50665d',roughness:.55}),
    gold:new MatcapMaterial({color:'#e2b876',matcap:maps.metal}),
    brassRed:new MatcapMaterial({color:'#d38b64',matcap:maps.metal}),
    steel:new MatcapMaterial({color:'#d7e4db',matcap:maps.metal}),
    glass:new MatcapMaterial({color:'#dfede5',matcap:maps.glass,transparent:true,opacity:.34,depthWrite:false}),
    water:new MatcapMaterial({color:'#8ac8cd',matcap:maps.liquid}),
    meniscus:new Material({shading:'basic',color:'#80cdd3'}),
    spark:new Material({shading:'basic',color:'#a2e4d8'}),
    waste:new Material({shading:'basic',color:'#e8bc7e'}),
    pulse:new Material({shading:'basic',color:'#317a83'}),
  };
  const all=[];
  const add=(geometry,material,name,type)=>{
    const mesh=createMesh(engine,geometry,material);all.push(mesh);
    mesh.root.name=name;
    if(type==='floor')shadows.add(mesh,{static:true,castShadow:false});
    if(type==='static')shadows.add(mesh,{static:true});
    return mesh;
  };
  stand(add,mats);
  galleries(add,mats);
  const alter=valves(add,mats);
  const level=tank(add,mats);
  const flow=movingWater(add,mats);
  let lit;
  return {
    update(sample,delta){
      const surge=sample.p>10000;
      if(surge!==lit){mats.pulse.color.set(surge?'#5cafab':'#317a83');lit=surge;}
      alter(sample);level(sample.water);flow(sample,delta);
    },
    anchors:[[-.245,.303,0],[.146,crown+.056,0],[.430,.438,0]],
    dispose(){for(const mesh of all.reverse())mesh.dispose();for(const m of Object.values(mats))m.dispose();for(const map of Object.values(maps))map.dispose();},
  };
}