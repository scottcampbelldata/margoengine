import {Geometry,PbrMaterial,box} from '@margoengine/core';

const TAU=Math.PI*2;
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mul=(p,a)=>p.map(v=>v*a);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>mul(a,1/(Math.hypot(...a)||1));

const rnd=i=>{const x=Math.sin(i*53.485+7.61)*43758.5453;return x-Math.floor(x);};
const colors={
  trunk:['#724e47',.61,0],oliveStem:['#566446',.58,0],emberStem:['#844637',.60,0],
  bladeA:['#44784c',.57,0],bladeB:['#53894c',.54,0],bladeC:['#729755',.57,0],bladeD:['#94a667',.61,0],
  silverA:['#507361',.64,0],silverB:['#668f75',.62,0],silverC:['#84a685',.61,0],silverD:['#a8b99b',.65,0],
  copperA:['#5b6350',.62,0],copperB:['#8b8260',.58,0],copperC:['#a49062',.57,0],copperD:['#c0a36b',.57,0],
  vein:['#a9ae72',.66,0],spine:['#c8c29a',.75,0],
  petal:['#b54b76',.51,0],petalEdge:['#d15c74',.49,0],inner:['#624677',.49,0],leafbud:['#af776b',.57,0],
  bell:['#953b50',.57,0],tube:['#9b5d50',.64,0],stamen:['#d7ad75',.63,0],iris:['#906395',.51,0],
  coals:['#a85231',.52,0],coalRim:['#da9062',.50,0],coalInner:['#7f534c',.53,0],
  glaze:['#3d6c60',.24,0],glazeA:['#457366',.22,0],glazeB:['#365f58',.28,0],rim:['#819d8b',.33,0],
  bare:['#726257',.68,0],soil:['#444239',.96,0],loam:['#51463b',.94,0],grit:['#676052',.81,0],lichen:['#5d6444',.88,0],
  plinth:['#414b46',.67,0],edge:['#657268',.61,0],floor:['#454743',.84,0],mat:['#4a4a42',.79,0],
  plaster:['#484854',.92,0],panel:['#3a3b48',.87,0],innerPanel:['#494852',.91,0],wood:['#5d5547',.76,0],glass:['#435355',.68,0],glassAlt:['#4d5859',.76,0],glassBase:['#3c5054',.68,0],mullion:['#605c51',.62,0],
  brass:['#ae9974',.50,1],antique:['#64523a',.50,1],inlay:['#a48d68',.73,0],
};
export function material(key){
  const [color,roughness,metalness]=colors[key];
  return new PbrMaterial({color,roughness,metalness});
}
function model(){
  const groups=new Map();
  function face(key,a,b,c,na,nb=na,nc=na){
    let n=na;
    if(!n){
      const d=cross(sub(b,a),sub(c,a)),length=Math.hypot(d[0],d[1],d[2]);
      if(length<1e-14)return;
      n=mul(d,1/length);
    }
    const g=groups.get(key)??{p:[],n:[],i:[]};
    if(!groups.has(key))groups.set(key,g);
    const k=g.p.length/3;
    g.p.push(...a,...b,...c);
    g.n.push(...(na||n),...(nb||n),...(nc||n));
    g.i.push(k,k+1,k+2);
  }
  function quad(key,a,b,c,d,na,nb=na,nc=na,nd=na){face(key,a,b,c,na,nb,nc);face(key,a,c,d,na,nc,nd);}
  function build(){
    return [...groups].map(([name,{p,n,i}])=>({name,geometry:new Geometry(new Float32Array(p),new Float32Array(n),new Uint32Array(i)),material:material(name)}));
  }
  return {face,quad,build};
}
function turn(m,names,[x,y,z],profile,segments=68,wobble=0){
  const ring=(j,k)=>{
    const [r,h]=profile[j],a=k/segments*TAU;
    const drift=1+wobble*(.48*Math.sin(3*a+h*21)+.27*Math.sin(7*a-h*42)+.16*Math.sin(13*a));
    return [x+Math.cos(a)*r*drift,y+h,z+Math.sin(a)*r*drift];
  };
  const normal=(j,k)=>{
    const [a,b]=profile[Math.max(0,j-1)],[c,d]=profile[Math.min(profile.length-1,j+1)],t=k/segments*TAU;
    return norm([Math.cos(t)*(d-b),a-c,Math.sin(t)*(d-b)]);
  };
  for(let j=0;j<profile.length-1;j++)for(let k=0;k<segments;k++){
    const l=k+1,a=ring(j,k),b=ring(j+1,k),c=ring(j+1,l),d=ring(j,l);
    m.quad(typeof names==='function'?names(j,k):names,a,b,c,d,normal(j,k),normal(j+1,k),normal(j+1,l),normal(j,l));
  }
}
function cylinder(m,key,a,b,r,R=r,sides=7){
  const axis=norm(sub(b,a)),basis=norm(cross(axis,Math.abs(axis[1])<.95?[0,1,0]:[0,0,1])),other=cross(axis,basis);
  const fan=j=>add(mul(basis,Math.cos(j/sides*TAU)),mul(other,Math.sin(j/sides*TAU)));
  for(let j=0;j<sides;j++){
    const d=fan(j),e=fan(j+1);
    m.quad(key,add(a,mul(d,r)),add(b,mul(d,R)),add(b,mul(e,R)),add(a,mul(e,r)),d,d,e,e);
  }
}
function stone(m,key,seed,x,y,z,s){
  const p=(j,r,h)=>[x+s*r*Math.cos(j/6*TAU)*(1+.13*rnd(j+seed)),y+s*h,z+.75*s*r*Math.sin(j/6*TAU)];
  const top=[x+.11*s,y+.66*s,z-.15*s];
  for(let j=0;j<6;j++)m.face(key,p(j,1,.10),p(j+1,1,.08),top);
}
function bed(m){
  turn(m,'plinth',[0,.012,0],[[.01,0],[.343,0],[.367,.023],[.367,.047],[.352,.058],[.01,.058]],84);
  turn(m,'edge',[0,.057,0],[[.001,0],[.346,0],[.351,.004],[.347,.010],[.001,.010]],84);
  turn(m,'antique',[0,.061,0],[[.297,-.002],[.304,.000],[.305,.002],[.301,.005],[.297,.005]],84);
  const fired=[[.000,0],[.110,0],[.128,.006],[.136,.014],[.139,.025],[.149,.034],
    [.163,.051],[.177,.075],[.191,.104],[.202,.135],[.209,.158],[.219,.176],[.229,.192],
    [.232,.205],[.230,.216],[.224,.220],[.214,.218],[.208,.209],[.207,.197],[.199,.175],
    [.192,.153],[.186,.125],[.177,.102],[.156,.072],[.145,.058],[.126,.048],[.000,.046]];
  const profile=[];
  for(let j=0;j<fired.length;j++){
    const p=fired[j];
    if(j>=6&&j<=12){
      const q=fired[j+1];
      for(let i=0;i<5;i++){
        const t=i/5;
        profile.push([p[0]+(q[0]-p[0])*t+.0013*Math.sin(i*1.7+j*.27),p[1]+(q[1]-p[1])*t]);
      }
    }else profile.push(p);
  }
  turn(m,(j,k)=>{
    const [r,h]=profile[j];
    if(h<.04)return 'bare';
    if(j===profile.length-14||h>=.216)return 'rim';
    if(j>profile.length-12)return 'glazeB';
    return Math.sin(j*.44+k*.038)>.36?'glazeA':j%5===0?'glazeB':'glaze';
  },[0,.066,0],profile,132,.033);
  turn(m,'soil',[0,.259,0],[[.001,.014],[.080,.018],[.144,.014],[.194,.008],[.212,.008]],82,.035);
  for(let j=0;j<190;j++){
    const a=TAU*rnd(j*19.38),r=.191*Math.sqrt(rnd(j*.684+.2));
    const v=[Math.sin(a)*r,.270+(.194-r)*.048,Math.cos(a)*r];
    stone(m,['loam','lichen','grit','soil'][Math.floor(rnd(j+.72)*4)],j,...v,.002+.006*rnd(j*2.91));
  }
}
function archPoint(j,n,width,wall,run){
  if(j===0)return [-width,0];
  if(j===n+2)return [width,0];
  const a=Math.PI*(1-(j-1)/n);
  return [Math.cos(a)*width,wall+Math.sin(a)*run];
}
function archTrim(m,x,y,z,w,wall,run,band,key){
  const n=47;
  for(let j=0;j<=n+1;j++){
    const points=(k,d)=>{ const [p,q]=archPoint(k,n,w+d,wall,run+d); return [p+x,q+y,z]; };
    m.quad(key,points(j,0),points(j+1,0),points(j+1,band),points(j,band),[0,0,1]);
  }
}
function glazing(m,x,y,z,w,wall,run){
  const N=40,cols=8;
  for(let i=0;i<cols;i++){
    const q=(k,height)=>[x+w*k,y+height,z];
    const left=(i/cols*2-1),right=(i+1)/cols*2-1;
    const profile=x=>wall+run*Math.sqrt(Math.max(0,1-x*x));
    for(let j=0;j<5;j++){
      const u=(left+(right-left)*j/5),v=left+(right-left)*(j+1)/5;
      m.quad(i%3?'glass':'glassAlt',q(u,0),q(v,0),q(v,profile(v)),q(u,profile(u)),[0,0,1]);
    }
  }
  for(let i=1;i<cols;i++){
    const a=i/cols*2-1,h=wall+run*Math.sqrt(1-a*a),k=x+w*a;
    m.quad(i%2?'glassBase':'mullion',[k-.004,y,z+.006],[k+.005,y,z+.006],[k+.005,y+h,z+.006],[k-.004,y+h,z+.006],[0,0,1]);
  }
  for(let i=1;i<=3;i++){
    const a=y+wall*i/3,d=i===2?.011:.006;
    m.quad('mullion',[x-w,a-d,z+.007],[x+w,a-d,z+.007],[x+w,a+d,z+.007],[x-w,a+d,z+.007],[0,0,1]);
  }
  const round=(rx,ry,weight)=>Array.from({length:N+1},(_,i)=>{
    const a=i/N*Math.PI*2,c=Math.cos(a),s=Math.sin(a);
    return [x+(rx+weight)*c,y+wall*.57+(ry+weight)*s,z+.014];
  });
  const a=round(.137,.137,0),b=round(.137,.137,.004);
  for(let i=0;i<N;i++)m.quad('mullion',a[i],a[i+1],b[i+1],b[i],[0,0,1]);
  archTrim(m,x,y,z+.022,w,wall,run,.034,'wood');
  archTrim(m,x,y,z+.026,w+.035,wall,run+.036,.009,'inlay');
  archTrim(m,x,y,z+.030,w+.055,wall,run+.054,.014,'panel');
}
export function glasshouse(){
  const meshes=[],m=model();
  const B=(key,c,w,h,d)=>meshes.push({name:key,position:c,geometry:box(w,h,d),material:material(key)});
  B('floor',[0,-.080,.24],7.6,.146,6.3);
  for(let j=-3;j<=3;j++)for(let k=-2;k<=3;k++){
    const x=j*.406+(k%2)*.20,z=k*.246+.03;
    B((j+k)%3===0?'mat':'floor',[x,-.013,z],.401,.023,.239);
  }
  B('plaster',[0,1.000,-1.11],7.7,2.0,.17);
  B('panel',[0,.073,-.984],6.71,.13,.048);
  B('wood',[0,.154,-.967],6.71,.026,.060);
  B('inlay',[0,.175,-.951],6.71,.009,.018);
  for(const x of [-1.38,0,1.38])glazing(m,x,.195,-.980,.594,.775,.347);
  for(const x of [-.696,.696,-2.071,2.071]){
    B('panel',[x,.971,-.931],.078,1.86,.068);
    B('wood',[x,.971,-.897],.034,1.887,.031);
    B('inlay',[x-.017,.967,-.877],.005,1.85,.012);
  }
  bed(m);
  return [...meshes,...m.build()];
}
const palettes={
  bell:['bladeA','bladeB','bladeC','bladeD'],
  fern:['silverA','silverB','silverC','silverD'],
  ember:['copperA','copperB','copperC','copperD'],
};

