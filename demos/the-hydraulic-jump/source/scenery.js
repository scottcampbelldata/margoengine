import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry,latheGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4, mergeGeometries } from '@margoengine/geometry/utils';
import { Material, MatcapMaterial, Texture } from '@margoengine/materials';
import { bed, inlet, outlet, width } from './hydraulics.js';

const place=(shape,[x,y,z],angle=0)=>{
  const s=Math.sin(angle),c=Math.cos(angle);
  return applyMatrix4(shape,[c,s,0,0,-s,c,0,0,0,0,1,0,x,y,z,1]);
};
const block=(w,h,d,pos,r=.009,angle=0)=>place(roundedBoxGeometry(w,h,d,1,r),pos,angle);
const turn=(r1,r2,h,xyz,n=32)=>place(cylinderGeometry(r1,r2,h,n,1),xyz);
const pointBolt=([x,y,z],r=.011)=>applyMatrix4(cylinderGeometry(r,r,.009,8,1),
  [1,0,0,0,0,0,1,0,0,-1,0,0,x,y,z,1]);

export function rgb(hex){
  return Array.from({length:3},(_,i)=>{
    const c=parseInt(hex.slice(1+i*2,3+i*2),16)/255;
    return c<=.04045?c/12.92:((c+.055)/1.055)**2.4;
  });
}
export const shade=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);

function cyclorama(){
  const paper=rgb('#9e9992'),base=rgb('#514843'),high=rgb('#796761');
  const geometry={positions:[],normals:[],colors:[],indices:[]};
  const rows=[[-.022,5,0,paper],[-.022,.8,0,paper],[-.022,-.60,0,base]];
  for(let i=1;i<=24;i++){
    const t=Math.PI*i/48;
    rows.push([-.022+1.22*(1-Math.cos(t)),-.60-1.22*Math.sin(t),t,shade(base,high,Math.sin(t))]);
  }
  rows.push([6,-1.82,Math.PI/2,high]);
  for(const [i,[y,z,t,c]] of rows.entries()){
    for(const x of [-8,8]){
      geometry.positions.push(x,y,z);
      geometry.normals.push(0,Math.cos(t),Math.sin(t));geometry.colors.push(...c);
    }
    if(i){const k=2*(i-1);geometry.indices.push(k,k+1,k+2,k+1,k+3,k+2);}
  }
  return geometry;
}

function enclosure(join,mat){
  join(cyclorama(),mat.studio,'Warm plaster sweep','receive');
  join([
    block(3.42,.091,.86,[0,.030,.012],.026),
    block(3.33,.016,.78,[0,.079,.012],.019),
  ],mat.stone,'Honed mineral specimen table','cast');
  join([
    block(3.25,.036,.038,[0,.164,.213]),
    block(3.25,.036,.038,[0,.164,-.213]),
    ...[-1.33,-.48,.48,1.33].flatMap(x=>[
      block(.088,.021,.515,[x,.100,0],.007),block(.105,.052,.478,[x,.211,0],.009),
      ...[-1,1].map(s=>block(.044,.113,.045,[x,.160,s*.186],.006,s*.14)),
    ]),
    block(3.15,.036,.418,[-.013,bed-.018,0],.007),
    block(3.18,.037,.026,[-.013,bed-.005,.190],.009),
    block(3.18,.036,.026,[-.013,bed-.006,-.190],.009),
    ...[-1.49,1.47].map(x=>block(.025,.034,.40,[x,bed-.006,0],.005)),
  ],mat.frame,'Continuous enamel chassis, rails and cross braces','cast-only');
  join([
    block(outlet-inlet,.006,width,[(outlet+inlet)/2,bed-.003,0],.002),
    block(3.11,.341,.020,[-.013,bed+.168,-.155],.005),
    block(3.16,.017,.042,[-.013,bed+.339,-.160],.006),
    block(3.16,.009,.015,[-.013,bed+.015,-.145],.002),
  ],mat.interior,'Glazed channel bed and rear wall','cast-only');

  const windows=[[-1.408,-.760], [.698,1.427]];
  join(windows.map(([a,b])=>block(b-a,.326,.006,[(a+b)/2,bed+.164,.160],.002)),mat.glass,
    'Ground glass front sections',undefined,6);
  join(windows.flatMap(([a,b])=>[
    block(b-a,.009,.014,[(a+b)/2,bed+.327,.160],.003),
    block(b-a,.009,.013,[(a+b)/2,bed+.008,.160],.003),
    ...[a,b].map(x=>block(.016,.333,.020,[x,bed+.166,.160],.004)),
  ]),mat.chrome,'Glass seams with machined caps');
  join([
    ...[-1.408,-.759,.699,1.427].flatMap(x=>[bed+.041,bed+.308].map(y=>pointBolt([x,y,.173],.009))),
    ...[-1.33,-.48,.48,1.33].flatMap(x=>[-.199,.199].map(z=>turn(.012,.013,.009,[x,.116,z],8))),
    block(.215,.042,.006,[-1.143,.031,.445],.004),
    ...[-1.235,-1.051].map(x=>pointBolt([x,.031,.450],.008)),
  ],mat.chrome,'Stainless fasteners and specimen plate');
}

