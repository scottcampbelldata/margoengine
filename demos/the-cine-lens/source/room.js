import {Geometry,PbrMaterial} from '@margoengine/core';

export const targets={
  front:{label:'Film tin',position:[.028,.54,1.237]},
  projector:{label:'Projector',position:[.125,.745,.414]},
  wall:{label:'Back wall',position:[.52,1.24,-3.65]},
};

const TAU=Math.PI*2;
const materialTable={
  shell:['#566d67',.51,0],
  screen:['#1f2c2e',.6,0],
  dark:['#2f3c3c',.63,0],
  rubber:['#333a36',.88,0],
  gunmetal:['#a6b6ae',.41,1], cast:['#535f5e',.68,0],
  brushed:['#cbc7a8',.46,1],
  brass:['#c4944f',.30,.92],
  paleBrass:['#c4aa71',.52,1],
  maroon:['#724841',.47,.12],
  amber:['#ac7242',.36,.15,[.11,.054,.016]],
  glass:['#244d55',.105,0,[.008,.037,.051]],
  reflection:['#76b9b1',.26,.9,[.023,.104,.092]],
  film:['#362c23',.48,0],
  stripe:['#797557',.67,.1],
  wood:['#644c40',.69,0],
  edge:['#6c5242',.63,0],
  seam:['#493d35',.72,0],
  cloth:['#38454a',.79,0],
  wall:['#263334',.88,0],
  floor:['#46504d',.90,0],
  warm:['#e0a04f',.40,0,[25,10.3,2.1]],
  ivory:['#d8b091',.58,0,[19,12.4,6.4]],
  turquoise:['#449f9a',.43,0,[.9,15.2,11.4]],
  rose:['#ba7868',.43,0,[16.2,3.8,1.5]],
  amberPractical:['#a98055',.43,0,[.76,.37,.12]],
  turquoisePractical:['#517e7a',.54,0,[.26,1.21,1.05]],
  offwhite:['#dacaa6',.75,0],
};

function normal(a,b,c){
  const u=b.map((x,i)=>x-a[i]),v=c.map((x,i)=>x-a[i]);
  const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  const length=Math.hypot(...n);
  return n.map(x=>x/length);
}

function formBuilder(){
  const groups=new Map();
  function polygon(key,points,normals){
    const group=groups.get(key)??{points:[],normals:[],indices:[]};
    groups.set(key,group);
    const first=group.points.length/3;
    const face=normals??points.map(()=>normal(...points.slice(0,3)));
    for(let i=0;i<points.length;i++){
      group.points.push(...points[i]);group.normals.push(...face[i]);
      if(i>1)group.indices.push(first,first+i-1,first+i);
    }
  }
  function solid(key,outline,z,d){
    const end=z+d/2,start=z-d/2;
    polygon(key,outline.map(([x,y])=>[x,y,end]));
    polygon(key,outline.map(([x,y])=>[x,y,start]).reverse());
    for(let i=0;i<outline.length;i++){
      const a=outline[i],b=outline[(i+1)%outline.length];
      polygon(key,[[...a,start],[...b,start],[...b,end],[...a,end]]);
    }
  }
  function softRect(key,x,y,z,w,h,d,corner){
    const c=Math.min(corner,w/3,h/3),u=w/2,v=h/2;
    solid(key,[[x-u+c,y-v],[x+u-c,y-v],[x+u,y-v+c],[x+u,y+v-c],
      [x+u-c,y+v],[x-u+c,y+v],[x-u,y+v-c],[x-u,y-v+c]],z,d);
  }
  function block(key,x,y,z,w,h,d){
    solid(key,[[x-w/2,y-h/2],[x+w/2,y-h/2],[x+w/2,y+h/2],[x-w/2,y+h/2]],z,d);
  }
  function lathe(key,center,profile,{segments=44,axis='z'}={}){
    const xyz=axis==='y'?([x,y,z])=>[x,z,-y]:axis==='x'?([x,y,z])=>[z,y,-x]:p=>p;
    const move=p=>xyz(p).map((v,i)=>v+center[i]);
    for(let i=1;i<profile.length;i++){
      const [r0,z0]=profile[i-1],[r1,z1]=profile[i];
      const len=Math.hypot(z1-z0,r1-r0);
      if(!len||(!r0&&!r1))continue;
      const section=angle=>xyz([(z1-z0)*Math.cos(angle)/len,(z1-z0)*Math.sin(angle)/len,(r0-r1)/len]);
      for(let s=0;s<segments;s++){
        const a=s*TAU/segments,b=(s+1)*TAU/segments;
        const point=(r,z,k)=>move([r*Math.cos(k),r*Math.sin(k),z]);
        const face=[point(r0,z0,a),point(r0,z0,b),point(r1,z1,b),point(r1,z1,a)];
        const shade=[section(a),section(b),section(b),section(a)];
        if(r0===0){face.splice(1,1);shade.splice(1,1);}
        if(r1===0){face.splice(3,1);shade.splice(3,1);}
        polygon(key,face,shade);
      }
    }
  }
  function cylinder(key,center,radius,depth,options={}){
    const d=depth/2,b=Math.min(depth*.24,radius*.13);
    lathe(key,center,[[0,-d],[radius-b,-d],[radius,-d+b],[radius,d-b],[radius-b,d],[0,d]],options);
  }
  function rim(key,center,inner,outer,depth,options){
    const d=depth/2,b=Math.min(depth*.26,(outer-inner)*.25);
    lathe(key,center,[[inner,-d],[outer-b,-d],[outer,-d+b],[outer,d-b],[outer-b,d],
      [inner+b,d],[inner,d-b],[inner,-d]],options);
  }
  function bar(key,a,b,thickness,depth){
    const [x,y,z]=a,[xx,yy]=b;
    const m=Math.hypot(xx-x,yy-y),dx=(yy-y)*thickness/(2*m),dy=(x-xx)*thickness/(2*m);
    solid(key,[[x-dx,y-dy],[x+dx,y+dy],[xx+dx,yy+dy],[xx-dx,yy-dy]],z,depth);
  }
  return {polygon,solid,softRect,block,cylinder,rim,lathe,bar,finish:()=>{
    const result=[];
    for(const [key,{points,normals,indices}] of groups){
      const [color,roughness,metalness,emissive]=materialTable[key];
      result.push({geometry:new Geometry(points,normals,indices),material:new PbrMaterial({
        color,roughness,metalness:metalness>.5?1:0,...(emissive&&{emissive}),
      })});
    }
    return result;
  }};
}

