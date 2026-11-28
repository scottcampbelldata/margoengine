import { roundedBoxGeometry } from '@margoengine/geometry/extras';
import { cylinderGeometry,latheGeometry,torusGeometry } from '@margoengine/geometry/primitives';
import { applyMatrix4,mergeGeometries } from '@margoengine/geometry/utils';
import { Material,MatcapMaterial,Texture } from '@margoengine/materials';
import { ringRadius,startY,trackLength } from './vortex.js';

const tau=2*Math.PI,top=.434;
export const waterY=.401;
export const gradeX=.176;
const box=(w,h,d,x,y,z,r=.003)=>transform(roundedBoxGeometry(w,h,d,1,r),[x,y,z]);
const profile=(p,x,y,z,n=30)=>transform(latheGeometry(p,n),[x,y,z]);
const round=(r,h,x,y,z,n=24)=>transform(cylinderGeometry(r,r,h,n,1),[x,y,z]);

function transform(mesh,[x,y,z],a=0){
  const s=Math.sin(a),c=Math.cos(a);
  return applyMatrix4(mesh,[c,s,0,0,-s,c,0,0,0,0,1,0,x,y,z,1]);
}

export function rgb(hex){
  return Array.from({length:3},(_,i)=>{
    const a=parseInt(hex.slice(2*i+1,2*i+3),16)/255;
    return a<=.04045?a/12.92:((a+.055)/1.055)**2.4;
  });
}
const blend=(a,b,x)=>a.map((v,i)=>v+(b[i]-v)*x);

function stage(){
  const g={positions:[],normals:[],colors:[],indices:[]};
  const slate=rgb('#426075'),dark=rgb('#17233b'),black=rgb('#101725');
  const rows=[[-.016,3.6,0,slate],[-.016,.32,0,slate],[-.016,-.45,0,dark]];
  for(let i=1;i<=21;i++){
    const theta=Math.PI*i/42;
    rows.push([-.016+.74*(1-Math.cos(theta)),-.45-.74*Math.sin(theta),theta,blend(dark,black,Math.sin(theta))]);
  }
  rows.push([4,-1.19,Math.PI/2,black]);
  for(const [i,[y,z,t,c]] of rows.entries()){
    for(const x of [-5,5]){
      g.positions.push(x,y,z);g.normals.push(0,Math.cos(t),Math.sin(t));g.colors.push(...c);
    }
    if(i){const v=(i-1)*2;g.indices.push(v,v+1,v+2,v+1,v+3,v+2);}
  }
  return g;
}

function reflector(base,key){
  const size=64,data=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const a=2*(x+.5)/size-1,b=2*(y+.5)/size-1;
    const soft=Math.exp(-2.4*((a+.56)/.22)**4-1.9*((b-.18)/.78)**4);
    const vertical=Math.exp(-2.9*((a-.39)/.12)**4-1.15*((b-.12)/.69)**4);
    const bounce=Math.exp(-2.4*((a+.03)/.57)**4-3.2*((b+.52)/.19)**4);
    const at=4*(x+y*size);
    for(let i=0;i<3;i++)data[at+i]=Math.min(250,base[i]+key[i]*soft+[50,97,130][i]*vertical+[29,39,91][i]*bounce);
    data[at+3]=255;
  }
  return new Texture({width:size,height:size,data},{colorSpace:'srgb',magFilter:'linear',minFilter:'linear'});
}

