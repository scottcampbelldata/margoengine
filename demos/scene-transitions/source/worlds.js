const TAU=Math.PI*2;
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const scale=(a,t)=>a.map(v=>v*t);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=v=>scale(v,1/Math.hypot(...v));
const blend=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const clamp=x=>Math.min(1,Math.max(0,x));
function random(seed){
  let state=seed;
  return ()=>{
    state=(Math.imul(1664525,state)+1013904223)>>>0;
    return state/4294967296;
  };
}
function assemble(){
  const vertices=[],indices=[];
  const result={
    face(points,tint,material,smooth){
      const first=vertices.length/10;
      const normal=smooth?.[0]??unit(cross(sub(points[1],points[0]),sub(points[2],points[0])));
      const shaded=Array.isArray(tint[0]);
      for(let i=0;i<points.length;i++){
        const color=shaded?tint[i]:tint,n=smooth?smooth[i]:normal;
        vertices.push(...points[i],...n,...color,material);
        if(i>1)indices.push(first,first+i-1,first+i);
      }
    },
    finish(){return {vertices:Float32Array.from(vertices),indices:Uint32Array.from(indices)};},
  };
  return result;
}
function baseFrame(axis){
  const n=unit(axis);
  const a=unit(cross(Math.abs(n[1])>.92?[0,0,1]:[0,1,0],n));
  return [a,cross(n,a),n];
}
function revolve(world,origin,axis,section,color,mat,sides=48,start=0,end=TAU){
  const [u,v,w]=baseFrame(axis);
  const at=(r,h,a)=>add(origin,add(scale(w,h),add(scale(u,Math.cos(a)*r),scale(v,Math.sin(a)*r))));
  for(let i=1;i<section.length;i++){
    const [r0,z0]=section[i-1],[r1,z1]=section[i];
    const front=z1-z0,side=r0-r1;
    if(!front&&!side)continue;
    const normal=a=>unit(add(scale(w,side),add(scale(u,front*Math.cos(a)),scale(v,front*Math.sin(a)))));
    for(let j=0;j<sides;j++){
      const a=start+(end-start)*j/sides,b=start+(end-start)*(j+1)/sides;
      const p=[at(r0,z0,a),at(r0,z0,b),at(r1,z1,b),at(r1,z1,a)];
      const n=[normal(a),normal(b),normal(b),normal(a)];
      if(!r0){p.splice(1,1);n.splice(1,1);}
      if(!r1){p.splice(3,1);n.splice(3,1);}
      world.face(p,color,mat,n);
    }
  }
}
function tube(world,a,b,width,tint,mat,sides=9,ratio=1){
  const direction=sub(b,a),height=Math.hypot(...direction),chamfer=Math.min(height*.27,width*.43),w=width;
  revolve(world,a,direction,[[0,0],[w*.79,0],[w,chamfer],[w*ratio,height-chamfer],[w*ratio*.78,height],[0,height]],
    tint,mat,sides);
}
function column(world,center,y0,y1,rx,rz,tip,tint,mat,sides=6,slant=[0,0],seed=137){
  const rng=random(seed);
  const chain=Array.from({length:sides},(_,i)=>{
    const angle=TAU*i/sides+rng()*.17;
    return [Math.cos(angle)*(.77+rng()*.49),Math.sin(angle)*(.76+rng()*.46)];
  });
  const rim=chain.map(([x,z])=>[center[0]+x*rx,y0,center[1]+z*rz]);
  const middle=chain.map(([x,z],i)=>[center[0]+x*rx*.94+slant[0]*.18,
    y0+(y1-y0)*(.56+.11*Math.sin(seed+i*1.23)),center[1]+z*rz*.96+slant[1]*.23]);
  const top=chain.map(([x,z],i)=>[center[0]+x*rx*tip+slant[0],
    y1+(y1-y0)*(.049*Math.sin(seed+i*1.6)),center[1]+z*rz*tip+slant[1]]);
  for(let i=0;i<sides;i++){
    const j=(i+1)%sides;
    const color=blend(tint,[.87,.80,.71],rng()*.08);
    world.face([rim[j],rim[i],middle[i],middle[j]],tint,mat);
    world.face([middle[j],middle[i],top[i]],color,mat);
    world.face([middle[j],top[i],top[j]],blend(color,[.21,.38,.47],rng()*.082),mat);
  }
  const crown=[center[0]+slant[0],y1+(y1-y0)*.022,center[1]+slant[1]];
  for(let i=0;i<sides;i++)world.face([top[(i+1)%sides],top[i],crown],tint,mat);
}
function slab(world,x,y,z,w,d,h,tint,mat){
  const e=Math.min(w,d)*.093;
  const outline=[[-w/2+e,-d/2],[w/2-e,-d/2],[w/2,-d/2+e],[w/2,d/2-e],[w/2-e,d/2],[-w/2+e,d/2],[-w/2,d/2-e],[-w/2,-d/2+e]];
  const low=outline.map(([a,b])=>[x+a,y-h*.5,z+b]),high=outline.map(([a,b])=>[x+a*.986,y+h*.5,z+b*.986]);
  world.face([...high].reverse(),tint,mat);
  for(let i=0;i<8;i++)world.face([low[i],high[i],high[(i+1)%8],low[(i+1)%8]],tint,mat);
}

