
import {box, PbrMaterial} from '@margoengine/core';
import {Clustered} from '@margoengine/clustered';
import {AreaLights} from '@margoengine/clustered/area';
import {lineLights} from '@margoengine/clustered/line';
import {lumensToCandela} from '@margoengine/clustered/units';
import {sphere,turned,tray,capsule,cyclorama,cycloramaPosition} from './geometry.js';

const sourceOutput=520, exposure=.0038;
const warm=[1,.91,.77];
const tint=warm.map(value=>value/(warm[0]*.2126+warm[1]*.7152+warm[2]*.0722));
const inclination=.63;
const directions=[0,-Math.cos(inclination),Math.sin(inclination)];
const discUp=[0,Math.sin(inclination),Math.cos(inclination)];
const mountHeight=1.025,mountDepth=.511;
const types={
  sphere:{caption:'The spherical source makes a compact, round highlight.',radius:.112},
  disc:{caption:'The round panel makes a broader highlight that foreshortens with its angle.',radius:.167},
  tube:{caption:'A broad luminous tube stretches the highlight across the curved metal.',radius:.048,halfLength:.308},
  line:{caption:'Eight luminous samples approximate a slender line, with a finer highlight than the tube.',
    radius:.016,halfLength:.326},
};

function finish(color,roughness,metalness=0){
  return new PbrMaterial({color,roughness,metalness});
}

