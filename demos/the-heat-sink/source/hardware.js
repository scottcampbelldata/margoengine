import { PbrMaterial, box } from '@margoengine/core';
import { CatmullRomCurve3, Path, Shape } from '@margoengine/geometry/shapes';
import { cylinderGeometry, torusGeometry, tubeGeometry } from '@margoengine/geometry/primitives';
import { extrudeGeometry } from '@margoengine/geometry/extrude';
import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { toGeometry } from '@margoengine/geometry/utils';
import { axisAngleToQuaternion } from '@margoengine/math/quat';
import { ambient, cells, finCount, finDepth, finHeight, finThickness } from './thermal.js';

const tau=2*Math.PI;
const Z=[0,0,1];
const alongZ=axisAngleToQuaternion([1,0,0],Math.PI/2);
const sinkX=.029, sinkZ=-.023, finFloor=.089;
const fanY=.118, fanZ=.042;
const shades=[[56,84,162],[71,65,170],[151,59,124],[219,98,89],[242,164,111],[255,226,171]];
const linear=(v)=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;

function temperatureColor(value) {
  const q=Math.max(0,Math.min(1,value/(110-ambient)))*(shades.length-1);
  const i=Math.min(shades.length-2,Math.floor(q)), offset=q-i;
  return shades[i].map((v,j)=>linear((v+(shades[i+1][j]-v)*offset)/255));
}

function fanFrame(){
  const shape=new Shape([[-.040,-.043],[.040,-.043],[.043,-.039],[.043,.039],[.040,.043],[-.040,.043],[-.043,.039],[-.043,-.039]]);
  shape.holes.push(new Path(Array.from({length:72},(_,i)=>[.0386*Math.cos(i*tau/72),.0386*Math.sin(i*tau/72)])));
  return extrudeGeometry(shape,{depth:.0135,bevelSize:.00085,bevelThickness:.00085,bevelSegments:2});
}

function fanBlade() {
  const outline=new Shape([[.012,-.0038],[.015,-.0079],[.024,-.012],[.032,-.0130],[.036,-.0096],
    [.0379,-.0037],[.0370,.0036],[.0351,.0070],[.0302,.0060],[.0220,.0028],[.0130,.0016]]);
  const geometry=extrudeGeometry(outline,{depth:.0015,bevelSize:.00042,bevelThickness:.00042,bevelSegments:1});
  for(let i=0;i<geometry.positions.length;i+=3)geometry.positions[i+2]+=geometry.positions[i+1]*.34;
  return geometry;
}

