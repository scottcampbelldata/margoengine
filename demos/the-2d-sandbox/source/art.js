import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {triangulateShape} from '@margoengine/geometry';
import {crateSize,deck,height,shelves,shore,width} from './layout.js';

const dot=box();
const colors=new Map();
const finish=color=>{
  if(!colors.has(color))colors.set(color,new PbrMaterial({color,roughness:1,doubleSided:true}));
  return colors.get(color);
};
const lerp=(a,b,t)=>a.map((x,i)=>Math.round(x+(b[i]-x)*t));
const css=a=>'#'+a.map(x=>x.toString(16).padStart(2,'0')).join('');
const position=(x,y,z)=>[x*.01,-y*.01,z];
const register=(engine,geometry,material,parent)=>engine.createMesh(parent).setGeometry(geometry).setMaterial(material);
function rectangle(x,y,w,h){
  return [[x,y],[x+w,y],[x+w,y+h],[x,y+h]];
}
function loop(x,y,r1,r2,n=48){
  return Array.from({length:n},(_,i)=>{
    const a=i*2*Math.PI/n;return [x+r1*Math.cos(a),y+r2*Math.sin(a)];
  });
}

export function paintLandscape(engine){
  const palette=new Map();
  let depth=0;
  function poly(points,color){
    let model=palette.get(color);
    if(!model){model={positions:[],normals:[],indices:[]};palette.set(color,model);}
    const first=model.positions.length/3;
    const layer=depth++*.0018;
    for(const p of points){model.positions.push(...position(...p,layer));model.normals.push(0,0,1);}
    const {indices}=triangulateShape(points);
    for(const i of indices)model.indices.push(first+i);
  }
  const rect=(x,y,w,h,color)=>poly(rectangle(x,y,w,h),color);
  const circle=(x,y,r1,r2,color,n)=>poly(loop(x,y,r1,r2,n),color);
  function path(points,color,size=2){
    for(let i=1;i<points.length;i++){
      const [a,b]=points[i-1],[c,d]=points[i];
      const dx=c-a,dy=d-b,n=Math.hypot(dx,dy);
      const x=-dy*size*.5/n,y=dx*size*.5/n;
      poly([[a+x,b+y],[c+x,d+y],[c-x,d-y],[a-x,b-y]],color);
    }
  }

  for(let i=0;i<48;i++){
    const blend=Math.min(1,i/38);
    const shade=lerp([27,36,67],[183,113,111],Math.pow(blend,.91));
    rect(0,i*height/48,width,height/48+.08,css(shade));
  }
  for(let i=0;i<7;i++){
    const r=91-i*5.9;
    circle(500,139,r,r,css(lerp([93,72,106],[191,106,104],i/6)));
  }
  circle(500,139,53,53,'#f4bb8c',54);
  circle(493,131,44,44,'#ffd2a0',54);
  const striae=[
    [442,112,52,2.5],[513,120,42,2],[468,144,102,3.5],[450,165,78,2],
    [521,169,65,2.2],[551,154,128,1.9],[281,135,100,1.7],[84,91,92,1.9],
  ];
  for(const [x,y,w,h] of striae){
    poly([[x,y],[x+w,y-1.25],[x+w-12,y+h],[x+8,y+h]],'#d38982');
  }

  poly([[0,164],[60,189],[102,173],[157,192],[233,143],[308,181],[338,223],[383,206],[430,221],[481,210],[538,229],[589,182],[620,157],[655,182],[679,166],[740,200],[789,172],[840,170],[840,510],[0,510]],'#57516b');
  poly([[0,226],[81,213],[153,239],[205,198],[247,211],[291,164],[337,231],[406,245],[470,254],[510,226],[559,246],[628,196],[694,246],[733,216],[769,228],[840,193],[840,510],[0,510]],'#414959');
  poly([[0,266],[59,254],[107,269],[151,233],[178,250],[218,222],[243,250],[260,237],[293,272],[326,290],[364,280],[413,314],[457,292],[505,283],[558,269],[596,239],[636,259],[687,248],[736,282],[789,201],[840,253],[840,510],[0,510]],'#344653');
  poly([[0,352],[83,322],[145,347],[204,315],[273,344],[317,360],[368,356],[422,383],[466,376],[526,359],[605,334],[666,343],[730,317],[797,335],[840,304],[840,510],[0,510]],'#313e4b');
  poly([[0,440],[119,402],[201,418],[299,442],[424,456],[507,444],[589,434],[672,415],[840,429],[840,510],[0,510]],'#26394b');

  rect(0,455,width,55,'#263d4d');
  const wave=['#365166','#3a5368','#455a68','#30495c','#b48776'];
  for(let i=0;i<48;i++){
    const x=(i*173)%779+8,y=462+(i*29)%44,w=14+(i*23)%58;
    poly([[x,y],[Math.min(width,x+w),y],[Math.min(width,x+w-6),y+1.5],[x+4,y+2]],wave[i%wave.length]);
  }
  poly(shore[0],'#293943');poly(shore[1],'#263842');
  poly([[0,333],[76,347],[117,325],[166,339],[218,324],[209,350],[172,363],[151,391],[102,399],[70,441],[0,449]],'#3d4a50');
  poly([[0,379],[92,401],[153,385],[183,367],[169,408],[145,425],[144,457],[92,486],[0,488]],'#303e4b');
  poly([[840,330],[799,326],[745,343],[702,323],[620,320],[628,353],[660,363],[671,391],[726,409],[745,450],[840,455]],'#384851');
  poly([[840,408],[738,422],[691,392],[651,390],[661,409],[696,429],[697,448],[722,482],[749,510],[840,510]],'#2e3b48');
  const edges=[
    [[0,300],[54,306],[74,314],[113,310],[135,316],[164,311],[194,318],[219,321]],
    [[622,320],[640,311],[662,314],[690,305],[723,306],[742,298],[788,304],[815,286],[840,288]],
    [[0,338],[83,350],[115,333],[162,342],[211,338]],[[627,342],[662,357],[697,352],[757,366],[840,347]],
    [[0,391],[49,398],[88,421],[141,406],[169,398]],[[657,391],[696,404],[732,433],[791,421],[840,427]],
  ];
  edges.forEach((p,i)=>path(p,['#ad7765','#a87563','#58636a','#59636b','#475560','#4a5864'][i],i<2?3.2:2.1));
  for(let i=0;i<26;i++){
    const far=i%2===0,z=(i*83)%139;
    const x=far?19+z:655+(z*1.07),y=352+(i*41)%123,l=8+(i*33)%24;
    path([[x,y],[x+l*.42,y-2.6],[x+l,y+.6]],i%3===0?'#48545e':'#38464e',.9);
  }

  function pine(x,y,size,tint){
    rect(x-1.1,y-size*.94,2.2,size*.99,'#333348');
    for(let k=0;k<3;k++){
      const h=y-size+k*size*.24,base=size*(.16+.07*k);
      poly([[x,h],[x+base,h+size*.39],[x-base,h+size*.39]],tint);
    }
  }
  for(const [x,y,s,t] of [[22,304,68,'#38424a'],[48,306,43,'#3e494b'],[84,314,54,'#3a464c'],
    [758,300,43,'#3b4248'],[785,299,61,'#36434b'],[816,286,70,'#343c49']])pine(x,y,s,t);
  for(const {p:[x,y],w,h} of shelves){
    rect(x-w/2,y-h/2,w,h,'#3b3d49');
    rect(x-w/2,y-h/2,w,3.1,'#c09883');
    rect(x-w/2+3,y+h/2-4,w-6,2.2,'#6c5d66');
    for(let i=0;i<6;i++)rect(x-w/2+7+i*(w-15)/5,y-2,1.5,5,'#91717a');
  }
  for(const x of [deck.start,deck.end]){
    const sign=x<420?-1:1;
    const side=x+sign*18;
    rect(side-13,307,26,25,'#1f2d39');
    poly([[side-12,312],[side-8,276],[side+8,276],[side+12,312]],'#c08a6c');
    rect(side-8,280,16,30,'#a96b56');
    rect(side-13,273,26,8,'#df9f77');
    rect(side-5,280,4,31,'#d99069');
    path([[side,286],[x,deck.y]],'#c79978',4.3);
    circle(x,deck.y,7.1,7.1,'#f5c589',28);
    circle(x,deck.y,3.5,3.5,'#5d3944',22);
    for(let i=0;i<4;i++){
      const xp=x+sign*(i*7.4+5);
      rect(xp-1,329,2,4.5,'#7a6663');
    }
  }
  for(const [color,buffer] of palette)register(engine,new Geometry(buffer.positions,buffer.normals,buffer.indices),finish(color));
}