function ringPoint([x,y],r,angle){
  return [x+r*Math.cos(angle),y+r*Math.sin(angle)];
}
function makeReel(room,[x,y,z],radius){
  const {cylinder,lathe,rim,solid}=room;
  cylinder('film',[x,y,z-.006],radius*.78,.035,{segments:64});
  for(const face of [-1,1]){
    const f=z+face*.024;
    rim('gunmetal',[x,y,f],radius*.855,radius,.013,{segments:68});
    rim('paleBrass',[x,y,f+face*.005],radius*.914,radius*.944,.004,{segments:68});
    rim('brushed',[x,y,f],radius*.194,radius*.30,.016,{segments:36});
    for(let i=0;i<6;i++){
      const a=i*TAU/6+.12;
      const border=[[.24,a-.25],[.55,a-.18],[.87,a-.028],[.91,a+.18],[.61,a+.072],[.25,a+.24]];
      solid('brushed',border.map(([ratio,k])=>ringPoint([x,y],radius*ratio,k)),f,.011);
    }
  }
  for(const f of [z-.017,z+.019])rim('stripe',[x,y,f],radius*.744,radius*.749,.003,{segments:60});
  for(let i=0;i<12;i++){
    const [px,py]=ringPoint([x,y],radius*.925,i*TAU/12);
    cylinder('dark',[px,py,z+.032],.0033,.002,{segments:8});
  }
  lathe('brass',[x,y,z+.037],[[0,-.015],[.018,-.015],[.022,-.009],[.022,.006],[.017,.01],[0,.01]],
    {segments:28});
}
function makeProjector(room){
  const {block,softRect,cylinder,rim,lathe}=room;
  const x=.11;
  softRect('dark',x,.494,.075,.70,.13,.657,.043);
  softRect('gunmetal',x,.560,.067,.671,.023,.638,.009);
  softRect('shell',x,.675,.065,.631,.226,.553,.042);
  softRect('dark',x,.796,.052,.580,.085,.51,.028);
  softRect('maroon',x+.119,.675,.36,.335,.175,.101,.025);
  softRect('shell',x-.148,.690,.362,.193,.164,.076,.025);
  block('dark',.437,.681,.079,.009,.110,.331);
  for(let vent=0;vent<9;vent++){
    block('cast',.443,.680,-.065+.036*vent,.006,.076,.016);
  }
  softRect('paleBrass',x+.160,.630,.417,.184,.033,.007,.007);
  
  const engraving=.423;
  room.bar('offwhite',[.215,.627,engraving],[.221,.637,engraving],.0018,.001);
  room.bar('offwhite',[.221,.637,engraving],[.227,.627,engraving],.0018,.001);
  block('offwhite',.221,.631,engraving,.008,.0015,.001);
  block('offwhite',.234,.6315,engraving,.0018,.011,.001);
  room.bar('offwhite',[.234,.635,engraving],[.242,.635,engraving],.0018,.001);
  room.bar('offwhite',[.242,.635,engraving],[.242,.631,engraving],.0018,.001);
  room.bar('offwhite',[.242,.631,engraving],[.234,.631,engraving],.0018,.001);
  room.bar('offwhite',[.237,.631,engraving],[.244,.626,engraving],.0018,.001);
  room.bar('offwhite',[.249,.634,engraving],[.257,.638,engraving],.0018,.001);
  room.bar('offwhite',[.249,.634,engraving],[.249,.628,engraving],.0018,.001);
  room.bar('offwhite',[.249,.628,engraving],[.257,.625,engraving],.0018,.001);

  for(let j=0;j<8;j++){
    block('dark',x-.175+j*.020,.697,.402,.008,.094,.004);
    block('gunmetal',x-.178+j*.020,.695,.404,.003,.087,.003);
  }

  const barrel=[.241,.754,.415];
  lathe('screen',barrel,[[0,-.021],[.104,-.02],[.108,.047],[.086,.058],[.083,.128],[.094,.139],
    [.092,.207],[.080,.222],[.066,.219],[.066,.194],[0,.194]],{segments:64});
  for(const [z,r,w] of [[.065,.087,.022],[.114,.087,.033],[.170,.095,.021],[.220,.087,.016]]){
    rim('gunmetal',[barrel[0],barrel[1],barrel[2]+z],r-.008,r,w,{segments:64});
  }
  rim('brass',[barrel[0],barrel[1],barrel[2]+.229],.063,.085,.013,{segments:72});
  rim('dark',[barrel[0],barrel[1],barrel[2]+.236],.056,.066,.008,{segments:64});
  lathe('glass',[barrel[0],barrel[1],barrel[2]+.227],[[.061,-.017],[.061,0],[.054,.009],
    [.042,.018],[.025,.022],[0,.026]],{segments:64});
  rim('reflection',[barrel[0],barrel[1],barrel[2]+.237],.060,.0617,.001,{segments:52});
  for(let i=0;i<30;i++){
    const angle=i*TAU/30;
    const [xx,yy]=ringPoint(barrel,.091,angle);
    cylinder('dark',[xx,yy,barrel[2]+.119],.0026,.026,{segments:5});
  }
  for(const [xx,yy] of [[-.133,.645],[-.128,.756],[.392,.626],[.390,.710]]){
    cylinder('brass',[xx,yy,.423],.0081,.005,{segments:14});
    block('dark',xx,yy,.427,.007,.0016,.002);
  }
  cylinder('amber',[.374,.652,.423],.0069,.007,{segments:12});

  softRect('cast',-.158,.91,.12,.095,.284,.171,.021);
  softRect('cast',.182,.942,.043,.118,.340,.192,.027);
  softRect('dark',.075,.850,.277,.133,.081,.139,.012);
  for(const y of [.829,.878]){
    cylinder('gunmetal',[.009,y,.334],.020,.046,{segments:28});
    cylinder('brass',[.009,y,.358],.012,.006,{segments:24});
  }
  makeReel(room,[-.199,1.055,.151],.174);
  makeReel(room,[.208,1.184,.105],.226);
  room.bar('film',[-.105,.928,.177],[-.008,.861,.177],.012,.003);
  room.bar('film',[.018,.851,.169],[.167,.971,.169],.012,.004);
  for(const xx of [-.14,.36]){
    for(const zz of [-.13,.31])cylinder('rubber',[xx,.429,zz],.043,.031,{axis:'y',segments:22});
  }
}
function makeTin(room){
  const {cylinder,rim,block,softRect,bar}=room;
  const [x,,z]=targets.front.position;
  cylinder('maroon',[x,.466,z],.168,.067,{axis:'y',segments:62});
  cylinder('gunmetal',[x,.512,z],.169,.028,{axis:'y',segments:66});
  for(const [y,a,b] of [[.483,.165,.170],[.518,.166,.174],[.530,.146,.153],[.530,.108,.110]]){
    rim('brass',[x,y,z],a,b,.004,{axis:'y',segments:60});
  }
  softRect('maroon',x,.479,z+.171,.152,.042,.018,.006);
  softRect('offwhite',x,.479,z+.182,.138,.031,.002,.006);
  const base=x-.017,y=.479,front=z+.184;
  block('seam',base-.017,y,front,.004,.020,.0013);
  bar('seam',[base-.028,y+.001,front],[base-.017,y+.010,front],.003,.001);
  bar('seam',[base+.012,y-.009,front],[base+.033,y+.009,front],.003,.001);
  bar('seam',[base+.011,y+.008,front],[base+.033,y-.008,front],.003,.001);
  for(let i=0;i<7;i++){
    block('brass',x+.081+i*.010,.462,z+.152-i*.004,.004,.003,.002);
  }
}
function makeRoom(room){
  const {block,softRect,rim,cylinder}=room;
  block('floor',0,-.056,-2.37,19,.10,15);
  block('wall',0,1.87,-6.48,17,3.83,.13);
  block('wall',-5.1,1.85,-4.04,.16,3.82,4.9);
  block('wall',5.1,1.85,-4.04,.15,3.82,4.9);
  for(let i=-21;i<=21;i++){
    const x=i*.39;
    block('cloth',x,1.70,-6.35,.355,3.35,.12);
    block('dark',x-.16,1.70,-6.28,.018,3.34,.02);
  }
  block('dark',0,1.42,-6.24,16.8,.026,.035);
  block('dark',0,2.67,-6.24,16.8,.033,.035);
  block('edge',.02,.393,.81,3.41,.068,2.74);
  block('wood',.02,.421,.81,3.40,.019,2.70);
  for(let lane=-5;lane<=5;lane++){
    const x=lane*.27;
    block(lane%3===0?'edge':'wood',x,.432,.83,.266,.008,2.60);
    block('seam',x-.134,.437,.84,.004,.002,2.60);
  }
  for(const x of [-1.42,1.44]){
    block('seam',x,.176,.72,.106,.34,1.96);
  }

  const rows=[
    {z:-4.78,y:1.35,spread:2.41,count:12,step:.39,offset:-.09},
    {z:-5.61,y:2.23,spread:2.52,count:12,step:.455,offset:.07},
    {z:-3.66,y:1.81,spread:1.81,count:8,step:.477,offset:-.05},
  ];
  const hues=['warm','ivory','warm','turquoise','rose','warm','warm','ivory','turquoise'];
  for(let row=0;row<rows.length;row++){
    const {z,y,spread,count,step,offset}=rows[row];
    block('dark',0,y-.003,z-.114,spread*2.52,.031,.12);
    for(let i=0;i<count;i++){
      const x=(i-(count-1)/2)*step+offset;
      const Y=y+.043*Math.sin(i*2.67+row*.5);
      cylinder('gunmetal',[x,Y,z-.045],.035,.066,{segments:16});
      rim('amber',[x,Y,z-.007],.020,.032,.013,{segments:16});
      cylinder(hues[(i+row*4)%hues.length],[x,Y,z+.002],.020+(i%4)*.0019,.009,{segments:17});
    }
  }
  for(const side of [-1,1]){
    for(const [y,z] of [[1.01,-1.98],[1.39,-2.54],[.56,-2.14]]){
      const x=side*(.96+(y>.7?.23:.27));
      softRect('dark',x,y,z-.035,.062,.073,.059,.014);
      rim('brass',[x,y,z],.015,.027,.012,{segments:20});
      cylinder(side>0?'turquoise':'warm',[x,y,z+.011],.016,.014,{segments:22});
    }
  }
  for(const [x,y,z,tint] of [[-1.32,1.10,-.951,'amberPractical'],[.971,1.015,-1.12,'turquoisePractical']]){
    softRect('dark',x,.71,z,.165,.56,.208,.021);
    rim('gunmetal',[x,y,z],.088,.116,.088,{segments:40});
    for(const offset of [-.082,.082]){
      block('dark',x+offset,y-.06,z-.025,.013,.201,.025);
    }
    cylinder(tint,[x,y,z+.047],.086,.025,{segments:44});
    for(const radius of [.034,.051,.068,.083]){
      rim('gunmetal',[x,y,z+.062],radius,radius+.0016,.003,{segments:44});
    }
  }
}

export function prepareRoom(){
  const room=formBuilder();
  makeRoom(room);
  makeProjector(room);
  makeTin(room);
  return room.finish();
}

export function mountRoom(engine,parts){
  engine.scene.background='#152025';
  engine.lighting.direction.set([-.69,1.19,4.2,2.96]);
  engine.lighting.radiance.set([1,.850,.713,.52]);
  engine.lighting.ambient.set([.61,.89,1.13]);
  for(const {geometry,material} of parts)engine.createMesh().setGeometry(geometry).setMaterial(material);
}
