import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry,latheGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4,mergeGeometries } from '@margoengine/geometry/utils';
import { Material } from '@margoengine/materials';
import { bed,farZ,leftX,mouthX,nearZ,seaX,surface } from './estuary.js';

export const landEnd=.530,deep=-.383;
const tau=Math.PI*2;
const box=(w,h,d,x,y,z,r=.003,angle=0)=>place(roundedBoxGeometry(w,h,d,1,r),x,y,z,angle);
const cylinder=(a,b,h,x,y,z,n=20)=>place(cylinderGeometry(a,b,h,n,1),x,y,z);
const lathe=(p,x,y,z,n=26)=>place(latheGeometry(p,n),x,y,z);
function place(g,x,y,z,angle=0){
  const s=Math.sin(angle),c=Math.cos(angle);
  return applyMatrix4(g,[c,s,0,0,-s,c,0,0,0,0,1,0,x,y,z,1]);
}
export function color(hex){
  return Array.from({length:3},(_,i)=>{
    const v=parseInt(hex.slice(2*i+1,2*i+3),16)/255;
    return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
  });
}
export const mix=(a,b,t)=>a.map((v,i)=>v+t*(b[i]-v));
const cap=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
const exp=(x,scale)=>Math.exp(-((x/scale)**2));
const unit=a=>{const m=Math.hypot(...a);return a.map(v=>v/m);};
const seaBreeze=Math.PI*.30;

function stage(){
  const g={positions:[],normals:[],colors:[],indices:[]};
  const sand=color('#a9ac9f'),behind=color('#647e7a'),air=color('#829d97');
  const rows=[[-.019,4.0,0,sand],[-.019,.39,0,sand],[-.019,-.52,0,behind]];
  for(let i=1;i<=20;i++){
    const t=Math.PI*i/40;
    rows.push([-.019+.82*(1-Math.cos(t)),-.52-.82*Math.sin(t),t,mix(behind,air,Math.sin(t))]);
  }
  rows.push([5,-1.34,Math.PI/2,air]);
  for(const [i,[y,z,angle,c]] of rows.entries()){
    for(const x of [-6,6]){
      g.positions.push(x,y,z);g.normals.push(0,Math.cos(angle),Math.sin(angle));g.colors.push(...c);
    }
    if(i){const k=(i-1)*2;g.indices.push(k,k+1,k+2,k+1,k+3,k+2);}
  }
  return g;
}

function slope(x,z){
  const u=cap((farZ-z)/(farZ-deep));
  const steep=.048+.144*exp(x+.384,.245)+.098*exp(x-.34,.163);
  const edge=cap((landEnd-x)/.075);
  const ridge=(.008*Math.sin(47*x+6*z)+.009*Math.sin(x*30+18*z))*u;
  return surface+.003+edge*(steep*Math.sin(u*Math.PI*.55)**.79+ridge);
}

function bank(){
  const m={positions:[],normals:[],colors:[],indices:[]};
  const grass=color('#506e5d'),meadow=color('#9ba174'),rock=color('#a49576'),sand=color('#d3b992');
  const cols=88,rows=27;
  for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
    const x=leftX+(landEnd-leftX)*i/cols,z=farZ+(deep-farZ)*j/rows,h=slope(x,z);
    const dx=(slope(x+.0008,z)-slope(x-.0008,z))/.0016;
    const dz=(slope(x,z+.0008)-slope(x,z-.0008))/.0016;
    const texture=.5+.5*Math.sin(29*x+45*z+1.4*Math.sin(21*x-34*z));
    const mud=cap((h-surface-.018)/.056);
    const bare=cap((Math.hypot(dx,dz)-.64)*.77+.14*texture);
    const grain=.5+.5*Math.sin(209*x-169*z+2.7*Math.sin(x*159+29*z));
    const dryGrass=.50+.50*Math.sin(39*x-76*z+1.6*Math.sin(x*27+z*95));
    const shade=.11+.47*texture+.20*dryGrass+.13*grain;
    const c=mix(mix(sand,mix(grass,meadow,shade),mud),rock,cap(bare+.12*grain));
    m.positions.push(x,h,z);m.normals.push(...unit([-dx,1,-dz]));m.colors.push(...c);
    if(i&&j){
      const d=i+j*(cols+1),c=d-1,b=d-cols-1,a=b-1;
      m.indices.push(a,b,c,b,d,c);
    }
  }
  return m;
}

