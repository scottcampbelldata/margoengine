import {Geometry,PbrMaterial} from '@margoengine/core';
import {
  walkways,ramp,pathWidth,stairEntrance,stairExit,stairTop,stairCount,ferrySize,finishZ,floorHeight,
} from './layout.js';

const tau=Math.PI*2;
const plus=(a,b)=>a.map((v,i)=>v+b[i]);
const delta=(a,b)=>a.map((v,i)=>v-b[i]);
const scale=(a,s)=>a.map(v=>v*s);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>scale(a,1/(Math.hypot(...a)||1));
const turnX=(a,t)=>[a[0],a[1]*Math.cos(t)-a[2]*Math.sin(t),a[1]*Math.sin(t)+a[2]*Math.cos(t)];
const tone={
  court:['#526765',.76,0],joint:['#344c4d',.81,0],plate:['#547472',.55,.05],
  brushed:['#7d9087',.52,.17],cap:['#a4aa8e',.48,.23],dark:['#2a4147',.58,.21],
  bar:['#486365',.52,.20],edge:['#b79e74',.45,.36],shadow:['#314747',.86,0],
  step:['#607773',.67,.04],copper:['#9f6250',.55,.53],ochre:['#cf985e',.56,.20],
  signal:['#dd734d',.49,.06],white:['#dac495',.69,0],graphite:['#3a4845',.80,0],
  water:['#4e6b70',.34,.08],waterA:['#62888a',.50,0],waterB:['#758e89',.45,0],
  stone0:['#88675b',.91,0],stone1:['#986d59',.93,0],stone2:['#a7765d',.96,0],
  stone3:['#ae8166',.94,0],stone4:['#b28a74',.93,0],stone5:['#a58375',.98,0],
  pier:['#9a8c75',.83,0],pierEdge:['#b2a185',.77,0],
  farBank:['#af947f',.96,0],farFace:['#b6a08c',.96,0],roof:['#6a6858',.72,0],window:['#3b4f4c',.52,0],lamp:['#eac285',.50,0],
  shrubs0:['#666753',.95,0],shrubs1:['#7d825f',.96,0],beamA:['#6c572f',.66,.4],
};
export const material=name=>{
  const [color,roughness,metalness]=tone[name];
  return new PbrMaterial({color,roughness,metalness,doubleSided:false});
};
function model(){
  const groups=new Map();
  function triangle(k,a,b,c,smooth){
    const n=norm(cross(delta(b,a),delta(c,a)));
    if(Math.hypot(...n)<.9)return;
    if(!groups.has(k))groups.set(k,{positions:[],normals:[],indices:[]});
    const g=groups.get(k),off=g.positions.length/3;
    g.positions.push(...a,...b,...c);
    g.normals.push(...(smooth?.[0]??n),...(smooth?.[1]??n),...(smooth?.[2]??n));
    g.indices.push(off,off+1,off+2);
  }
  return {triangle,quad(k,a,b,c,d,smooth){
    triangle(k,a,b,c,smooth?.slice(0,3));triangle(k,a,c,d,smooth?[smooth[0],smooth[2],smooth[3]]:null);
  },meshes:()=>[...groups].map(([name,{positions,normals,indices}])=>({
    name,geometry:new Geometry(positions,normals,indices),material:material(name),
  }))};
}
function rounded(m,k,c,[u,v,w],r=.027,tilt=0){
  const x=u/2,y=v/2,z=w/2;
  r=Math.min(r,x*.45,y*.45,z*.45);
  const ring=(a,b,d)=>[[b-d,a,z-d*.50],[b,a,z-1.9*d],[b,a,-z+1.9*d],[b-d,a,-z+d*.50],
    [-b+d,a,-z+d*.50],[-b,a,-z+1.9*d],[-b,a,z-1.9*d],[-b+d,a,z-d*.50]];
  const rows=[ring(-y,x-r,r),ring(-y+r,x,r*.33),ring(y-r,x,r*.33),ring(y,x-r,r)]
    .map(row=>row.map(p=>plus(c,turnX(p,tilt))));

  for(let q=0;q<3;q++)for(let j=0;j<8;j++){
    const n=(j+1)%8;m.quad(k,rows[q][j],rows[q][n],rows[q+1][n],rows[q+1][j]);
  }
  for(let j=1;j<7;j++){
    m.triangle(k,rows[0][0],rows[0][j+1],rows[0][j]);
    m.triangle(k,rows[3][0],rows[3][j],rows[3][j+1]);
  }
}
function tube(m,k,a,b,r,sides=14){
  const axis=norm(delta(b,a)),u=norm(cross(axis,Math.abs(axis[1])>.8?[1,0,0]:[0,1,0])),v=cross(axis,u);
  const radial=i=>plus(scale(u,Math.cos(i*tau/sides)),scale(v,Math.sin(i*tau/sides)));
  for(let i=0;i<sides;i++){
    const n=radial(i),p=radial(i+1),ar=plus(a,scale(n,r)),as=plus(a,scale(p,r));
    const br=plus(b,scale(n,r)),bs=plus(b,scale(p,r));
    m.quad(k,ar,as,bs,br,[n,p,p,n]);m.triangle(k,a,as,ar);m.triangle(k,b,br,bs);
  }
}
function assembleSupports(m){
  const rail=(x,y,z0,z1)=>{
    for(const h of [.37,.82]){
      tube(m,h>.7?'edge':'bar',[x,y+h,z0],[x,y+h,z1],h>.7?.038:.024);
    }
    const n=Math.max(1,Math.ceil(Math.abs(z0-z1)/.94));
    for(let i=0;i<=n;i++){
      const z=z0+(z1-z0)*i/n;
      rounded(m,'bar',[x,y+.39,z],[.069,.82,.069],.011);
      rounded(m,'edge',[x,y+.020,z],[.18,.045,.18],.009);
    }
  };
  for(const piece of walkways){
    const {position:[x,y,z],size,top,key}=piece;
    rounded(m,key==='tread'?'step':'court',[x,y,z],size,.021);
    const depth=size[2];
    rounded(m,'plate',[x,top-.021,z],[pathWidth-.14,.047,depth-.038],.014);
    if(key==='tread'){
      rounded(m,'ochre',[0,top-.002,z+depth*.5-.059],[pathWidth-.15,.014,.051],.004);
      for(let x=-1.32;x<=1.4;x+=.22){
        rounded(m,'cap',[x,top+.002,z+depth*.5-.137],[.118,.012,.018],.002);
      }
      for(const x of [-1.645,1.645])rounded(m,'edge',[x,top-.184,z],[.09,.335,depth],.020);
    }else{
      const n=Math.ceil(depth/.87);
      for(let i=0;i<n;i++){
        const a=z+(i+.5-n/2)*depth/n;
        rounded(m,'joint',[0,top+.0008,a],[pathWidth-.22,.008,.012],.002);
        for(const x of [-1.37,1.37])rounded(m,'brushed',[x,top+.006,a],[.081,.014,.28],.004);
      }
      for(const x of [-1.632,1.632]){
        rounded(m,'dark',[x,y-.38,z],[.18,.92,depth],.034);
        rounded(m,'edge',[x,top-.080,z],[.100,.15,depth-.027],.013);
        rail(x,top,z-depth*.47,z+depth*.47);
      }
    }
  }
  for(const x of [-1.645,1.645]){
    tube(m,'edge',[x,.67,stairEntrance+.025],[x,stairTop+.80,stairExit-.01],.038);
    tube(m,'dark',[x,.31,stairEntrance+.025],[x,stairTop+.37,stairExit-.01],.025);
    for(let i=0;i<stairCount;i++){
      const y=(i+1)*.18,z=stairEntrance-(i+.42)*.45;
      rounded(m,'bar',[x,y+.32,z],[.062,.69,.068],.008);
    }
  }
  rounded(m,'step',ramp.position,ramp.size,.025,ramp.tilt);
  const along=(x,y,z)=>plus(ramp.position,turnX([x,y,z],ramp.tilt));
  for(const x of [-1.62,1.62]){
    const z0=-ramp.size[2]*.47,z1=ramp.size[2]*.47;
    tube(m,'dark',along(x,.164,z0),along(x,.164,z1),.060);
    tube(m,'edge',along(x,.95,z0),along(x,.95,z1),.037);
    for(let k=0;k<=4;k++){
      const d=z0+k*(z1-z0)/4;
      tube(m,'bar',along(x,.20,d),along(x,.94,d),.033,12);
    }
  }
  for(let z=-1.55;z<=1.6;z+=.35){
    rounded(m,'edge',along(0,.196,z),[pathWidth-.18,.014,.038],.004,ramp.tilt);
  }
  for(const z of [8.3,3.4,1.55,-7.42,-13.6]){
    const top=floorHeight(z+.48)-.135;
    for(const x of [-1.12,1.12]){
      rounded(m,'pier',[x,(top-3.65)/2,z],[.83,top+3.65,.80],.065);
      rounded(m,'pierEdge',[x,top-.43,z],[1.07,.29,1.08],.043);
      tube(m,'shadow',[x,top-.47,z],[x,-2.05,z+.87],.092);
    }
  }
}
const marks={
  A:['04 02 20 42 44','02 42'],B:['04 00 30 41 32 02','32 43 34 04'],
  C:['40 10 01 03 14 44'],G:['40 10 01 03 14 44 42 22'],
  1:['11 20 24','14 34'],2:['01 10 30 41 42 04 44'],0:['10 30 41 43 34 14 03 01 10'],
  W:['00 04 22 44 40'],R:['04 00 30 41 32 02','22 44'],K:['04 00','40 02 44'],S:['40 10 01 12 32 43 34 04'],
};
function lettering(m,word,x,y,z,h,key='white'){
  const stride=.7*h;
  x-=(word.length*stride-.11*h)/2;
  for(const char of word){
    for(const stroke of marks[char]||[]){
      const p=stroke.split(' ').map(pair=>[x+Number(pair[0])*h*.14,y-Number(pair[1])*h*.25,z]);
      for(let j=0;j<p.length-1;j++){
        const a=p[j],b=p[j+1],d=norm(delta(b,a)),side=[-d[1]*h*.041,d[0]*h*.041,0];
        m.quad(key,delta(a,side),delta(b,side),plus(b,side),plus(a,side),[[0,0,1],[0,0,1],[0,0,1],[0,0,1]]);
      }
    }
    x+=stride;
  }
}
function wayfinder(m,x,y,z,label,panel='dark'){
  rounded(m,'bar',[x,y+.54,z],[.12,1.08,.13],.014);
  rounded(m,'edge',[x,y+1.06,z],[.58,.52,.17],.025);
  rounded(m,panel,[x,y+1.06,z+.085],[.49,.43,.028],.013);
  lettering(m,label,x,y+1.23,z+.106,.33);
}
function infrastructure(m,arches){
  const x=-2.98;
  for(const z of [6.05,-6.85,-14.9]){
    for(const side of [-1,1]){
      const i=side*2.18;
      rounded(m,'pier',[i,-1.61,z],[.83,3.24,.81],.072);
      rounded(m,'copper',[i,1.81,z],[.42,4.15,.40],.046);
      rounded(m,'edge',[i,3.83,z],[.58,.21,.55],.030);
      rounded(m,'shadow',[i,.12,z],[.58,.27,.60],.04);
      for(const d of [-.36,.36]){
        tube(m,'copper',[i,.12,z+d],[i+side*.66,-1.53,z+d],.068);
      }
      rounded(m,'lamp',[i,1.95,z+.201],[.20,.19,.052],.024);
    }
    rounded(arches,'copper',[0,4.04,z],[5.03,.24,.46],.046);
    rounded(arches,'ochre',[0,4.178,z],[4.82,.064,.37],.025);
    rounded(arches,'dark',[0,3.930,z+.24],[2.10,.20,.066],.014);
    lettering(arches,z>5?'W0RKS':z<-10?'C':'B',0,4.013,z+.280,.145);
    for(let j=0;j<7;j++){
      tube(arches,'bar',[-2.25+.65*j,3.690,z],[-1.64+.65*j,4.050,z],.030,10);
    }
  }
  for(const x of [-1.1,1.1]){
    tube(m,'dark',[x,.76,.51],[x,.76,-6.25],.09);
    tube(m,'edge',[x,.842,.53],[x,.842,-6.26],.025);
  }
  for(const z of [6.5,3.7,.75,-3.20,-6.27,-9.77,-13.12]){
    tube(m,'copper',[x,1.25,z+.29],[x,1.25,z-.29],.37,28);
    rounded(m,'pier',[x,-.48,z],[.46,2.98,.63],.06);
    tube(m,'edge',[x,1.25,z+.045],[x,1.25,z-.045],.409,26);
    for(let t=0;t<12;t++){
      const a=t*tau/12,s=x+.346*Math.sin(a),h=1.25+.346*Math.cos(a);
      tube(m,'brushed',[s,h,z+.061],[s,h,z+.125],.025,8);
    }
  }
  tube(m,'copper',[x,1.25,10.2],[x,1.25,-16.8],.331,32);
  tube(m,'dark',[x,-.43,10.2],[x,-.43,-17.9],.196,22);
  // The intake’s brass shutoff and stem are distinct silhouettes in the entrance view.
  rounded(m,'bar',[x,1.60,6.50],[.44,.60,.50],.058);
  tube(m,'edge',[x,1.64,6.50],[x,2.08,6.50],.086,18);
  const rim=(r,t)=>[x+Math.cos(t)*r,2.115,6.50+Math.sin(t)*r];
  for(let i=0;i<24;i++)tube(m,'ochre',rim(.27,i*tau/24),rim(.27,(i+1)*tau/24),.027,7);
  for(let i=0;i<5;i++)tube(m,'copper',[x,2.115,6.50],rim(.255,i*tau/5),.025,8);
  tube(m,'edge',[x,2.07,6.50],[x,2.17,6.50],.070,18);
  wayfinder(m,1.90,0,5.42,'A');
  wayfinder(m,1.93,stairTop,.65,'B');
  wayfinder(m,1.89,stairTop,-7.26,'C');
  wayfinder(m,1.91,0,finishZ,'C');

  for(const [cx,z,y,wide] of [[5.40,-15.1,0,5.2],[6.8,-6.12,-1.9,4.8],[-6.7,-11.5,-.4,4.5]]){
    rounded(m,'pier',[cx,y+1.14,z],[wide,2.72,3.25],.077);
    rounded(m,'pierEdge',[cx,y+2.59,z],[wide+.22,.26,3.45],.075);
    rounded(m,'roof',[cx,y+2.78,z],[wide-.16,.20,3.13],.047);
    for(let i=0;i<4;i++){
      const x=cx+(i-1.5)*wide/4.42;
      rounded(m,'roof',[x,y+1.72,z+1.64],[.85,1.03,.095],.025);
      rounded(m,i===1?'lamp':'window',[x,y+1.72,z+1.695],[.71,.87,.019],.012);
      for(const dx of [-.16,.16])rounded(m,'edge',[x+dx,y+1.72,z+1.710],[.023,.80,.02],.003);
    }
  }
}
function canyon(m){
  const vertical=[-3.2,-1.65,.19,1.32,2.83,4.85,6.01,8.19,9.12,10.7,13.2];
  const xNoise=(z,level)=>Math.sin(z*.304+level*.64)*.80+Math.sin(z*.885+level*.073)*.56+Math.sin(z*.123+level*.93)*.59;
  const face=(sign,i,j)=>{
    const z=19-i*1.58;
    const y=vertical[j]+Math.sin(i*.46+j*.85)*.72+Math.sin(i*.15-.5*j)*.37;
    const x=sign*(7.20+j*.15+xNoise(z,j)+(sign===-1?-.67:.43));
    return [x,y,z];
  };
  for(const sign of [-1,1]){
    for(let i=0;i<41;i++)for(let j=0;j<vertical.length-1;j++){
      const a=face(sign,i,j),b=face(sign,i+1,j),c=face(sign,i+1,j+1),d=face(sign,i,j+1);
      const grade='stone'+((j+(i%11===7?1:0)+3)%6);
      if(sign===1)m.quad(grade,b,a,d,c);else m.quad(grade,a,b,c,d);
    }
    for(let i=0;i<34;i++){
      const z=15.3-i*1.48,blend=.5+.5*Math.sin(i*4.17);
      const x=sign*(4.95+blend*1.88);
      rounded(m,'stone'+(i%6),[x,-1.69+blend*.56,z],[1.1+blend*1.27,.6+blend*1.8,1.57+blend*.92],.163);
      for(let q=0;q<4;q++){
        const a=x+Math.cos(q*1.11+i)*.52,yy=-1.35+blend*.94;
        const b=z+Math.sin(q*.76-i)*.61;
        m.triangle(q%2?'shrubs0':'shrubs1',[a-.13,yy,b],[a+.08,yy,b+.01],[a-.04,yy+.63,b-.18]);
        m.triangle('shrubs1',[a+.08,yy,b+.01],[a-.13,yy,b],[a-.04,yy+.63,b-.18]);
      }
    }
  }
}
function distantWalls(m){
  const edge=(i,y)=>[
    (i-10)*2.1,
    y+Math.sin(i*.51)*1.42+Math.cos(i*.92)*.74,
    -38.9-Math.sin(i*.17)*3.5,
  ];
  for(let i=0;i<21;i++){
    const shoulder=5.8+Math.pow(Math.cos(.51+i*.185),2)*6.1;
    const next=5.8+Math.pow(Math.cos(.51+(i+1)*.185),2)*6.1;
    m.quad('farBank',edge(i,-2.25),edge(i+1,-2.25),edge(i+1,next*.55),edge(i,shoulder*.55));
    m.quad('farFace',edge(i,shoulder*.55),edge(i+1,next*.55),edge(i+1,next),edge(i,shoulder));
  }
}
function water(m){
  rounded(m,'water',[0,-2.21,-5],[20,.19,55],.03);
  const height=-2.108;
  for(let i=0;i<114;i++){
    const t=i*2.381,span=.19+.45*(.5+.5*Math.sin(t)),z=13-i*.372;
    const x=5.95*Math.sin(t)+Math.sin(i*.231)*.79;
    m.quad(i%4===0?'waterB':'waterA',[x-span,height,z+.024],[x+span,height,z+.016],[x+span*.76,height,z-.030],[x-span*.63,height,z-.034]);
  }
}
export function buildStation(){
  const m=model(),arches=model();
  assembleSupports(m);infrastructure(m,arches);canyon(m);distantWalls(m);water(m);
  return {structure:m.meshes(),arches:arches.meshes()};
}
export function buildFerry(){
  const m=model();
  rounded(m,'dark',[0,0,0],ferrySize,.045);
  rounded(m,'plate',[0,.132,0],[3.00,.037,2.06],.016);
  rounded(m,'ochre',[0,.084,1.083],[3.10,.111,.088],.020);
  rounded(m,'ochre',[0,.084,-1.083],[3.10,.111,.088],.020);
  for(let i=0;i<11;i++){
    const x=(i-5)*.249;
    rounded(m,'brushed',[x,.149,0],[.145,.021,1.82],.005);
    rounded(m,i%2?'dark':'signal',[x,.143,-.982],[.162,.027,.036],.008);
    rounded(m,i%2?'dark':'signal',[x,.143,.982],[.162,.027,.036],.008);
  }
  for(const x of [-1.489,1.489]){
    for(const z of [-.88,0,.88]){
      rounded(m,'ochre',[x,.524,z],[.09,.79,.10],.012);
    }
    tube(m,'ochre',[x,.914,-.94],[x,.914,.94],.041);
    tube(m,'bar',[x,.503,-.94],[x,.503,.94],.026);
    tube(m,'dark',[x,-.12,-.82],[x,-.12,.82],.10);
  }
  const target=(r,t)=>[r*Math.cos(t),.161,r*Math.sin(t)];
  for(let j=0;j<48;j++){
    const t=j*tau/48,s=(j+1)*tau/48;
    m.quad('ochre',target(.45,t),target(.41,t),target(.41,s),target(.45,s));
  }
  return m.meshes();
}
export function tuneLighting(engine){
  engine.scene.background='#c5ab91';
  engine.lighting.direction.set([-.51,.75,.37,2.74]);
  engine.lighting.radiance.set([1,.90,.78,.65]);
  engine.lighting.ambient.set([.74,.87,.91]);
}
