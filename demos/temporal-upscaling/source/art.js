import {Geometry,PbrMaterial} from '@margoengine/core';
import {engineRuntime} from '@margoengine/core/extension';

const TAU=Math.PI*2;
const mix=(a,b,t)=>a+(b-a)*t;
const place=(a,b,t)=>a.map((v,i)=>mix(v,b[i],t));
const plus=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const scale=(a,s)=>a.map(v=>v*s);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>{const d=Math.hypot(...a)||1;return scale(a,1/d);};
const f=Math.fround;
const colors={
  sky:['#b2c1ba',.95],
  stone0:['#5b5b52',.88],stone1:['#626157',.91],stone2:['#69685d',.90],stone3:['#736f60',.90],snow:['#c2c5b8',.82],
  hill0:['#75888c',.93],hill1:['#85939a',.89],hill2:['#93949e',.88],hill3:['#aa9eaa',.91],
  hillSnow0:['#aeb9b8',.89],hillSnow1:['#b9c0c2',.92],hillSnow2:['#c0bcc0',.90],hillSnow3:['#cbc0c2',.91],
  pine:['#3b514b',.86],pineTip:['#56665a',.88],pineFar:['#556564',.91],trunk:['#706351',.90],
  steel:['#486262',.51],steelDark:['#374f55',.69],steelLight:['#6e8683',.56],grating:['#a4ac9a',.54],
  wire:['#39484a',.46],wireLight:['#a99972',.62],bolts:['#a0a192',.52],
  concrete:['#9b9584',.88],concreteDark:['#706e62',.91],stucco:['#b9ad90',.71],
  roof:['#675d51',.77],roofRim:['#827768',.65],timber:['#715a42',.85],warm:['#e0d6b7',.71],
  red:['#bf4e36',.46],redLight:['#dc6749',.43],garnet:['#8d4134',.62],glass:['#46595b',.27],
  metal:['#c6b18c',.49],rubber:['#3a4545',.76],
};

function builder(){
  const groups=new Map();
  function group(key){
    if(!groups.has(key))groups.set(key,{points:[],normals:[],indices:[]});
    return groups.get(key);
  }
  const tri=(m,A,B,C,shading)=>{
    const r=group(m),i=r.points.length/3,N=unit(cross(sub(B,A),sub(C,A)));
    r.points.push(...A,...B,...C);
    if(shading)r.normals.push(...shading[0],...shading[1],...shading[2]);
    else r.normals.push(...N,...N,...N);
    r.indices.push(i,i+1,i+2);
  };
  const quad=(m,A,B,C,D)=>{tri(m,A,B,C);tri(m,A,C,D);};
  return {tri,quad,create(){
    return [...groups].map(([name,g])=>{
      const [color,roughness]=colors[name];
      return {name,geometry:new Geometry(g.points,g.normals,g.indices),
        material:new PbrMaterial({color,roughness,doubleSided:true})};
    });
  }};
}

function bevel(g,m,c,w,h,d,r=.02){
  const [X,Y,Z]=c,a=w/2,b=h/2,k=d/2;
  const v=Math.min(r,a*.42,b*.42,k*.42);
  const loop=(y,x,z,s)=>[[X-x+s,Y+y,Z+z],[X+x-s,Y+y,Z+z],[X+x,Y+y,Z+z-s],[X+x,Y+y,Z-z+s],
    [X+x-s,Y+y,Z-z],[X-x+s,Y+y,Z-z],[X-x,Y+y,Z-z+s],[X-x,Y+y,Z+z-s]];
  const rows=[loop(-b,a-v,k-v,v*.3),loop(-b+v,a,k,v),loop(b-v,a,k,v),loop(b,a-v,k-v,v*.3)];
  for(let j=0;j<3;j++)for(let i=0;i<8;i++){
    const next=(i+1)%8;
    g.quad(m,rows[j][i],rows[j][next],rows[j+1][next],rows[j+1][i]);
  }
  for(let j=1;j<7;j++){
    g.tri(m,rows[0][0],rows[0][j+1],rows[0][j]);
    g.tri(m,rows[3][0],rows[3][j],rows[3][j+1]);
  }
}
function pipe(g,m,A,B,r,sides=8,caps=true){
  const d=unit(sub(B,A)),u=unit(cross(d,Math.abs(d[1])>.87?[1,0,0]:[0,1,0])),v=cross(d,u);
  const p=(o,k)=>plus(o,plus(scale(u,r*Math.cos(k*TAU/sides)),scale(v,r*Math.sin(k*TAU/sides))));
  for(let i=0;i<sides;i++){
    g.quad(m,p(A,i),p(A,i+1),p(B,i+1),p(B,i));
    if(caps){g.tri(m,A,p(A,i+1),p(A,i));g.tri(m,B,p(B,i),p(B,i+1));}
  }
}

