import {Geometry,PbrMaterial} from '@margoengine/core';
import {obstacleBoxes,stations,span,start} from './airspace.js';

const tau=2*Math.PI;
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mul=(a,s)=>a.map(v=>v*s);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>mul(a,1/(Math.hypot(...a)||1));
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
function seeded(n){return ()=>{n=Math.imul(n,1664525)+1013904223|0;return (n>>>0)/4294967296;};}
const tones={
  floor0:['#a6aca0',.88],floor1:['#a7ad9e',.84],floor2:['#aab1a5',.84],floor3:['#a7b1ab',.86],
  frame:['#6f7c74',.69],frameB:['#aab4a6',.72],chalk:['#cbd3c1',.64],bone:['#d8d4bc',.67],
  underside:['#696e62',.82],recess:['#434d49',.85],shadow:['#737d73',.86],grit:['#99a298',.92],
  glass0:['#93b3aa',.60],glass1:['#a8c1b1',.68],glass2:['#83a7a1',.61],glass3:['#75a09b',.66],
  mineral:['#c59269',.85],clay:['#a26e56',.77],terra:['#ae6346',.66],bronze:['#997c5d',.58],edge:['#9aa492',.54],
  ceiling:['#aabeb1',.81],bar:['#879689',.66],glaze:['#c1ccc0',.53],depth:['#3e615b',.81],rail:['#617c72',.67],transom:['#cdd1b5',.67],glassVeil:['#9db9ae',.64],
  plant0:['#62795b',.94],plant1:['#789473',.90],plant2:['#829b78',.87],plant3:['#b0b391',.94],
  bank0:['#677b67',.86],bank1:['#8f9d7c',.88],pot:['#ae9f81',.81],
  drone:['#d6d8c3',.53],carbon:['#465952',.58],rubber:['#384944',.86],rotor:['#607772',.61],lens:['#628788',.34],
  amber:['#d89b59',.48],azure:['#5aa2a1',.49],orchid:['#7b81a9',.52],milk:['#ddded0',.68],stripe:['#a3694d',.69],
  routeA:['#d38b48',.54],routeB:['#3b9096',.53],routeC:['#7966a4',.57],
};
const shades=['amber','azure','orchid'],routeColours=['routeA','routeB','routeC'];