function leaf(m,organ,kind){
  const i=organ.index,r=rnd(i+.714);
  let axis=norm(organ.direction),side=norm(cross(axis,organ.up));
  axis=norm(add(mul(axis,.91),[side[0]*.16,-.46+side[1]*.16,side[2]*.16]));
  side=norm(cross(axis,norm(add(mul(organ.up,.43),[0,.73,.20]))));
  const up=norm(cross(side,axis)),c=organ.at;
  const len=(kind==='fern'?.081:.125)*(.79+.43*r),width=len*(kind==='fern'?.355:.29);
  const stemTip=add(c,mul(axis,len*.13));
  cylinder(m,'oliveStem',c,stemTip,.0024,.0016,5);
  const points=19,palette=palettes[kind];
  function point(t,v,raise=0){
    const taper=Math.sin(Math.PI*t)**.79*(1.11-.32*t);
    const tooth=kind==='fern'?Math.cos(t*12*TAU)*.119:Math.cos(t*11*TAU)*.058;
    const w=width*taper*(1+tooth*Math.pow(Math.abs(v),1.7));
    const bend=len*(.163*Math.sin(Math.PI*t)-(.16+.16*r)*t*t+.10*t);
    const cup=len*taper*(-.112*v*v+.051*v*(r-.23)+.024*v*Math.sin(t*5*TAU));
    return add(stemTip,add(mul(axis,t*len),add(mul(side,w*v),mul(up,bend+cup+raise))));
  }
  const bands=[-1,-.59,-.135,0,.135,.61,1];
  const faceN=(t,v)=>norm(cross(sub(point(t+.001,v),point(t-.001,v)),sub(point(t,v-.001),point(t,v+.001))));
  function normal(t,v){
    const a=Math.max(.001,Math.min(.999,t)),n=faceN(a,v);
    return n[1]<0?mul(n,-1):n;
  }
  for(let j=0;j<points;j++)for(let b=0;b<bands.length-1;b++){
    const a=j/points,t=(j+1)/points,u=bands[b],v=bands[b+1];
    const key=palette[b===0||b===5?0:b===2||b===3?2:1];
    m.quad(key,point(a,u),point(t,u),point(t,v),point(a,v),normal(a,u),normal(t,u),normal(t,v),normal(a,v));
  }
  for(let j=0;j<14;j++){
    const a=(j+.08)/15,b=(j+1.11)/15;
    cylinder(m,kind==='fern'?'spine':'vein',point(a,0,.0017),point(b,0,.0017),.00070*(1-a*.73),.00062*(1-a*.70),4);
  }
  for(let j=1;j<=7;j++)for(const sign of [-1,1]){
    const a=j/9;
    cylinder(m,'vein',point(a,0,.0015),point(a+.075,sign*.65,.0014),.00042,.00019,3);
    cylinder(m,palette[3],point(a+.075,sign*.65,.0014),point(a+.147,sign*.94,.0010),.00020,.00008,3);
  }
}
function pendant(m,organ,kind){
  const i=organ.index,r=rnd(i+.11),s=.84+.48*r;
  const axis=norm(organ.direction);
  const hook=add(organ.at,[axis[0]*.018,.008,axis[2]*.018]);
  const top=add(hook,[axis[0]*.014,-.018,axis[2]*.014]);
  cylinder(m,'tube',organ.at,hook,.0025,.0020,6);
  cylinder(m,'tube',hook,top,.0020,.0025,6);
  const color=kind==='ember'?'coals':'petal',edge=kind==='ember'?'coalRim':'petalEdge',inner=kind==='ember'?'coalInner':'inner';
  const core=add(top,[0,-.019*s,0]),bell=add(top,[0,-.038*s,0]);
  turn(m,kind==='ember'?'coals':'bell',bell,[[.007*s,0],[.009*s,.008*s],[.007*s,.020*s],
    [.0032*s,.035*s],[.001*s,.042*s]],26,.047);
  const point=(base,angle,t,v,type)=>{
    const petal=type===0,w=(petal?.011:.006)*Math.sin(Math.PI*t)**.65;
    const amount=petal?.005+.017*Math.sin(t*2)-.006*t*t:.005+.033*t;
    const y=petal?-.037*t:.008*Math.sin(t*2.8)-.020*t;
    const a=angle+.19*Math.sin(t*2.6);
    return add(base,[s*(Math.cos(a)*amount-Math.sin(a)*w*v),s*(y-.009*v*v*Math.sin(Math.PI*t)),
      s*(Math.sin(a)*amount+Math.cos(a)*w*v)]);
  };
  for(let k=0;k<4;k++){
    const a=TAU*k/4+r*TAU;
    for(const type of [0,1]){
      const base=type===0?bell:core,turning=a+(type===0?Math.PI/4:0),n=13;
      for(let j=0;j<n;j++)for(let q=0;q<4;q++){
        const t=j/n,u=(j+1)/n,x=q/2-1,y=(q+1)/2-1;
        const pigment=type===0?(q===1||q===2?inner:kind==='ember'?'coals':'iris'):(q===0||q===3?edge:color);
        m.quad(pigment,point(base,turning,t,x,type),point(base,turning,t,y,type),point(base,turning,u,y,type),point(base,turning,u,x,type));
      }
    }
  }
  for(let k=0;k<6;k++){
    const a=TAU*k/6+.12,x=Math.cos(a),z=Math.sin(a);
    const end=add(bell,[.011*s*x,(-.048+.004*rnd(k+i))*s,.011*s*z]);
    cylinder(m,'petalEdge',add(bell,[x*.004,0,z*.004]),end,.00057,.00041,4);
    stone(m,'stamen',k+i,...end,.0019*s);
  }
  cylinder(m,'stamen',bell,add(bell,[.002,-.059*s,.001]),.00081,.00060,5);
}
export function plantArt(plant,kind){
  const m=model(),stem=kind==='bell'?'trunk':kind==='fern'?'oliveStem':'emberStem';
  for(const organ of plant.organs){
    if(organ.symbol==='L')leaf(m,organ,kind);
    else pendant(m,organ,kind);
  }
  const pieces=m.build();
  if(plant.geometry)pieces.push({name:stem,role:'stem',geometry:plant.geometry,material:material(stem)});
  return pieces;
}
export function cameraFor(w,h,bounds,orbit=0){
  const upper=Math.max(.84,bounds?.max[1]??1),bottom=Math.min(.005,bounds?.min[1]??0);
  const half=upper-bottom,wide=Math.max(.73,(bounds?.max[0]??.4)-(bounds?.min[0]??-.4),
    (bounds?.max[2]??.4)-(bounds?.min[2]??-.4));
  const aspect=w/Math.max(1,h),angle=.125+orbit;
  const vertical=aspect<.99?39:36;
  const d=Math.max(1.91,half*1.78,wide*1.54/Math.max(.76,aspect));
  const topY=(upper+bottom)*.5+.012;
  const centre=bounds?bounds.min.map((v,i)=>(v+bounds.max[i])*.5):[0,topY,0];
  return {position:[centre[0]+Math.sin(angle)*d,topY+d*.166,centre[2]+Math.cos(angle)*d],
    target:[centre[0],topY,centre[2]],fov:vertical,near:.055,far:35};
}
