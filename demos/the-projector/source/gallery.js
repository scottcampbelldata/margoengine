import {Geometry,PbrMaterial} from '@margoengine/core';

const TAU=Math.PI*2;
const add=(a,b)=>a.map((n,i)=>n+b[i]);
const sub=(a,b)=>a.map((n,i)=>n-b[i]);
const mul=(v,f)=>v.map(n=>n*f);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normalized=v=>mul(v,1/(Math.hypot(...v)||1));
const normal=(a,b,c)=>normalized(cross(sub(b,a),sub(c,a)));
const palette={
  chalk:['#a59b90',.81,0],
  joint:['#403835',.94,0],
  trim:['#2a2525',.78,0],
  darkWood:['#49332b',.60,0],
  limestone:['#a69b8b',.73,0],
  ceramic:['#e4d1b5',.56,0],
  wing:['#d6bf9e',.62,0],
  joints:['#b89675',.55,0],
  bill:['#7a4c36',.42,0],
  bronze:['#8c6240',.37,1],
  satin:['#403837',.50,1],
  lens:['#436470',.17,0],
  amber:['#d1a177',.27,1],
};

export const lamp=[-.91,1.83,2.0];
export const aim=[.12,1.71,-2.4];
const beam=normalized(sub(aim,lamp));

function meshBuilder(){
  const p=[],n=[],i=[];
  return {
    triangle(a,b,c,ns){
      const first=p.length/3,d=normal(a,b,c);
      p.push(...a,...b,...c);
      n.push(...(ns??[d,d,d]).flat());
      i.push(first,first+1,first+2);
    },
    quad(a,b,c,d){
      this.triangle(a,b,c);
      this.triangle(a,c,d);
    },
    geometry(){return new Geometry(p,n,i);},
  };
}

function cappedBox(g,center,size,bevel=.026){
  const [x,y,z]=center,[w,h,d]=mul(size,.5);
  const b=Math.min(w,h,d,bevel);
  function frame(k,yy,rx,rz){
    const ch=k?b:.003;
    return [[x-rx+ch,yy,z+rz],[x+rx-ch,yy,z+rz],[x+rx,yy,z+rz-ch],
      [x+rx,yy,z-rz+ch],[x+rx-ch,yy,z-rz],[x-rx+ch,yy,z-rz],[x-rx,yy,z-rz+ch],[x-rx,yy,z+rz-ch]];
  }
  const rings=[frame(0,y-h,w-b,d-b),frame(1,y-h+b,w,d),frame(1,y+h-b,w,d),frame(0,y+h,w-b,d-b)];
  for(let k=0;k<3;k++)for(let j=0;j<8;j++){
    const next=(j+1)%8;
    g.quad(rings[k][j],rings[k][next],rings[k+1][next],rings[k+1][j]);
  }
  for(let i=1;i<7;i++){
    g.triangle(rings[3][0],rings[3][i],rings[3][i+1]);
    g.triangle(rings[0][0],rings[0][i+1],rings[0][i]);
  }
}

function tube(g,rows,sides=32,ridge=0){
  const rings=rows.map(([c,u,v],row)=>Array.from({length:sides},(_,i)=>{
    const t=TAU*i/sides;
    const flute=1-ridge*(.5+.5*Math.cos(t*7+row*.22));
    return add(c,add(mul(u,Math.cos(t)*flute),mul(v,Math.sin(t)*flute)));
  }));
  const surfaceNormal=(r,s)=>{
    const last=rings[Math.max(0,r-1)][s],next=rings[Math.min(rings.length-1,r+1)][s];
    const lhs=rings[r][(s+sides-1)%sides],rhs=rings[r][(s+1)%sides];
    return normalized(cross(sub(next,last),sub(rhs,lhs)));
  };
  for(let j=0;j<rings.length-1;j++)for(let s=0;s<sides;s++){
    const next=(s+1)%sides;
    const a=rings[j][s],b=rings[j+1][s],c=rings[j+1][next],d=rings[j][next];
    const na=surfaceNormal(j,s),nb=surfaceNormal(j+1,s),nc=surfaceNormal(j+1,next),nd=surfaceNormal(j,next);
    g.triangle(a,b,c,[na,nb,nc]);
    g.triangle(a,c,d,[na,nc,nd]);
  }
  for(let s=0;s<sides;s++){
    const next=(s+1)%sides;
    g.triangle(rows[0][0],rings[0][s],rings[0][next]);
    const j=rows.length-1;
    g.triangle(rows[j][0],rings[j][next],rings[j][s]);
  }
}

