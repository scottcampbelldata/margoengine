export const atlasWidth=512;
export const atlasHeight=256;
const TAU=2*Math.PI, segments=88;
const profile=[
  [.042,.103,.132,-.017],[.049,.116,.147,-.009],[.060,.129,.166,-.001],
  [.081,.132,.172,.004],[.108,.132,.173,.006],[.143,.129,.167,.003],
  [.160,.126,.156,0],[.183,.127,.156,-.003],[.201,.131,.151,-.006],
  [.220,.133,.149,-.008],[.239,.128,.143,-.010],[.260,.117,.130,-.012],
  [.280,.101,.112,-.013],[.296,.080,.089,-.016],[.308,.049,.060,-.019],
  [.315,.025,.036,-.020],[.318,.005,.009,-.020],
];

const add=(a,b)=>a.map((v,i)=>v+b[i]);
const minus=(a,b)=>a.map((v,i)=>v-b[i]);
const scale=(a,m)=>a.map(v=>v*m);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normalize=a=>scale(a,1/Math.hypot(...a));
const mix=(a,b,t)=>a+(b-a)*t;
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));

function forms(){
  const values=[],indices=[];
  function face(points,tag,uv=points.map(()=>[0,0]),normals){
    const first=values.length/9;
    const plane=normals?null:normalize(cross(minus(points[1],points[0]),minus(points[2],points[0])));
    for(let i=0;i<points.length;i++){
      values.push(...points[i],...(normals?normals[i]:plane),...uv[i],tag);
      if(i>1)indices.push(first,first+i-1,first+i);
    }
  }
  return {face,read:()=>({vertices:new Float32Array(values),indices:new Uint32Array(indices)}),
    count:()=>indices.length};
}

function outer(row,theta){
  const [y,rx,rz,zc]=profile[row];
  const front=Math.max(0,Math.cos(theta));
  const nose=.011*front**7*Math.exp(-((y-.085)**2)/.0028);
  const lip=.0075*front**6*Math.exp(-((y-.200)**2)/.0012);
  const h=y+front**5*(row>4&&row<10?.0075*Math.sin((row-5)*.484):0);
  return [rx*Math.sin(theta),h,rz*Math.cos(theta)+zc+nose+lip];
}

function skinNormal(row,theta){
  const around=minus(outer(row,theta+.018),outer(row,theta-.018));
  const up=minus(outer(Math.min(profile.length-1,row+1),theta),outer(Math.max(0,row-1),theta));
  return normalize(cross(around,up));
}

