import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry,latheGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4,mergeGeometries } from '@margoengine/geometry/utils';
import { Material,MatcapMaterial,Texture } from '@margoengine/materials';
import { referenceY } from './rise.js';

export const color=hex=>Array.from({length:3},(_,i)=>{
  const a=parseInt(hex.slice(1+2*i,3+2*i),16)/255;
  return a<=.04045?a/12.92:((a+.055)/1.055)**2.4;
});
const mix=(a,b,k)=>a.map((v,i)=>v+(b[i]-v)*k);
const unit=a=>{const d=Math.hypot(...a);return a.map(v=>v/d);};
const cross=([a,b,c],[d,e,f])=>[b*f-c*e,c*d-a*f,a*e-b*d];
const tau=Math.PI*2;
export const shape=(mesh,[x,y,z])=>applyMatrix4(mesh,[1,0,0,0,0,1,0,0,0,0,1,0,x,y,z,1]);
export const box=(w,h,d,p,r=.006)=>shape(roundedBoxGeometry(w,h,d,1,r),p);
export const profile=(p,xyz,n=30)=>shape(latheGeometry(p,n),xyz);
export const cylinder=(r,h,p,n=20)=>shape(cylinderGeometry(r,r,h,n,1),p);

function rod(a,b,r,n=8){
  const direction=b.map((v,i)=>v-a[i]),height=Math.hypot(...direction),up=unit(direction);
  const east=unit(cross(up,Math.abs(up[2])<.88?[0,0,1]:[0,1,0])),north=cross(east,up);
  const middle=a.map((v,i)=>(v+b[i])*.5);
  return applyMatrix4(cylinderGeometry(r,r,height,n,1),[...east,0,...up,0,...north,0,...middle,1]);
}

export function studioMap(base,k){
  const size=64,data=new Uint8Array(size*size*4);
  for(let j=0;j<size;j++)for(let i=0;i<size;i++){
    const x=2*(i+.5)/size-1,y=2*(j+.5)/size-1;
    const key=Math.exp(-2*((x+.48)/.26)**4-1.25*((y-.10)/.68)**4);
    const rim=Math.exp(-2*((x-.49)/.13)**4-1.56*((y-.05)/.56)**4);
    const floor=Math.exp(-2*((x+.09)/.51)**4-1.5*((y+.58)/.16)**4);
    const at=4*(j*size+i);
    for(let c=0;c<3;c++)data[at+c]=Math.min(250,base[c]+k[c]*key+[45,74,83][c]*rim+[51,44,31][c]*floor);
    data[at+3]=255;
  }
  return new Texture({width:size,height:size,data},{colorSpace:'srgb',magFilter:'linear',minFilter:'linear'});
}

const tiles=['#bdb5a0','#9ca59a','#aea68d','#c4baa6','#a29d87'].map(color);
function flagstones(){
  const g={positions:[],normals:[],colors:[],indices:[]};
  const b=roundedBoxGeometry(.107,.016,.106,1,.003);
  for(let iz=0;iz<11;iz++)for(let ix=0;ix<14;ix++){
    const x=-.765+.110*ix,z=-.495+.109*iz;
    const v=g.positions.length/3;
    const tint=tiles[(ix*7+iz*13+((ix+iz)%3))%tiles.length];
    for(let k=0;k<b.positions.length;k+=3){
      const h=b.positions[k+1]<.007?.88:1;
      g.positions.push(b.positions[k]+x,b.positions[k+1]-.009,b.positions[k+2]+z);
      g.normals.push(b.normals[k],b.normals[k+1],b.normals[k+2]);
      g.colors.push(...tint.map(x=>x*h));
    }
    for(const i of b.indices)g.indices.push(i+v);
  }
  return g;
}

function panes(){
  const g={positions:[],normals:[],colors:[],indices:[]};
  const outside=color('#b7c9a8'),top=color('#e9f3cf'),bottom=color('#527664');
  const spans=46,rows=24,z=-.378;
  for(let j=0;j<=rows;j++)for(let i=0;i<=spans;i++){
    const x=-.90+1.8*i/spans,y=.7*j/rows;
    const glimmer=Math.exp(-(Math.hypot((x+.26)*3.4,(y-.32)*3.1)**2));
    const garden=(.5+.5*Math.sin(x*20+.6*Math.sin(y*13)))*Math.max(0,1-y*4);
    const falloff=.38*Math.exp(-(Math.hypot((x+.39)*4.5,(y-.43)*6.5)**2));
    const streak=.13*Math.exp(-(((x+.72*y+.22)/.086)**2));
    const reflection=.12*Math.exp(-(((x+.75*y-.13)/.12)**2));
    const c=mix(mix(outside,bottom,.56*garden),top,.12+.35*glimmer+falloff+streak+reflection);
    g.positions.push(x,y,z);g.normals.push(0,0,1);g.colors.push(...c);
    if(i&&j){const d=i+j*(spans+1),c=d-1,b=d-(spans+1),a=b-1;g.indices.push(a,b,c,b,d,c);}
  }
  return g;
}