export function prepareBench(){
  const slate=finish('#4d5b60',.86), charcoal=finish('#374549',.58);
  const bronze=finish('#c6986a',.34,1), darkSteel=finish('#759096',.39,0);
  const ink=finish('#4c6065',.69), cream=finish('#f4e8c7',.67);
  const trim=finish('#7b8d86',.52), indicator=finish('#b0c5dd',.50);
  const parts=[], placements=[];
  function part(name,geometry,material,position=[0,0,0]){
    const item={name,geometry,material,position,mesh:null};
    parts.push(item);
    return item;
  }

  part('Continuous studio sweep',cyclorama(),slate,cycloramaPosition);
  part('Teknik pedestal',tray(2.10,.228,1.38,.131,.026),charcoal,[0,.034,0]);
  part('Bronze accent at the pedestal bevel',tray(2.075,.023,1.35,.127,.009),bronze,[0,.157,0]);
  part('Dark anodized working surface',tray(2.03,.071,1.31,.11,.017),ink,[0,.193,0]);
  part('Front hardware line',box(1.78,.007,.008),trim,[0,.144,.685]);
  const lowerPlate=tray(.254,.065,.025,.011,.004);
  part('Front datum plate',lowerPlate,darkSteel,[0,.032,.693]);
  part('Copper datum inset',box(.145,.007,.005),bronze,[0,.039,.708]);

  const bearing=turned([
    [0,0],[.177,0],[.196,.009],[.198,.019],[.191,.033],[.167,.046],
    [.160,.058],[.145,.063],[.126,.061],[.122,.047],[0,.040],
  ],52);
  const brassLiner=turned([[.162,.007],[.178,.007],[.180,.012],[.176,.017],[.163,.018],[.161,.015],[.162,.007]],52);
  const plate=tray(.372,.021,.118,.026,.007);
  const vessel=sphere(.181,64,32);
  const grades=[
    {name:'Polished nickel',color:'#c6d5df',metal:1,rough:.148},
    {name:'Satin brass',color:'#e8b971',metal:1,rough:.31},
    {name:'Glazed ceramic',color:'#438373',metal:0,rough:.145},
  ];
  for(const [index,grade] of grades.entries()){
    const x=(index-1)*.56;
    part(grade.name+' holder',bearing,darkSteel,[x,.230,.155]);
    part(grade.name+' brass liner',brassLiner,bronze,[x,.231,.155]);
    part(grade.name,vessel,finish(grade.color,grade.rough,grade.metal),[x,.450,.155]);
    part(grade.name+' legend plate',plate,charcoal,[x,.233,.505]);
    part(grade.name+' legend inlay',box(.205,.003,.008),grade.metal?bronze:indicator,[x,.246,.508]);
  }

  const columns=tray(.119,1.05,.145,.032,.014), foot=tray(.26,.078,.26,.05,.018);
  const rail=tray(1.88,.083,.115,.035,.012), inner=box(1.66,.028,.012);
  for(const side of [-1,1]){
    part('Upright foot',foot,darkSteel,[side*.895,.257,-.432]);
    part('Back rail riser',columns,charcoal,[side*.895,.770,-.432]);
    part('Front trim on riser',box(.028,.85,.009),darkSteel,[side*.895,.782,-.354]);
  }
  part('Emitter movement rail',rail,darkSteel,[0,1.253,-.430]);
  part('Rail slot in shadow',inner,charcoal,[0,1.252,-.369]);
  const mark=box(.004,.015,.004);
  for(let i=-10;i<=10;i++){
    part('Rail measurement tick',mark,i%5===0?bronze:trim,[i*.072,1.290,-.365]);
  }
  const bolt=sphere(.016,14,8);
  for(const side of [-1,1]){
    for(const z of [-.52,-.34]){
      part('Milled mount screw',bolt,bronze,[side*.958,.307,z]);
    }
  }

  function moving(name,shape,material,[x,y,z]){
    const p=part(name,shape,material,[x,y,z]);
    placements.push({p,x,y,z});
    return p;
  }
  moving('Sliding carriage',tray(.213,.108,.178,.038,.014),charcoal,[0,1.264,-.414]);
  moving('Amber carriage inset',box(.122,.024,.010),bronze,[0,1.263,-.320]);
  moving('Suspension extrusion',tray(.092,.081,1.04,.029,.014),darkSteel,[0,1.237,-.018]);
  moving('Bronze rim of extrusion',box(.034,.004,.730),bronze,[0,1.281,-.002]);
  moving('Emitter yoke',tray(.147,.109,.144,.034,.014),charcoal,[0,1.168,.511]);
  moving('Machined emitter neck',turned([[0,0],[.036,0],[.043,.009],[.043,.074],[.033,.081],[0,.081]],28),
    bronze,[0,1.065,mountDepth]);
  const fixture=moving('Emitter lens',null,cream,[0,mountHeight,mountDepth]);
  const housing=moving('Emitter retaining ring',null,darkSteel,[0,mountHeight,mountDepth]);

  const sphereShell=sphere(types.sphere.radius,49,27);
  const discLens=turned([[0,-.009],[.159,-.009],[.167,-.004],[.166,.003],[.151,.007],[0,.007]],58);
  const discBody=turned([[0,.005],[.168,.005],[.184,.017],[.183,.041],[.164,.053],[0,.055]],58);
  const tubeShell=capsule(types.tube.radius,types.tube.halfLength);
  const lineShell=capsule(types.line.radius,types.line.halfLength);
  const tubeClip=tray(.080,.075,.057,.022,.009),lineClip=tray(.044,.090,.036,.014,.009);
  const connector=moving('Knurled lamp connector',null,charcoal,[0,1.070,mountDepth]);
  const attachment={
    sphere:{lens:sphereShell,body:null,rotation:[0,0,0]},
    disc:{lens:discLens,body:discBody,rotation:[-inclination,0,0]},
    tube:{lens:tubeShell,body:null,rotation:[0,0,0]},
    line:{lens:lineShell,body:null,rotation:[0,0,0]},
  };
  return engine=>{
    for(const item of parts){
      item.mesh=engine.createMesh().setGeometry(item.geometry).setMaterial(item.material).setPosition(item.position);
      item.mesh.name=item.name;
    }
    let kind;
    return (shape,shift)=>{
      if(kind!==shape){
        const next=attachment[shape];
        fixture.mesh.setGeometry(next.lens).setRotation(next.rotation);
        housing.mesh.setGeometry(next.body).setRotation(next.rotation);
        connector.mesh.setGeometry(shape==='tube'?tubeClip:shape==='line'?lineClip:null);
        kind=shape;
      }
      for(const {p,x,y,z} of placements)p.mesh.setPosition([x+shift,y,z]);
    };
  };
}

function discPanels(position,radius){
  const slices=11, size=radius*2/slices;
  const panels=Array.from({length:slices},(_,i)=>{
    const offset=-radius+size*(i+.5);
    const width=2*Math.sqrt(radius*radius-offset*offset);
    return {position:position.map((p,j)=>p+discUp[j]*offset),direction:directions,up:discUp,width,height:size};
  });
  return setEmission(panels);
}

function tubePanels(position,radius,length){
  const lanes=10, width=2*radius*Math.tan(Math.PI/lanes);
  return setEmission(Array.from({length:lanes},(_,i)=>{
    const angle=i/lanes*2*Math.PI,dir=[0,Math.sin(angle),Math.cos(angle)];
    return {position:position.map((p,j)=>p+dir[j]*radius),direction:dir,up:[1,0,0],width,height:length};
  }));
}

function setEmission(panels){
  const area=panels.reduce((sum,panel)=>sum+panel.width*panel.height,0);
  const intensity=exposure*sourceOutput/(Math.PI*area);
  return panels.map(panel=>({...panel,color:tint,intensity}));
}

