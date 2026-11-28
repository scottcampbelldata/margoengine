import {Geometry,PbrMaterial} from '@margoengine/core';

const tau=Math.PI*2;
const sub=(a,b)=>a.map((v,k)=>v-b[k]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const norm=a=>{const l=Math.hypot(...a)||1;return a.map(v=>v/l);};
const surface={
  oxide:['#bb502c',.33,.39],shoulder:['#932e23',.37,.45],ink:['#263038',.52,.32],
  lining:['#171c21',.75,.16],bronze:['#9c6240',.24,.72],alloy:['#c3aa89',.27,.81],
  graphite:['#464b46',.47,.66],woven:['#555347',.91,.05],weft:['#706c57',.86,.06],
  stitch:['#ba9f70',.85,.04],rubber:['#232420',.91,.01],warm:['#d6bc8a',.69,.16],
  glass:['#283d3b',.14,.42],signal:['#dff0be',.44,.0],
  ember:['#ffc95b',.44,.01],
};
function model(){
  const batches=new Map();
  function face(key,a,b,c,normal,nb=normal,nc=normal){
    const result=cross(sub(b,a),sub(c,a));
    if(Math.hypot(...result)<1e-10)return;
    const point=batches.get(key)??{p:[],n:[],i:[]};
    if(!batches.has(key))batches.set(key,point);
    const index=point.p.length/3;
    if(dot(result,normal)<0){[b,c]=[c,b];[nb,nc]=[nc,nb];}
    point.p.push(...a,...b,...c);
    point.n.push(...normal,...nb,...nc);
    point.i.push(index,index+1,index+2);
  }
  function quad(key,a,b,c,d,na,nb=na,nc=na,nd=na){
    face(key,a,b,c,na,nb,nc);
    face(key,a,c,d,na,nc,nd);
  }
  function materialize(){
    return Array.from(batches,([name,{p,n,i}])=>{
      const [color,roughness,metalness]=surface[name];
      return {geometry:new Geometry(new Float32Array(p),new Float32Array(n),new Uint32Array(i)),name,
        material:new PbrMaterial({color,roughness,metalness})};
    });
  }
  return {face,quad,materialize};
}
const forward=(x,y,z)=>[x,y,z];
const up=(x,y,z)=>[x,z,-y];
const side=(x,y,z)=>[z,y,-x];
function beveled(m,key,centre,w,h,d,r,bevel=.018,convert=forward,steps=7){
  const [X,Y,Z]=centre;
  const point=(x,y,z)=>{const [a,b,c]=convert(x,y,z);return [a+X,b+Y,c+Z];};
  const b=Math.min(bevel,r*.86,d*.45),a=w/2-r,k=h/2-r;
  const shape=[];
  for(let c=0;c<4;c++){
    const sx=c===0||c===3?1:-1,sy=c<2?1:-1;
    for(let j=0;j<=steps;j++){
      const t=(c+j/steps)*Math.PI/2,cos=Math.cos(t),sin=Math.sin(t);
      shape.push([sx*a,sy*k,cos,sin]);
    }
  }
  const ring=(z,rr,l,n)=>shape.map(([u,v,cos,sin])=>[point(u+rr*cos,v+rr*sin,z),convert(cos*l,sin*l,n)]);
  const c=.7071067811865476;
  const rings=[ring(-d/2,r-b,0,-1),ring(-d/2+b*(1-c),r-b*(1-c),c,-c),ring(-d/2+b,r,1,0),
    ring(d/2-b,r,1,0),ring(d/2-b*(1-c),r-b*(1-c),c,c),ring(d/2,r-b,0,1)];
  for(let row=0;row<rings.length-1;row++){
    for(let j=0;j<shape.length;j++){
      const k=(j+1)%shape.length;
      const [p,na]=rings[row][j],[q,nb]=rings[row][k],[s,nc]=rings[row+1][k],[t,nd]=rings[row+1][j];
      m.quad(key,p,q,s,t,na,nb,nc,nd);
    }
  }
  for(const [j,z] of [[0,-d/2],[5,d/2]]){
    const dir=convert(0,0,Math.sign(z));
    for(let k=0;k<shape.length;k++)m.face(key,point(0,0,z),rings[j][k][0],rings[j][(k+1)%shape.length][0],dir);
  }
}
function turned(m,key,[X,Y,Z],profile,sides=56,convert=forward){
  const rings=profile.map(([r,z])=>Array.from({length:sides},(_,j)=>{
    const a=tau*j/sides,[x,y,k]=convert(r*Math.cos(a),r*Math.sin(a),z);
    return [X+x,Y+y,Z+k];
  }));
  for(let k=0;k<profile.length-1;k++){
    const dr=profile[k+1][0]-profile[k][0],dz=profile[k+1][1]-profile[k][1];
    for(let j=0;j<sides;j++){
      const next=(j+1)%sides;
      const normal=i=>{const a=tau*i/sides;return convert(...norm([dz*Math.cos(a),dz*Math.sin(a),-dr]));};
      const a=normal(j),b=normal(next);
      m.quad(key,rings[k][j],rings[k][next],rings[k+1][next],rings[k+1][j],a,b,b,a);
    }
  }
}
function disc(m,key,p,r,d,convert=forward,steps=48){
  turned(m,key,p,[[.001,-d/2],[r*.94,-d/2],[r,-d*.37],[r,d*.30],[r*.96,d/2],[.001,d/2]],steps,convert);
}
function ruled(m,key,a,b,w,z){
  const d=norm([b[0]-a[0],b[1]-a[1],0]),v=[-d[1]*w*.5,d[0]*w*.5];
  m.quad(key,[a[0]+v[0],a[1]+v[1],z],[a[0]-v[0],a[1]-v[1],z],
    [b[0]-v[0],b[1]-v[1],z],[b[0]+v[0],b[1]+v[1],z],[0,0,1]);
}

const types={
  A:['04 22 44','13 33'],E:['42 02 04 44','03 33'],F:['04 02 42','03 33'],
  L:['02 04 44'],D:['02 04 34 43 32 02'],S:['42 12 03 13 33 44 04'],
  O:['12 32 43 34 14 03 12'],R:['04 02 32 42 43 03','23 44'],B:['02 04 34 43 33 03','33 42 02'],
  I:['12 32','22 24','14 34'],H:['02 04','42 44','03 43'],T:['02 42','22 24'],P:['04 02 32 43 33 03'],
  N:['04 02 44 42'],V:['02 24 42'],Y:['02 23 42','23 24'],
  0:['12 32 43 34 14 03 12'],1:['12 22 24','14 34'],2:['02 32 43 13 04 44'],
  4:['02 03 43','32 34'],5:['42 02 03 33 44 04'],7:['02 42 14'],8:['12 32 43 34 14 03 12','03 43'],
  '.':['14 24'],'−':['13 33'],
};
function lettering(m,key,word,x,y,z,height,width=height*.56,weight=height*.10){
  for(const letter of word){
    for(const stroke of types[letter]??[]){
      const positions=stroke.split(' ').map(pair=>[x+Number(pair[0])*width/4,y-(Number(pair[1])-2)*height/2]);
      for(let j=1;j<positions.length;j++)ruled(m,key,positions[j-1],positions[j],weight,z);
    }
    x+=width*1.42;
  }
}

function perforations(m){
  const z=.327,step=.038,r=.0121,rows=10,cols=20;
  const inner=[[-.707,-.707],[0,-1],[.707,-.707],[1,0],[.707,.707],[0,1],[-.707,.707],[-1,0]];
  const outer=[[-1,-1],[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0]];
  for(let j=0;j<rows;j++){
    for(let k=0;k<cols;k++){
      const x=-.815+k*step,y=.419+j*step;
      const rad=((j===0||j===rows-1)&&(k===0||k===cols-1))?r*.68:r;
      for(let l=0;l<8;l++){
        const next=(l+1)%8,point=([u,v],s,d)=>[x+u*s,y+v*s,d];
        const a=point(outer[l],step*.5,z),b=point(outer[next],step*.5,z);
        const c=point(inner[next],rad,z),d=point(inner[l],rad,z);
        m.quad('graphite',a,b,c,d,[0,0,1]);
        const bottom=point(inner[l],rad*.83,z-.008),bottomNext=point(inner[next],rad*.83,z-.008);
        m.quad('ink',d,c,bottomNext,bottom,norm([-inner[l][0],-inner[l][1],.48]));
      }
    }
  }
}
function liftingStrap(m){
  const start=-.67,end=.66,pieces=56;
  const pose=(s,w,z)=>{
    const x=start+(end-start)*s;
    const y=1.106+.267*Math.sin(Math.PI*s)**.84+.016*s;
    const dxy=norm([end-start,.267*.84*Math.PI*Math.cos(Math.PI*s)*Math.max(.04,Math.sin(Math.PI*s))**(-.16),0]);
    return [[x-dxy[1]*w,y+dxy[0]*w,z],[-dxy[1],dxy[0],0]];
  };
  const z=-.047,wide=.092,thick=.025;
  for(let j=0;j<pieces;j++){
    const a=j/pieces,b=(j+1)/pieces;
    const [al,an]=pose(a,thick,z-wide),[ar]=pose(a,thick,z+wide),[bl,bn]=pose(b,thick,z-wide),[br]=pose(b,thick,z+wide);
    const [il]=pose(a,-thick,z-wide),[ir]=pose(a,-thick,z+wide),[jl]=pose(b,-thick,z-wide),[jr]=pose(b,-thick,z+wide);
    m.quad(j%3?'woven':'weft',al,ar,br,bl,an,an,bn,bn);
    m.quad('woven',il,ir,jr,jl,an.map(x=>-x),an.map(x=>-x),bn.map(x=>-x),bn.map(x=>-x));
    m.quad('weft',ar,ir,jr,br,[0,0,1]);
    m.quad('weft',al,il,jl,bl,[0,0,-1]);
    if(j%2===0)for(const dz of [-.075,.075]){
      const [p,np]=pose(a+.003,thick+.001,z+dz),[q,nq]=pose(b-.003,thick+.001,z+dz);
      const move=(v,d)=>[v[0],v[1],v[2]+d];
      m.quad('stitch',move(p,-.004),move(p,.004),move(q,.004),move(q,-.004),np,np,nq,nq);
    }
  }
}
function dial(m){
  const x=.548,y=.650;
  turned(m,'ink',[x,y,.327],[[.234,-.010],[.250,0],[.250,.012],[.237,.025],[.211,.025]],72);
  turned(m,'bronze',[x,y,.353],[[.220,0],[.225,.004],[.224,.026],[.211,.035],[.200,.031]],72);
  turned(m,'alloy',[x,y,.389],[[.179,-.018],[.186,-.011],[.186,.028],[.175,.042],[.150,.042]],72);
  const polar=(r,t,z)=>[x+r*Math.cos(t),y+r*Math.sin(t),z];
  for(let j=0;j<55;j++){
    const t=tau*j/55,d=.024,c=polar(.187,t+d,.391),b=polar(.194,t,.400),a=polar(.187,t-d,.391);
    const e=polar(.187,t+d,.414),f=polar(.194,t,.417),g=polar(.187,t-d,.414);
    const n=norm([Math.cos(t),Math.sin(t),.13]);
    m.quad('alloy',a,b,f,g,n);m.quad('alloy',b,c,e,f,n);
  }
  turned(m,'ink',[x,y,.432],[[.165,0],[.162,.009],[.146,.016],[.001,.016]],72);
  turned(m,'bronze',[x,y,.450],[[.073,-.002],[.070,.002],[.062,.008],[.001,.008]],44);
  disc(m,'oxide',[x,y,.462],.054,.011,forward,48);
  for(let n=0;n<33;n++){
    const t=Math.PI*.17+n*Math.PI*1.66/32;
    const a=polar(n%4===0?.109:.126,t,.449),b=polar(.140,t,.449);
    ruled(m,n%4===0?'warm':'graphite',a,b,n%4===0?.0039:.0025,.449);
  }
  ruled(m,'ember',polar(.081,2.02,.452),polar(.142,2.02,.452),.007,.452);
}

export function receiver(){
  const m=model(),B=(s,p,w,h,d,r,b,c,k)=>beveled(m,s,p,w,h,d,r,b,c,k);
  B('ink',[0,.568,-.022],2.145,1.015,.514,.153,.042,forward,13);
  B('shoulder',[0,.568,-.157],2.175,1.026,.277,.15,.041,forward,12);
  B('oxide',[0,.564,.067],2.188,1.035,.394,.159,.047,forward,14);
  B('shoulder',[0,.563,.264],2.113,.963,.072,.139,.030,forward,12);
  B('ink',[0,.566,.293],2.027,.876,.046,.109,.017,forward,12);
  B('lining',[-.458,.609,.312],.835,.438,.020,.064,.007);
  B('lining',[-.454,.591,.318],.786,.397,.014,.038,.005);
  perforations(m);
  B('bronze',[-.441,.858,.324],.730,.103,.022,.026,.007);
  B('glass',[-.441,.860,.337],.693,.077,.011,.017,.004);
  for(let j=0;j<47;j++){
    const x=-.757+j*.01366,len=j%5===0?.015:.008;
    ruled(m,j%5===0?'signal':'warm',[x,.835],[x,.835+len],j%5===0?.0019:.00115,.344);
  }
  for(let j=0;j<3;j++){
    const l=-.729+j*.202;
    lettering(m,'signal',['74','88','102'][j],l,.886,.344,.015,.008,.00125);
  }
  ruled(m,'ember',[-.370,.833],[-.370,.888],.004,.344);
  B('shoulder',[-.431,.294,.315],.768,.100,.018,.036,.007);
  B('graphite',[-.432,.293,.328],.737,.065,.016,.027,.006);
  for(let j=0;j<5;j++){
    const x=-.718+j*.142;
    B(j===1?'oxide':'ink',[x,.295,.339],.111,.043,.025,.015,.007);
    B('warm',[x,.292,.354],j===1?.022:.014,.0038,.0009,.0015,.0003,forward,2);
  }
  dial(m);
  lettering(m,'warm','RELAY',.339,.365,.319,.048,.027,.0051);
  lettering(m,'stitch','B 07',.407,.286,.319,.031,.018,.0033);
  for(const x of [-.927,.923])for(const y of [.220,.890]){
    disc(m,'bronze',[x,y,.324],.020,.012,forward,18);
    ruled(m,'ink',[x-.009,y-.006],[x+.009,y+.006],.0039,.331);
  }
  for(const x of [-.734,.734])for(const z of [-.160,.155]){
    B('ink',[x,.092,z],.261,.237,.077,.047,.012,up);
    B('rubber',[x,.037,z],.218,.198,.073,.034,.010,up);
    for(let j=0;j<4;j++)B('graphite',[x,.013,z+(j-1.5)*.037],.162,.013,.009,.004,.0016,up,3);
  }
  for(const x of [-.65,.65]){
    B('shoulder',[x,1.068,-.046],.254,.241,.064,.062,.018,up);
    B('bronze',[x,1.098,-.047],.201,.202,.051,.056,.016,up);
    B('ink',[x,1.119,-.047],.169,.178,.034,.040,.011,up);
    for(const z of [-.11,.015])disc(m,'alloy',[x,1.139,z],.015,.012,up,14);
  }
  liftingStrap(m);
  addAntenna(m);
  sidePanels(m);
  return m.materialize();
}
function addAntenna(m){
  const p=[-.893,1.056,-.111],v=norm([-.363,.837,-.119]),b=norm(cross([0,0,1],v)),c=cross(v,b);
  const orient=(x,y,z)=>v.map((k,i)=>b[i]*x+c[i]*y+k*z);
  disc(m,'bronze',p,.060,.052,up,30);
  disc(m,'ink',p.map((k,i)=>k+v[i]*.050),.041,.112,orient,28);
  const rods=[[.083,.279,.025],[.271,.427,.019],[.419,.574,.0135]];
  for(const [start,end,r] of rods){
    const centre=p.map((k,i)=>k+v[i]*(start+end)*.5);
    disc(m,'alloy',centre,r,end-start,orient,26);
    disc(m,'bronze',p.map((k,i)=>k+v[i]*(end-.012)),r*1.08,.011,orient,26);
  }
  disc(m,'ink',p.map((k,i)=>k+v[i]*.581),.020,.035,orient,24);
}
function sidePanels(m){
  const B=(s,p,w,h,d,r,b)=>beveled(m,s,p,w,h,d,r,b,side,6);
  B('shoulder',[1.079,.563,-.035],.260,.774,.044,.078,.013);
  B('ink',[1.101,.572,-.035],.216,.657,.025,.064,.009);
  for(let i=0;i<9;i++){
    const y=.438+i*.047;
    B('lining',[1.116,y,-.035],.154,.020,.013,.008,.004);
    B('graphite',[1.125,y-.006,-.036],.131,.004,.006,.0015,.001);
  }
  for(const y of [.298,.830])disc(m,'bronze',[1.119,y,-.036],.024,.016,side,18);
  beveled(m,'shoulder',[0,.583,-.319],1.284,.486,.065,.097,.017,forward,8);
  for(let j=0;j<6;j++)beveled(m,'lining',[-.444+j*.176,.575,-.355],.106,.300,.015,.038,.004,forward,5);
}

export function cameraFor(w,h,angle=19){
  const aspect=w/Math.max(1,h),a=angle*Math.PI/180;
  const lens=aspect<1.12?30:25.8;
  const d=aspect<1.12?Math.max(4.55,4.69/aspect):4.46;
  return {position:[Math.sin(a)*d,1.91,Math.cos(a)*d],
    target:[aspect<1.12?.095:.008,.732,0],fov:lens,near:.05,far:42};
}
export const key=[-2.55,4.55,2.85];