function capSediment(side){
  const g={positions:[],normals:[],colors:[],indices:[]};
  const brown=color('#7b5f4d'),ash=color('#aca396'),tan=color('#bf9b71'),black=color('#4f574c');
  const d=side==='cut'?nearZ+.00045:farZ-.0005;
  const left=leftX-.002,right=side==='cut'?seaX:landEnd;
  const bottom=side==='cut'?.019:bed,rows=18,cols=145;
  for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
    const u=i/cols,t=j/rows,x=left+(right-left)*u;
    const top=side==='cut'?bed:slope(x,d);
    const y=bottom+(top-bottom)*t;
    const curl=.034*Math.sin(11*x)+.013*Math.sin(54*x+3*t);
    const narrow=.66*Math.sin((t+curl)*70+.56*Math.sin(44*x));
    const broad=.5+.5*Math.sin((t+curl)*18.3);
    const grain=.5+.5*Math.sin(178*x+243*t+2.7*Math.sin(47*x-54*t));
    const c=mix(mix(brown,tan,.14+.50*broad+.24*grain),j<14?ash:black,Math.max(0,narrow)*.63);
    g.positions.push(x,y,d);g.normals.push(0,0,1);g.colors.push(...c);
    if(i&&j){
      const q=i+j*(cols+1),r=q-1,b=q-(cols+1),a=b-1;
      g.indices.push(a,b,r,b,q,r);
    }
  }
  return g;
}


function climb(){
  const g={positions:[],normals:[],colors:[],indices:[]};
  const start=farZ-.010,end=-.158;
  const sand=color('#bdae8a'),edge=color('#928e6a');
  for(let i=0;i<=26;i++){
    const t=i/26,z=start+(end-start)*t;
    const x=.445-.058*t+.015*Math.sin(Math.PI*1.48*t);
    const w=(.005+.003*Math.sin(t*Math.PI))*.5;
    for(const s of [-1,0,1]){
      const at=x+s*w;
      g.positions.push(at,slope(at,z)+.0011,z);
      g.normals.push(0,1,0);
      g.colors.push(...mix(sand,edge,Math.abs(s)*.45+.15*Math.sin(i*4.1)));
    }
    if(i){
      const k=(i-1)*3;
      for(let j=0;j<2;j++){
        const a=k+j,b=a+1,c=a+3,d=c+1;
        g.indices.push(a,b,c,b,d,c);
      }
    }
  }
  return g;
}

function trees(join,mat){
  const barks=[],patches=[];
  const sites=[[-.59,-.226,.067],[-.55,-.246,.089],[-.49,-.280,.102],[-.43,-.268,.081],[-.37,-.301,.105],
    [-.30,-.269,.078],[-.53,-.158,.061],[-.23,-.204,.051],[-.14,-.331,.072],[.145,-.298,.053],[.222,-.303,.050],
    [.262,-.291,.059],[-.61,-.32,.093],[-.401,-.33,.104]];
  for(const [x,z,h] of sites){
    const y=slope(x,z);
    barks.push(cylinder(.0021,.0038,h*.77,x,y+h*.38,z,7));
    for(let rank=0;rank<3;rank++){
      const radii=[.275,.228,.161],r=h*radii[rank];
      const trunk=y+h*(.33+rank*.172),height=h*(.42-rank*.098);
      const profile=[[r*.17,0],[r,.09*height],[r*.83,.16*height],[r*.71,.32*height],
        [r*.56,.40*height],[r*.50,.53*height],[r*.38,.61*height],[r*.20,.77*height],[0,height]];
      patches.push(lathe(profile,x+(.15-rank*.18)*r,trunk,z,10));
    }
  }
  join(barks,mat.bark,'Fir trunks');
  join(patches,mat.forest,'Wind-broken fir silhouettes','cast');
}

function reeds(){
  const g={positions:[],normals:[],colors:[],indices:[]};
  const bark=color('#735e38'),leaf=color('#a5a870');
  for(let i=0;i<250;i++){
    const t=(i*93%251)/250;
    const x=leftX+.05+(landEnd-leftX-.11)*t;
    const band=Math.sin(x*37.1)*.0076+.022;
    const z=farZ-band-.016*((i*303%253)/252);
    if(Math.abs(Math.sin(i*7.85+x*14.2))<.28)continue;
    const y=slope(x,z);
    const height=.012+.023*Math.sin(i*11.16)**2;
    const lean=.003+.008*Math.sin(i*27.1)**2;
    const v=g.positions.length/3;
    const d=i*2.39996;
    const slopeAngle=d+seaBreeze*.31;
    for(let j=0;j<4;j++){
      const f=j/3,width=.0009*(1-.80*f);
      const X=x+Math.cos(slopeAngle)*lean*f*f,Z=z+Math.sin(slopeAngle)*lean*f*f;
      for(const sign of [-1,1]){
        g.positions.push(X+sign*width*Math.sin(d),y+height*f,Z+sign*width*Math.cos(d));g.normals.push(.33,.38,.86);
        g.colors.push(...mix(bark,leaf,.18+f*.78));
      }
      if(j){
        const a=v+2*(j-1),b=a+1,c=a+2,e=c+1;
        g.indices.push(a,b,c,b,e,c,c,b,a,c,e,b);
      }
    }
  }
  return g;
}