function rough(a,b,k){
  const t=Math.sin(a*142.57+b*13.39+k*35.91)*43758.5453123;
  return t-Math.floor(t);
}

export function grade(x,z){
  const valley=-.48-3.0/(1+Math.exp((x-.08)*1.06));
  const broad=.51*Math.sin(x*.57+z*.33+.1)*Math.sin(.58*z+.47);
  const cut=.27*Math.sin(1.2*x+z*1.31)*Math.cos(1.06*z-.25*x);
  const grit=.034*Math.sin(x*8.04+z*.73)*Math.sin(z*5.87-.31*x);
  return f(valley+broad+cut+grit);
}
function gradeNormal(x,z){
  const d=.055;
  return unit([grade(x-d,z)-grade(x+d,z),2*d,grade(x,z-d)-grade(x,z+d)]);
}
function sky(g){
  g.quad('sky',[ -127,-19,-83],[125,-19,-83],[125,64,-83],[-127,64,-83]);
}

// The sky card lives behind the ridges and shares their perspective and temporal sample positions.
export function lightSky(engine){
  const runtime=engineRuntime(engine);
  const fragment='@fragment fn fragment(i:Output,@builtin(front_facing) front:bool)->@location(0) vec4f {';
  const skyState= /* wgsl */`
    if(i.position.z<-82.9){
      let p=i.position.xy;
      let up=smoothstep(-15.0,37.0,p.y);
      let mist=mix(vec3f(.79,.724,.619),vec3f(.527,.669,.698),up);
      let sun=p-vec2f(-49.0,11.0);
      let haze=exp(-dot(sun,sun)*0.00076);
      let lowCloud=sin(p.x*.125+p.y*.91+sin(p.x*.093)*.82)*.008;
      let highCloud=sin(p.x*.032+p.y*.311+p.x*p.y*.001)*.011;
      let modulation=(lowCloud+highCloud)*(1.0-up*.65);
      return vec4f(mist+vec3f(.070,.034,.011)*haze+vec3f(modulation),1.0);
    }
  `;
  runtime.use({name:'daybreak-sky',setup(){},registerPasses(graph){
    graph.add({name:'daybreak-sky:shade',order:-800,execute(c){
      if(c.backend==='webgpu')c.shader=c.shader.replace(fragment,fragment+skyState);
    }});
  }});
}
function ground(g){
  const W=68,D=49,left=-16.5,back=-17,rows=[];
  for(let j=0;j<=D;j++){
    rows.push(Array.from({length:W+1},(_,i)=>{
      const x=left+i*.445+(rough(i,j,0)-.5)*.18,z=back+j*.449+(rough(i,j,1)-.5)*.175;
      return [[x,grade(x,z),z],gradeNormal(x,z)];
    }));
  }
  const key=(x,z,n)=>{
    const mineral=Math.sin(.63*x+.36*z)*.24+.20*Math.sin(x*1.99-z*.74)+.20*Math.cos(x*.64+z*1.84);
    const drift=Math.sin(.27*x+.57*z+.51*Math.sin(x*1.04+z*.62))+.42*Math.sin(.91*x-z*.98);
    if(n[1]>.85&&x<1.7&&drift>.79)return 'snow';
    const index=Math.min(3,Math.floor(4*(.51+mineral*.58)));
    return 'stone'+index;
  };
  for(let j=0;j<D;j++)for(let i=0;i<W;i++){
    const [[a,na],[b,nb],[c,nc],[d,nd]]=[rows[j][i],rows[j+1][i],rows[j+1][i+1],rows[j][i+1]];
    g.tri(key((a[0]+b[0]+c[0])/3,(a[2]+b[2]+c[2])/3,nb),a,b,c,[na,nb,nc]);
    g.tri(key((a[0]+c[0]+d[0])/3,(a[2]+c[2]+d[2])/3,nc),a,c,d,[na,nc,nd]);
  }
  for(let ridge=3;ridge>=0;ridge--){
    const samples=95,levels=6,z0=-18-12*ridge,bottom=-7.8-2.4*ridge;
    const ridgeline=x=>{
      const a=.45+.31*Math.sin(x*.18+.93+ridge*.50)*Math.cos(x*.39-ridge*.44);
      const peaks=.27*Math.abs(Math.sin(x*.32-1.03+ridge*.61))**2.55+.06*Math.sin(x*1.16+ridge*1.3);
      const weather=.032*Math.sin(x*2.11-ridge)+.023*Math.cos(x*3.41);
      return bottom+2+(9.2+ridge*4.8)*(a+peaks+weather);
    };
    const point=(i,l)=>{
      const stride=.62+ridge*.29,yieldHeight=l/levels,x=(i-samples*.48)*stride;
      const warp=(Math.sin(.43*x-ridge)*1.75+.8*Math.sin(.98*x+ridge))*(1-yieldHeight);
      return [x+warp*.42,mix(bottom,ridgeline(x),yieldHeight)+warp*.43,
        z0+(1-yieldHeight)*(3.98+ridge*.51)+.49*Math.sin(x*.87+ridge)*Math.sin(yieldHeight*Math.PI)];
    };
    const p=Array.from({length:levels+1},(_,l)=>Array.from({length:samples+1},(_,i)=>point(i,l)));
    const N=(i,l)=>{
      const row=p[l],left=row[Math.max(0,i-1)],right=row[Math.min(samples,i+1)];
      return unit(cross(sub(right,left),sub(p[Math.min(levels,l+1)][i],p[Math.max(0,l-1)][i])));
    };
    const normals=p.map((row,l)=>row.map((_,i)=>N(i,l)));
    for(let i=0;i<samples;i++)for(let l=0;l<levels;l++){
      const striation=Math.sin(i*.34+l*.50+ridge)*.45+Math.sin(i*.18-l*.75+ridge*1.8)*.55;
      const m=l>3&&striation>.26?'hillSnow'+ridge:'hill'+ridge;
      const A=p[l][i],B=p[l][i+1],C=p[l+1][i+1],D=p[l+1][i];
      const na=normals[l][i],nb=normals[l][i+1],nc=normals[l+1][i+1],nd=normals[l+1][i];
      g.tri(m,A,B,C,[na,nb,nc]);g.tri(m,A,C,D,[na,nc,nd]);
    }
  }
}