function headworks(join,mat){
  join([
    block(.331,.404,.443,[-1.54,bed+.207,0],.021),
    block(.100,.068,.366,[-1.31,bed+.067,0],.005),
    block(.240,.051,.443,[1.469,bed+.001,0],.012),
    block(.052,.363,.411,[1.552,bed+.173,0],.013),
    block(.085,.370,.048,[1.410,bed+.173,-.186],.009),
    block(.085,.370,.048,[1.410,bed+.173,.185],.009),
    block(.168,.041,.418,[1.465,bed+.350,0],.010),
  ],mat.frame,'Inlet still box, sluice frame and receiving gate','cast');
  join([
    block(.343,.024,.455,[-1.54,bed+.411,0],.013),
    block(.075,.050,.317,[-1.334,bed+.061,0],.008),
    block(.027,.040,.324,[-1.291,bed+.049,0],.005),
    block(.132,.006,.284,[-1.572,bed+.427,0],.006),
    block(.011,.023,.291,[1.503,bed+.354,0],.004),
  ],mat.ivory,'Cream caps and convergent inlet lip');
  join([
    turn(.052,.052,.018,[-1.558,bed+.438,0],22),
    turn(.025,.025,.119,[-1.558,bed+.487,0],18),
    turn(.055,.055,.025,[-1.558,bed+.551,0],34),
    turn(.017,.017,.050,[-1.558,bed+.582,0],18),
    turn(.061,.061,.020,[1.462,bed+.387,0],29),
    turn(.022,.022,.049,[1.462,bed+.417,0],16),
    ...[-1.646,-1.428].flatMap(x=>[-.157,.157].map(z=>turn(.012,.012,.008,[x,bed+.439,z],8))),
  ],mat.brass,'Brass fittings and tailgate handwheel');
  const profile=[[.023,-.062],[.027,-.062],[.027,-.047],[.023,-.044],[.023,.062],[.027,.062],
    [.027,.074],[.016,.074],[.016,.069]];
  join(place(latheGeometry(profile,32),[-1.613,bed+.482,-.003],-.5*Math.PI),mat.chrome,'Inlet union ferrule');
}

function gauges(join,mat){
  const rules=[],ticks=[],plates=[];
  for(const x of [-.938,1.173]){
    rules.push(block(.061,.327,.013,[x,bed+.158,-.134],.004));
    plates.push(block(.068,.020,.020,[x,bed+.325,-.131],.004));
    for(let i=0;i<32;i++){
      const major=i%5===0;
      ticks.push(block(major?.034:.015,major?.0023:.0012,.0015,
        [x+.023-(major?.016:.008),bed+i*.010,-.126],.0003));
    }
  }
  join(rules,mat.ivory,'Wet depth rules');
  join(ticks,mat.ink,'Calibrated ten millimetre graduation marks');
  join(plates,mat.brass,'Ruler retainers');
}

function reflector(){
  const size=64,data=new Uint8Array(size*size*4);
  for(let j=0;j<size;j++)for(let i=0;i<size;i++){
    const u=(i+.5)/size*2-1,v=(j+.5)/size*2-1;
    const softbox=Math.exp(-3*((u+.53)/.40)**4-1.6*((v-.12)/.67)**4);
    const edge=Math.exp(-2.6*((u-.49)/.19)**4-1.1*((v-.16)/.57)**4);
    const at=4*(i+j*size);
    for(let c=0;c<3;c++)data[at+c]=Math.min(253,[86,104,107][c]+[156,133,112][c]*softbox+[67,90,128][c]*edge);
    data[at+3]=255;
  }
  return new Texture({width:size,height:size,data},{colorSpace:'srgb',magFilter:'linear',minFilter:'linear'});
}

export function setDressing(add){
  const mirror=reflector();
  const mat={
    studio:new Material({color:'#e0d6d1',roughness:.85}),
    stone:new Material({color:'#5a4e48',roughness:.71}),
    frame:new Material({color:'#2d484e',roughness:.44}),
    interior:new Material({color:'#486c60',roughness:.39}),
    glass:new MatcapMaterial({color:'#e5f1d1',matcap:mirror,opacity:.13,transparent:true,depthWrite:false}),
    chrome:new MatcapMaterial({color:'#ceeeec',matcap:mirror}),
    ivory:new Material({color:'#daccaa',roughness:.30}),
    brass:new MatcapMaterial({color:'#e6b36e',matcap:mirror}),
    ink:new Material({shading:'basic',color:'#263139'}),
  };
  const join=(shapes,...args)=>add(Array.isArray(shapes)?mergeGeometries(shapes):shapes,...args);
  enclosure(join,mat);
  headworks(join,mat);
  gauges(join,mat);
  return {dispose(){for(const m of Object.values(mat))m.dispose();mirror.dispose();}};
}
