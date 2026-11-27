const scale=(v,k)=>v.map(n=>k*n);
const add=(a,b)=>a.map((n,i)=>n+b[i]);
const dot=(a,b)=>a.reduce((sum,n,i)=>sum+n*b[i],0);
const cross=([a,b,c],[x,y,z])=>[b*z-c*y,c*x-a*z,a*y-b*x];
const unit=v=>scale(v,1/Math.hypot(...v));

export const aperture=150;
export const polarAngle=42;
const radians=polarAngle*Math.PI/180;
const polar=[0,Math.sin(radians),-Math.cos(radians)];
const sight=unit([.91,.391,.289]);
const dec=scale(unit(cross(polar,sight)),-1);
const hub=[-.075,.872,-.035];
const tube=add(hub,scale(dec,.166));
const view=[0,1,0];
const above=unit(add(view,scale(sight,-dot(view,sight))));
const right=unit(cross(sight,above));

export const annotations={
  aperture:add(tube,scale(sight,.462)),
  polar:add(hub,scale(polar,-.189)),
  shaft:add(hub,scale(dec,-.370)),
};
export const anchors={polar,dec,sight,hub,tube};
const radialFrame=(axis)=>{
  const u=unit(cross(Math.abs(axis[1])>.91?[1,0,0]:[0,1,0],axis));
  return [u,unit(cross(axis,u))];
};
function collection(){
  const points=[],normals=[],indices=[];
  return {
    triangle(a,b,c,na,nb=na,nc=na){
      const next=points.length/3;
      points.push(...a,...b,...c);
      normals.push(...na,...nb,...nc);
      indices.push(next,next+1,next+2);
    },
    result:()=>({points,normals,indices}),
  };
}

/** A closed axial profile, including the inner wall for a through-bore. */
function turned(origin,axis,profile,sides){
  const [u,v]=radialFrame(axis);
  const spokes=Array.from({length:sides},(_,i)=>{
    const theta=i*2*Math.PI/sides;
    return add(scale(u,Math.cos(theta)),scale(v,Math.sin(theta)));
  });
  const points=[],normals=[],indices=[];
  for(const [i,[s0,r0]] of profile.entries()){
    const [s1,r1]=profile[(i+1)%profile.length];
    if(r0===0&&r1===0)continue;
    const first=points.length/3;
    const normal=spoke=>unit(add(scale(spoke,s1-s0),scale(axis,r0-r1)));
    for(const [station,radius] of [[s0,r0],[s1,r1]]){
      const center=add(origin,scale(axis,station));
      for(const spoke of spokes){
        points.push(...add(center,scale(spoke,radius)));
        normals.push(...normal(spoke));
      }
    }
    for(let j=0;j<sides;j++){
      const k=(j+1)%sides;
      if(r0>0)indices.push(first+j,first+k,first+sides+k);
      if(r1>0)indices.push(first+j,first+sides+k,first+sides+j);
    }
  }
  return {points,normals,indices};
}

function ringProfile(a,b,outer,inner,chamfer=.0023){
  const edge=Math.min((b-a)/2.5,(outer-inner)/2.5,chamfer);
  return [[a,inner],[a,outer-edge],[a+edge,outer],[b-edge,outer],
    [b,outer-edge],[b,inner],[b-edge,inner-edge],[a+edge,inner-edge]];
}
function diskProfile(a,b,radius,chamfer=.0035){
  const edge=Math.min((b-a)/3,radius/3,chamfer);
  return [[a,0],[a,radius-edge],[a+edge,radius],[b-edge,radius],[b,radius-edge],[b,0]];
}
function strut(a,b,width,depth){
  const axis=unit(b.map((n,i)=>n-a[i])),[x,z]=radialFrame(axis);
  const halfW=width/2,halfD=depth/2, bevel=Math.min(halfW,halfD)*.22;
  const local=[[-halfW+bevel,-halfD],[halfW-bevel,-halfD],[halfW,-halfD+bevel],[halfW,halfD-bevel],
    [halfW-bevel,halfD],[-halfW+bevel,halfD],[-halfW,halfD-bevel],[-halfW,-halfD+bevel]];
  const face=origin=>local.map(([u,v])=>add(origin,add(scale(x,u),scale(z,v))));
  const start=face(a),end=face(b),body=collection();
  for(let j=1;j+1<start.length;j++){
    body.triangle(start[0],start[j+1],start[j],scale(axis,-1));
    body.triangle(end[0],end[j],end[j+1],axis);
  }
  for(let j=0;j<start.length;j++){
    const k=(j+1)%start.length;
    const n=unit(cross(start[k].map((value,i)=>value-start[j][i]),axis));
    body.triangle(start[j],start[k],end[k],n);
    body.triangle(start[j],end[k],end[j],n);
  }
  return body.result();
}