function upright(g,levels,sides){
  tube(g,levels.map(([x,y,z,rx,rz,turn=0])=>{
    const s=Math.sin(turn),c=Math.cos(turn);
    return [[x,y,z],[rx*c,0,rx*s],[-rz*s,0,rz*c]];
  }),sides);
}

function axial(g,rows,sides=32,ridge=0){
  const ab=normalized(sub(rows.at(-1)[0],rows[0][0])),u=normalized(cross([0,1,0],ab)),v=cross(u,ab);
  tube(g,rows.map(([c,x,y=x])=>[c,mul(u,x),mul(v,y)]),sides,ridge);
}

function stone(g){
  cappedBox(g('joint'),[0,-.156,1.6],[13,.24,9.1]);
  for(let row=0;row<10;row++)for(let i=0;i<13;i++){
    const x=(i-6)*.97+(row%2)*.38,z=-2.06+row*.89;
    cappedBox(g('floor'+((row*5+i*11)%5)),[x,-.031,z],[.964,.06,.881],.013);
  }
  cappedBox(g('joint'),[.02,2.28,-2.50],[13.4,4.56,.2],.026);
  for(let i=-5;i<=5;i++){
    const x=.12+i*1.23;
    const mat=i< -3?'chalk2':i>3?'chalk1':'chalk';
    cappedBox(g(mat),[x,2.12,-2.387],[1.226,4.24,.16],.018);
  }
  cappedBox(g('trim'),[.02,.12,-2.265],[13.4,.22,.13],.022);
  cappedBox(g('limestone'),[.02,.243,-2.272],[13.4,.035,.13],.011);
  cappedBox(g('trim'),[.02,4.45,-2.383],[13.5,.32,.4],.047);
  cappedBox(g('satin'),[-5.29,2.14,.2],[.3,4.28,5.28],.034);
  cappedBox(g('trim'),[5.28,2.14,.2],[.3,4.28,5.28],.034);
  for(const x of [-4.07,4.06]){
    cappedBox(g('darkWood'),[x,1.41,-2.299],[.37,.53,.086],.012);
    cappedBox(g('satin'),[x,1.43,-2.242],[.28,.41,.098],.022);
    for(let k=0;k<6;k++)cappedBox(g(k===5?'amber':'bronze'),[x,1.28+k*.055,-2.176],[.224,.024,.037],.007);
  }
}

function sculpture(g){
  const x=.38,z=-.62;
  cappedBox(g('trim',true),[x,.105,z],[1.43,.21,1.13],.043);
  cappedBox(g('plinth',true),[x,.315,z],[1.31,.23,1.01],.035);
  cappedBox(g('limestone',true),[x,.472,z],[1.54,.09,1.17],.027);
  cappedBox(g('bronze'),[x,.305,z+.516],[.39,.072,.015],.013);
  for(let i=0;i<9;i++)cappedBox(g('satin'),[x-.12+i*.03,.306,z+.526],[.014,.022,.005],.002);

  const body=[
    [.32,.502,-.62,.16,.16], [.36,.526,-.60,.25,.23],
    [.37,.564,-.58,.30,.29],[.40,.62,-.57,.35,.35],
    [.43,.71,-.56,.42,.37],[.45,.83,-.55,.48,.38],
    [.46,.98,-.54,.50,.39],[.48,1.12,-.53,.48,.38],
    [.49,1.25,-.51,.43,.36],[.51,1.36,-.49,.34,.30],
    [.51,1.46,-.48,.25,.25],[.51,1.53,-.46,.16,.16],
    [.50,1.63,-.45,.12,.12],[.46,1.72,-.44,.113,.108],
    [.39,1.79,-.42,.107,.107],[.29,1.85,-.41,.113,.114],
    [.19,1.9,-.41,.146,.132],[.10,1.94,-.42,.156,.14],
    [.075,2,-.43,.151,.132],[.093,2.066,-.44,.148,.127],
    [.133,2.117,-.445,.134,.117],[.164,2.147,-.45,.077,.074],
    [.17,2.163,-.45,.014,.018],
  ];
  upright(g('ceramic',true),body,34);
  axial(g('bill',true),[
    [[.045,2,-.414],.107,.080],
    [[-.047,1.995,-.385],.077,.060],
    [[-.235,1.98,-.355],.047,.039],
    [[-.43,1.945,-.323],.031,.022],
    [[-.577,1.901,-.29],.006,.007],
  ],24);
  curvedEye(g,.043,2.028,-.298,1);
  curvedEye(g,.037,2.036,-.549,-1);

  // Each closed wing has a broad shoulder and a fluted relief along the folded feathers.
  for(const side of [-1,1]){
    const origin=-.54;
    const pt=(x,y,z)=>[x,y,origin+side*z];
    axial(g('wing',true),[
      [pt(.34,1.386,.16),.019,.021],
      [pt(.40,1.34,.208),.084,.089],
      [pt(.51,1.25,.237),.134,.131],
      [pt(.64,1.12,.244),.155,.153],
      [pt(.765,.996,.229),.15,.15],
      [pt(.86,.897,.204),.124,.117],
      [pt(.951,.821,.165),.095,.091],
      [pt(1.025,.775,.109),.061,.057],
      [pt(1.074,.754,.066),.021,.019],
    ],46,.085);
  }
  axial(g('ceramic',true),[
    [[.74,.94,-.587],.21,.19],[[.90,.83,-.63],.192,.113],
    [[1.09,.714,-.68],.131,.093],[[1.22,.637,-.715],.094,.066],
    [[1.28,.60,-.73],.025,.014],
  ],24);
}