function desertHeight(x,z){
  const ripple=.52*Math.sin(x*.157+z*.074)+.24*Math.sin(x*.277-z*.204)+.11*Math.sin(x*.43-z*.348);
  const dune=2.9*Math.sin(x*.032+.062*z)+3.4*Math.cos(x*.026-.031*z);
  const flat=Math.exp(-((x/11)**2+((z+12)/19)**2));
  return .22+ripple*.61+dune*(1-flat*.95)*.31;
}

function landField(world,icy){
  const minX=-171,maxX=176, minZ=-412,maxZ=48, columns=57, rows=73;
  const height=icy?(x,z)=>{
    const lane=(x-(.057*z+1.7*Math.sin(z*.046)))/11.4;
    const swell=1.66+.62*Math.sin(x*.098+z*.028)+.51*Math.sin(x*.172-z*.081)+.21*Math.sin(z*.34+x*.22);
    return Math.max(-.71,swell-Math.exp(-lane*lane)*2.59-1.65*Math.exp(-((x/26)**2+(z+14)**2/500)));
  }:desertHeight;
  const tint=icy?(x,z,h)=>blend([.19,.36,.43],[.49,.67,.68],
    clamp(.46+h*.09+.26*Math.sin(x*.22-z*.18))):(x,z,h)=>blend([.35,.173,.106],[.68,.39,.218],
    clamp(.52+h*.16+.22*Math.sin(x*.16-z*.082)+.15*Math.sin(x*.48+z*.43)));
  function p(x,z){
    const y=height(x,z);
    const n=unit([height(x-.4,z)-height(x+.4,z),.8,height(x,z-.4)-height(x,z+.4)]);
    return {position:[x,y,z],tint:tint(x,z,y),n};
  }
  for(let iz=0;iz<rows;iz++){
    const z=minZ+(maxZ-minZ)*iz/rows,z1=minZ+(maxZ-minZ)*(iz+1)/rows;
    for(let ix=0;ix<columns;ix++){
      const x=minX+(maxX-minX)*ix/columns,x1=minX+(maxX-minX)*(ix+1)/columns;
      const group=[p(x,z),p(x,z1),p(x1,z1),p(x1,z)];
      world.face(group.map(v=>v.position),group.map(v=>v.tint),icy?4:1,group.map(v=>v.n));
    }
  }
}