export function buildRefractor(){
  const parts=[];
  const put=(name,finish,body,hidden,crease=29,guide)=>parts.push({name,finish,body,hidden,crease,guide});
  const turn=(name,finish,origin,axis,profile,{hidden=false,sides=44,crease=29,guide}={})=>
    put(name,finish,turned(origin,axis,profile,sides),hidden,crease,guide);
  const block=(name,finish,a,b,w,d,hidden=false)=>
    put(name,finish,strut(a,b,w,d),hidden);

  turn('Beveled pier plate','warm',[0,0,0],view,diskProfile(.033,.066,.217),{sides:50});
  turn('Pier spigot','cool',[0,0,0],view,diskProfile(.066,.122,.137),{sides:44});
  turn('Pier column','ivory',[0,0,0],view,
    [[.115,0],[.115,.109],[.178,.100],[.608,.072],[.655,.088],[.686,.082],[.686,0]]);
  turn('Pier collar','cool',[0,0,0],view,ringProfile(.56,.606,.095,.074),{sides:46});
  turn('Mount bracket pad','warm',[0,0,0],view,diskProfile(.674,.720,.117),{sides:42});

  for(let i=0;i<3;i++){
    const theta=(i+.28)*Math.PI*2/3;
    const foot=[Math.cos(theta)*.34,.070,Math.sin(theta)*.34];
    const hinge=[foot[0]*.285,.378,foot[2]*.285];
    block('Pier brace '+i,'cool',foot,hinge,.056,.051);
    turn('Anchor foot '+i,'warm',foot,view,diskProfile(-.036,.012,.052),{sides:22});
    turn('Foot nut '+i,'dark',foot,view,diskProfile(.011,.025,.022),{sides:8});
  }

  const bearing=add(hub,scale(polar,-.219));
  block('Latitude block','cool',[bearing[0],.694,bearing[2]],[bearing[0],bearing[1]+.01,bearing[2]],.139,.13);
  turn('Polar housing','cool',hub,polar,
    [[-.341,0],[-.341,.061],[-.328,.080],[-.252,.081],[-.239,.099],
      [-.118,.098],[-.099,.071],[-.016,.069],[.012,.058],[.012,0]]);
  turn('Right ascension dial','warm',hub,polar,ringProfile(-.136,-.099,.106,.080),{sides:48});
  turn('Polar cover','dark',hub,polar,diskProfile(-.356,-.338,.063),{sides:36});
  turn('Polar axle inside housing','warm',hub,polar,diskProfile(-.328,.025,.034),{hidden:true,sides:32});
  turn('Declination drum','ivory',hub,dec,diskProfile(-.080,.102,.092),{sides:48});
  turn('Declination dial','warm',hub,dec,ringProfile(.062,.091,.103,.092),{sides:50});
  turn('Counterweight spindle','dark',hub,dec,diskProfile(-.485,-.034,.014),{hidden:true,sides:30});
  for(const [i,at] of [-.355,-.271].entries())
    turn('Counterweight '+i,'cool',hub,dec,ringProfile(at-.032,at+.032,.066,.015),{sides:44});
  turn('Thread stop','warm',hub,dec,diskProfile(-.492,-.472,.031),{sides:32});
  const motor=add(add(hub,scale(polar,-.19)),scale(right,.105));
  block('Tracking drive housing','dark',add(motor,[0,-.050,0]),add(motor,[0,.048,0]),.103,.108);
  const saddle=add(tube,scale(dec,-.093));
  block('Dovetail saddle','cool',add(saddle,scale(sight,-.175)),add(saddle,scale(sight,.143)),.109,.043);

  turn('Optical tube','ivory',tube,sight,
    [[-.463,.048],[-.448,.063],[-.365,.065],[-.271,.071],[-.082,.074],[.302,.076],
      [.321,.083],[.390,.084],[.415,.080],[.415,.073],[.386,.070],[.305,.069],
      [-.089,.067],[-.283,.061],[-.438,.046],[-.463,.038]],{sides:60,crease:22});
  turn('Objective shade','ivory',tube,sight,
    [[.340,.080],[.353,.092],[.425,.094],[.455,.090],[.462,.084],[.462,.075],
      [.446,.075],[.429,.076],[.351,.075],[.340,.075]],{sides:60,crease:25});
  turn('Objective cell','warm',tube,sight,ringProfile(.359,.385,.078,.065),{sides:56});
  turn('Recessed objective','glass',tube,sight,
    [[.365,0],[.366,.041],[.372,.063],[.380,.066],[.391,.065],[.399,.041],[.401,0]],{sides:56,crease:24});
  for(const [i,at] of [-.163,.116].entries())
    turn('Tube band '+i,'cool',tube,sight,ringProfile(at-.014,at+.014,.083,.074),{sides:52});
  for(const [i,at] of [-.228,-.075,.052,.208].entries())
    turn('Interior light baffle '+i,'dark',tube,sight,ringProfile(at-.007,at+.006,.067,i<2?.041:.051,.001),
      {hidden:true,sides:40,guide:{origin:tube,axis:sight,station:at+.006,radius:i<2?.041:.051}});
  turn('Rear drawtube','dark',tube,sight,ringProfile(-.564,-.445,.040,.028),{hidden:true,sides:44});
  turn('Focus collar','cool',tube,sight,ringProfile(-.527,-.467,.047,.035),{sides:44});
  turn('Eyepiece housing','warm',tube,sight,ringProfile(-.632,-.563,.032,.019),{sides:42});
  turn('Eye guard','dark',tube,sight,ringProfile(-.651,-.622,.034,.024),{sides:40});
  const focus=add(tube,scale(sight,-.482));
  turn('Focus wheel','warm',focus,right,diskProfile(.039,.087,.030),{sides:32});
  turn('Focus axle','dark',focus,right,diskProfile(-.059,.044,.011),{sides:22});

  const finder=add(add(tube,scale(above,.132)),scale(right,-.018));
  turn('Finder tube','cool',finder,sight,ringProfile(-.320,-.027,.024,.019),{sides:36});
  turn('Finder objective shade','warm',finder,sight,ringProfile(-.062,-.008,.029,.020),{sides:36});
  turn('Finder eyepiece','dark',finder,sight,ringProfile(-.358,-.317,.019,.012),{sides:30});
  for(const [i,station] of [-.250,-.092].entries()){
    const mount=add(tube,scale(sight,station));
    block('Finder support '+i,'cool',add(mount,scale(above,.073)),add(mount,scale(above,.114)),.035,.028);
    turn('Finder ring '+i,'warm',finder,sight,ringProfile(station-.011,station+.011,.030,.023),{sides:35});
  }
  return parts;
}

export function tickLines(){
  const positions=[];
  for(const [axis,start,radius,count] of [[polar,-.121,.1075,40],[dec,.074,.1037,36]]){
    const [u,v]=radialFrame(axis);
    for(let i=0;i<count;i++){
      const theta=i*2*Math.PI/count;
      const n=add(scale(u,Math.cos(theta)),scale(v,Math.sin(theta)));
      const point=add(add(hub,scale(axis,start)),scale(n,radius));
      positions.push(...point,...add(point,scale(axis,i%5? .009:.015)));
    }
  }
  return Float32Array.from(positions);
}

export function datumLines(){
  const floor=[];
  const axis=.45;
  floor.push(-axis,.034,0,axis,.034,0,0,.034,-axis,0,.034,axis);
  for(const x of [-.42,-.32,-.22,-.12,.12,.22,.32,.42]){
    floor.push(x,.034,-.010,x,.034,.010,-.010,.034,x,.010,.034,x);
  }
  return Float32Array.from(floor);
}