function ironwork(join,m){
  const main=[],trim=[],seats=[];
  for(const z of [-.317,-.268]){
    for(const s of [-1,1]){
      main.push(rod([s*.335,.011,z],[s*.335,.230,z],.0064,10));
      seats.push(box(.043,.011,.029,[s*.335,.010,z],.005));
    }
    const segments=26;
    for(let i=0;i<segments;i++){
      const a=Math.PI*i/segments,b=Math.PI*(i+1)/segments;
      const points=[a,b].map(t=>[.335*Math.cos(t),.230+.225*Math.sin(t),z]);
      main.push(rod(...points,.0058,9));
    }
  }
  for(const x of [-.257,-.176,-.088,0,.088,.176,.257]){
    const y=.230+.225*Math.sqrt(1-(x/.335)**2);
    trim.push(rod([x,.016,-.316],[x,y,-.316],.0023,7));
    trim.push(rod([x,y,-.316],[x,y,-.268],.0028,7));
  }
  for(const y of [.082,.228,.313]){
    const half=y>.23?.335*Math.sqrt(1-((y-.23)/.225)**2):.335;
    trim.push(rod([-half,y,-.316],[half,y,-.316],.0028,8));
  }
  join(main,m.iron,'Curved iron ribs','cast');
  join(trim,m.mullion,'Slender greenhouse glazing bars');
  join(seats,m.stone,'Stone frame footings');
  join(panes(),m.windows,'Backlit glazing and garden light');
  join([
    box(.791,.027,.076,[0,.010,-.297],.010),
    box(.777,.013,.069,[0,.055,-.307],.006),
  ],m.stone,'Low conservatory sill');
}

function leaves(p,scale,count){
  const structure=[],geometry={positions:[],normals:[],colors:[],indices:[]};
  const dark=color('#214c39'),leaf=color('#517c44'),back=color('#839b5b'),vein=color('#a2a17d');
  const [tx,ty,tz]=p;
  for(let k=0;k<count;k++){
    const angle=k*2.39996+.65,reach=scale*(.25+.17*Math.sin(k*7.3)**2);
    const h=scale*(.49+.54*Math.sin(k*3.8+.93)**2);
    const dx=Math.cos(angle),dz=Math.sin(angle);
    const at=t=>[tx+dx*reach*t*t,ty+h*t,tz+dz*reach*t*t];
    structure.push(rod(at(0),at(.52),scale*.0088),rod(at(.52),at(1),scale*.0064));
    const leaves=k===0?1:2;
    for(let index=0;index<leaves;index++){
      const a=at(.63+index*.24);
      const side=index===1?-.56:.59;
      const head=[dx*Math.cos(side)-dz*Math.sin(side),dz*Math.cos(side)+dx*Math.sin(side)];
      const length=scale*(.30+.17*Math.sin(k*7.19+index)**2);
      const width=length*(.19+.14*Math.sin(k*5.2)**2);
      const yaw=[head[1],0,-head[0]];
      const first=geometry.positions.length/3;
      const lift=(.07+.20*Math.sin(k*4.2)**2)*length;
      for(let i=0;i<=7;i++){
        const s=i/7,w=width*Math.max(.006,Math.sin(Math.PI*s)**.9);
        const y=a[1]+lift*s+.22*length*Math.sin(Math.PI*s)-.15*length*s*s;
        for(const j of [-1,0,1]){
          const pos=[a[0]+head[0]*length*s+yaw[0]*j*w,y-.27*Math.abs(j)*w,a[2]+head[1]*length*s+yaw[2]*j*w];
          geometry.positions.push(...pos);
          const n=unit([head[0]*(s-.29)*.75+yaw[0]*j*.24,1,head[1]*(s-.29)*.75+yaw[2]*j*.24]);
          geometry.normals.push(...n);
          geometry.colors.push(...mix(dark,j===0?vein:j===-1?leaf:back,(j===0?.54:.61)+.20*s));
        }
        if(i){
          const b=first+(i-1)*3,c=b+3;
          for(let j=0;j<2;j++){
            geometry.indices.push(b+j,b+j+1,c+j,c+j,b+j+1,c+j+1);
            geometry.indices.push(b+j,c+j,b+j+1,c+j,c+j+1,b+j+1);
          }
        }
      }
    }
  }
  return {structure,geometry};
}