function glassPanel(width,height,x0,y0,z,lit){
  const g={positions:[],normals:[],colors:[],indices:[]};
  const columns=36,rows=20,edge=rgb('#71b8c6'),mid=rgb('#7cc7eb'),purple=rgb('#7b86cc');
  for(let j=0;j<=rows;j++)for(let i=0;i<=columns;i++){
    const u=i/columns,v=j/rows;
    const x=x0+(u-.5)*width,y=y0+(v-.5)*height;
    const left=Math.exp(-2.7*((u-.082)/.034)**2);
    const right=Math.exp(-2.2*((u-.918)/.082)**2);
    const seam=Math.exp(-2*((u+.15*v-.395)/.069)**2);
    const top=Math.exp(-2.4*((v-.92)/.070)**2);
    const taper=Math.sin(Math.PI*v)**.52;
    const opacity=lit?(.05+.64*left+.33*right+.24*seam)*(.53+.46*taper)+top*.16:(.018+.12*left+.15*right+.08*seam)*taper;
    const tone=blend(blend(mid,purple,.76*right),edge,.52*top+.18*left);
    g.positions.push(x,y,z);g.normals.push(0,0,1);g.colors.push(...tone,opacity);
    if(i&&j){
      const d=i+j*(columns+1),c=d-1,b=d-columns-1,a=b-1;
      g.indices.push(a,b,c,b,d,c);
    }
  }
  return g;
}

function base(join,m){
  join(stage(),m.sweep,'Studio cove and contact floor','receive');
  join([
    box(.443,.035,.334,0,.010,0,.010),box(.421,.021,.318,0,.033,0,.008),
    box(.394,.012,.298,0,.047,0,.006),
  ],m.slate,'CNC-radiused graphite reservoir plinth','cast');
  join([
    box(.403,.0019,.302,0,.030,0,.006),
    box(.106,.020,.003,-.116,.041,.158,.003),
    ...[-.184,.184].flatMap(x=>[-.133,.133].map(z=>round(.011,.007,x,.057,z,8))),
  ],m.chrome,'Machined inlay, serial plate and bolted corners');
  join(box(.059,.005,.003,.146,.043,.160,.001),m.glow,'Power indicator');
  join([
    box(.328,.016,.269,0,.054,0,.004),
    box(.325,.005,.266,0,.066,0,.003),
    ...[-.155,.155].map(x=>box(.008,.368,.012,x,.246,-.120,.003)),
  ],m.ink,'Tank floor, channels and rear pressure shell','cast');
}

function windows(join,m){
  join([
    box(.322,.009,.264,0,top,0,.004),box(.320,.005,.251,0,top+.007,0,.002),
    ...[-.152,.152].flatMap(x=>[-.118,.118].map(z=>box(.009,.366,.010,x,.246,z,.002))),
  ],m.slate,'Upper pressure ring and four vertical glass captures');
  join([
    ...[-.153,.153].map(x=>box(.004,.359,.003,x,.244,.124,.0009)),
    box(.303,.003,.003,0,top-.007,.124,.0013),box(.303,.002,.003,0,.074,.124,.0006),
  ],m.chrome,'Fine stainless edge inlay');
  join([
    box(.0025,.356,.238,-.149,.247,0,.0010),
    box(.0025,.356,.238,.149,.247,0,.0010),
    box(.300,.356,.0045,0,.247,.121,.0015),
  ],m.glass,'Transparent laminated tank walls',undefined,10);
  join(glassPanel(.292,.352,0,.246,.124,false),m.frontReflection,'Thin front-glass reflections',undefined,12);
  join(glassPanel(.286,.354,0,.244,-.111,true),m.afterlight,'Vertical lighting through the rear wall',undefined,1);
  join([
    box(.013,.316,.006,-.141,.242,-.103,.002),box(.017,.325,.006,.139,.241,-.103,.002),
  ],m.ink,'Diffuser recesses');
  join([
    box(.0043,.271,.003,-.141,.240,-.099,.0010),
    box(.0036,.275,.003,.142,.240,-.099,.0010),
  ],m.glow,'Cold vertical LED strips');
  join(box(.294,.0024,.230,0,waterY,0,.0016),m.lineWater,'Faint free surface',undefined,6);
  join([
    box(.288,.0014,.003,0,waterY+.001,.114,.0006),
    box(.288,.0014,.003,0,waterY+.001,-.113,.0006),
    ...[-.145,.145].map(x=>box(.003,.0014,.228,x,waterY+.001,0,.0006)),
  ],m.meniscus,'Water surface meniscus',undefined,7);
  const knobs=[];
  for(const x of [-.122,.122])for(const z of [-.091,.091]){
    knobs.push(round(.009,.007,x,top+.010,z,8),round(.012,.002,x,top+.006,z,18));
  }
  join(knobs,m.chrome,'Four lid clamp toggles');
}