function sky(world){
  world.face([[-1450,-125,-460],[1450,-125,-460],[1450,500,-460],[-1450,500,-460]],[.5,.5,.5],0);
}
function duneStation(world){
  sky(world);landField(world,false);
  const copper=[.72,.35,.14],warmSteel=[.32,.205,.153],dark=[.152,.143,.136],gold=[.84,.46,.16],light=[.95,.51,.168];
  const mesas=[
    [-66,-83,16,18,16,.67],[-49,-73,12.3,13,9.6,.57],[-31,-81,10,13,13,.48],
    [-90,-141,22,23,16,.73],[-60,-155,20,29,19,.73],[64,-137,21,24,15,.59],[43,-115,15,23,16,.78],
    [95,-151,18,20,14.7,.63],[-26,-161,19,18,14,.43],[13,-197,27,35,15,.55],
    [-43,-10,7,11,8,.38],[38,-40,9,12,6.5,.35],[-54,-44,8.6,7.8,6.2,.58],
  ];
  for(const [i,[x,z,y,rx,rz,tip]] of mesas.entries())
    column(world,[x,z],-1.5,y,rx,rz,tip,blend([.477,.244,.163],[.30,.227,.213],i/21),2,12,[.45*Math.sin(i),-.55*Math.cos(i)],827+i*31);
  const next=random(75511);
  for(let i=0;i<115;i++){
    const x=-104+next()*205,z=24-next()*117;
    if(Math.abs(x)<11&&Math.abs(z+12)<23)continue;
    const size=.32+next()*2.13;
    column(world,[x,z],-1.42,size*(.44+next()*.45),size*1.25,size*.87,.34+next()*.36,
      [.43,.253,.172],2,7,[.24,-.16],i+13);
  }
  for(const [w,d,z,y,h] of [[17.3,14.1,-13,.49,1.51],[15.2,12.5,-13,1.26,.165],[13.8,11.8,-13,1.48,.41]]){
    slab(world,0,y,z,w,d,h,dark,3);
  }
  const up=[0,1,0];
  revolve(world,[0,1.74,-13],up,[[0,0],[4.6,0],[4.83,.20],[4.82,.46],[4.52,.63],[0,.63]],dark,3,62);
  revolve(world,[0,2.30,-13],up,[[0,0],[3.1,0],[3.15,.16],[3.07,1.0],[2.53,1.42],[0,1.42]],warmSteel,3,66);
  revolve(world,[0,2.52,-13],up,[[3.08,-.10],[3.19,-.10],[3.22,.01],[3.16,.15],[3.06,.14]],copper,3,62);
  const center=[-.20,9.43,-13.72],axis=unit([.64,.26,.722]),[x,y]=baseFrame(axis);
  const ringPoint=(r,h,theta)=>add(center,add(scale(axis,h),add(scale(x,Math.cos(theta)*r),scale(y,Math.sin(theta)*r))));
  revolve(world,center,axis,[[4.94,-1.23],[5.34,-1.45],[6.27,-1.22],[6.61,-.63],[6.55,.54],
    [6.27,.94],[5.40,.83],[5.08,.56],[4.98,-.92],[4.94,-1.23]],warmSteel,3,112);
  revolve(world,center,axis,[[5.37,.72],[6.12,.78],[6.41,.64],[6.45,1.01],[6.23,1.17],[5.46,1.04],[5.37,.72]],copper,3,112);
  for(const [r,h] of [[5.43,1.02],[6.23,1.18],[6.53,.11]]){
    revolve(world,center,axis,[[r-.072,h-.065],[r+.034,h-.065],[r+.083,h],[r+.039,h+.067],[r-.074,h+.065],[r-.072,h-.065]],
      light,6,102);
  }
  for(let i=0;i<14;i++){
    const a=i*TAU/14,b=a+.31;
    revolve(world,center,axis,[[4.67,-.83],[5.47,-.91],[5.61,-.62],[5.17,-.49],[4.75,-.51],[4.67,-.83]],
      i%3===0?gold:dark,3,9,a,b);
    const tip=ringPoint(5.15,-.44,a+.15),origin=ringPoint(3.76,-1.39,a+.1);
    tube(world,tip,origin,.083,copper,3,7,.67);
    tube(world,ringPoint(6.11,.96,a+.071),ringPoint(6.11,1.20,a+.071),.095,dark,3,7,.91);
  }
  // The center feed is suspended by three open struts above the recessed inner dish.
  revolve(world,center,axis,[[0,-2.47],[1.16,-2.47],[2.27,-2.25],[3.2,-1.92],[4.45,-.98],[4.61,-.91]],
    [.36,.292,.225],3,76);
  revolve(world,center,axis,[[0,-2.14],[.74,-2.14],[.90,-1.86],[.77,-1.18],[.52,.01],[.39,.37],[0,.38]],
    gold,3,54);
  revolve(world,center,axis,[[0,.39],[.43,.39],[.44,.48],[.33,.61],[0,.61]],light,6,48);
  for(const a of [.52,2.62,4.71]){
    tube(world,ringPoint(5.18,-.14,a),ringPoint(.50,.29,a),.16,copper,3,10,.76);
    tube(world,ringPoint(5.22,.05,a-.061),ringPoint(.51,.37,a),.071,gold,3,9,.73);
  }
  for(const side of [-1,1]){
    const start=[side*3.33,2.90,-13.23],end=ringPoint(6.16,-.65,side>0?.047:3.13);
    tube(world,start,end,.49,dark,3,10,1);
    tube(world,[side*2.9,2.6,-15.8],add(end,[0,-.24,-.18]),.225,warmSteel,3,10,.90);
    for(let i=0;i<6;i++){
      const z=-5.8+i*.51;
      tube(world,[side*5.9,1.73,z],[side*5.9,2.69,z],.067,copper,3,8);
    }
    tube(world,[side*5.9,2.65,-5.89],[side*5.9,2.65,-3.17],.075,copper,3,8);
  }

  for(let i=0;i<11;i++){
    const fraction=i/10,z=-5.42+i*.91,x=-1.63+fraction*.48;
    const ground=desertHeight(x,z)-.14;
    const height=Math.max(ground+.25,1.55-fraction*1.02);
    slab(world,x,(ground+height)*.5,z,4.21+fraction*.37,.98,height-ground,[.30,.235,.182],3);
    slab(world,x,height+.044,z+.13,4.05+fraction*.32,.22,.086,[.415,.305,.220],3);
    if(i%3===0){
      for(const side of [-1,1]){
        const X=x+side*2.10;
        tube(world,[X,height-.065,z],[X,height+.076,z],.081,light,6,8);
      }
    }
  }
  for(const x of [-7.8,7.8]){
    tube(world,[x,1.39,-8],[x,2.31,-8],.19,dark,3,10);
    tube(world,[x,2.2,-8],[x,2.39,-8],.20,light,6,12);
  }
}

