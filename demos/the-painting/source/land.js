const clamp=(n,lo=0,hi=1)=>Math.max(lo,Math.min(hi,n));
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const gaussian=n=>Math.exp(-n*n);

export const shore=z=>-7+12*gaussian((z-12)/15)-13*gaussian((z+25)/18)
  +23*gaussian((z+62)/23)-19*gaussian((z+100)/29)+17*gaussian((z+147)/34)
  +1.9*Math.sin(z*.118)+.58*Math.sin(z*.407);

function baseHeight(z){
  return 3.75+3.25*gaussian((z-9)/27)+4.7*gaussian((z+61)/30)+.66*Math.sin(z*.151)
    +.47*Math.sin(z*.302);
}
function plateau(x,z){
  const inland=Math.max(0,shore(z)-x);
  return baseHeight(z)+Math.min(6.4,inland*.13)
    +1.55*Math.sin(z*.044+x*.071)*Math.min(1,inland*.24)
    +.49*Math.sin(z*.33-x*.27)*Math.min(1,inland*.20);
}
function fieldColor(x,z){
  const edge=shore(z)-x;
  const drift=.5+.24*Math.sin(x*.13+z*.116)+.18*Math.sin(x*.27-z*.16);
  const moss=mix([.242,.285,.174],[.580,.457,.268],clamp(drift));
  const path=Math.exp(-(((edge-2.65-.62*Math.sin(z*.14))/.95)**2));
  const clay=mix(moss,[.677,.540,.289],path*.76);
  return mix(clay,[.687,.584,.328],clamp((1.1-edge)/1.2)*.51);
}
function unit(v){
  const m=Math.hypot(...v);
  return v.map(x=>x/m);
}
function cross(u,v){
  return [u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
}
function difference(a,b){return a.map((v,i)=>v-b[i]);}
function generator(seed=5041){
  let state=seed;
  return ()=>{
    state=(Math.imul(state,1664525)+1013904223)>>>0;
    return state*2.3283064365386963e-10;
  };
}
const TAU=Math.PI*2;
function buffer(){
  const fields=[],indices=[];
  function face(p,colors,tag,{flex=[],normals}={}){
    const start=fields.length/11;
    const direction=normals??p.map(()=>unit(cross(difference(p[1],p[0]),difference(p[2],p[0]))));
    for(const [index,point] of p.entries()){
      fields.push(...point,...direction[index],...(Array.isArray(colors[0])?colors[index]:colors),tag,flex[index]??0);
      if(index>1)indices.push(start,start+index-1,start+index);
    }
  }
  return {face, finish:()=>({vertices:Float32Array.from(fields),indices:Uint32Array.from(indices)})};
}

function land(mesh){
  const offsets=[0,.18,.52,1.10,2,3.4,4.9,6.5,8.2,10.2,12.5,15.8,20,26,34,44,58,75,94,119,153,200,260];
  const count=244,min=-251,max=28;
  const landPoint=(z,off)=>[shore(z)-off,plateau(shore(z)-off,z),z];
  const layers=[0,.075,.14,.27,.32,.48,.65,.73,.88,.94,1];
  const rocks=[[.246,.245,.228],[.404,.367,.296],[.544,.451,.355],[.421,.382,.351],[.592,.491,.371],
    [.444,.368,.306],[.657,.555,.433],[.453,.419,.338],[.643,.555,.406],[.552,.487,.335]];
  const cliff=(z,layer)=>{
    if(layer===1)return landPoint(z,0);
    const edge=shore(z);
    const height=baseHeight(z);
    const ridge=.36*Math.sin(z*.54+layer*8)+.11*Math.sin(z*1.72+layer*17);
    const rubble=1.18*(1-layer)+ridge*(1-layer*.63)+.44*Math.sin(layer*40);
    return [edge+rubble,height*layer-.32+(1-layer)*.26*Math.sin(z*.39),z];
  };
  for(let i=0;i<count;i++){
    const near=min+(max-min)*i/count, far=min+(max-min)*(i+1)/count;
    for(let j=0;j<offsets.length-1;j++){
      const right=offsets[j],left=offsets[j+1];
      const p=[landPoint(far,right),landPoint(near,right),landPoint(near,left),landPoint(far,left)];
      mesh.face(p,p.map(([x,,z])=>fieldColor(x,z)),2);
    }
    for(const [j,low] of layers.slice(0,-1).entries()){
      const high=layers[j+1];
      const p=[cliff(far,low),cliff(near,low),cliff(near,high),cliff(far,high)];
      const change=.12+.15*Math.sin(near*.31)+.14*Math.sin(near*1.34);
      const colors=mix(rocks[j],[.896,.674,.410],clamp(change));
      mesh.face(p,colors,3);
    }
  }
}

function waterAndSky(mesh){
  mesh.face([[-1540,-160,-805],[1540,-160,-805],[1540,660,-805],[-1540,660,-805]],[.67,.70,.76],0);
  const depths=[34,25,17,10,5,0,-5,-10,-16,-23,-32,-42,-55,-70,-88,-113,-145,-184,-226,-272,-338,-416,-506,-623,-791];
  const widths=[-760,-411,-250,-140,-90,-52,-29,-13,-4,3,9,16,24,33,45,64,94,141,230,405,760];
  for(let j=0;j<depths.length-1;j++){
    const front=depths[j],back=depths[j+1];
    for(let i=0;i<widths.length-1;i++){
      const left=widths[i],right=widths[i+1];
      mesh.face([[left,0,front],[right,0,front],[right,0,back],[left,0,back]],[.295,.411,.465],1);
    }
  }
}
function surfacePoint(center,radius,azimuth,latitude,distort,aspect){
  const shell=radius*(1+distort);
  return [center[0]+shell*Math.cos(azimuth)*Math.cos(latitude)*aspect[0],
    center[1]+shell*Math.sin(latitude)*aspect[1],center[2]+shell*Math.sin(azimuth)*Math.cos(latitude)*aspect[2]];
}
function irregular(mesh,center,radius,aspect,material,tag,seed,flex=0,segments=9,rings=6){
  const wiggle=(a,b)=>.18*Math.cos(seed+a*2)*Math.sin(b*3)+.09*Math.cos(a*3-b*4+seed);
  const point=(i,j)=>{
    const a=TAU*i/segments,b=Math.PI*(j/rings-.5);
    return surfacePoint(center,radius,a,b,wiggle(a,b),aspect);
  };
  const sway=k=>Math.max(0,flex+flex*(k-3)/rings*.28);
  for(let j=0;j<rings;j++){
    for(let i=0;i<segments;i++){
      const a=point(i,j),b=point(i+1,j),c=point(i+1,j+1),d=point(i,j+1);
      const color=mix(material,[.76,.67,.32],clamp(.07+.10*Math.sin(seed+i*.92+j*.84)));
      if(j===0)mesh.face([a,c,d],color,tag,{flex:[sway(j),sway(j+1),sway(j+1)]});
      else if(j===rings-1)mesh.face([c,b,a],color,tag,{flex:[sway(j+1),sway(j),sway(j)]});
      else mesh.face([a,d,c,b],color,tag,{flex:[sway(j),sway(j+1),sway(j+1),sway(j)]});
    }
  }
}
function limb(mesh,a,b,ra,rb,tint,segments=8,flexA=0,flexB=0){
  const axis=unit(difference(b,a));
  const side=unit(cross(axis,Math.abs(axis[1])>.84?[1,0,0]:[0,1,0]));
  const across=cross(axis,side);
  const circle=(p,r,index)=>p.map((v,j)=>v+r*(side[j]*Math.cos(index*TAU/segments)+across[j]*Math.sin(index*TAU/segments)));
  for(let i=0;i<segments;i++){
    const color=mix(tint,[.63,.461,.272],.08+.075*Math.sin(i));
    mesh.face([circle(a,ra,i),circle(a,ra,i+1),circle(b,rb,i+1),circle(b,rb,i)],color,4,
      {flex:[flexA,flexA,flexB,flexB]});
  }
}
function pine(mesh,x,z,scale,seed){
  const y=plateau(x,z)-.11,start=[x,y,z];
  const p=(dx,dy,dz)=>[x+dx*scale,y+dy*scale,z+dz*scale];
  const trunk=[start,p(-.16,.89,.007),p(-.39,1.85,-.14),p(-.66,2.68,-.31),p(-1.02,3.48,-.54),p(-1.54,4.31,-.72)];
  const radii=[.29,.188,.158,.130,.087,.038];
  const bark=[.266,.225,.180], random=generator(seed);
  for(let i=1;i<trunk.length;i++)limb(mesh,trunk[i-1],trunk[i],radii[i-1]*scale,radii[i]*scale,bark,10,
    (i-1)**2*.011*scale,i**2*.011*scale);
  const branches=[
    [2,[-1.81,2.34,.38],[-2.63,3.30,.48],.85],
    [2,[1.22,2.39,-.16],[1.39,3.23,-.31],.57],
    [3,[-.80,3.76,.92],[-1.24,4.06,1.21],.83],
    [3,[-1.68,3.21,-1.53],[-2.53,3.87,-1.78],.91],
    [4,[-1.38,3.86,.39],[-2.05,4.62,.18],.83],
    [4,[-.76,4.07,-.56],[-.52,4.65,-.89],.68],
    [5,[-2.25,4.40,-.88],[-2.76,4.68,-1.22],.68],
  ];
  for(const [i,leg,tip,size] of branches){
    const middle=p(...leg),end=p(...tip);
    limb(mesh,trunk[i],middle,.105*scale,.057*scale,bark,7,.10*scale,.20*scale);
    limb(mesh,middle,end,.057*scale,.013*scale,bark,7,.20*scale,.32*scale);
    for(let j=0;j<7;j++){
      const cx=end[0]+(random()-.5)*size*2.8*scale,cz=end[2]+(random()-.5)*size*1.9*scale;
      const cy=end[1]+random()*size*.87*scale;
      const color=mix([.169,.223,.159],[.483,.479,.251],.22+random()*.53);
      irregular(mesh,[cx,cy,cz],size*(.43+random()*.48)*scale,
        [1.38,.54,.90],color,5,seed+j+i*.47,.29*scale,8,5);
    }
  }
}

function details(mesh){
  pine(mesh,1.87,4.8,1.06,10911);
  pine(mesh,-3.81,8.9,.66,11901);
  pine(mesh,shore(-53.2)-5.3,-53.2,1.13,19513);
  pine(mesh,shore(-54.5)-9.3,-54.5,.88,5113);
  const random=generator(490789);
  for(let i=0;i<2510;i++){
    const z=-84+Math.sqrt(random())*104,d=.18+random()*13;
    const x=shore(z)-d;
    if(d>2.2&&d<4.1&&random()>.20)continue;
    const y=plateau(x,z)-.07,h=.055+random()*.26,r=.010+random()*.042;
    const color=mix([.301,.340,.161],[.760,.591,.310],random());
    const lean=.05+random()*.07;
    mesh.face([[x-r,y,z-.028],[x+r,y,z+.022],[x-lean,y+h,z-.011]],color,6,{flex:[0,0,.10+h*.55]});
    if(i%3===0)mesh.face([[x-.025,y,z-r],[x+.024,y,z+r],[x+lean*.5,y+h*.71,z]],color,6,
      {flex:[0,0,.07+h*.5]});
  }
  for(let j=0;j<94;j++){
    const z=-169+random()*196, edge=shore(z);
    const r=.27+random()*1.15;
    irregular(mesh,[edge+.2+random()*2.02,-.195+random()*.54,z],r,[1.32,.68,1.11],[.396,.382,.341],3,j);
  }
  for(let j=0;j<27;j++){
    const z=-27-random()*52,x=shore(z)+5+random()*13;
    const s=.5+random()*.96;
    irregular(mesh,[x,-.26+s*.12,z],s,[1.2,.67,1.46],[.352,.371,.369],3,47+j);
  }
  // Eroded skerries anchor the far side of the sound.
  for(const [x,y,z,s] of [[32,.40,-104,6], [36,.38,-110,5.3], [32,.40,-119,7.1],
    [46,.56,-140,8.4], [46,.14,-159,8.5], [50,.9,-174,8.2],[53,.54,-218,12.2],
    [119,.94,-286,19.5], [147,.91,-306,23.1], [118,1,-330,20.0],[114,.45,-340,18.6]]){
    irregular(mesh,[x,y,z],s,[1.53,.28,.87],[.342,.348,.443],3,x+z,0,13,8);
  }
  const z=-49,x=shore(z)-5.75,y=plateau(x,z);
  // Low-ended shepherd shelter with slate roof and a short chimney.
  const corners=[[x,y,z],[x+3.2,y,z],[x+3.2,y,z-2.4],[x,y,z-2.4]];
  const top=corners.map(p=>[p[0],p[1]+1.84,p[2]]);
  for(let i=0;i<4;i++)mesh.face([corners[i],corners[(i+1)%4],top[(i+1)%4],top[i]],[.582,.467,.325],7);
  const peak=[x+1.6,y+2.71,z+.21],end=[peak[0],peak[1],z-2.58];
  mesh.face([[x-.18,y+1.75,z+.21],peak,end,[x-.18,y+1.75,z-2.58]],[.361,.324,.358],7);
  mesh.face([peak,[x+3.38,y+1.75,z+.21],[x+3.38,y+1.75,z-2.58],end],[.338,.345,.395],7);
  mesh.face([top[0],top[1],[peak[0],peak[1],z]],[.603,.430,.299],7);
  mesh.face([[x+1.65,y+.03,z+.015],[x+2.35,y+.03,z+.015],[x+2.35,y+1.36,z+.015],[x+1.65,y+1.36,z+.015]],
    [.259,.246,.232],7);
}

export function prepareLand(){
  const mesh=buffer();
  waterAndSky(mesh);
  land(mesh);
  details(mesh);
  return mesh.finish();
}