function draft(){
  const entries=new Map();
  function tri(name,a,b,c,known){
    let normal=unit(cross(sub(b,a),sub(c,a)));
    if(known&&normal.reduce((a,v,i)=>a+v*known[i],0)<0){[b,c]=[c,b];normal=mul(normal,-1);}
    if(Math.hypot(...normal)<.5)return;
    if(!entries.has(name))entries.set(name,{p:[],n:[],i:[]});
    const data=entries.get(name),k=data.p.length/3,n=known??normal;
    data.p.push(...a,...b,...c);data.n.push(...n,...n,...n);data.i.push(k,k+1,k+2);
  }
  return {
    tri,quad(name,a,b,c,d,n){tri(name,a,b,c,n);tri(name,a,c,d,n);},
    make(engine,parent=null){
      return [...entries].map(([name,v])=>{
        const [color,roughness]=tones[name];
        return engine.createMesh(parent).setGeometry(new Geometry(v.p,v.n,v.i))
          .setMaterial(new PbrMaterial({color,roughness,metalness:0,doubleSided:true}));
      });
    },
  };
}
function panel(m,key,[x,y,z],[width,height,depth],edge=.025){
  const a=width/2,b=height/2,c=depth/2,t=Math.min(a*.35,b*.62,c*.35,Math.max(.0005,edge));
  const corners=(Y,W,D)=>[[W-t,D],[-W+t,D],[-W,D-t],[-W,-D+t],[-W+t,-D],[W-t,-D],[W,-D+t],[W,D-t]]
    .map(([u,v])=>[x+u,y+Y,z+v]);
  const slices=[corners(-b,a-t,c-t),corners(-b+t,a,c),corners(b-t,a,c),corners(b,a-t,c-t)];
  for(let j=0;j<3;j++)for(let i=0;i<8;i++){
    const k=(i+1)%8;
    m.quad(key,slices[j][k],slices[j][i],slices[j+1][i],slices[j+1][k]);
  }
  for(let i=1;i<7;i++){
    m.tri(key,slices[3][0],slices[3][i],slices[3][i+1],[0,1,0]);
    m.tri(key,slices[0][0],slices[0][i],slices[0][i+1],[0,-1,0]);
  }
}
function rod(m,name,a,b,r0,r1=r0,count=12,caps=true){
  const axis=unit(sub(b,a)),u=unit(cross(axis,Math.abs(axis[1])>.83?[1,0,0]:[0,1,0])),v=cross(axis,u);
  const N=i=>add(mul(u,Math.cos(i*tau/count)),mul(v,Math.sin(i*tau/count)));
  for(let i=0;i<count;i++){
    const n=N(i),o=N(i+1),p=add(a,mul(n,r0)),q=add(a,mul(o,r0)),r=add(b,mul(o,r1)),s=add(b,mul(n,r1));
    m.quad(name,p,q,r,s,unit(add(n,o)));
    if(caps){m.tri(name,a,p,q,mul(axis,-1));m.tri(name,b,r,s,axis);}
  }
}
function disc(m,key,p,r,w,a=0,b=tau,sides=54){
  const v=(t,s)=>[p[0]+s*Math.cos(t),p[1],p[2]+s*Math.sin(t)];
  for(let i=0;i<sides;i++){
    const u=a+(b-a)*i/sides,t=a+(b-a)*(i+1)/sides;
    m.quad(key,v(u,r-w),v(u,r),v(t,r),v(t,r-w),[0,1,0]);
  }
}
function grille(m,key,p,dims,n){
  const [x,y,z]=p,[w,h,d]=dims;
  for(let i=0;i<n;i++)panel(m,key,[x+w*(i+.5-n/2)/n,y,z],[Math.min(.023,w*.47/n),h,d],.004);
}
function leaf(m,key,base,tip,width){
  const d=sub(tip,base),crossway=mul(unit(cross(d,[.16,1,.46])),width);
  const midge=add(mix(base,tip,.48),[0,width*.39,.012]);
  const left=add(mix(base,tip,.51),crossway),right=sub(mix(base,tip,.51),crossway);
  m.tri(key,base,left,midge);m.tri(key,left,tip,midge);
  m.tri(key,base,midge,right);m.tri(key,midge,tip,right);
}
function garden(m,x,z,seed){
  const rnd=seeded(seed),h=.11+.07*rnd();
  rod(m,'pot',[x,.017,z],[x,h,z],.17,.22,16);
  rod(m,'bank0',[x,h,z],[x,h+.026,z],.199,.19,16);
  for(let i=0;i<11;i++){
    const dx=(rnd()-.5)*.28,dz=(rnd()-.5)*.29,w=.044+rnd()*.031;
    const p=[x+dx,h+.013,z+dz],tip=[x+dx*2.6,h+.17+rnd()*.38,z+dz*2.5];
    rod(m,'bank1',p,mix(p,tip,.76),.007,.004,5);
    leaf(m,'plant'+(i%4),mix(p,tip,.25),tip,w);
  }
}
function floor(m){
  panel(m,'underside',[0,-.245,0],[12.63,.42,8.45],.084);
  panel(m,'frame',[0,-.152,0],[12.56,.15,8.42],.030);
  panel(m,'frameB',[0,-.064,0],[12.54,.07,8.36],.021);
  panel(m,'recess',[0,-.028,0],[12.49,.033,8.30],.007);
  for(let z=0;z<9;z++)for(let x=0;x<12;x++){
    const z0=(z-4)*.915,x0=(x-5.5)*1.033;
    panel(m,'floor'+((x*7+z*3+x*z)%4),[x0,-.005,z0],[1.025,.032,.907],.005);
  }
  const rnd=seeded(12190);
  for(let i=0;i<660;i++){
    const x=(rnd()-.5)*12.36,z=(rnd()-.5)*8.11,a=.008+rnd()*.010;
    m.tri(i%7===0?'chalk':'grit',[x-a,.013,z],[x+a,.013,z+a*.41],[x,.013,z-a],[0,1,0]);
  }
  for(let i=0;i<48;i++){
    const x=(i-23.5)*.249;
    panel(m,i%4===0?'terra':'rail',[x,.014,3.885],[.009,.005,i%4===0?.124:.06],.001);
  }
  for(const x of [-3.88,4.34]){
    panel(m,'frameB',[x,.018,-.19],[.031,.010,7.56],.003);
  }
  for(const x of [-4.69,-.61,3.51]){
    panel(m,'shadow',[x,.013,-2.25],[1.41,.004,1.92],.001);
    panel(m,'floor3',[x-.96,.0138,-2.03],[.24,.003,2.15],.001);
  }
}
function pavilion(m){
  const Z=-4.08;
  panel(m,'recess',[0,.31,Z],[12.38,.62,.15],.021);
  panel(m,'glaze',[0,3.24,Z],[12.38,5.24,.12],.022);
  const rnd=seeded(8192);
  for(let i=0;i<12;i++){
    const x=(i-5.5)*1.024;
    for(let j=0;j<4;j++){
      const y=.835+j*1.246,a=.96-.010*rnd();
      panel(m,j===3?'glassVeil':'glass'+(i+Math.floor(j*.67)+i*j)%4,[x,y,Z+.078],[a,1.193,.022],.008);
      if((i+j)%4===0)rod(m,'frameB',[x-a*.44,y-.515,Z+.107],[x+a*.43,y+.521,Z+.107],.008,.008,5);
    }
  }
  for(let i=0;i<13;i++){
    const x=(i-6)*1.025;
    panel(m,i%3===0?'frame':'bar',[x,3.22,Z+.14],[i%3===0?.101:.042,5.25,.102],.014);
    panel(m,'edge',[x,.713,Z+.15],[.128,.16,.14],.014);
  }
  for(const y of [.63,1.444,2.695,3.944,5.190,5.91]){
    panel(m,'rail',[0,y,Z+.143],[12.38,y>5.8?.20:.071,.12],.015);
  }
  for(const x of [-6.04,6.04]){
    panel(m,'frameB',[x,3.007,-3.95],[.235,5.90,.222],.040);
    panel(m,'clay',[x,5.94,-3.95],[.30,.160,.31],.025);
  }
  // Laminated arch ribs, bolted end shoes and roof diagonals at the cutaway edge.
  const roof=(x,z)=>[x,5.95+1.14*Math.sin(Math.PI*(z+3.93)/7.85),z];
  for(let i=0;i<7;i++){
    const x=(i-3)*1.96;
    for(let j=0;j<18;j++){
      const a=roof(x,-3.89+j*.437),b=roof(x,-3.89+(j+1)*.437);
      rod(m,'transom',a,b,.054,.053,10,false);
      rod(m,'rail',add(a,[.015,-.089,0]),add(b,[.015,-.089,0]),.022,.023,8,false);
      if(j%3===0){
        const p=add(a,[.013,-.085,0]),q=add(a,[.078,.022,0]);
        rod(m,'edge',p,q,.027,.019,8);
      }
    }
    for(const z of [-3.89,3.96]){
      const p=roof(x,z);
      panel(m,'clay',[x,p[1]-.025,z],[.219,.091,.163],.028);
      for(const sign of [-1,1])rod(m,'edge',[x+sign*.067,p[1]+.022,z],[x+sign*.067,p[1]+.043,z],.013,.011,8);
    }
  }
  for(const z of [-3.22,-1.91,-.56,.85,2.30,3.80]){
    const y=roof(0,z)[1];
    rod(m,'bar',[-5.90,y,z],[5.90,y,z],.030,.028,8);
    for(let i=0;i<6;i++){
      const x=(i-3)*1.96,q=roof(x+1.96,z+.42);
      rod(m,'frameB',[x,y,z],q,.012,.011,5);
    }
  }
  for(const x of [-5.91,5.91]){
    const z=3.885;
    panel(m,'chalk',[x,3.02,z],[.177,5.88,.201],.020);
    panel(m,'rail',[x,.11,z],[.263,.22,.246],.027);
    panel(m,'rail',[x,5.811,z],[.239,.213,.214],.019);
    rod(m,'bar',[x,5.51,z],[x*.845,6.085,z-1.126],.026,.027,8);
  }
  for(let i=0;i<14;i++){
    const x=(i-6.5)*.79;
    garden(m,x,-3.92,199+i*717);
  }
  for(const z of [-2.51,-1.21,.1,1.31,2.48]){
    garden(m,-5.88,z,8472+Math.round((z+3)*150));
    garden(m,5.88,z,726+Math.round((z+3)*150));
  }
  for(const x of [-5.94,5.94]){
    rod(m,'terra',[x,.06,3.56],[x,1.0,3.56],.049,.043,14);
    rod(m,'bone',[x,1.01,3.56],[x,1.088,3.56],.043,.048,12);
  }
}
function bladePanel(m,[x,y,z],w,h,key,side){
  panel(m,'recess',[x,y,z],[w,h,.028],.007);
  panel(m,key,[x,y,z+side*.013],[w-.038,h-.037,.018],.006);
  for(let i=1;i<5;i++){
    const v=y-h/2+h*i/5;
    panel(m,'frameB',[x,v,z+side*.023],[w-.087,.009,.009],.002);
  }
}
function specimen(m,[x,y,z],id,seed){
  const rnd=seeded(seed),a=id==='root'?'mineral':'glass2';
  panel(m,'recess',[x,y,z-.018],[.41,.51,.024],.018);
  panel(m,a,[x,y,z-.004],[.382,.476,.009],.015);
  panel(m,'frameB',[x,y-.234,z+.005],[.26,.037,.012],.006);
  const foot=[x,y-.186,z+.009];
  for(let i=0;i<5;i++){
    const p=[x+(rnd()-.5)*.27,y-.025+rnd()*.22,z+.012];
    rod(m,'plant0',foot,p,.007,.005,5);
    const side=i%2===0?1:-1,lead=[p[0]+side*.061,p[1]+.027,p[2]+.001];
    leaf(m,'plant'+(i%4),mix(foot,p,.79),lead,.038);
  }
  for(const sign of [-1,1])rod(m,'edge',[x+sign*.166,y+.212,z+.007],
    [x+sign*.166,y+.212,z+.020],.013,.012,6);
}
function rack(m,item){
  const [a,b,c]=item.min,[x,y,z]=item.max,center=[(a+x)/2,(b+y)/2,(c+z)/2],w=x-a,h=y-b,d=z-c;
  const key=item.id==='root'?'mineral':item.id==='canopy'?'glass2':'glass0';
  const baseKey=item.id==='root'?'clay':item.id==='canopy'?'rail':'depth';
  panel(m,baseKey,center,[w-.055,h-.073,d-.043],.040);
  for(const level of [b+.047,y-.046]){
    panel(m,'frameB',[center[0],level,center[2]],[w,.089,d],.029);
    panel(m,item.id==='root'?'terra':'edge',[center[0],level+.017,z-.012],[w-.017,.029,.024],.007);
  }
  for(const u of [a+.049,x-.049])for(const v of [c+.054,z-.054]){
    panel(m,'frame',[u,center[1],v],[.091,h-.069,.091],.016);
  }
  for(let i=0;i<4;i++){
    const q=b+h*(i+.5)/4;
    panel(m,'chalk',[center[0],q+h*.107,z-.020],[w-.13,.038,.035],.011);
    bladePanel(m,[center[0],q,z-.045],w-.19,h*.218,i%2?'glass1':key,1);
    if(i===1||i===3)specimen(m,[center[0],q,z-.026],item.id,451+i*81+(item.id==='root'?17:99));
    for(const u of [a+.013,x-.013])for(let j=0;j<8;j++){
      const t=c+d*(j+.5)/8;
      panel(m,((i+j)%4===0?'glass3':key),[u,q,t],[.021,h*.191,d/8-.079],.007);
      panel(m,'bar',[u,q-h*.106,t],[.021,.029,d/8-.05],.008);
    }
  }
  for(const u of [a+.19,x-.19]){
    const v= item.id==='canopy'?b+.11:y-.103;
    rod(m,'bronze',[u,v,z-.023],[u,v,z-.006],.032,.032,10);
  }
  for(let i=0;i<9;i++){
    const v=c+.49+i*(d-.98)/8,q=item.id==='canopy'?b+.083:y-.073;
    panel(m,'recess',[center[0],q,v],[w*.28,.026,.11],.008);
    panel(m,item.id==='root'?'amber':'azure',[center[0],q+.013,v],[w*.19,.010,.073],.004);
  }
}
function mast(m,item){
  const [a,b,c]=item.min,[x,y,z]=item.max,p=[(a+x)/2,(b+y)/2,(c+z)/2],w=x-a,d=z-c,h=y-b;
  panel(m,'rail',p,[w,h,d],.037);
  for(const level of [b+.11,p[1],y-.096]){
    panel(m,'clay',[p[0],level,p[2]],[w,.115,d],.020);
  }
  grille(m,'edge',[p[0],p[1]-.53,z-.009],[w-.065,.89,.010],8);
  panel(m,'glaze',[p[0],p[1]+.54,z-.009],[w-.12,.36,.012],.009);
  panel(m,'amber',[p[0],p[1]+.53,z-.003],[w-.21,.050,.005],.002);
}
function gauges(m){
  const x=-5.16,z=3.868;
  rod(m,'rail',[x,.05,z],[x,4.88,z],.021,.016,8);
  for(let i=0;i<19;i++){
    const y=.12+i*.255;
    rod(m,i%4===0?'terra':'frameB',[x,y,z],[x+(i%4===0?.18:.084),y,z],i%4===0?.015:.009,undefined,6);
  }
  for(const [j,p] of start.entries()){
    const [x,y,z]=p,q=[x-.35,y-.17,z];
    disc(m,shades[j],q,.145,.021,0,tau,26);
    rod(m,'bar',[q[0],y-.177,z],[q[0]-.39,y-.177,z],.028,.02,8);
    panel(m,'rail',[q[0]-.43,y-.174,z],[.13,.088,.13],.015);
  }
}
function aircraft(engine,index){
  const root=engine.createMesh().setScale([1.14,1.14,1.14]),shape=draft(),marks=shades[index],fans=[];
  for(const s of [-1,1]){
    panel(shape,'carbon',[s*.125,-.001,0],[.038,.032,.181],.010);
    panel(shape,'rubber',[s*.109,-.076,0],[.035,.018,.155],.007);
    rod(shape,'bar',[s*.09,-.040,-.042],[s*.107,-.079,-.044],.014,.010,8);
    rod(shape,'bar',[s*.09,-.040,.042],[s*.107,-.079,.044],.014,.010,8);
    for(const f of [-1,1]){
      const x=s*.137,z=f*.090;
      rod(shape,'frame',[x,.005,z],[x,.030,z],.065,.067,20,false);
      disc(shape,'carbon',[x,.032,z],.068,.010,0,tau,23);
      disc(shape,marks,[x,.034,z],.069,.006,.22,Math.PI-.22,12);
      rod(shape,'carbon',[x,.002,z],[x,.017,z],.018,.020,9);
      const blade=draft(),part=engine.createMesh(root).setPosition([x,.026,z]);
      for(let i=0;i<3;i++){
        const t=i*tau/3,p=(d,u)=>[d*Math.cos(t)-u*Math.sin(t),0,d*Math.sin(t)+u*Math.cos(t)];
        blade.quad('rotor',p(.004,-.005),p(.006,.013),p(.049,.011),p(.055,.002),[0,1,0]);
      }
      blade.make(engine,part);fans.push(part);
    }
  }
  panel(shape,'carbon',[0,-.024,0],[.199,.089,.180],.029);
  panel(shape,'drone',[0,.026,.01],[.214,.070,.195],.029);
  panel(shape,marks,[0,.067,.01],[.103,.015,.131],.007);
  panel(shape,'carbon',[0,-.040,.097],[.091,.061,.060],.017);
  rod(shape,'lens',[0,-.039,.119],[0,-.037,.145],.038,.034,17);
  rod(shape,'chalk',[0,-.038,.151],[0,-.038,.137],.014,.016,12);
  panel(shape,'milk',[0,.009,-.094],[.093,.010,.019],.004);
  shape.make(engine,root);
  return {root,fans};
}
function routeMeshes(engine,plans,parent){
  const old=draft();
  for(const [index,plan] of plans.entries()){
    const colour=routeColours[index];
    for(const p of plan.points.slice(1,-1)){
      rod(old,colour,[p[0],p[1]-.039,p[2]],[p[0],p[1]+.039,p[2]],.040,.034,8);
    }
    for(let k=1;k<plan.points.length;k++){
      const a=plan.points[k-1],b=plan.points[k],n=Math.max(1,Math.ceil(span(a,b)/.171));
      for(let j=0;j<n;j++){
        const p=mix(a,b,j/n),q=mix(a,b,(j+.65)/n);
        rod(old,colour,p,q,.022,.018,6,false);
      }
    }
  }
  return old.make(engine,parent);
}
function stationLamps(engine){
  const root=engine.createMesh(),marks=stations.map(()=>engine.createMesh(root));
  for(const [i,site] of stations.entries()){
    const a=draft();
    for(const [j,port] of site.ports.entries()){
      const [x,y,z]=port;
      disc(a,shades[j],[x,y-.145,z],.234,.026,.23,3.03,28);
      disc(a,shades[j],[x,y-.145,z],.234,.026,3.33,6.12,28);
      disc(a,'frameB',[x,y-.147,z],.155,.009,tau*.04,tau*.95,35);
    }
    a.make(engine,marks[i]);marks[i].visible=i===0;
  }
  return marks;
}
export function makeConservatory(engine,state){
  engine.scene.background='#a0ada0';
  engine.lighting.direction.set([-.51,.79,.57,3.14]);
  engine.lighting.radiance.set([1,.914,.784,.47]);
  engine.lighting.ambient.set([.74,.89,.94]);
  const m=draft();floor(m);pavilion(m);
  for(const item of obstacleBoxes){
    if(item.id==='mast')mast(m,item);else rack(m,item);
  }
  gauges(m);m.make(engine);
  const figures=state.drones.map((_,i)=>aircraft(engine,i)),marker=stationLamps(engine),routes=engine.createMesh();
  const tracked=state.drones.map((_,i)=>{
    const root=engine.createMesh(),t=draft(),k=routeColours[i];
    for(let j=0;j<4;j++)disc(t,k,[0,0,0],.267,.013,j*tau/4+.28,j*tau/4+.96,16);
    t.make(engine,root);return root;
  });
  let plotted=[],revision=-1;
  return {update(state,show){
    if(revision!==state.revision){
      for(const mesh of plotted)mesh.dispose();
      plotted=routeMeshes(engine,state.plans,routes);revision=state.revision;
      const where=stations.indexOf(state.site);
      marker.forEach((mesh,i)=>{mesh.visible=i===where;});
    }
    routes.visible=show;
    for(const [i,agent] of state.drones.entries()){
      const {root,fans}=figures[i];
      root.setPosition(agent.position).setRotation([agent.tilt,agent.yaw,0]);
      tracked[i].visible=show;
      tracked[i].setPosition([agent.position[0],agent.position[1]-.17,agent.position[2]]);
      for(const [j,fan] of fans.entries())fan.setRotation([0,state.time*(5+j%2*6)*(agent.done?.36:3.5)*(j%2?-1:1),0]);
    }
  }};
}