function graph(engine){
  const firstOpening=27,lastOpening=61,bottom=5,top=8;
  const theta=i=>TAU*(i/segments-.5);
  const skin=(r,i)=>outer(r,theta(i)),n=(r,i)=>skinNormal(r,theta(i));
  const uv=(r,i)=>[i/segments,.977-(profile[r][0]-.042)/.2907];
  const shell=(r,i)=>[[r,i],[r,i+1],[r+1,i+1],[r+1,i]];
  for(let row=0;row<profile.length-1;row++){
    for(let i=0;i<segments;i++){
      if(row>=bottom&&row<top&&i>=firstOpening&&i<lastOpening)continue;
      const guide=shell(row,i);
      engine.face(guide.map(([r,u])=>skin(r,u)),row<1?4:0,
        guide.map(([r,u])=>uv(r,u)),guide.map(([r,u])=>n(r,u)));
    }
  }
  const topY=profile[profile.length-1][0];
  for(let i=0;i<segments;i++){
    const row=profile.length-1, center=[0,topY,-.02];
    const b=Math.abs(i/segments-.5)<.078?i/segments:.5;
    engine.face([skin(row,i),skin(row,i+1),center],0,[uv(row,i),uv(row,i+1),[b,.027]],
      [n(row,i),n(row,i+1),[0,1,0]]);
  }

  // The smoked visor is one convex patch set into its actual opening, with formed rubber lips along its edges.
  function inset(r,i,offset=.0027){
    const p=outer(r,theta(i)),normal=n(r,i);
    return minus(p,scale(normal,offset));
  }
  for(let i=firstOpening;i<lastOpening;i++){
    for(let row=bottom;row<top;row++){
      const guide=shell(row,i);
      engine.face(guide.map(([r,u])=>inset(r,u)),1,
        guide.map(([r,u])=>[(u-firstOpening)/(lastOpening-firstOpening),(r-bottom)/(top-bottom)]),
        guide.map(([r,u])=>n(r,u)));
    }
    for(const [row,join,travel] of [[bottom,bottom+1,.20],[top,top-1,.17]]){
      const p=[skin(row,i),skin(row,i+1)];
      const q=[inset(join,i),inset(join,i+1)];
      const raster=[p[0],p[1],p[1].map((x,a)=>mix(x,q[1][a],travel)),p[0].map((x,a)=>mix(x,q[0][a],travel))];
      engine.face(row===top?raster.reverse():raster,2);
    }
  }
  for(const edge of [firstOpening,lastOpening]){
    const inner=edge+(edge===firstOpening?1:-1);
    for(let row=bottom;row<top;row++){
      const surface=[skin(row,edge),inset(row,inner),inset(row+1,inner),skin(row+1,edge)];
      engine.face(edge===firstOpening?surface:surface.reverse(),2);
    }
  }

  // Bottom neck seal. It turns under the shell and leaves a dark recessed opening.
  for(let i=0;i<segments;i++){
    const a=skin(0,i),b=skin(0,i+1),neck=p=>[p[0]*.87,p[1]-.006,(p[2]+.017)*.91-.017];
    engine.face([b,a,neck(a),neck(b)],4);
    engine.face([neck(b),neck(a),[0,.041,-.017]],2);
  }

  // Paired anodised hinge caps. The local disc normal follows the shell rather than sitting flat on an axis.
  for(const side of [-1,1]){
    const angle=side*1.25;
    const at=outer(7,angle),axis=skinNormal(7,angle),right=normalize(cross([0,1,0],axis)),up=cross(axis,right);
    const hinge=add(at,scale(axis,.0037));
    function disk(radius,steps,tag){
      lathe(engine,hinge,right,up,axis,[[0,-.002],...steps.map(([r,d])=>[r*radius,d]),[0,steps.at(-1)[1]]],tag,42);
    }
    disk(.022,[[.87,-.002],[1,0],[.99,.0035],[.82,.0044]],2);
    disk(.0176,[[.89,.0044],[1,.0058],[.98,.007],[.94,.008]],3);
    disk(.0135,[[.94,.008],[1,.0087],[.91,.0108]],4);
    disk(.0064,[[.92,.0109],[1,.0127],[.91,.0135]],3);
    const bolt=add(hinge,scale(axis,.0137));
    engine.face([add(bolt,add(scale(right,-.0035),scale(up,-.0006))),
      add(bolt,add(scale(right,.0035),scale(up,-.0006))),
      add(bolt,add(scale(right,.0035),scale(up,.0006))),
      add(bolt,add(scale(right,-.0035),scale(up,.0006)))],4);
  }

  // Inlet lips and apertures follow the curved brow. Widths vary around the contour.
  for(const theta of [-.33,-.18,.18,.33]){
    const at=outer(10,theta),axis=skinNormal(10,theta),right=[Math.cos(theta),0,-Math.sin(theta)],up=normalize(cross(axis,right));
    const mark=(x,y,depth)=>add(at,add(scale(right,x),add(scale(up,y),scale(axis,depth))));
    const opening=(w,h,depth)=>[mark(-w*.50,-h*.32,depth),mark(w*.54,-h*.34,depth),
      mark(w*.36,h*.43,depth),mark(-w*.36,h*.43,depth)];
    engine.face(opening(.020,.010,.0014),3);
    engine.face(opening(.016,.007,.0020),2);
  }
}

