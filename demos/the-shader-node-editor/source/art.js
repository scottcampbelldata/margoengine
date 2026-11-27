import {Geometry,PbrMaterial} from '@margoengine/core';

const TAU=Math.PI*2;
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mul=(a,n)=>a.map(v=>v*n);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>mul(a,1/(Math.hypot(...a)||1));

function museumMesh(){
  const p=[],n=[],i=[];
  const tri=(a,b,c)=>{
    const f=norm(cross(sub(b,a),sub(c,a))),j=p.length/3;
    p.push(...a,...b,...c);n.push(...f,...f,...f);i.push(j,j+1,j+2);
  };
  return {tri,quad(a,b,c,d){tri(a,b,c);tri(a,c,d);},build:()=>new Geometry(p,n,i)};
}
function box(m,c,w,h,d,r=.014){
  const [x,y,z]=c,a=w/2,b=h/2,k=d/2,v=Math.min(r,a*.40,b*.40,k*.40);
  const ring=(Y,A,K,q)=>[[x-A+q,Y,z+K],[x+A-q,Y,z+K],[x+A,Y,z+K-q],[x+A,Y,z-K+q],
    [x+A-q,Y,z-K],[x-A+q,Y,z-K],[x-A,Y,z-K+q],[x-A,Y,z+K-q]];
  const rs=[ring(y-b,a-v,k-v,v*.27),ring(y-b+v,a,k,v),ring(y+b-v,a,k,v),ring(y+b,a-v,k-v,v*.27)];
  for(let j=0;j<3;j++)for(let s=0;s<8;s++){
    const t=(s+1)%8;
    m.quad(rs[j][s],rs[j][t],rs[j+1][t],rs[j+1][s]);
  }
  for(let s=1;s<7;s++){
    m.tri(rs[0][0],rs[0][s+1],rs[0][s]);
    m.tri(rs[3][0],rs[3][s],rs[3][s+1]);
  }
}
function round(g,x,y,z,R,H,sides=48){
  const rings=[[-H/2,R*.94],[-H*.35,R],[H*.34,R],[H*.5,R*.94]];
  const p=(j,[h,r])=>[x+r*Math.cos(j*TAU/sides),y+h,z+r*Math.sin(j*TAU/sides)];
  for(let row=0;row<3;row++)for(let j=0;j<sides;j++){
    g.quad(p(j,rings[row]),p(j,rings[row+1]),p(j+1,rings[row+1]),p(j+1,rings[row]));
  }
  for(let i=1;i<sides-1;i++){
    g.tri(p(0,rings[0]),p(i,rings[0]),p(i+1,rings[0]));
    g.tri(p(0,rings[3]),p(i+1,rings[3]),p(i,rings[3]));
  }
}

const colors={
  scene:['#504c42',.91],wall:['#434138',.86],left:['#615243',.91],panel:['#685942',.85],
  dark:['#353c3c',.73],plinth:['#5b5b53',.83],pale:['#978a72',.66],bronze:['#89654c',.52],
  brass:['#ad9670',.52],glow:['#dbc6a0',.70],shadow:['#4b4540',.93],warm:['#755e49',.88],
};
export function scenery(){
  const sets=new Map(),get=name=>{
    if(!sets.has(name))sets.set(name,museumMesh());
    return sets.get(name);
  };
  const B=(name,x,y,z,w,h,d,r)=>box(get(name),[x,y,z],w,h,d,r);
  B('scene',0,-.06,-.20,6.7,.135,4.6,.025);
  B('wall',0,1.16,-1.39,6.10,2.40,.19,.027);
  B('left',0,1.17,-1.278,3.72,2.36,.035,.010);
  B('panel',0,1.218,-1.247,3.38,2.28,.045,.015);
  for(let i=0;i<59;i++){
    const x=(i-29)*.055;
    B(i%11===0?'pale':'warm',x,1.221,-1.214,.029,2.12,.023,.004);
  }
  B('dark',0,.08,-1.16,4.30,.166,.216,.025);
  B('bronze',0,.176,-1.101,3.84,.028,.045,.007);
  B('plinth',0,.067,.05,1.98,.122,1.42,.053);
  B('dark',0,.144,.058,1.91,.043,1.38,.025);
  B('bronze',0,.123,.750,1.86,.020,.027,.006);
  B('brass',-.56,.093,.771,.278,.035,.014,.003);
  for(let k=0;k<9;k++){
    const x=-.65+k*.023;
    B(k%4===0?'glow':'bronze',x,.094,.780,.013,.004,.003,.0004);
  }
  round(get('shadow'),-.32,.173,.015,.496,.028);
  round(get('pale'),-.32,.195,.015,.441,.037);
  round(get('dark'),-.32,.226,.015,.395,.025);
  round(get('bronze'),-.32,.236,.015,.319,.014);
  B('plinth',.43,.179,.135,.462,.043,.72,.017);
  B('pale',.44,.206,.130,.42,.017,.66,.006);
  B('dark',.44,.223,.125,.365,.025,.586,.009);
  for(const x of [.274,.604])for(const z of [-.130,.382])round(get('bronze'),x,.235,z,.009,.006,12);
  for(const x of [-1.54,1.54]){
    B('bronze',x,1.31,-1.182,.044,2.08,.055,.010);
    B('glow',x,1.24,-1.142,.013,1.93,.025,.005);
  }
  return [...sets].map(([key,m])=>{
    const [color,roughness]=colors[key];
    return {name:key,geometry:m.build(),material:new PbrMaterial({color,roughness,doubleSided:false})};
  });
}

