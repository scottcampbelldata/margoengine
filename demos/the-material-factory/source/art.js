import {Geometry,PbrMaterial} from '@margoengine/core';

const tau=Math.PI*2;
const linear=c=>(c/=255)<=.04045?c/12.92:((c+.055)/1.055)**2.4;
function color(hex){return [1,3,5].map(i=>linear(parseInt(hex.slice(i,i+2),16)));}
export const finishes={
  rust:{label:'Oxide',caption:'Oxidized steel',repeat:[5,5],color:color('#bd5631'),secondary:color('#5c6262'),
    roughness:.64,roughnessVariation:.32,heightScale:.12,normalStrength:.98,detail:.62,depth:.013},
  wood:{label:'Walnut',caption:'Cut walnut',repeat:[8,4],color:color('#bb8253'),secondary:color('#5e402d'),
    roughness:.59,roughnessVariation:.24,heightScale:.13,normalStrength:.36,detail:.48,depth:.009},
  stone:{label:'Stone',caption:'Cut limestone',repeat:[5,5],color:color('#c6ad87'),secondary:color('#484747'),
    roughness:.77,roughnessVariation:.24,heightScale:.16,normalStrength:.95,detail:.59,depth:.020,grout:.042,tint:.26,chip:.56},
};
export const firstSeed=37;
export const mapSize=256;

