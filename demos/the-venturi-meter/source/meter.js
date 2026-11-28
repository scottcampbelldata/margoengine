import { createMesh,MatcapMaterial,Material } from '@margoengine/materials';
import { box,finish,horizontal,label,merge,pipeGlass,pipeWater,round,sweep,vertical } from './craft.js';
import { axisHeight,exitX,feedHead,inletX,internalVolume,radiusAt,taps,tracerAt } from './flow.js';

const toe=.190;
const rim=.485;

function framework(add,mats){
  add(sweep(),mats.sweep,'Slate studio arch and grounded reference shadows','floor');
  add(box(1.322,.031,.382,[0,.000,0],.014),mats.skid,'Warm enamel bench skid','static');
  add(box(1.302,.011,.360,[0,.019,0],.0047),mats.frame,'Inset petroleum grey instrument panel','static');
  add(box(1.273,.0029,.338,[0,.026,0],.00145),mats.panel,'Fine satin mounting sheet','static');
  const collars=[];
  const grip=[];
  const base=[];
  const studs=[];
  for(const x of [-.536,.534]){
    for(const z of [-.144,.144]){
      collars.push(round(.011,.003,[x,.028,z],20));
      grip.push(box(.013,.001,.0015,[x,.0298,z],.00043,.19));
      base.push(round(.030,.009,[x,-.0155,z],18));
    }
    base.push(box(.105,.099,.126,[x,.077,-.004],.010));
    base.push(box(.154,.008,.155,[x,.032,-.004],.0034));
    for(const z of [-.055,.055])studs.push(round(.0071,.006,[x,.039,z],10));
  }
  collars.push(box(.154,.0027,.031,[-.351,.029,.136],.0036));
  grip.push(box(.115,.00065,.0012,[-.353,.03069,.139],.00036));
  for(let i=0;i<12;i++){
    const height=i%4===0?.010:.006;
    grip.push(box(.0010,.00071,height,[-.409+i*.010,.03071,.137-height/2],.00031));
  }
  add(merge(base),mats.frame,'Two cradle castings and floor isolation mounts','static');
  add(merge(collars),mats.brass,'Bench corner screws and scale plate');
  add(merge(grip),mats.dark,'Recessed screw slots and engraving');
  add(merge(studs),mats.nickel,'Fixture bolts');
}

function ferrules(add,mats){
  const sleeve=[];
  const bronze=[];
  const ribs=[];
  const joints=[];
  for(const side of [-1,1]){
    const center=.490*side;
    const x=side<0?center-.105:center-.030;
    sleeve.push(horizontal([[.032,0],[.047,0],[.053,.008],[.053,.091],[.051,.104],[.035,.108],[.032,.108],[.032,0]],
      [x,axisHeight,0],48));
    joints.push(horizontal([[.035,0],[.053,0],[.058,.006],[.058,.017],[.052,.024],[.035,.024]], [center-.012,axisHeight,0],12));
    for(const offset of [-.024,.020]){
      bronze.push(horizontal([[.052,0],[.054,.002],[.054,.008],[.052,.011]],[center+offset,axisHeight,0],44));
    }
    for(const z of [-.046,.046]){
      ribs.push(box(.093,.056,.016,[center,.102,z],.0055));
      sleeve.push(round(.0095,.007,[center,.132,z],12));
    }
    const pipe=side<0?-.614:.565;
    sleeve.push(horizontal([[.029,0],[.033,0],[.036,.006],[.036,.035],[.032,.042],[.029,.042]], [pipe,axisHeight,0],36));
  }
  add(merge(sleeve),mats.nickel,'Machined pipe ferrules and feed couplings','static');
  add(merge(joints),mats.frame,'Hexagonal service unions','static');
  add(merge(bronze),mats.brass,'Brass union trim rings');
  add(merge(ribs),mats.dark,'Rubber-backed cradle cheeks','static');
}