function tree(g,x,z,height,seed){
  const y=grade(x,z)-.08,form=rough(x,z,seed)*TAU;
  const far=z<-8.5,near=x<-3.8&&z>-2.5;
  const layers=far?5:near?8:7,branches=far?7:near?10:8;
  const stem=height*.018;
  pipe(g,'trunk',[x,y,z],[x+stem,y+.91*height,z-stem*.70],.026*height,far?4:6,false);
  for(let l=0;l<layers;l++){
    const t=l/(layers-1),normalized=.257+t*.681,y0=y+normalized*height;
    const thin=height*(.058-.035*t),hold=height*(.247-.210*t),wind=height*.039*t*t;
    for(let k=0;k<branches;k++){
      const az=form+k/branches*TAU+l*2.39996,s=Math.sin(az),c=Math.cos(az);
      const wiggle=rough(k,l,seed),radius=hold*(.68+.52*wiggle),dip=height*(.032+.068*wiggle)*(1-t*.61);
      const anchor=[x+wind,y0+.074*height,z+wind*.21];
      const end=[x+wind+c*radius,y0-dip,z+wind*.21+s*radius];
      const split=place(anchor,end,.48);
      const L=[split[0]-s*thin,split[1]-.046*height,split[2]+c*thin];
      const R=[split[0]+s*thin,split[1]-.039*height,split[2]-c*thin];
      const ridge=[split[0],split[1]+height*(.034-.017*t),split[2]];
      const key=far?'pineFar':wiggle>.54?'pineTip':'pine';
      g.tri(key,anchor,L,ridge);g.tri(key,anchor,ridge,R);
      g.tri(key,L,end,ridge);g.tri(key,ridge,end,R);
      if(near&&t<.78)g.tri(key,L,place(end,anchor,.22),R);
    }
  }
}