function lightRig(engine){
  const local=Clustered.attach(engine,{grid:[6,4,7],maxLights:12});
  const panels=AreaLights.attach(engine,{lights:local,maxLights:16});
  const accent={position:[.20,1.15,-.83],range:3.3,intensity:.10,radius:.25,color:[.53,.73,1]};
  const fill=[
    {position:[-1.40,1.34,.67],direction:[.92,-.18,-.21],up:[0,1,0],width:.86,height:1.74,color:[.65,.84,1],intensity:.66},
    {position:[1.26,.79,1.28],direction:[-.70,-.16,-.70],up:[0,1,0],width:1.2,height:1.72,color:[1,.85,.66],intensity:.27},
    {position:[0,2.05,-.07],direction:[0,-1,0],up:[0,0,1],width:3.13,height:1.05,color:[.85,.90,1],intensity:.29},
    {position:[0,.46,2.04],direction:[0,0,-1],up:[0,1,0],width:3.30,height:1.13,color:[.74,.85,.90],intensity:.16},
  ];
  const candela=lumensToCandela(sourceOutput)*exposure;
  return (shape,shift)=>{
    const {radius,halfLength}=types[shape], position=[shift,mountHeight,mountDepth];
    const start=[shift-(halfLength??0),mountHeight,mountDepth],end=[shift+(halfLength??0),mountHeight,mountDepth];
    const emitter=shape==='disc'?discPanels(position,radius):shape==='tube'?tubePanels(position,radius,2*halfLength):[];
    panels.setLights([...fill,...emitter]);
    if(shape==='line'){
      local.setLights([accent,...lineLights({
        start,end,range:0,castShadow:false,radius,samples:8,
        intensity:candela,color:tint,
      })]);
    }else if(shape==='sphere'){
      local.setLights([accent,{position,radius,range:0,intensity:candela,color:tint}]);
    }else{
      local.setLights([accent]);
    }
  };
}

export async function show({engine,canvas,status,notice,size,signal,fail,assemble}){
  const buttons=[...document.querySelectorAll('[data-shape]')];
  const slider=document.querySelector('#position'),offset=document.querySelector('#offset');
  const description=document.querySelector('#description'),route=document.querySelector('#renderer');
  const place=assemble(engine), illuminate=lightRig(engine);
  engine.scene.background='#17282d';
  engine.lighting.radiance.set([.91,.94,1,.68]);
  engine.lighting.direction.set([.38,.782,.493,.44]);
  engine.lighting.ambient.set([.49,.59,.63]);
  const compatibility=engine.gpu.adapterInfo?.vendor==='margo-webgl2';
  canvas.dataset.renderer=compatibility?'compatibility':'webgpu';
  route.textContent=compatibility?'Margo WebGL2':'Margo WebGPU';

  let shape='sphere',shift=+slider.value,revision=0,first=false,pending=0;
  let drawnShape='',drawnShift=NaN;
  function draw(){
    const narrow=canvas.clientWidth<720;
    engine.camera.fov=narrow?46:37;
    engine.camera.position=[.29,1.52,2.82];
    engine.camera.target=[.015,.55,0];
    if(drawnShape!==shape||drawnShift!==shift){
      place(shape,shift*.01);
      illuminate(shape,shift*.01);
      drawnShape=shape;
      drawnShift=shift;
    }
    engine.render(0);
  }

  async function update(mark){
    const serial=++revision;
    draw();
    await engine.gpu.queue.onSubmittedWorkDone();
    if(signal.aborted||serial!==revision)return;
    for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.shape===shape));
    description.textContent=types[shape].caption;
    slider.setAttribute('aria-valuetext',shift===0?'Centered':Math.abs(shift)+' centimetres '+(shift<0?'left':'right'));
    offset.value=(shift<0?'−':'')+Math.abs(shift)+' cm';
    Object.assign(canvas.dataset,{shape,offset:String(shift),revision:String(serial)});
    if(mark&&!first){
      await new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)));
      if(!first&&!signal.aborted){
        first=true;
        performance.mark('area-change-applied');
      }
    }
  }
  function request(){
    cancelAnimationFrame(pending);
    pending=requestAnimationFrame(()=>update(true).catch(fail));
  }
  for(const button of buttons)button.addEventListener('click',()=>{
    if(shape===button.dataset.shape)return;
    shape=button.dataset.shape;
    request();
  },{signal});
  slider.addEventListener('input',()=>{shift=+slider.value;request();},{signal});
  const observer=new ResizeObserver(()=>{
    if(!size())return;
    try{draw();}catch(reason){fail(reason);}
  });
  observer.observe(canvas);
  signal.addEventListener('abort',()=>{
    observer.disconnect();
    cancelAnimationFrame(pending);
  },{once:true});

  await update(false);
  if(status.ready()){
    notice.hidden=true;
    for(const control of [...buttons,slider])control.disabled=false;
    performance.mark('area-frame-ready');
  }
}