function curvedEye(g,x,y,z,hand){
  axial(g('joints',true),[[[x,y,z-hand*.008],.054,.043],[[x,y,z+hand*.011],.041,.033],[[x-.003,y+.004,z+hand*.02],.031,.024]],18);
  axial(g('bill'),[[[x-.006,y+.007,z+hand*.017],.027,.020],[[x-.009,y+.007,z+hand*.025],.016,.016]],16);
}

function fixture(g){
  const at=(distance,y=0)=>add(add(lamp,mul(beam,distance)),[0,y,0]);
  const b=at(-.83);
  cappedBox(g('darkWood'),[b[0],.485,b[2]],[.77,.97,.77],.033);
  cappedBox(g('limestone'),[b[0],1.005,b[2]],[.91,.074,.89],.031);
  axial(g('satin'),[[at(-.81,-1.055),.086],[at(-.67,-.49),.051],[at(-.54,-.18),.092]],22);
  const head=at(-.69);
  cappedBox(g('darkWood'),head,[.397,.37,.53],.042);
  cappedBox(g('trim'),[head[0],head[1]+.232,head[2]+.128],[.21,.102,.22],.025);
  const row=distances=>distances.map(([d,r])=>[at(d),r]);
  axial(g('satin'),row([[-.62,.172],[-.38,.172],[-.32,.149],[-.11,.136],[-.051,.124]]));
  axial(g('bronze'),row([[-.44,.176],[-.405,.183],[-.37,.175]]));
  axial(g('bronze'),row([[-.151,.141],[-.128,.155],[-.093,.154],[-.075,.145]]));
  axial(g('amber'),row([[-.083,.14],[-.039,.139],[-.016,.127]]));
  axial(g('lens'),row([[-.022,.119],[-.014,.123],[-.007,.108],[-.004,.022]]));
  for(let i=0;i<6;i++)cappedBox(g('bronze'),[head[0]+.208,head[1]+.04,head[2]+.021+i*.024],[.012,.102,.008],.002);
}

export function prepareGallery(){
  const records=new Map();
  const colors={
    ...palette,chalk1:['#80756e',.88,0],chalk2:['#918279',.9,0],plinth:['#76675c',.87,0],
    floor0:['#584c47',.64,0],floor1:['#5d514d',.70,0],floor2:['#64564f',.67,0],floor3:['#60524d',.70,0],floor4:['#62564f',.71,0],
  };
  const get=(material,caster=false)=>{
    const key=material+'/'+caster;
    if(!records.has(key))records.set(key,{geometry:meshBuilder(), material, caster});
    return records.get(key).geometry;
  };
  stone(get);
  sculpture(get);
  fixture(get);
  return Array.from(records.values(),({geometry,material,caster})=>{
    const [color,roughness,metalness]=colors[material];
    return {geometry:geometry.geometry(),material:new PbrMaterial({color,roughness,metalness,doubleSided:false}),caster};
  });
}