function instruments(add,mats){
  const clamps=[];
  const backers=[];
  const scores=[];
  const brass=[];
  const feet=[];
  const datum=[];
  for(const [i,x] of taps.entries()){
    const neck=.012+radiusAt(x);
    const backingX=x-.035;
    feet.push(box(.076,.020,.076,[backingX,.039,-.069],.007));
    feet.push(box(.025,.425,.021,[backingX,.256,-.077],.0039));
    feet.push(box(.056,.013,.074,[x-.012,.224,-.047],.003));
    feet.push(box(.056,.013,.074,[x-.012,.454,-.047],.003));
    const tapHeight=axisHeight+neck;
    const shank=Math.max(.030,toe-tapHeight+.014);
    brass.push(vertical([[.011,0],[.020,0],[.020,.006],[.017,.010],[.017,shank-.007],[.014,shank],[.011,shank]],
      [x,tapHeight-.009,0],24));
    clamps.push(vertical([[.0148,0],[.021,0],[.022,.004],[.022,.012],[.019,.016],[.0148,.016]],
      [x,.207,0],32));
    clamps.push(vertical([[.0148,0],[.020,0],[.020,.010],[.017,.015],[.0148,.015]],
      [x,.447,0],32));
    const y=.301;
    backers.push(box(.065,.325,.016,[backingX,y,-.033],.0045));
    datum.push(box(.042,.015,.007,[backingX,.458,-.024],.0038));
    scores.push(box(.0012,.294,.0016,[x-.040,.291,-.024],.00035));
    for(let cm=0;cm<=31;cm++){
      const height=axisHeight+cm*.01;
      const len=cm%10===0?.020:cm%5===0?.014:.009;
      scores.push(box(len,.00091,.00183,[x-.038+len/2,height,-.0224],.00032));
      if(cm&&cm%10===0) scores.push(...label(String(cm),[x-.060,height,-.022]));
    }
    datum.push(box(.021,.0020,.003,[x-.009,axisHeight+feedHead,-.020],.0006));
    datum.push(round(.0056,.0027,[backingX,.466,-.024],12));
    for(const y of [.224,.454]){
      brass.push(box(.008,.0031,.012,[x+.020,y,-.014],.00087));
    }
  }
  add(merge(feet),mats.frame,'Two riveted pressure-tube stanchions','static');
  add(merge(backers),mats.dark,'Enamel head scales');
  add(merge(scores),mats.ink,'Calibrated centimeter scale engravings');
  add(merge(datum),mats.nickel,'Scale index plates and baseline marks');
  add(merge(brass),mats.brass,'Correct axial inlet and throat outlets');
  add(merge(clamps),mats.nickel,'Piezometer anti-vibration collars');
}

function columns(add,mats){
  return taps.map(x=>{
    const casing=vertical([[.0108,toe],[.0146,toe],[.0146,rim-.003],
      [.0158,rim-.0006],[.0155,rim+.002],[.0126,rim+.003],[.0108,rim],[.0108,toe]], [x,0,0],44);
    const brim=vertical([[.014,rim-.002],[.0160,rim-.0003],[.0158,rim+.002],[.0118,rim+.003]], [x,0,0],46);
    add(casing,mats.glass,'Open glass pressure column with true bore');
    add(brim,mats.glassLip,'Polished glass tube rim');
    const post=add(vertical([[.0001,0],[.01055,0],[.01055,.99],[.01027,1],[.0001,1]], [0,0,0],34),
      mats.column,'Dyed hydrostatic water column');
    const meniscus=add(vertical([[.0104,-.0008],[.0104,.00025],[.0096,.0011],[.0067,.0003],[.0001,.00013]],
      [0,0,0],38),mats.meniscus,'Visible curved water meniscus');
    return h=>{
      const top=axisHeight+h;
      post.root.setPosition([x,toe,0]);post.root.setScale([1,top-toe,1]);
      meniscus.root.setPosition([x,top,0]);
    };
  });
}