function lathe(engine,center,x,y,axis,rings,tag,segments){
  const vec=(r,h,phi)=>add(center,add(scale(axis,h),add(scale(x,r*Math.cos(phi)),scale(y,r*Math.sin(phi)))));
  for(let j=1;j<rings.length;j++){
    const [r0,z0]=rings[j-1],[r1,z1]=rings[j],rise=z1-z0,fall=r0-r1;
    const direction=theta=>normalize(add(scale(axis,fall),add(scale(x,rise*Math.cos(theta)),scale(y,rise*Math.sin(theta)))));
    for(let i=0;i<segments;i++){
      const a=TAU*i/segments,b=TAU*(i+1)/segments;
      const p=[vec(r0,z0,a),vec(r0,z0,b),vec(r1,z1,b),vec(r1,z1,a)];
      const n=[direction(a),direction(b),direction(b),direction(a)];
      if(!r0){p.splice(1,1);n.splice(1,1);}
      if(!r1){p.splice(3,1);n.splice(3,1);}
      engine.face(p,tag,undefined,n);
    }
  }
}

function studio(engine){
  const sweep=[[0,-.028],[.81,-.028],[1.19,-.027],[1.40,-.010],[1.59,.037],[1.74,.12],[1.84,.25],[1.91,.44],[1.935,.73],[1.94,1.18],[1.94,2.5]];
  const p=[0,0,0],x=[1,0,0],z=[0,0,-1],y=[0,1,0];
  lathe(engine,p,x,z,y,sweep,7,64);
  lathe(engine,p,x,z,y,[[0,-.026],[.228,-.026],[.245,-.018],[.247,-.010],[.244,.003],[.223,.014],[.206,.020],[0,.020]],5,100);
  lathe(engine,p,x,z,y,[[.241,.0006],[.245,.0006],[.246,.0023],[.242,.0042],[.240,.0030]],6,100);
  lathe(engine,p,x,z,y,[[.025,.020],[.093,.020],[.103,.024],[.101,.040],[.094,.0425],[.027,.0425],[.025,.040]],2,68);
}

function paintAtlas(){
  const data=new Uint8Array(atlasWidth*atlasHeight*4);
  const cream=[213,180,130],rust=[203,84,52],darkRed=[169,63,39],ink=[62,53,48],pin=[234,181,140],wing=[239,204,160];
  const cover=(edge,aa)=>clamp(.5+edge/aa,0,1);
  for(let y=0;y<atlasHeight;y++){
    const v=(y+.5)/atlasHeight;
    for(let x=0;x<atlasWidth;x++){
      const u=(x+.5)/atlasWidth, surface=u-.5, center=Math.abs(surface);
      const bottom=.70+.10*Math.cos(surface*TAU)+.042*Math.cos(surface*TAU*2);
      const cell=Math.imul(x,1597334677)^Math.imul(y,3812015801);
      const fleck=(Math.imul(cell^(cell>>>16),73244475)>>>30)-1.5;
      const centerBand=.061+.014*Math.sin(v*Math.PI);
      const sideCentre=.607-(u-.690)*.71;
      const rear=cover(.023-Math.min(u,1-u),.0032);
      const field=cover(v-bottom-.045,.0053);
      const pinstripe=cover(.005-Math.abs(v-bottom),.0048);
      const border=cover(.0051-Math.abs(center-centerBand),.0033);
      const whiteStripe=Math.max(rear,cover(centerBand-.0065-center,.0033));
      const orangeStripe=Math.max(cover(.0052-center,.0029),cover(.002-Math.abs(center-.044),.0029));
      const shortWing=cover(Math.min(u-.675,.718-u,.006-Math.abs(v-.629+(u-.691)*.72)),.0030);
      const longWing=cover(Math.min(u-.651,.734-u,.011-Math.abs(v-sideCentre)),.0030);
      const at=(y*atlasWidth+x)*4;
      for(let ch=0;ch<3;ch++){
        const base=mix(mix(mix(rust[ch],darkRed[ch],field),pin[ch],pinstripe),ink[ch],border);
        const offset=mix(mix(base,cream[ch],whiteStripe),rust[ch],orangeStripe);
        data[at+ch]=clamp(mix(offset,wing[ch],Math.max(longWing,shortWing))+fleck,0,255);
      }
      data[at+3]=255;
    }
  }
  return data;
}

export function prepare(){
  const builder=forms();
  graph(builder);
  const helmetElements=builder.count();
  studio(builder);
  return {...builder.read(),helmetElements,source:paintAtlas()};
}