const crates=[
  ['#488b8e','#61a4a1','#266772','#bac7a1'],
  ['#c27c5e','#e59e79','#904e4e','#f3c29a'],
  ['#c69a65','#e5b47e','#8e6a5b','#f0d0ab'],
  ['#7778a2','#9592b6','#555e82','#d4bda8'],
];

export function rig(engine,item){
  const root=engine.createMesh();
  const objects=[];
  const panel=(color,x,y,w,h,layer)=>{
    const child=register(engine,dot,finish(color),root);
    child.setPosition(position(x,y,layer)).setScale([w*.01,h*.01,.003]);
    objects.push(child);
  };
  function shape(points,color,layer){
    const vertices=[],normal=[];
    for(const p of points){vertices.push(...position(...p,layer));normal.push(0,0,1);}
    objects.push(register(engine,new Geometry(vertices,normal,triangulateShape(points).indices),finish(color),root));
  }
  if(item.kind==='crate'){
    const [base,edge,inner,ink]=crates[item.paint];
    const size=crateSize,half=size/2;
    panel('#252e3c',0,0,size,size,0);
    panel(base,0,0,size-2.8,size-2.8,.018);
    panel(edge,0,-half+3,size-3.2,3.3,.027);
    panel(inner,0,half-3,size-3.2,3.2,.027);
    panel(inner,0,0,23,22,.027);
    panel(base,0,0,19.5,18.6,.034);
    shape([[-10,8],[-7,10],[10,-7],[8,-10]],ink,.047);
    for(const x of [-10.5,10.5])for(const y of [-10.5,10.5])panel(edge,x,y,1.6,1.6,.053);
  }else if(item.kind==='plank'){
    const l=item.length;
    const wood=item.paint?'#a3735e':'#ba8263';
    panel('#302a34',0,0,l,deck.thickness,0);
    panel(wood,0,0,l-2,deck.thickness-2.3,.018);
    panel('#e7b386',0,-5.0,l-2,2.0,.038);
    panel('#754e4c',0,5.9,l-2,2.0,.037);
    for(const x of [-l*.41,l*.41]){
      shape(loop(x,0,3.8,3.8,22),'#5b4750',.047);
      shape(loop(x,0,2.35,2.35,22),'#f8c98d',.056);
    }
  }else{
    shape(loop(0,0,25,25,54),'#273442',0);
    shape(loop(0,0,22.3,22.3,48),'#537381',.02);
    shape(loop(0,0,17.5,17.5,48),'#6c9299',.032);
    shape(loop(0,0,10.6,10.6,40),'#44576b',.047);
    shape(loop(0,0,7,7,40),'#cead7a',.058);
    for(let i=0;i<8;i++){
      const theta=i*Math.PI/4;
      shape(loop(18.4*Math.cos(theta),18.4*Math.sin(theta),1.85,1.85,14),'#e8c394',.056);
    }
  }
  function draw(next=item){
    const [x,y]=next.body.position;
    root.setPosition(position(x,y,item.kind==='crate'?5.4:5.2));
    root.setRotation([0,0,-next.body.rotation]);
  }
  draw();
  return {item,draw,dispose(){objects.forEach(x=>x.dispose());root.dispose();}};
}