function glacierRelay(world){
  sky(world);landField(world,true);
  const ice=[.25,.52,.60],deep=[.16,.30,.42],sapphire=[.29,.48,.58];
  const dark=[.178,.258,.291],anodized=[.35,.50,.54],iceLamp=[.43,.91,.97],purple=[.50,.35,.84];
  const ridges=[
    [-45,-41,15,13,13,.13,[-2.6,3.0]],[-31,-57,23,12,9.5,.13,[3.1,-.8]],
    [-54,-96,33,17,18,.17,[5.3,1.7]],[-68,-119,35,21,19,.25,[5.9,-3.6]],
    [56,-64,22,17,12,.16,[-6.4,-1.0]],[39,-52,13,14,10,.22,[-3.5,1.5]],
    [71,-102,28,24,18,.15,[-8.3,-5.8]],[-20,-119,17,12,13,.12,[-.7,4.0]],
    [8,-155,28,22,20,.12,[4.3,0]], [28,-143,19,16,17,.13,[-4.3,6]],
    [51,-153,36.1,16,17,.09,[.7,5.1]],[-29,-10,9,10,8,.20,[-2.9,-1.9]],
    [43,-5,15.5,15,9,.11,[-8.1,-2.6]],[-23,9,8,7,5.5,.23,[-3.1,1.9]],
  ];
  for(const [i,[x,z,y,rx,rz,tip,slant]] of ridges.entries()){
    column(world,[x,z],-1.15,y,rx,rz,tip,i%3===0?deep:ice,5,10,slant,110+i*207);
  }
  const next=random(151934);
  for(let i=0;i<80;i++){
    const x=-76+next()*155,z=20-next()*127;
    if(Math.abs(x)<9&&z>-26)continue;
    const size=.42+next()*2.83;
    column(world,[x,z],-.89,size*(.36+.56*next()),size*1.28,size*.91,.35+next()*.38,
      blend(deep,sapphire,next()),5,6,[next()-.54,next()-.43],411+i);
  }
  // The raised base leaves the frozen channel readable around the equipment.
  for(const [w,d,z,y,h] of [[15.51,12.30,-14,.19,1.42],[14.93,11.82,-14,.91,.144],[13.33,10.92,-14,1.30,.54]]){
    slab(world,0,y,z,w,d,h,dark,8);
  }
  for(const x of [-6.65,6.65]){
    tube(world,[x,.62,-8.11],[x,.62,-19.81],.17,anodized,8,8);
    tube(world,[x,1.61,-8.03],[x,1.61,-19.25],.080,iceLamp,7,8);
  }
  for(let i=0;i<8;i++){
    const z=-5.97+i*2.5,y=.18-i*.018;
    slab(world,-.46+Math.sin(i*.34)*.28,y,z,4.7-i*.12,2.04,.34,anodized,8);
    for(const x of [-2.5,1.57])tube(world,[x,y+.23,z-1.0],[x,y+.23,z+.87],.073,iceLamp,7,7);
  }

  const base=[0,1.65,-14],n=unit([.093,.997,-.04]);
  revolve(world,base,n,[[0,0],[4.38,0],[4.62,.34],[4.02,.75],[3.53,1.13],[0,1.13]],dark,8,50);
  const tapered=[
    [0,.96],[2.87,.96],[2.94,1.74],[2.26,3.82],[1.43,6.33],[1.05,10.11],[.82,12.21],[.64,14.12],[.28,15.42],[0,15.83],
  ];
  revolve(world,base,n,tapered,anodized,8,6,.16,TAU+.16);
  const atop=(r,altitude,a)=>add(base,[r*Math.cos(a)+n[0]*altitude,n[1]*altitude,r*Math.sin(a)+n[2]*altitude]);
  for(let side=0;side<6;side++){
    const a=side*TAU/6+.136;
    const p=[atop(2.66,1.87,a),atop(1.64,6.04,a+.021),atop(1.10,10.06,a+.032),atop(.74,13.61,a+.04)];
    for(let i=1;i<p.length;i++)tube(world,p[i-1],p[i],.11,iceLamp,7,8,i===3?.5:.82);
  }
  for(const [h,r] of [[3.2,2.66],[6.3,1.87],[11.68,1.13],[13.89,.90]]){
    revolve(world,base,n,[[r-.27,h-.11],[r+.03,h-.11],[r+.15,h],[r+.076,h+.14],[r-.21,h+.13]],
      dark,8,24);
  }
  for(let i=0;i<3;i++){
    const a=.57+i*TAU/3,grip=atop(1.01,9.41,a),a1=atop(3.42,10.43,a),tip=atop(4.95,14.36,a+.16);
    tube(world,grip,a1,.245,dark,8,6,.86);
    tube(world,a1,tip,.206,anodized,8,6,.50);
    tube(world,atop(.66,13.83,a),tip,.110,anodized,8,7,.87);
    tube(world,sub(tip,[0,.17,0]),add(tip,[0,.36,0]),.166,purple,7,10,.62);
  }
  tube(world,atop(0,15.16,0),atop(0,17.24,0),.104,anodized,8,10,.45);
  tube(world,atop(0,16.49,0),atop(0,17.55,0),.116,iceLamp,7,10,.72);
  for(const [x,z,h] of [[-6.43,-11,3.34],[6.43,-13,3.03]]){
    const center=[x,1.59,z];
    revolve(world,center,n,[[0,0],[.96,0],[1.06,.15],[.81,1.23],[.69,h-1.9],[.40,h-1.66],[0,h-1.56]],
      [.24,.35,.43],8,6);
    tube(world,[x,h-.75,z],[x,h-.03,z],.135,iceLamp,7,12,.77);
  }
}

export function prepareWorlds(){
  const dune=assemble(),glacier=assemble();
  duneStation(dune);
  glacierRelay(glacier);
  return {dune:dune.finish(),glacier:glacier.finish()};
}