function curve(profile,k,segments){
  const n=profile.length-1,s=Math.min(n-1,Math.floor(k/segments)),t=Math.min(1,k/segments-s);
  const a=profile[Math.max(0,s-1)],b=profile[s],c=profile[s+1],d=profile[Math.min(n,s+2)];
  return b.map((x,i)=>{
    const p=a[i],y=c[i],z=d[i];
    return .5*(2*x+(-p+y)*t+(2*p-5*x+4*y-z)*t*t+(-p+3*x-3*y+z)*t*t*t);
  });
}
export function vesselGeometry(){
  const profile=[
    [.001,.018],[.139,.017],[.199,.022],[.215,.049],[.248,.111],[.304,.216],
    [.336,.321],[.337,.423],[.320,.525],[.290,.615],[.269,.688],[.273,.751],
    [.299,.797],[.328,.824],[.331,.842],[.311,.851],[.283,.838],[.262,.802],
    [.247,.719],[.256,.615],[.288,.524],[.310,.418],[.305,.321],[.276,.216],
    [.219,.129],[.172,.101],[.079,.086],[.002,.087],
  ];
  const sides=98,subdivisions=3,rows=(profile.length-1)*subdivisions+1;
  const point=(r,j)=>{
    const [radius,y]=curve(profile,r,subdivisions);
    const a=j/sides*TAU,clamped=Math.min(1,Math.max(0,y/.842));
    const shoulder=Math.sin(Math.PI*clamped)**.76;
    const profileSweep=a-.18-.64*clamped;
    const width=radius*(1+.061*Math.cos(2*profileSweep)+.084*Math.cos(3*profileSweep)*shoulder+
      .037*Math.cos(15*a-2.35*clamped)*shoulder);
    const lipWiggle=(.043*Math.sin(a*3+.33)+.021*Math.cos(a*2-1.18))*Math.max(0,(clamped-.68)/.32)**1.6;
    return [width*Math.cos(a)+.022*Math.sin(y*3.1),y+lipWiggle,width*Math.sin(a)*.884];
  };
  const cache=Array.from({length:rows},(_,r)=>Array.from({length:sides+1},(_,j)=>point(r,j)));
  const positions=[],normals=[],uvs=[],indices=[];
  for(let r=0;r<rows;r++)for(let j=0;j<=sides;j++){
    const a=cache[r][j],near=cache[r][(j+sides-1)%sides],far=cache[r][(j+1)%sides];
    const backward=cache[Math.max(0,r-1)][j],forward=cache[Math.min(rows-1,r+1)][j];
    positions.push(...a);normals.push(...norm(cross(sub(forward,backward),sub(far,near))));uvs.push(j/sides,r/(rows-1));
    if(r+1<rows&&j<sides){
      const i=r*(sides+1)+j,b=i+sides+1;
      indices.push(i,b,i+1,i+1,b,b+1);
    }
  }
  return {positions,normals,uvs,indices};
}
export function glazeSample(){
  const positions=[],normals=[],uvs=[],indices=[];
  const rows=36,columns=30,stride=columns+1,total=(rows+1)*stride;
  const point=(x,z)=>[x,.025+.143*(1-(x/.168)**2)+.035*Math.cos(z*3.4)+z*.196,z];
  for(const lower of [false,true])for(let row=0;row<=rows;row++)for(let col=0;col<=columns;col++){
    const u=col/columns,v=row/rows,x=(u-.5)*.314,z=(v-.5)*.494;
    const p=point(x,z),a=sub(point(x+.001,z),point(x-.001,z)),b=sub(point(x,z+.001),point(x,z-.001));
    positions.push(p[0],p[1]-(lower?.020:0),p[2]);
    normals.push(...mul(norm(cross(b,a)),lower?-1:1));uvs.push(u,v);
    if(row<rows&&col<columns){
      const i=(lower?total:0)+row*stride+col,d=i+stride;
      if(lower)indices.push(i,i+1,d,i+1,d+1,d);
      else indices.push(i,d,i+1,i+1,d,d+1);
    }
  }
  function edge(a,b){
    const quad=[a,b,b+total,a+total].map(k=>positions.slice(k*3,k*3+3));
    const N=norm(cross(sub(quad[1],quad[0]),sub(quad[2],quad[0]))),start=positions.length/3;
    for(let i=0;i<4;i++){
      positions.push(...quad[i]);normals.push(...N);uvs.push(i%2,i>1?1:0);
    }
    indices.push(start,start+1,start+2,start,start+2,start+3);
  }
  for(let col=0;col<columns;col++){
    edge(col+1,col);
    edge(total-stride+col,total-stride+col+1);
  }
  for(let row=0;row<rows;row++){
    edge(row*stride,(row+1)*stride);
    edge((row+1)*stride+columns,row*stride+columns);
  }
  return {positions,normals,uvs,indices};
}

export function cameraFor(w,h,yaw=0){
  const portrait=w/h<1.06,a=.22+yaw,range=portrait?2.24:2.48;
  return {position:[Math.sin(a)*range,1.22,Math.cos(a)*range],target:[-.065,.581,.022],
    fov:portrait?43.0:34,near:.074,far:18};
}