function vegetation(g){
  for(let i=0;i<73;i++){
    const x=mix(-14,9,rough(i,1,7)),z=mix(-16,1.25,rough(i,3,5)),v=rough(i,6,2);
    if((x>-.25&&x<6.4&&z>-6.5)|| (z>-.8&&x>-4.8))continue;
    tree(g,x,z,mix(.44,1.86,v),i);
  }
  for(const [i,[x,z,h]] of [[-4.9,-.9,1.58],[-6.15,1.02,2.36],[5.8,-1.62,1.58],[6,-4.18,1.50],[-2.7,-3.4,.78]].entries()){
    tree(g,x,z,h,i+700);
  }
}
function tower(g){
  const X=.73,Z=-1.63,Y=-.33,signs=[[-1,-1],[1,-1],[1,1],[-1,1]];
  const axis=(sx,sz,t)=>[X+sx*mix(.755,.455,t),Y+t*4.59,Z+sz*mix(.66,.38,t)];
  for(const [sx,sz] of signs){
    const p=axis(sx,sz,0),q=axis(sx,sz,1);
    bevel(g,'concrete',[p[0],p[1]+.02,p[2]],.43,.45,.43,.035);
    bevel(g,'steelDark',[p[0],p[1]+.27,p[2]],.28,.066,.28,.009);
    pipe(g,'steel',p,q,.078,6);
    for(const [a,b] of signs){
      pipe(g,'bolts',[p[0]+a*.097,p[1]+.25,p[2]+b*.097],[p[0]+a*.097,p[1]+.318,p[2]+b*.097],.016,6);
    }
  }
  const heights=[.07,.247,.425,.603,.781,.959];
  for(let end=0;end<4;end++){
    const a=signs[end],b=signs[(end+1)%4];
    for(let n=0;n<heights.length;n++){
      const t=heights[n],P=axis(...a,t),Q=axis(...b,t);
      pipe(g,'steelDark',P,Q,.041,5);
      if(n<heights.length-1){
        pipe(g,'steelLight',P,axis(...b,heights[n+1]),.021,5);
        pipe(g,'steel',Q,axis(...a,heights[n+1]),.021,5);
      }
    }
  }
  bevel(g,'steelDark',[X,4.23,Z],.99,.14,1.46,.033);
  bevel(g,'steelLight',[X,4.36,Z],.55,.17,1.89,.029);
  for(const s of [-1,1]){
    const z=Z+s*.65;
    for(let j=0;j<6;j++){
      const px=X-.372+j*.148,ry=4.534-Math.abs(j-2.5)*.013;
      pipe(g,'steelDark',[px,ry,z-.070],[px,ry,z+.070],.083,16);
      pipe(g,'metal',[px,ry,z-.077],[px,ry,z-.062],.027,12);
      if(j===0||j===5)pipe(g,'steel',[px,4.31,z],[px,ry-.022,z],.049,8);
    }
    bevel(g,'steel',[X,4.43,z],.96,.085,.18,.011);
  }
  for(let i=0;i<28;i++){
    const y=.17+i*.131;
    pipe(g,'grating',[X+.64,y,Z+.76],[X+1.01,y,Z+.76],.0105,6);
  }
  for(const x of [X+.64,X+1.01])pipe(g,'steelLight',[x,.08,Z+.76],[x,4.34,Z+.76],.025,8);
}