function deltaGuide(add,mats){
  const z=.026;
  const right=.063;
  const upper=[];
  for(let i=0;i<18;i++){
    upper.push(box(.0108,.0019,.0027,[taps[0]+.018+i*.021,0,z],.00066));
  }
  const lower=[];
  for(let i=0;i<4;i++){
    lower.push(box(.0104,.0019,.0027,[taps[1]+.019+i*.019,0,z],.00061));
  }
  upper.push(box(.016,.0019,.0031,[right,0,z],.00072));
  lower.push(box(.016,.0019,.0031,[right,0,z],.00072));
  const top=add(merge(upper),mats.legend,'Upstream hydraulic-grade datum');
  const bottom=add(merge(lower),mats.legend,'Throat waterline datum');
  const bar=add(box(.0018,1,.0024,[right,-.5,z],.00082),mats.legend,'Measured head difference');
  return (settings,visible)=>{
    for(const asset of [top,bottom,bar])asset.root.visible=visible;
    if(!visible)return;
    top.root.setPosition([0,axisHeight+settings.inletHead,0]);
    bottom.root.setPosition([0,axisHeight+settings.throatHead,0]);
    bar.root.setPosition([0,axisHeight+settings.inletHead,0]);
    bar.root.setScale([1,Math.max(settings.dropHead,.0001),1]);
  };
}

function tracers(add,mats){
  const needle=horizontal([[0,-.009],[.0018,-.007],[.0022,-.002],[.0018,.005],
    [.0010,.009],[0,.010]], [0,0,0],9);
  const pieces=Array.from({length:16},()=>add(needle,mats.light,'Dye trace convected at local modeled speed'));
  return (volume,rate)=>{
    for(const [i,mesh] of pieces.entries()){
      const x=tracerAt(volume+internalVolume*(i+.43)/pieces.length);
      const radius=radiusAt(x);
      const transverse=(.29+(i%3-1)*.23)*radius;
      const velocity=rate/(Math.PI*radius**2);
      // Draw the tracer at the front of the water so the dyed core cannot occlude it.
      const near=Math.sqrt(radius**2-transverse**2)+.00041;
      mesh.root.visible=rate>0 && x>inletX+.023 && x<exitX-.023;
      mesh.root.setPosition([x,axisHeight+transverse,near]);
      mesh.root.setScale([.52+Math.min(1.40,.74*velocity),.70,.60]);
    }
  };
}

export function makeMeter(engine,shadows){
  const map=finish();
  const mats={
    sweep:new Material({color:'#e5ebe4',roughness:.92}),
    skid:new Material({color:'#b0a48c',roughness:.61}),
    frame:new Material({color:'#3e5960',roughness:.47}),
    panel:new Material({color:'#566c6c',roughness:.54}),
    dark:new Material({color:'#304448',roughness:.68}),
    ink:new Material({shading:'basic',color:'#e4d6b5'}),
    brass:new MatcapMaterial({color:'#e8ba7a',matcap:map.metal}),
    nickel:new MatcapMaterial({color:'#dae7e5',matcap:map.metal}),
    glass:new MatcapMaterial({color:'#e3f3ee',matcap:map.glass,transparent:true,opacity:.35,depthWrite:false}),
    glassLip:new MatcapMaterial({color:'#dae9e2',matcap:map.glass,transparent:true,opacity:.67,depthWrite:false}),
    liquid:new MatcapMaterial({color:'#87c8d4',matcap:map.water}),
    column:new MatcapMaterial({color:'#97cad1',matcap:map.water}),
    meniscus:new Material({shading:'basic',color:'#a1d9dc'}),
    light:new Material({shading:'basic',color:'#a3f0d3'}),
    legend:new Material({shading:'basic',color:'#e7ba7c'}),
  };
  const all=[];
  const add=(geometry,material,name,role)=>{
    const mesh=createMesh(engine,geometry,material);
    mesh.root.name=name;all.push(mesh);
    if(role==='floor')shadows.add(mesh,{static:true,castShadow:false});
    if(role==='static')shadows.add(mesh,{static:true});
    return mesh;
  };
  framework(add,mats);
  ferrules(add,mats);
  instruments(add,mats);
  const wet=columns(add,mats);
  add(pipeWater(),mats.liquid,'Dye-filled variable-diameter core');
  add(pipeGlass(),mats.glass,'Transparent nested tube with converger, throat and diffuser');
  const guide=deltaGuide(add,mats);
  const flow=tracers(add,mats);
  return {
    update(settings,volume,show){
      wet[0](settings.inletHead);
      wet[1](settings.throatHead);
      guide(settings,show);
      flow(volume,settings.volumeRate);
    },
    anchors:[[-.338,.505,0],[-.024,.505,0]],
    dispose(){for(const mesh of all.reverse())mesh.dispose();for(const material of Object.values(mats))material.dispose();for(const t of Object.values(map))t.dispose();},
  };
}