function plants(join,m){
  const pots=[],soil=[],stems=[];
  for(const [x,z,s,n] of [[-.255,-.126,.104,10],[.259,-.098,.149,12],[-.369,-.217,.119,10],[.373,-.225,.140,12]]){
    const radius=s*.32,h=s*.40;
    pots.push(profile([[0,0],[radius*.70,0],[radius*.77,.003],[radius*.89,h*.82],[radius*.99,h*.85],
      [radius,h*.97],[radius*.94,h],[radius*.86,h],[radius*.81,h*.79],[radius*.70,.008],[0,.008]],[x,.007,z],32));
    soil.push(cylinder(radius*.85,.004,[x,.007+h*.88,z],28));
    const plant=leaves([x,.007+h*.91,z],s,n);
    stems.push(...plant.structure);
    join(plant.geometry,m.leaf,'Hand-shaped botanical foliage');
  }
  join(pots,m.pot,'Throwing-ring ceramic planters','cast');
  join(soil,m.soil,'Potting surfaces');
  join(stems,m.stem,'Botanical stems');
}

function vessel(join,m){
  join([
    box(.413,.032,.184,[0,.017,.018],.011),
    box(.388,.011,.168,[0,.038,.018],.009),
    box(.366,.020,.118,[0,.057,.021],.005),
  ],m.stone,'Honed laboratory pedestal','cast');
  join([
    box(.367,.011,.121,[0,.047,.021],.008),
    box(.354,.010,.112,[0,.071,.021],.006),
    box(.354,.040,.011,[0,.092,-.049],.004),
    ...[-.18,.18].map(x=>box(.012,.040,.132,[x,.092,.012],.005)),
  ],m.glaze,'Deep glazed supply trough','cast');
  join(box(.347,.022,.115,[0,referenceY-.011,.013],.0025),m.bath,'Reservoir water and parallel surface');
  join(box(.360,.034,.005,[0,.092,.073],.0019),m.frontGlass,'Viewing pane at the water datum',undefined,6);
  join([
    box(.365,.0040,.006,[0,referenceY+.009,.073],.001),
    box(.367,.0020,.005,[0,referenceY,.076],.0008),
    box(.360,.004,.008,[0,.075,.073],.001),
  ],m.patina,'Glazed edge and reservoir datum');
  const support=[];
  for(const x of [-.175,.175]){
    support.push(cylinder(.004,.132,[x,.158,-.027],16),cylinder(.009,.006,[x,.103,-.027],18),
      cylinder(.006,.006,[x,.225,-.027],18));
  }
  support.push(rod([-.179,.215,-.027],[.179,.215,-.027],.0043,12));
  join(support,m.brass,'Brass riser gantry');
  const tick=[];
  for(let i=0;i<=10;i++){
    const distance=i*.010;
    tick.push(box(i%5===0?.025:.012,.0015,.0019,[-.200+(i%5===0?.0065:0),referenceY+distance,.029],.0004));
  }
  join(box(.025,.111,.007,[-.199,referenceY+.051,.024],.002),m.patina,'Centimetre scale');
  join(tick,m.letter,'Graduated height ticks');
}

export function makeGarden(add,maps){
  const m={
    floor:new Material({color:'#d3c6ad',roughness:.69}),
    mortar:new Material({color:'#515854',roughness:.74}),
    windows:new Material({color:'#d7e7cf',shading:'basic'}),
    iron:new Material({color:'#5c6f64',roughness:.56}),
    mullion:new Material({color:'#7d8870',roughness:.62}),
    stone:new Material({color:'#b3a897',roughness:.43}),
    glaze:new Material({color:'#355f60',roughness:.22}),
    bath:new MatcapMaterial({color:'#70b6b7',matcap:maps.water}),
    frontGlass:new MatcapMaterial({color:'#a1ded4',matcap:maps.metal,opacity:.19,transparent:true,depthWrite:false}),
    patina:new MatcapMaterial({color:'#8dac98',matcap:maps.metal}),
    letter:new Material({color:'#ede3be',shading:'basic'}),
    brass:new MatcapMaterial({color:'#dbb275',matcap:maps.metal}),
    pot:new Material({color:'#985d47',roughness:.51}),
    soil:new Material({color:'#52443a',roughness:.89}),
    stem:new Material({color:'#718c57',roughness:.66}),
    leaf:new Material({color:'#aaba88',roughness:.58}),
  };
  const join=(g,...args)=>add(Array.isArray(g)?mergeGeometries(g):g,...args);
  join(box(8,.03,8,[0,-.029,0],.005),m.mortar,'Conservatory subfloor','receive');
  join(flagstones(),m.floor,'Honed variegated floor tiles','receive');
  ironwork(join,m);plants(join,m);vessel(join,m);
  return {dispose(){for(const mat of Object.values(m))mat.dispose();}};
}