const track=[
  [-12.5,.65,-7.40],[-6.52,2.83,-4.42],[.73,4.66,-1.61],[4.91,4.96,.11],[12,5.48,2.81],
];
function railPoint(span,t,side=0){
  const p=place(track[span],track[span+1],t);
  p[1]-=[.31,.42,.14,.30][span]*4*t*(1-t);p[2]+=side;
  return p;
}
function cables(g){
  for(let span=0;span<track.length-1;span++)for(const [side,m,r] of [[-.66,'wire',.024],[.66,'wire',.024],[.40,'wireLight',.011],[-.40,'wireLight',.011]]){
    const steps=span===1?27:19;
    for(let step=0;step<steps;step++){
      pipe(g,m,railPoint(span,step/steps,side),railPoint(span,(step+1)/steps,side),r,7,false);
    }
  }
}
function tram(g){
  const p=railPoint(1,.54,.66),[x,cable,z]=p,yo=cable-1.31;
  const B=(m,y,w,h,d,r=.024)=>bevel(g,m,[x,yo+y,z],w,h,d,r);
  for(const dx of [-.34,.34]){
    pipe(g,'rubber',[x+dx,cable+.016,z-.085],[x+dx,cable+.016,z+.085],.098,18);
    pipe(g,'metal',[x+dx,cable+.016,z+.084],[x+dx,cable+.016,z+.113],.042,12);
    pipe(g,'steelDark',[x+dx,cable-.03,z],[x+dx*.57,cable-.44,z],.032,8);
  }
  B('steel',.990,.78,.075,.20,.017);
  pipe(g,'steelDark',[x,cable-.32,z],[x,cable-.63,z],.064,10);
  pipe(g,'metal',[x-.180,yo+.62,z],[x+.180,yo+.62,z],.039,8);
  B('garnet',-.43,1.40,.120,.89,.045);
  B('red',-.235,1.56,.35,.99,.075);
  B('rubber',-.011,1.48,.72,.90,.072);
  B('warm',-.019,1.515,.052,.944,.008);
  B('red',.429,1.57,.16,1.01,.039);
  B('redLight',.512,1.43,.043,.93,.014);
  B('metal',.544,1.19,.045,.72,.015);
  const P=(dx,y,dz)=>[x+dx,yo+y,z+dz];
  for(const off of [-.461,.462]){
    const side=off>0?1:-1;
    for(let i=0;i<4;i++){
      const x0=-.676+i*.338,x1=x0+.305, xTop0=x0*.94,xTop1=x1*.94;
      g.quad('glass',P(x0,.014,off),P(x1,.014,off),P(xTop1,.342,off*1.007),P(xTop0,.342,off*1.007));
      pipe(g,'garnet',P(x0,-.039,off+side*.011),P(xTop0,.413,off+side*.014),.017,7);
      pipe(g,'metal',P(x0+.02,.337,off+side*.014),P(x1-.008,.337,off+side*.014),.011,7);
    }
    pipe(g,'garnet',P(.679,-.039,off+side*.011),P(.639,.411,off+side*.014),.022,7);
    pipe(g,'rubber',P(-.615,-.362,off+side*.044),P(.613,-.362,off+side*.044),.024,8);
    for(let i=0;i<5;i++){
      const sx=-.51+i*.255;
      bevel(g,'redLight',P(sx,-.25,off+side*.039),.020,.175,.018,.004);
    }
  }
  for(const side of [-1,1]){
    const q=side*.725;
    g.quad('glass',P(q,.005,-.364),P(q,.005,.364),P(q*.985,.358,.357),P(q*.985,.358,-.357));
    pipe(g,'metal',P(q*1.002,.017,.004),P(q*.993,.398,.004),.014,8);
  }
}

