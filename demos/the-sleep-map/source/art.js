import {Geometry,PbrMaterial} from '@margoengine/core';
import {bays,radius} from './layout.js';

const tau=Math.PI*2;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const unit=a=>{const len=Math.hypot(...a)||1;return a.map(v=>v/len);};
const colors={
  slate:['#303e3f',.93,0],slateLight:['#313f3e',.86,0],groove:['#233132',.95,0],
  cork:['#29332f',.89,0],frame:['#375957',.50,.18],lacquer:['#527271',.44,.21],
  seal:['#172627',.91,0],bevel:['#476365',.54,.27],bench:['#416264',.65,.18],
  amber:['#dba373',.44,.59],brass:['#99754e',.47,.75],patina:['#735c49',.62,.59],
  warm:['#72533f',.66,.60],wall:['#324344',.61,.23],floor:['#697f79',.85,0],
  trace:['#788a80',.83,0],black:['#273939',.59,.26],bolt:['#a59a84',.37,.72],
  ivory:['#d1c0a0',.67,.05],enamel:['#bd7754',.48,.09],yellow:['#f5bb79',.36,.16],
  specimen:['#914f46',.49,.07],
};
function material(name){
  const [color,roughness,metalness]=colors[name];
  return new PbrMaterial({color,roughness,metalness});
}
function draft(){
  const buffers=new Map();
  function triangle(name,a,b,c,na,nb,nc){
    const facing=unit(cross(sub(b,a),sub(c,a)));
    if(Math.hypot(...facing)<.1)return;
    if(!buffers.has(name))buffers.set(name,{p:[],n:[],i:[]});
    const mesh=buffers.get(name),base=mesh.p.length/3;
    mesh.p.push(...a,...b,...c);mesh.n.push(...(na??facing),...(nb??na??facing),...(nc??na??facing));
    mesh.i.push(base,base+1,base+2);
  }
  return {triangle,quad(name,a,b,c,d,na,nb,nc,nd){
    triangle(name,a,b,c,na,nb,nc);triangle(name,a,c,d,na,nc,nd);
  },meshes:()=>[...buffers].map(([name,{p,n,i}])=>({geometry:new Geometry(p,n,i),material:material(name)}))};
}
function edge(m,name,x,y,z,w,h,d,r){
  const a=w*.5,b=h*.5,c=d*.5,v=Math.min(r,a*.45,b*.45,c*.45);
  const corners=(p,q,t)=>[[-p+t,q],[p-t,q],[p,q-t],[p,-q+t],[p-t,-q],[-p+t,-q],[-p,-q+t],[-p,q-t]];
  const plane=(s,p,q,t)=>corners(p,q,t).map(([i,j])=>[x+i,s,z+j]);
  const faces=[plane(y-b,a-v,c-v,v),plane(y-b+v,a,c,2*v),plane(y+b-v,a,c,2*v),plane(y+b,a-v,c-v,v)];
  for(let k=0;k<3;k++)for(let j=0;j<8;j++){
    const n=(j+1)%8;
    m.quad(name,faces[k][j],faces[k][n],faces[k+1][n],faces[k+1][j]);
  }
  for(let j=1;j<7;j++){
    m.triangle(name,faces[0][0],faces[0][j+1],faces[0][j]);
    m.triangle(name,faces[3][0],faces[3][j],faces[3][j+1]);
  }
}
function turn(m,keys,x,z,profile,n=92,start=0,end=tau){
  const pos=(j,u)=>[x+profile[j][0]*Math.cos(u),profile[j][1],z+profile[j][0]*Math.sin(u)];
  for(let j=0;j<profile.length-1;j++){
    const key=Array.isArray(keys)?keys[j]:keys;
    const [r,y]=profile[j],[R,Y]=profile[j+1];
    const normal=u=>unit([(Y-y)*Math.cos(u),r-R,(Y-y)*Math.sin(u)]);
    for(let k=0;k<n;k++){
      const a=start+(end-start)*k/n,b=start+(end-start)*(k+1)/n;
      m.quad(key,pos(j,a),pos(j+1,a),pos(j+1,b),pos(j,b),normal(a),normal(a),normal(b),normal(b));
    }
  }
}
function faceLine(m,key,a,b,w){
  const [x,y,z]=a,[X,Y,Z]=b;
  const n=unit([Z-z,0,x-X]).map(v=>v*w*.5);
  const point=(p,k)=>p.map((v,i)=>v+k*n[i]);
  m.quad(key,point(a,-1),point(b,-1),point(b,1),point(a,1),[0,1,0]);
}
const glyphs={
  A:['04 02 20 42 44','02 42'],B:['04 00 30 41 32 02','32 43 34 04'],
  C:['40 10 01 03 14 44'],D:['04 00 20 41 43 24 04'],I:['00 40','20 24','04 44'],
  S:['40 10 01 12 32 43 34 04'],L:['00 04 44'],N:['04 00 44 40'],G:['40 10 01 03 14 44 42 22'],
  R:['04 00 30 41 32 02','22 44'],E:['40 00 04 44','02 32'],
};
function engraving(m,name,word,cx,y,z,h){
  let x=cx-(word.length*.80-.17)*h/2;
  for(const letter of word){
    for(const line of glyphs[letter]||[]){
      const points=line.split(' ').map(p=>[x+Number(p[0])*h*.155,y,z+Number(p[1])*h*.25]);
      for(let i=1;i<points.length;i++)faceLine(m,name,points[i-1],points[i],h*.075);
    }
    x+=h*.80;
  }
}
function hardware(m,x,z){
  turn(m,['patina','brass','bolt'],x,z,[[.020,.142],[.021,.149],[.018,.157],[0,.157]],22);
  faceLine(m,'black',[x-.009,.1574,z+.003],[x+.009,.1574,z-.003],.0026);
}
export function makeCase(){
  const m=draft();
  turn(m,['groove','slateLight','slate'],0,0,[[8.98,-.10],[9.00,-.043],[8.94,-.001],[0,-.001]],80);
  edge(m,'cork',.018,.033,.022,1.72,.054,1.56,.021);
  edge(m,'frame',0,.077,0,1.746,.075,1.626,.023);
  edge(m,'patina',0,.107,0,1.726,.020,1.607,.006);
  edge(m,'lacquer',0,.126,0,1.716,.028,1.597,.010);
  edge(m,'seal',0,.142,0,1.669,.012,1.543,.004);
  edge(m,'bench',0,.148,0,1.633,.014,1.510,.004);
  edge(m,'warm',0,.079,.806,.703,.057,.026,.011);
  edge(m,'brass',0,.080,.819,.657,.032,.013,.006);
  for(const x of [-.790,.790])for(const z of [-.732,.732])hardware(m,x,z);
  for(let n=0;n<4;n++){
    const {id,center:[x,z]}=bays[n];
    turn(m,['seal','patina','brass','amber','wall','bevel','seal','floor'],x,z,
      [[.341,.155],[.345,.167],[.345,.190],[.338,.200],[.320,.200],[.316,.193],[.310,.167],[.307,.164],[0,.164]]);
    for(const rad of [.119,.214,.286]){
      turn(m,'trace',x,z,[[rad+.0008,.1644],[rad,.1644]],92);
    }
    for(let i=0;i<40;i++){
      const t=tau*i/40,base=.322,tip=i%5===0?.3355:.329;
      const point=r=>[x+Math.cos(t)*r,.20045,z+Math.sin(t)*r];
      faceLine(m,i%5===0?'ivory':'warm',point(base),point(tip),i%5===0?.0022:.0014);
    }
    for(const dx of [-.25,.25]){
      turn(m,['patina','brass','bolt'],x+dx,z+.275,[[.012,.15],[.013,.162],[.010,.166],[0,.166]],16);
    }
    const tagZ=z+.337,tagX=x-.216;
    edge(m,'patina',tagX,.171,tagZ,.070,.022,.068,.006);
    edge(m,'black',tagX,.184,tagZ,.057,.011,.056,.003);
    engraving(m,'ivory',id,tagX,.1902,tagZ-.019,.035);
    const capX=x+.236,capZ=z+.319;
    turn(m,['seal','patina','brass','amber'],capX,capZ,[[.036,.154],[.037,.163],[.036,.177],[.030,.182],[0,.182]],48);
  }
  edge(m,'patina',0,.154,.006,.230,.018,.063,.005);
  edge(m,'black',0,.166,.006,.210,.012,.054,.002);
  engraving(m,'ivory','ISLAND',0,.173,-.013,.036);
  return m.meshes();
}
export function selectionHardware(){
  const mark=draft(),cap=draft(),small=draft();
  turn(mark,'yellow',0,0,[[.346,.187],[.348,.195],[.344,.201],[.339,.201]],28,.31,1.29);
  turn(mark,'yellow',0,0,[[.346,.187],[.348,.195],[.344,.201],[.339,.201]],28,3.56,4.43);
  const plunger=[[.025,0],[.026,.012],[.022,.020],[.019,.021],[0,.021]];
  turn(cap,['patina','enamel','yellow','enamel'],0,0,plunger,40);
  turn(small,['patina','brass','bolt','black'],0,0,plunger,40);
  return {marker:mark.meshes(),selected:cap.meshes(),other:small.meshes()};
}
export function pelletGeometry(){
  const positions=[],normals=[],indices=[],rings=14,sides=20;
  for(let j=0;j<=rings;j++){
    const theta=Math.PI*j/rings;
    for(let i=0;i<sides;i++){
      const phi=tau*i/sides;
      const dir=[Math.sin(theta)*Math.cos(phi),Math.cos(theta),Math.sin(theta)*Math.sin(phi)];
      normals.push(...dir);positions.push(...dir.map(v=>v*radius));
    }
  }
  for(let j=0;j<rings;j++)for(let i=0;i<sides;i++){
    const a=j*sides+i,b=j*sides+(i+1)%sides,c=a+sides,d=b+sides;
    if(j>0)indices.push(a,b,c);
    if(j<rings-1)indices.push(b,d,c);
  }
  return new Geometry(positions,normals,indices);
}
export function pelletMaterials(){
  const ash=['#8ba9a5','#617f7c','#b6c3b4'],lit=['#d48c62','#b95943','#efd19a'];
  return [ash,lit].map((list,i)=>list.map((color,j)=>
    new PbrMaterial({color,roughness:j===2?.31:.43,metalness:i?.16:.08})));
}
export function cameraFor(width,height){
  const aspect=width/height;
  const distance=Math.max(1,1.275/aspect);
  return {position:[.57*distance,2.25*distance,1.97*distance],
    target:[-.012,.079,.121],fov:35,near:.06,far:12};
}
export function setLights(engine){
  engine.scene.background='#263332';
  engine.lighting.direction.set([-.54,.84,.42,3.05]);
  engine.lighting.radiance.set([1,.903,.772,.57]);
  engine.lighting.ambient.set([.67,.84,.89]);
}
