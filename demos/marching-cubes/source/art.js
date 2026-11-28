import {Geometry,PbrMaterial,box} from '@margoengine/core';

const tau=Math.PI*2;
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const mul=(p,a)=>p.map(v=>v*a);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const norm=a=>mul(a,1/(Math.hypot(...a)||1));
const palette={
  floor:['#514546',.85,0],wall:['#3d333f',.90,0],tile:['#4a3c47',.88,0],slat:['#4f4148',.83,0],
  recess:['#302c38',.90,0],stone:['#4b4851',.77,0],edge:['#645763',.77,0],panel:['#3c3d44',.61,0],
  nickel:['#747b7b',.52,.65],patina:['#6d5140',.56,.58],metal:['#ab7652',.42,.67],bronze:['#b49364',.47,.72],
  stamp:['#eacda3',.68,0],ink:['#35323a',.71,0],copper:['#a05948',.55,.39],coral:['#de9066',.48,0],
  coil:['#b27352',.49,.32],light:['#edba79',.53,0],
};
function material(key){
  const [color,roughness,metalness]=palette[key];
  return new PbrMaterial({color,roughness,metalness});
}
function batch(){
  const meshes=new Map();
  function tri(key,a,b,c,na,nb=na,nc=na){
    const n=na??norm(cross(sub(b,a),sub(c,a)));
    if(Math.hypot(...n)<.01)return;
    let g=meshes.get(key);
    if(!g){g={p:[],n:[],i:[]};meshes.set(key,g);}
    const index=g.p.length/3;
    g.p.push(...a,...b,...c);
    g.n.push(...n,...(nb||n),...(nc||n));
    g.i.push(index,index+1,index+2);
  }
  return {tri,quad(key,a,b,c,d,na,nb=na,nc=na,nd=na){tri(key,a,b,c,na,nb,nc);tri(key,a,c,d,na,nc,nd);},
    build:()=>[...meshes].map(([name,{p,n,i}])=>({name,geometry:new Geometry(p,n,i),material:material(name)}))};
}
function lathe(m,key,x,z,profile,N=84){
  function point(j,k){const [r,y]=profile[j],u=k*tau/N;return [x+r*Math.cos(u),y,z+r*Math.sin(u)];}
  function normal(j,k){
    const [a,b]=profile[Math.max(0,j-1)],[c,d]=profile[Math.min(profile.length-1,j+1)],u=k*tau/N;
    return norm([(d-b)*Math.cos(u),a-c,(d-b)*Math.sin(u)]);
  }
  for(let j=0;j<profile.length-1;j++)for(let k=0;k<N;k++){
    const a=point(j,k),b=point(j+1,k),c=point(j+1,k+1),d=point(j,k+1);
    const color=typeof key==='function'?key(j,k):key;
    m.quad(color,a,b,c,d,normal(j,k),normal(j+1,k),normal(j+1,k+1),normal(j,k+1));
  }
}
function bevel(m,key,[x,y,z],w,h,d,r){
  const a=w/2,b=h/2,c=d/2,v=Math.min(r,a*.50,b*.47,c*.49);
  const ring=(y,a,c,r)=>[[x-a+r,y,z+c],[x+a-r,y,z+c],[x+a,y,z+c-r],[x+a,y,z-c+r],
    [x+a-r,y,z-c],[x-a+r,y,z-c],[x-a,y,z-c+r],[x-a,y,z+c-r]];
  const q=[ring(y-b,a-v,c-v,.3*v),ring(y-b+v,a,c,v),ring(y+b-v,a,c,v),ring(y+b,a-v,c-v,.3*v)];
  for(let k=0;k<3;k++)for(let j=0;j<8;j++){const i=(j+1)%8;m.quad(key,q[k][j],q[k][i],q[k+1][i],q[k+1][j]);}
  for(let j=1;j<7;j++){
    m.tri(key,q[0][0],q[0][j+1],q[0][j]);
    m.tri(key,q[3][0],q[3][j],q[3][j+1]);
  }
}
function tube(m,key,a,b,r,N=18){
  const dir=norm(sub(b,a)),x=norm(cross(dir,Math.abs(dir[1])>.9?[0,0,1]:[0,1,0])),z=cross(dir,x);
  const side=(p,k)=>{
    const t=k*tau/N;
    return p.map((v,i)=>v+r*(x[i]*Math.cos(t)+z[i]*Math.sin(t)));
  };
  for(let j=0;j<N;j++){
    const p=side(a,j),q=side(a,j+1),s=side(b,j+1),t=side(b,j);
    m.quad(key,p,q,s,t);m.tri(key,a,q,p);m.tri(key,b,t,s);
  }
}
const glyphs={
  L:['00 03 23'],U:['00 02 13 23 32 30'],M:['03 00 12 30 33'],E:['30 00 03 33','01 21'],
  N:['03 00 33 30'],0:['10 20 31 32 23 13 02 01 10'],3:['00 30 21 32 23 03'],
};
function label(m,word,x,y,z,h){
  for(const c of word){
    for(const row of glyphs[c]??[]){
      const p=row.split(' ').map(pair=>[x+h*.19*Number(pair[0]),y-h*.33*Number(pair[1]),z]);
      for(let i=0;i<p.length-1;i++){
        const a=p[i],b=p[i+1],d=norm(sub(b,a)),v=[-d[1]*h*.05,d[0]*h*.05,0];
        const s=(p,k)=>p.map((v0,i)=>v0+k*v[i]);
        m.quad('stamp',s(a,-1),s(b,-1),s(b,1),s(a,1),[0,0,1]);
      }
    }
    x+=h*.77;
  }
}
export function setting(){
  const m=batch(),parts=[];
  const B=(key,x,y,z,w,h,d,r)=>bevel(m,key,[x,y,z],w,h,d,r);
  parts.push({name:'ground',position:[0,-.077,.07],material:material('floor'),geometry:box(4.5,.15,4.6)});
  parts.push({name:'room',position:[0,.69,-.64],material:material('wall'),geometry:box(5.1,2.4,.15)});
  B('recess',0,.475,-.550,1.46,1.02,.033,.014);
  for(let i=0;i<24;i++){
    const y=.057+i*.035;
    B(i%5===2?'slat':'tile',0,y,-.527,1.44,.024,.024,.0027);
    if(i%5===0)B('recess',0,y-.010,-.511,1.40,.008,.008,.0011);
  }
  for(const x of [-.547,.547]){
    B('patina',x,.443,-.493,.029,.938,.029,.005);
    B('bronze',x+.004,.438,-.477,.003,.939,.009,.001);
  }
  B('stone',0,.026,.012,.753,.051,.541,.024);
  B('edge',0,.052,.015,.707,.015,.490,.006);
  B('panel',0,.060,.018,.681,.014,.457,.006);
  B('metal',0,.036,.284,.714,.006,.009,.0025);
  for(let i=0;i<30;i++){
    const x=(i-14.5)*.0171;
    B(i%5===2?'stamp':'nickel',x,.068,.205,.0024,.0026,i%5===2?.022:.009,.0006);
  }
  lathe(m,'ink',0,0,[[.001,.067],[.145,.067],[.150,.070],[.150,.082],[.146,.084],[.001,.084]],90);
  lathe(m,(row,k)=>{
    if([2,3,8,12,14].includes(row))return 'bronze';
    if([0,1,7,15].includes(row))return 'patina';
    return k%13===3?'copper':'metal';
  },0,0,[[.001,.083],[.133,.083],[.143,.090],[.146,.099],[.143,.105],[.137,.115],[.128,.130],[.119,.147],[.115,.160],
    [.112,.177],[.110,.189],[.113,.192],[.125,.198],[.126,.208],[.122,.218],[.114,.220],[.001,.219]],112);
  lathe(m,'light',0,0,[[.092,.214],[.104,.219],[.109,.221],[.111,.226],[.107,.234],[.102,.234]],120);
  lathe(m,'coral',0,0,[[.001,.212],[.081,.210],[.098,.214],[.105,.223],[.107,.226]],108);
  for(let i=0;i<58;i++){
    const a=tau*(i+.12)/58,x=.141*Math.cos(a),z=.141*Math.sin(a);
    tube(m,'patina',[x,.091,z],[x*.99,.107,z*.99],.00165,6);
  }
  for(const x of [-.100,.100]){
    const z=-.051;
    tube(m,'bronze',[x,.207,z],[x*.88,.622,z],.0078); 
    tube(m,'nickel',[x*1.027,.237,z+.007],[x*.907,.610,z+.007],.0014,8);
    for(const y of [.228,.594]){
      const b=x*(1-(y-.207)*.12/.415);
      lathe(m,'metal',b,z,[[.002,y-.010],[.010,y-.01],[.013,y-.005],[.013,y+.005],[.010,y+.008],[.002,y+.008]],26);
    }
  }
  lathe(m,(row)=>[1,2,6,7,10,11].includes(row)?'bronze':row===8?'copper':'patina',0,0,
    [[.001,.605],[.088,.605],[.101,.611],[.103,.623],[.099,.630],[.089,.639],[.081,.647],[.080,.660],
      [.085,.669],[.089,.675],[.089,.681],[.083,.687],[.079,.689],[.001,.689]],116);
  lathe(m,'nickel',0,0,[[.001,.688],[.048,.688],[.055,.691],[.055,.695],[.051,.700],[.001,.700]],92);
  const face=[0,.138,.123];
  B('ink',...face,.109,.045,.020,.004);
  B('bronze',0,.141,.133,.104,.033,.006,.002);
  B('panel',0,.141,.136,.100,.028,.004,.0015);
  label(m,'LUMEN 03',-.0406,.148,.139,.0097);
  for(const x of [-.048,.048])tube(m,'stamp',[x,.142,.136],[x,.142,.141],.0023,8);
  B('patina',.225,.072,.113,.132,.024,.064,.007);
  B('panel',.225,.086,.113,.121,.010,.051,.003);
  label(m,'03',.210,.090,.141,.0128);
  return [...parts,...m.build()];
}
export function glassGeometry(){
  const rows=[
    [.103,.218],[.107,.229],[.112,.246],[.118,.281],[.124,.323],[.126,.374],[.124,.426],
    [.121,.468],[.116,.506],[.109,.547],[.102,.576],[.094,.601],[.093,.613],
  ],N=112,positions=[],normals=[],indices=[];
  function put(rings,inner){
    const offset=positions.length/3;
    for(let i=0;i<rings.length;i++){
      const [r,y]=rings[i],[a,b]=rings[Math.max(0,i-1)],[c,d]=rings[Math.min(rings.length-1,i+1)];
      for(let j=0;j<=N;j++){
        const a0=j/N*tau,cos=Math.cos(a0),sin=Math.sin(a0);
        positions.push(r*cos,y,r*sin);
        const n=norm([(d-b)*cos,a-c,(d-b)*sin]);
        normals.push(...(inner?mul(n,-1):n));
      }
    }
    for(let i=0;i<rings.length-1;i++)for(let j=0;j<N;j++){
      const a=offset+i*(N+1)+j,b=a+N+1;
      if(inner)indices.push(a,b+1,b,a,a+1,b+1);
      else indices.push(a,b,b+1,a,b+1,a+1);
    }
  }
  put(rows,false);
  put(rows.map(([r,y])=>[r-.0037,y]),true);
  return new Geometry(positions,normals,indices);
}
export function cameraFor(w,h){
  const phone=w/h<1.16;
  return {position:[.206,.644,phone?1.513:1.410],target:[-.005,.365,0],fov:phone?31.8:31.0,near:.030,far:16};
}