function station(g){
  const X=4.68,Z=.06;
  const B=(m,x,y,z,w,h,d,r)=>bevel(g,m,[X+x,y,Z+z],w,h,d,r);
  B('concreteDark',0,-.2,0,3.99,.52,2.43,.065);
  B('concrete',0,.015,0,3.73,.29,2.30,.050);
  B('stucco',.60,1.11,-.68,2.45,2.16,.62,.037);
  B('stucco',.60,1.13,-1.04,2.45,2.21,.19,.031);
  B('roof',.65,2.28,-.61,2.81,.18,1.33,.025);
  B('roofRim',.64,2.40,-.57,2.67,.11,1.26,.019);
  B('timber',.69,1.34,-.325,1.93,1.25,.052,.019);
  for(let i=0;i<17;i++)B(i%4===0?'roofRim':'timber',-.21+i*.108,1.335,-.265,.038,1.23,.027,.004);
  B('concreteDark',.63,.185,-.31,2.47,.32,.21,.018);
  B('steelDark',-.18,.188,.63,2.82,.11,.93,.017);
  for(let i=0;i<32;i++){
    B(i%4===0?'metal':'steelLight',-1.51+i*.086,.256,.64,.049,.019,.876,.003);
  }
  for(const x of [-1.48,-.78,-.08,.62,1.32]){
    pipe(g,'steelDark',[X+x,.21,Z+1.082],[X+x,1.01,Z+1.082],.027,8);
  }
  pipe(g,'metal',[X-1.54,1.04,Z+1.082],[X+1.37,1.04,Z+1.082],.026,9);
  for(let k=0;k<2;k++)pipe(g,'steel',[X-1.54,.40+k*.28,Z+1.082],[X+1.37,.40+k*.28,Z+1.082],.011,7);
  for(let i=0;i<39;i++){
    const x=X-1.48+i*.071;
    pipe(g,'grating',[x,.37,Z+1.072],[x,.92,Z+1.072],.0043,5);
  }
  for(const dx of [-1.24,-.46]){
    const a=[X+dx,.11,Z-.54],b=[X+dx,4.92,Z-.54];
    pipe(g,'steelDark',a,b,.059,6);
    pipe(g,'steelLight',[a[0],2.18,a[2]],[b[0],4.78,Z+1.02],.033,6);
  }
  B('steel',-.85,4.87,.08,1.03,.153,1.94,.03);
}

function moorings(g){
  for(const [x,y,Z] of track.slice(0,2)){
    const low=grade(x,Z)-.14;
    const side=[-.62,.62],groundW=.54,topW=.33;
    for(const sz of side)for(const dx of [-1,1]){
      const a=[x+dx*groundW,low,Z+sz],b=[x+dx*topW,y-.185,Z+sz*.79];
      bevel(g,'concrete',[a[0],a[1]+.06,a[2]],.32,.49,.33,.033);
      pipe(g,'steel',a,b,.056,6);
    }
    for(const zz of side){
      pipe(g,'steelLight',[x-groundW,low+.33,Z+zz],[x+topW,y-.185,Z+zz*.80],.025,6);
      pipe(g,'steelDark',[x+groundW,low+.33,Z+zz],[x-topW,y-.185,Z+zz*.80],.024,6);
    }
    bevel(g,'steelDark',[x,y-.147,Z],.57,.15,1.62,.028);
    for(const s of [-1,1])pipe(g,'metal',[x-.30,y-.058,Z+s*.66],[x+.30,y-.058,Z+s*.66],.036,8);
  }
}

export function buildCableway(){
  const g=builder();
  sky(g);ground(g);vegetation(g);tower(g);station(g);cables(g);tram(g);moorings(g);
  return g.create();
}

export function cameraAt(width,height,phase){
  const portrait=width/height<1.04;
  const yaw=.233+phase*.17,depth=portrait?10.65:12.65;
  return {position:[Math.sin(yaw)*depth,portrait?4.1:4.7,Math.cos(yaw)*depth],
    target:portrait?[-.24,2.05,-1.40]:[.58,2.00,-1.95],
    fov:portrait?Math.min(61,44+Math.max(0,1-width/height)*27):32,near:.13,far:115};
}