const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mul=(a,s)=>a.map(v=>v*s);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>mul(a,1/(Math.hypot(...a)||1));
const surfaces={
  floor:['#4b4c4a',.92,0],wall:['#3e4248',.92,0],panel:['#3b4247',.84,0],plaster:['#4e5558',.83,0],
  bench:['#55595a',.72,0],benchTop:['#63605a',.66,0],iron:['#35393c',.64,1],bronze:['#a18061',.59,1],
  guard:['#676157',.62,1],oxide:['#87634b',.76,0],tool:['#526068',.58,1],
  pewter:['#a4a39a',.60,1],rim:['#4d514c',.59,1],enamel:['#3e5553',.51,0],
  dark:['#393c3c',.78,0],marker:['#bdab87',.74,0],weak:['#806d57',.71,0],
};
export function paint(key){
  const [color,roughness,metalness]=surfaces[key];
  return new PbrMaterial({color,roughness,metalness});
}
function meshBatch(){
  const groups=new Map();
  function tri(key,a,b,c,normal){
    const n=normal??norm(cross(sub(b,a),sub(c,a)));
    if(Math.hypot(...n)<1e-5)return;
    let group=groups.get(key);
    if(!group){group={p:[],n:[],i:[]};groups.set(key,group);}
    const j=group.p.length/3;
    group.p.push(...a,...b,...c);group.n.push(...n,...n,...n);group.i.push(j,j+1,j+2);
  }
  return {
    tri,quad(key,a,b,c,d,n){tri(key,a,b,c,n);tri(key,a,c,d,n);},
    build:()=>[...groups].map(([name,{p,n,i}])=>({name,geometry:new Geometry(p,n,i),material:paint(name)})),
  };
}
function edgeBox(m,key,[x,y,z],W,H,D,cut=.015){
  const a=W/2,b=H/2,c=D/2,r=Math.min(cut,.45*a,.45*b,.45*c);
  const ring=(Y,A,C,R)=>[[x-A+R,Y,z+C],[x+A-R,Y,z+C],[x+A,Y,z+C-R],[x+A,Y,z-C+R],
    [x+A-R,Y,z-C],[x-A+R,Y,z-C],[x-A,Y,z-C+R],[x-A,Y,z+C-R]];
  const rings=[ring(y-b,a-r,c-r,r*.31),ring(y-b+r,a,c,r),ring(y+b-r,a,c,r),ring(y+b,a-r,c-r,r*.31)];
  for(let j=0;j<3;j++)for(let i=0;i<8;i++){
    const l=(i+1)%8;
    m.quad(key,rings[j][i],rings[j][l],rings[j+1][l],rings[j+1][i]);
  }
  for(let i=1;i<7;i++){
    m.tri(key,rings[0][0],rings[0][i+1],rings[0][i]);
    m.tri(key,rings[3][0],rings[3][i],rings[3][i+1]);
  }
}
function tube(m,key,a,b,r,cap=true,sides=28,R=r){
  const z=norm(sub(b,a)),x=norm(cross(z,Math.abs(z[1])<.91?[0,1,0]:[0,0,1])),y=cross(z,x);
  const d=i=>add(mul(x,Math.cos(tau*i/sides)),mul(y,Math.sin(tau*i/sides)));
  for(let i=0;i<sides;i++){
    const u=d(i),v=d(i+1),p=add(a,mul(u,r)),q=add(a,mul(v,r));
    const s=add(b,mul(v,R)),t=add(b,mul(u,R));
    m.quad(key,p,q,s,t);
    if(cap){m.tri(key,a,q,p);m.tri(key,b,t,s);}
  }
}
export function enclosure(){
  const m=meshBatch(),B=(k,x,y,z,w,h,d,r)=>edgeBox(m,k,[x,y,z],w,h,d,r);
  B('floor',0,-.151,.36,7,.14,5,.021);
  B('wall',0,1.12,-1.13,6.4,2.6,.17,.020);
  B('plaster',0,.94,-1.026,3.49,2.24,.054,.012);
  B('panel',0,.867,-.995,2.43,1.68,.036,.011);
  for(let i=0;i<38;i++){
    const x=(i-18.5)*.065;
    B(i%7===1?'bench':'panel',x,.882,-.978,.046,1.66,.031,.003);
    B('wall',x-.023,.882,-.961,.004,1.68,.004,.001);
  }
  for(const x of [-1.262,1.255]){
    B('iron',x,.893,-.951,.083,1.69,.063,.013);
    B('bronze',x,.894,-.911,.018,1.63,.016,.005);
  }
  B('iron',0,.163,-.902,3.40,.071,.085,.012);
  B('marker',0,.191,-.849,3.37,.018,.032,.004);
  B('bench',0,-.088,.118,3.19,.140,1.59,.038);
  B('benchTop',0,-.004,.118,3.10,.039,1.52,.013);
  B('bronze',0,-.051,.908,3.07,.018,.024,.006);
  for(let j=0;j<41;j++){
    const x=(j-20)*.062;
    B(j%5===0?'marker':'weak',x,.018,.790,.004,.003,j%5===0?.031:.014,.001);
  }
  B('iron',-.17,.044,.035,1.37,.055,.81,.022);
  B('guard',-.173,.078,.035,1.30,.034,.744,.015);
  B('dark',-.174,.094,.032,1.24,.019,.700,.007);
  B('bronze',-.171,.056,.445,1.25,.015,.021,.004);
  for(const x of [-.727,.381])for(const z of [-.263,.323]){
    tube(m,'pewter',[x,.094,z],[x,.106,z],.015,true,20);
    B('dark',x,.106,z,.016,.003,.004,.0006);
  }
  for(const x of [-.466,.136]){
    B('enamel',x,.211,.026,.092,.256,.530,.017);
    B('bronze',x,.339,.028,.100,.024,.315,.006);
    B('guard',x,.185,.298,.112,.055,.048,.009);
    tube(m,'pewter',[x,.182,.323],[x,.182,.333],.017,true,20);
    B('dark',x,.182,.335,.016,.004,.004,.001);
  }
  B('enamel',.657,.049,.126,.489,.063,.509,.018);
  B('bronze',.658,.084,.127,.437,.026,.451,.007);
  B('guard',.657,.102,.126,.389,.019,.403,.006);
  B('dark',.661,.097,.379,.421,.044,.079,.008);
  for(let i=0;i<11;i++){
    const x=.526+i*.026;
    B(i%5===0?'marker':'weak',x,.121,.387,.002,.004,i%5===0?.029:.012,.0005);
  }
  for(const x of [.442,.874]){
    tube(m,'pewter',[x,.113,.263],[x,.124,.263],.012,true,15);
    tube(m,'tool',[x,.126,.263],[x,.132,.263],.006,true,12);
  }
  return m.build();
}
export function ringGeometry(){
  const p=[],n=[],indices=[],count=144;
  const profile=[
    [.196,-.071],[.194,-.037],[.194,.066],[.201,.121],[.222,.154],[.245,.171],[.290,.182],
    [.345,.168],[.395,.143],[.442,.113],[.466,.082],[.483,.043],[.486,.005],
    [.485,-.070],[.476,-.112],[.446,-.126],[.303,-.125],[.217,-.109],[.196,-.071],
  ];
  const shifts=[-.166,.696,.034];
  function sample(i,section){
    const [r,depth]=section,a=i/count*tau,c=Math.cos(a),s=Math.sin(a);
    const face=Math.max(0,(r-.19)/.3),lobe=1+face*(.036*Math.cos(a*6+.24)+.022*Math.cos(a*3-.35));
    const ripple=face*.009*Math.sin(a*6+(r-.19)*7);
    return [r*lobe*c+shifts[0],r*lobe*s+shifts[1],depth+ripple+shifts[2]];
  }
  for(let row=0;row<profile.length;row++){
    const forward=profile[(row+1)%(profile.length-1)],back=profile[(row+profile.length-2)%(profile.length-1)];
    for(let j=0;j<=count;j++){
      const a=sample(j,profile[row]),along=sub(sample(j+.07,profile[row]),sample(j-.07,profile[row]));
      const side=sub(sample(j,forward),sample(j,back));
      p.push(...a);n.push(...norm(cross(side,along)));
    }
  }
  for(let i=0;i<profile.length-1;i++)for(let j=0;j<count;j++){
    const a=i*(count+1)+j,b=a+count+1;
    indices.push(a,b,b+1,a,b+1,a+1);
  }
  return {positions:p,normals:n,indices};
}
export function witnessGeometry(){
  const p=[],n=[],i=[];
  const pos=(x,z,offset)=>[.657+x,.154+z*.145+offset,.124+z];
  const bands=[
    [[-.159,-.167],[-.168,-.158],[-.168,.156],[-.150,.175],[.145,.175],[.165,.156],[.165,-.155],[.151,-.167]],
    [[-.147,-.157],[-.158,-.145],[-.158,.150],[-.141,.165],[.137,.165],[.155,.150],[.155,-.144],[.142,-.157]],
  ];
  const point=(q,row)=>pos(...q,row);
  for(let j=0;j<8;j++){
    const k=(j+1)%8;
    const [a,b,c,d]=[point(bands[0][j],-.019),point(bands[0][k],-.019),point(bands[1][k],0),point(bands[1][j],0)];
    const normal=norm(cross(sub(b,a),sub(c,a))),u=p.length/3;
    for(const v of [a,b,c,d]){
      p.push(...v);n.push(...normal);
    }
    i.push(u,u+1,u+2,u,u+2,u+3);
  }
  const start=p.length/3;
  for(const v of bands[1]){
    const q=point(v,0);
    p.push(...q);n.push(0,1,-.145);
  }
  for(let j=1;j<7;j++)i.push(start,start+j,start+j+1);
  return {positions:p,normals:n,indices:i};
}
export function cameraFor(w,h){
  const aspect=w/Math.max(1,h),phone=aspect<1.18,d=phone?2.88:2.68;
  const a=.161;
  return {position:[.082+Math.sin(a)*d,1.34,Math.cos(a)*d],target:[.082,.604,0],
    fov:phone?40.5:34.8,near:.045,far:24};
}
