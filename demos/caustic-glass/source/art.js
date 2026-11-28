import {Geometry,PbrMaterial} from '@margoengine/core';
import {table,source,opticalSolid} from './optics.js';

const tau=Math.PI*2;
const minus=(a,b)=>a.map((x,i)=>x-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const unit=a=>{const m=Math.hypot(...a);return a.map(x=>x/m);};
function normal(a,b,c){return unit(cross(minus(b,a),minus(c,a)));}

function mesh(){
  const positions=[],normals=[],indices=[];
  return {
    tri(a,b,c,N=normal(a,b,c)){
      const start=positions.length/3;
      positions.push(...a,...b,...c);
      normals.push(...N,...N,...N);
      indices.push(start,start+1,start+2);
    },
    quad(a,b,c,d){this.tri(a,b,c);this.tri(a,c,d);},
    core(){return new Geometry(positions,normals,indices);},
    surface(){return {positions,normals,indices};}
  };
}
function block(g,x,y,z,w,h,d,bevel){
  const a=w/2,b=d/2,c=h/2,r=Math.min(bevel,a*.35,b*.35,c*.55);
  const ring=(Y,A,B,q)=>[
    [x-A+q,Y,z+B],[x+A-q,Y,z+B],[x+A,Y,z+B-q],[x+A,Y,z-B+q],
    [x+A-q,Y,z-B],[x-A+q,Y,z-B],[x-A,Y,z-B+q],[x-A,Y,z+B-q],
  ];
  const rows=[ring(y-c,a-r,b-r,.4*r),ring(y-c+r,a,b,r),ring(y+c-r,a,b,r),ring(y+c,a-r,b-r,.4*r)];
  for(let j=0;j<3;j++)for(let i=0;i<8;i++){
    const k=(i+1)%8;
    g.quad(rows[j][i],rows[j][k],rows[j+1][k],rows[j+1][i]);
  }
  for(let i=1;i<7;i++){
    g.tri(rows[0][0],rows[0][i+1],rows[0][i]);g.tri(rows[3][0],rows[3][i],rows[3][i+1]);
  }
}
function round(g,x,y,z,r,h,divisions=40){
  const bands=[[-h/2,r*.92],[-h/2+.12*h,r],[h/2-.12*h,r],[h/2,r*.92]];
  const p=(i,[dy,R])=>[x+R*Math.cos(tau*i/divisions),y+dy,z+R*Math.sin(tau*i/divisions)];
  for(let j=0;j<3;j++)for(let i=0;i<divisions;i++)g.quad(p(i,bands[j]),p(i,bands[j+1]),p(i+1,bands[j+1]),p(i+1,bands[j]));
  for(let i=1;i<divisions-1;i++){
    g.tri(p(0,bands[0]),p(i,bands[0]),p(i+1,bands[0]));
    g.tri(p(0,bands[3]),p(i+1,bands[3]),p(i,bands[3]));
  }
}
function arc(g,x,z,r,w,begin,end,y,steps=32){
  const p=(a,d)=>[x+(r+d)*Math.cos(a),y,z+(r+d)*Math.sin(a)];
  for(let k=0;k<steps;k++){
    const a=begin+(end-begin)*k/steps,b=begin+(end-begin)*(k+1)/steps;
    g.quad(p(a,-w),p(b,-w),p(b,w),p(a,w));
  }
}
const swatches={
  backdrop:['#3b4c52',.87,0], rib:['#4b5660',.61,0], enamel:['#485360',.51,0], navy:['#293641',.64,0],
  silver:['#bac2c6',.38,1], anodized:['#61808e',.37,0], umber:['#835f48',.55,0], ivory:['#d1c5a4',.52,0],
  marks:['#69767b',.89,0], brightMark:['#9aadb1',.83,0], rubber:['#262e36',.78,0],
};
export function fabrication(){
  const groups=new Map();
  const forMat=key=>{
    if(!groups.has(key))groups.set(key,mesh());
    return groups.get(key);
  };
  const B=(mat,x,y,z,w,h,d,r=.012)=>block(forMat(mat),x,y,z,w,h,d,r);
  const C=(mat,x,y,z,r,h,n)=>round(forMat(mat),x,y,z,r,h,n);

  B('backdrop',0,1.07,-.981,4.63,2.43,.11,.011);
  B('navy',0,1.026,-.906,3.03,1.96,.05,.025);
  B('rib',0,1.047,-.876,2.83,1.80,.047,.009);
  for(let i=-25;i<=25;i++){
    const x=i*.058;
    B(i%6===0?'anodized':'backdrop',x,1.049,-.842,.041,1.73,.045,.005);
  }
  for(const x of [-1.49,1.49]){
    B('enamel',x,1.034,-.824,.096,1.96,.14,.015);
    B('anodized',x,1.033,-.748,.018,1.86,.020,.004);
  }
  B('navy',0,1.99,-.815,3.09,.096,.15,.013);
  B('rib',0,.107,-.84,3.01,.149,.086,.013);
  B('navy',0,-.158,-.023,2.16,.298,1.76,.053);
  B('enamel',0,-.075,-.012,1.83,.118,1.598,.037);
  B('rubber',0,-.025,-.031,1.565,.044,1.482,.009);
  B('anodized',0,-.079,.805,1.797,.032,.037,.009);
  B('umber',0,-.166,.848,1.99,.078,.081,.024);
  B('navy',0,-.229,.879,2.05,.058,.092,.013);
  for(const x of [-.61,.54])B('anodized',x,-.166,.893,.245,.015,.018,.004);
  for(const x of [-.767,.702])for(const z of [-.729,.667])C('silver',x,-.002,z,.009,.004,16);

  // Three optical locating pads hold the lower chamfer from outside the aperture.
  for(const [x,y,z] of [[-.431,.344,-.077],[-.328,.285,-.447],[-.021,.158,-.307]]){
    C('navy',x,.017,z,.036,.039,30);
    C('anodized',x,y*.49,z,.014,y*.91,24);
    C('silver',x,y-.012,z,.024,.022,24);
    C('rubber',x,y+.001,z,.019,.006,24);
  }
  B('navy',-.605,.023,-.561,.187,.054,.218,.022);
  C('anodized',-.604,.545,-.568,.033,1.035,40);
  C('silver',-.604,.108,-.568,.055,.107,40);
  C('navy',-.604,1.015,-.568,.053,.114,40);
  C('umber',-.604,.987,-.568,.060,.022,40);
  C('silver',-.604,1.045,-.568,.060,.020,40);
  B('enamel',-.406,1.107,-.552,.531,.08,.089,.014);
  B('silver',-.394,1.137,-.551,.493,.007,.061,.002);
  B('enamel',-.232,1.113,-.429,.110,.077,.318,.012);
  B('navy',-.232,1.121,-.232,.225,.090,.367,.018);
  B('anodized',-.232,1.078,-.232,.196,.026,.350,.008);
  B('navy',-.232,1.065,-.232,.174,.012,.326,.004);
  B('ivory',-.232,1.074,-.045,.108,.008,.007,.0012);
  for(let i=0;i<12;i++){
    B('enamel',-.232,1.144,-.385+.027*i,.233,.036,.013,.003);
  }

  for(const Z of [.556,.601]){
    const long=Z>.58;
    for(let i=0;i<=63;i++){
      if(!long&&i%5!==0)continue;
      const x=-.731+i*.0228,L=long?(i%5===0?.028:.015):.008;
      B(i%5===0?'brightMark':'marks',x,.0012,Z,.0025,.0015,L,.0002);
    }
  }
  for(let i=0;i<=49;i++){
    const z=-.622+i*.02345;
    B(i%5===0?'brightMark':'marks',.586,.0015,z,(i%5===0?.026:.012),.0016,.0025,.0002);
  }
  for(const r of [.194,.295,.417]){
    arc(forMat('marks'),-.122,-.25,r,.0013,.056,1.43,.002);
    arc(forMat('marks'),-.122,-.25,r,.0013,1.7,2.19,.002,18);
  }
  for(const [x,z] of [[.01,.155],[.301,-.15],[.502,.461],[-.607,.476]]){
    B('brightMark',x,.001,z,.049,.0014,.0021,.0002);
    B('marks',x,.0011,z,.0021,.0014,.035,.0002);
  }
  for(const x of [-1.07,.98])for(let i=0;i<3;i++)B('anodized',x,.174+i*.029,-.829,.124,.010,.012,.003);

  return [...groups].map(([key,geometry])=>{
    const [color,roughness,metalness]=swatches[key];
    return {key,geometry:geometry.core(),material:new PbrMaterial({color,roughness,metalness,doubleSided:false})};
  });
}

export function lensGeometry(){
  const {vertices,indices}=opticalSolid(),shell=mesh();
  for(let i=0;i<indices.length;i+=3)shell.tri(vertices[indices[i]],vertices[indices[i+1]],vertices[indices[i+2]]);
  return shell.surface();
}

export function chartGeometry(){
  const {minX,maxX,minZ,maxZ,y}=table;
  return {positions:[minX,y,minZ, minX,y,maxZ, maxX,y,maxZ, maxX,y,minZ],
    normals:[0,1,0,0,1,0,0,1,0,0,1,0],uvs:[0,0,0,1,1,1,1,0],indices:[0,1,2,0,2,3]};
}

export function lightGeometry(){
  const [x,y,z]=source.corner,w=source.edgeU[0],d=source.edgeV[2],t=y-.027;
  const diffuser=mesh(),panels=mesh();
  diffuser.quad([x,t,z],[x+w,t,z],[x+w,t,z+d],[x,t,z+d]);
  for(const side of [-1,1]){
    const X=side*1.49;
    panels.quad([X-.009,.25,-.741],[X+.009,.25,-.741],[X+.009,1.82,-.741],[X-.009,1.82,-.741]);
  }
  return {diffuser:diffuser.surface(),panels:panels.surface()};
}

export function cameraFor(width,height){
  const aspect=width/height;
  return {position:aspect<1.08?[1.17,1.44,1.67]:[1.68,1.66,2.18],target:[-.10,.443,-.083],
    fov:aspect<1.08?Math.min(51,41+.33*(1/aspect-1)*35):28,near:.06,far:15};
}