export function makeHardware(engine,shadows) {
  const paint=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
  const bench=paint('#4c666e',.86);
  const dark=paint('#343e46',.58), charcoal=paint('#41484c',.59);
  const resin=paint('#285e52',.59), mask=paint('#9eada3',.73);
  const etched=paint('#806741',.51), copper=paint('#b27750',.31,1);
  const aluminium=paint('#99a6aa',.33,1), steel=paint('#aebbad',.30,1);
  const ceramic=paint('#a59375',.55), fanBladeFinish=paint('#6c8499',.48);
  const intake=paint('#6d9ba1',.49), outflow=paint('#9fd3d0',.62);
  const dummyChip=paint('#4a4748',.45);
  const heatFin=Array.from({length:cells},()=>paint('#91578c',.61));
  const heatSpreader=paint('#d66c51',.56), heatChip=paint('#f5b07f',.54);

  function node(name,at,parent=null) {
    const item=engine.createMesh(parent).setPosition(at);
    item.name=name;
    return item;
  }
  function mesh(name,data,finish,at,parent=null,shadow=true,moving=false) {
    const item=node(name,at,parent).setGeometry('uvs' in data?toGeometry(data):data).setMaterial(finish);
    if(shadow)shadows.add(item,{static:!moving});
    return item;
  }
  function block(name,dims,radius,finish,at,parent=null,shadow=true) {
    return mesh(name,roundedBoxGeometry(...dims,2,radius),finish,at,parent,shadow);
  }
  function cylinder(name,radius,height,finish,at,parent=null,sections=48,moving=false) {
    return mesh(name,cylinderGeometry(radius,radius,height,sections),finish,at,parent,true,moving);
  }
  function axial(name,radius,height,finish,at,parent=null,sections=48,moving=false) {
    return cylinder(name,radius,height,finish,at,parent,sections,moving).setQuaternion(alongZ);
  }

  mesh('Studio sweep',box(40,.066,40),bench,[0,-.049,0],null,false);
  block('Dark base', [.386,.020,.278], .0085, dark, [0,0,0]);
  block('Bench metal reveal', [.367,.0034,.264], .0015, aluminium,[0,.0104,0]);
  block('Board carrier', [.358,.0098,.255], .0042, charcoal,[0,.0161,0]);
  for(const x of [-.156,.156]){
    for(const z of [-.102,.102]){
      block('Shock isolator',[.045,.013,.040],.004,dark,[x,-.012,z]);
      cylinder('Nylon board spacer',.0068,.008,ceramic,[x,.026,z],null,24);
    }
  }
  block('Circuit board',[.337,.0035,.230],.00165,resin,[0,.035,0]);
  const ruler=toGeometry(roundedBoxGeometry(.0010,.00028,.0042,1,.00012));
  for(let i=-11;i<=11;i++){
    const mark=mesh('Inlaid position marks',ruler,mask,[.012*i,.038,.105],null,false);
    if(i%5===0)mark.setScale([1,1,1.45]);
  }
  for(const x of [-.153,.153]){
    for(const z of [-.098,.098]){
      cylinder('Board screw',.0045,.0035,steel,[x,.0395,z],null,8);
    }
  }

  for(let i=0;i<14;i++){
    const x=-.140+i*.0063,z=-.068+.004*(i%4);
    block('Signal trace',[.0011,.00033,.035+.002*(i%7)],.00015,etched,[x,.037,z-.005],null,false);
    if(i%2===0)cylinder('Plated via',.0014,.00065,copper,[x,.0372,z-.024],null,12);
  }
  for(let i=0;i<8;i++){
    const at=[-.136+i*.009,.042,-.039+.004*(i%3)];
    block('Surface-mount ceramic body',[.0052,.0051,.011],.00065,i%3?ceramic:charcoal,at);
    for(const dir of [-1,1])block('Tinned chip contact',[.0052,.0048,.0019],.00055,steel,[at[0],at[1],at[2]+dir*.0051]);
  }
  block('Drive controller',[.044,.0058,.040],.0022,dark,[-.100,.041,-.078]);
  for(const sign of [-1,1]){
    for(let i=0;i<10;i++)block('Controller lead',[.0017,.0011,.0062],.00042,steel,
      [-.116+.0036*i,.0383,-.078+sign*.0215],null,false);
  }
  for(const x of [-.128,-.108,-.086]){
    cylinder('Power capacitor',.0072,.018,paint('#435b5a',.53),[x,.0478,.049],null,40);
    cylinder('Capacitor pressure lid',.0061,.0010,steel,[x,.0577,.049],null,36);
    block('Capacitor score',[.0082,.00035,.0008],.00012,dark,[x,.0583,.049],null,false);
  }
  block('Fan terminal', [.030,.017,.026], .0028, ceramic,[.121,.045,.072]);
  for(const x of [.111,.121,.131])cylinder('Terminal relief',.0030,.00085,steel,[x,.054,.072],null,18);

  const chip=block('Heat source lid',[.060,.010,.059],.0024,heatChip,[sinkX,.057,sinkZ]);
  block('Socket insulator',[.075,.014,.071],.0027,dummyChip,[sinkX,.048,sinkZ]);
  const spreader=block('Copper spreader',[.110,.0080,.106],.0012,heatSpreader,[sinkX,finFloor-.004,sinkZ]);
  const slug=block('Copper thermal slug',[.059,.023,.052],.0014,heatSpreader,[sinkX,.071,sinkZ]);
  for(const side of [-1,1]){
    const x=sinkX+side*.0620;
    block('Spreader bracket',[.014,.008,.084],.0023,aluminium,[x,.076,sinkZ]);
    for(const z of [sinkZ-.030,sinkZ+.032]){
      cylinder('Captive spring shoulder',.0039,.026,steel,[x,.058,z],null,28);
      cylinder('Spreader screw',.0050,.0048,steel,[x,.082,z],null,6);
    }
  }
  const fins=[];
  const layerHeight=finHeight/cells;
  const regular=box(finThickness,layerHeight-.000018,finDepth);
  const tip=toGeometry(roundedBoxGeometry(finThickness,layerHeight-.000018,finDepth,1,.00048));
  for(let row=0;row<cells;row++){
    const parts=[];
    for(let index=0;index<finCount;index++){
      parts.push(mesh('Aluminium fin segment',row===cells-1?tip:regular,heatFin[row],
        [sinkX+(index-(finCount-1)*.5)*.0057,finFloor+(row+.5)*layerHeight,sinkZ]));
    }
    fins.push(parts);
  }

  const fanHousing=fanFrame();
  mesh('Die-cast fan frame',fanHousing,charcoal,[sinkX,fanY,fanZ]);
  mesh('Intake retaining frame',fanHousing,intake,[sinkX,fanY,fanZ+.0016]).setScale([1.017,1.017,.14]);
  mesh('Intake rolled edge',torusGeometry(.0392,.00105,8,80),steel,[sinkX,fanY,fanZ+.0156]);
  for(const x of [-.037,.037]){
    for(const y of [-.035,.035])axial('Intake screw',.0032,.0026,steel,[sinkX+x,fanY+y,fanZ+.0158],null,6);
    block('Fan pedestal', [.012,.039,.022],.0028,charcoal,[sinkX+x,.055,fanZ+.007]);
  }
  const rotor=node('Fan rotor',[sinkX,fanY,fanZ+.0116]);
  const blade=toGeometry(fanBlade());
  for(let i=0;i<9;i++){
    mesh('Curved fan blade',blade,fanBladeFinish,[0,0,-.003],rotor,false)
      .setQuaternion(axisAngleToQuaternion(Z,tau*i/9));
  }
  axial('Fan hub',.013,.010,charcoal,[0,0,.004],rotor,56,true);
  axial('Hub label rim',.0106,.0011,aluminium,[0,0,.010],rotor,52,true);
  axial('Hub decal',.0089,.0008,resin,[0,0,.0106],rotor,48,true);
  const mark=block('Index mark',[.0055,.0011,.00054],.00025,mask,[.0038,0,.0115],rotor,false);
  mark.setQuaternion(axisAngleToQuaternion(Z,.46));

  const leads=[
    [[.104,.050,.072],[.094,.044,.087],[.081,.046,.083],[sinkX+.042,.080,fanZ+.012]],
    [[.117,.050,.080],[.107,.044,.092],[.084,.044,.092],[sinkX+.044,.082,fanZ+.010]],
  ];
  for(const [i,points] of leads.entries()){
    mesh('Sleeved fan lead',tubeGeometry(new CatmullRomCurve3(points),30,.00175,8),i?charcoal:resin,[0,0,0]);
  }

  const airGeometry=toGeometry(roundedBoxGeometry(.0010,.0010,.015,1,.00048));
  const streams=Array.from({length:27},(_,i)=>mesh('Air direction marker',airGeometry,outflow,
    [0,0,0],null,false));
  streams.forEach((mesh)=>{mesh.visible=false;});

  let lastMode=true,tintKey='',airShown=false;
  return {
    render(state, fan, angle, flowClock, thermal, hideFlow) {
      if(thermal!==lastMode){
        chip.setMaterial(thermal?heatChip:dummyChip);
        spreader.setMaterial(thermal?heatSpreader:copper);
        slug.setMaterial(thermal?heatSpreader:copper);
        fins.forEach((parts,i)=>parts.forEach((part)=>part.setMaterial(thermal?heatFin[i]:aluminium)));
        lastMode=thermal;
      }
      const key=thermal?state.map((value)=>Math.round(value*2)).join(','):'';
      if(thermal&&key!==tintKey){
        heatChip.set({color:temperatureColor(state[0])});
        heatSpreader.set({color:temperatureColor(state[1])});
        for(let i=0;i<cells;i++)heatFin[i].set({color:temperatureColor(state[2+i])});
      }
      tintKey=key;
      rotor.setQuaternion(axisAngleToQuaternion(Z,angle%tau));
      const active=fan>.026&&!hideFlow;
      if(active!==airShown){
        streams.forEach((mesh)=>{mesh.visible=active;});
        airShown=active;
      }
      if(active){
        streams.forEach((mesh,i)=>{
          const lane=i%9;
          const phase=(flowClock+i*.371)%1;
          const x=sinkX+(lane-4)*.0114;
          const y=finFloor+.010+(i%3)*.011;
          const z=.125-phase*.267;
          mesh.setPosition([x,y,z]).setScale([1,1,.54+fan*.7]);
        });
      }
    },
  };
}