function launcher(join,m){
  join([
    profile([[0,0],[.061,0],[.060,.008],[.053,.012],[.051,.025],[.045,.034],[ringRadius*.79,.034],
      [ringRadius*.69,.029],[ringRadius*.69,.016],[0,.016]],0,.063,0,48),
  ],m.ink,'Recessed piston outlet');
  join(profile([[.034,.0],[.044,0],[.046,.001],[.043,.004],[.037,.003],[.034,0]],0,.096,0,58),
    m.chrome,'Turned launch orifice and polished lip');
  const torus=torusGeometry(.040,.00115,7,58);
  join(applyMatrix4(torus,[1,0,0,0,0,0,1,0,0,-1,0,0,0,.099,0,1]),m.lens,'Illuminated inlet ring');
  join([
    round(.085,.009,0,.059,0,56),
    ...Array.from({length:12},(_,i)=>round(.0022,.004,.062*Math.cos(i*tau/12),.081,.062*Math.sin(i*tau/12),8)),
  ],m.slate,'Raked launcher ring with recessed screws');
}

function measurement(add,m){
  add(box(.025,.292,.005,gradeX,.237,.026,.003),m.ink,'Etched centre scale plate');
  add(mergeGeometries([.102,.362].map(y=>box(.026,.007,.011,.157,y,.026,.0014))),m.chrome,'Two side gauge brackets');
  const ticks=[];
  for(let j=0;j<=21;j++){
    const y=startY+j*.010;
    if(y>.377)break;
    const w=j%5===0?.019:.009;
    ticks.push(box(w,.00095,.0014,gradeX-.010+w*.5,y,.030,.00024));
  }
  add(mergeGeometries(ticks),m.chrome,'Ten millimetre scale divisions');
  const cursor=add(transform(roundedBoxGeometry(.019,.0055,.0021,1,.0012),[0,0,0]),m.gold,'Model centre height pointer');
  return height=>cursor.root.setPosition([gradeX-.005,startY+height,.033]);
}

export function assemble(add){
  const metallic=reflector([52,68,81],[158,150,128]),glass=reflector([35,81,107],[91,136,130]);
  const m={
    sweep:new Material({color:'#a0a8b5',roughness:.82}),
    slate:new Material({color:'#354454',roughness:.36,metalness:.10}),
    ink:new Material({color:'#1d2938',roughness:.48}),
    chrome:new MatcapMaterial({color:'#a1b4c7',matcap:metallic}),
    gold:new Material({shading:'basic',color:'#e8b97e'}),
    glow:new Material({shading:'basic',color:'#7bd5d9'}),
    lens:new Material({shading:'basic',color:'#689aaf'}),
    glass:new MatcapMaterial({color:'#bedfef',matcap:glass,transparent:true,opacity:.095,depthWrite:false}),
    frontReflection:new Material({shading:'basic',color:'#d2e9ed',transparent:true,opacity:.59,depthWrite:false}),
    afterlight:new Material({shading:'basic',color:'#b6c5eb',transparent:true,opacity:.74,depthWrite:false}),
    lineWater:new MatcapMaterial({color:'#77abc7',matcap:glass,transparent:true,opacity:.25,depthWrite:false}),
    meniscus:new Material({shading:'basic',color:'#438ca9',transparent:true,opacity:.56,depthWrite:false}),
  };
  const join=(g,...args)=>add(Array.isArray(g)?mergeGeometries(g):g,...args);
  base(join,m);windows(join,m);launcher(join,m);
  const positionCursor=measurement(add,m);
  return {positionCursor,dispose(){for(const mat of Object.values(m))mat.dispose();metallic.dispose();glass.dispose();}};
}