function headland(join,mat){
  const lightX=.383,z=-.147,level=slope(lightX,z);
  const foot=level+.002;
  join([
    lathe([[0,0],[.027,0],[.028,.005],[.022,.008],[.019,.076],[.022,.078],[.023,.084],[0,.084]],lightX,foot,z,34),
    box(.051,.033,.031,lightX-.060,foot+.014,z-.008,.002),
    ...[-.012,.012].map(x=>box(.010,.005,.026,lightX+x,foot+.006,z+.022,.001)),
  ],mat.paint,'White coastal beacon and watch shelter','cast');
  join([
    cylinder(.013,.013,.020,lightX,foot+.094,z,22),
    box(.058,.026,.019,lightX-.060,foot+.033,z-.006,.001,-.43),
    box(.058,.026,.019,lightX-.060,foot+.033,z-.006,.001,.43),
    lathe([[.015,0],[.017,.002],[.017,.005],[.010,.015],[.003,.019],[0,.020]],lightX,foot+.104,z,30),
  ],mat.roof,'Copper roof and lantern cupola');
  const cabin=[];
  for(let k=0;k<8;k++){
    const t=k*tau/8;
    cabin.push(cylinder(.00105,.00105,.024,lightX+.015*Math.cos(t),foot+.094,z+.015*Math.sin(t),8));
  }
  join(cabin,mat.rail,'Lantern window mullions');
  join(cylinder(.005,.005,.014,lightX,foot+.095,z,14),mat.lamp,'Beacon lamp');
  join(climb(),mat.rock,'Weathered path from the jetty');
  join(lathe([[0,-.003],[.007,-.003],[.008,.004],[.006,.009],[.003,.012],[.0021,.025],[0,.025]],mouthX,surface,.017,18),mat.roof,'Survey buoy at the modeled mouth');
  const pier=[];
  for(let k=0;k<13;k++){
    const z=farZ+.019-k*.007;
    pier.push(box(.065,.0031,.0058,.445,surface+.016,z,.0008));
    if(k%4===0)for(const x of [.420,.469]){
      pier.push(cylinder(.0025,.0025,.058,x,surface-.009,z,9));
    }
  }
  join(pier,mat.wharf,'Survey jetty planks');
}

export function makeCoast(add){
  const m={
    studio:new Material({color:'#e0ddca',roughness:.83}),
    plinth:new Material({color:'#4f605c',roughness:.51}),
    sand:new Material({color:'#b79872',roughness:.79}),
    soil:new Material({color:'#dfc4a9',roughness:.73}),
    rock:new Material({color:'#d4d2ab',roughness:.72}),
    marsh:new Material({color:'#acba95',roughness:.69}),
    bark:new Material({color:'#594832',roughness:.67}),
    forest:new Material({color:'#47614a',roughness:.63}),
    paint:new Material({color:'#e0d7b8',roughness:.50}),
    roof:new Material({color:'#a3583e',roughness:.41}),
    lamp:new Material({color:'#ebbe71',shading:'basic'}),
    rail:new Material({color:'#34464b',roughness:.58}),
    wharf:new Material({color:'#927251',roughness:.69}),
  };
  const join=(geometry,...args)=>add(Array.isArray(geometry)?mergeGeometries(geometry):geometry,...args);
  join(stage(),m.studio,'Coastal studio sweep','receive');
  join(box(seaX-leftX+.062,.041,.506,(seaX+leftX)*.5,.007,-.145,.015),m.plinth,'Sediment section plinth','cast');
  join(box(seaX-leftX,.097,.462,(seaX+leftX)*.5,.065,-.160,.012),m.sand,'Closed sediment block','cast');
  join(capSediment('cut'),m.soil,'Front geological section');
  join(capSediment('bank'),m.soil,'Far bank wet ledge');
  join(bank(),m.rock,'Vegetated estuary bank','cast');
  join(reeds(),m.marsh,'Tidal marsh grasses');
  trees(join,m);headland(join,m);
  return {dispose(){for(const material of Object.values(m))material.dispose();}};
}
