import {Geometry,PbrMaterial} from '@margoengine/core';
import {createMesh,UnlitMaterial} from '@margoengine/materials';

const rng=(seed)=>{
  const n=Math.sin(seed*127.891+84.179)*32419.38;
  return n-Math.floor(n);
};
export const river=x=>-4+6.8*Math.sin(x*.047)+2.25*Math.sin(x*.112+1.1);
const riverWidth=x=>8.35+3*Math.sin(x*.032+.2)+1.28*Math.sin(x*.085);
const shoreline=(x,z)=>Math.abs(z-river(x))-riverWidth(x);
export function elevation(x,z){
  const d=shoreline(x,z);
  const ground=.31*Math.sin(x*.114+z*.084)+.22*Math.cos(x*.29-z*.109)
    +.25*Math.sin(z*.48+x*.058)+.17*Math.cos(x*.65+z*.31);
  const bank=Math.max(0,Math.min(1,d/7));
  return -.23+bank*(.92+ground)+Math.max(0,Math.abs(z)-45)*.028;
}
function normal(a,b,c){
  const dx=b[0]-a[0],dy=b[1]-a[1],dz=b[2]-a[2];
  const ex=c[0]-a[0],ey=c[1]-a[1],ez=c[2]-a[2];
  const n=[dy*ez-dz*ey,dz*ex-dx*ez,dx*ey-dy*ex];
  const l=Math.hypot(...n)||1;
  return n.map(v=>v/l);
}
function batches(engine){
  const groups=new Map();
  function group(color, roughness){
    const key=color+' '+roughness;
    if(!groups.has(key))groups.set(key,{color,roughness,p:[],n:[],i:[]});
    return groups.get(key);
  }
  function triangle(a,b,c,color,roughness=.96){
    const batch=group(color,roughness), i=batch.p.length/3;
    const n=normal(a,b,c);
    batch.p.push(...a,...b,...c);batch.n.push(...n,...n,...n);batch.i.push(i,i+1,i+2);
  }
  function quad(a,b,c,d,color,roughness=.96){
    triangle(a,b,c,color,roughness);triangle(a,c,d,color,roughness);
  }
  function finish(){
    for(const {color,roughness,p,n,i} of groups.values()){
      engine.createMesh().setGeometry(new Geometry(p,n,i)).setMaterial(new PbrMaterial({color,roughness}));
    }
  }
  return {triangle,quad,finish};
}
function coloredSurface(engine,vertices,indices){
  const points=[], normals=[], colors=[];
  for(const {p,n,c} of vertices){points.push(...p);normals.push(...n);colors.push(...c);}
  const material=new UnlitMaterial({color:'#ffffff'});
  createMesh(engine,{positions:new Float32Array(points),normals:new Float32Array(normals),colors:new Float32Array(colors),
    indices:new Uint32Array(indices)},material);
}
const blend=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
const bound=(v,a,b)=>Math.min(b,Math.max(a,v));
function linear(hex){
  return [1,3,5].map(i=>{
    const v=parseInt(hex.slice(i,i+2),16)/255;
    return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
  });
}
const tundra=['#735c49','#a67a4e','#a69962','#7e885b','#ad9876'].map(linear);
const gravel=['#877d6d','#ada28c'].map(linear);
const riverPaint=['#537f82','#709d9a','#82a5a1','#466d72'].map(linear);
function smoothGround(engine){
  const rows=118,cols=140,step=2.10,vertices=[],indices=[];
  const heights=new Float32Array((rows+1)*(cols+1));
  for(let j=0;j<=rows;j++)for(let i=0;i<=cols;i++){
    heights[j*(cols+1)+i]=elevation((i-cols/2)*step,(j-rows/2)*step);
  }
  const vertexHeight=(i,j)=>heights[bound(j,0,rows)*(cols+1)+bound(i,0,cols)];
  for(let j=0;j<=rows;j++){
    for(let i=0;i<=cols;i++){
      const x=(i-cols/2)*step,z=(j-rows/2)*step,y=vertexHeight(i,j);
      const direction=[vertexHeight(i-1,j)-vertexHeight(i+1,j),step*2,vertexHeight(i,j-1)-vertexHeight(i,j+1)];
      const length=Math.hypot(...direction);
      const n=direction.map(v=>v/length);
      const broad=.5+.22*Math.sin(x*.096+z*.106)+.15*Math.sin(x*.153-z*.127)+.09*Math.cos(x*.353+z*.46);
      const index=(bound(broad,0.001,.998))*4;
      const basis=blend(tundra[Math.floor(index)],tundra[Math.floor(index)+1], index%1);
      const dust=.48+.24*Math.sin(x*1.11+z*.47)+.19*Math.cos(x*.73-z*.81);
      const sediment=blend(gravel[0],gravel[1],dust);
      const sunlight=bound(-.42*n[0]+.78*n[1]+.33*n[2],.0,1);
      const tone=.46+sunlight*.68, value=tone*(.89+.18*rng(i*412+j));
      const c=blend(sediment,basis,bound((shoreline(x,z)-.72)/4.65,0,1)).map(v=>v*value);
      vertices.push({p:[x,y,z],n,c});
      if(i>=cols||j>=rows)continue;
      const at=j*(cols+1)+i,b=at+cols+1;
      indices.push(at,b,b+1,at,b+1,at+1);
    }
  }
  coloredSurface(engine,vertices,indices);
  const points=[], faces=[], length=160,bands=12;
  for(let i=0;i<=length;i++){
    const x=-143+i*1.79;
    for(let j=0;j<=bands;j++){
      const ratio=j/bands, z=river(x)+riverWidth(x)*(ratio*2-1);
      const t=bound(.5+.28*Math.sin(i*.21+j*.75)+.15*Math.sin(i*.64-j*.32),0.02,.98);
      const base=blend(riverPaint[0],riverPaint[1],t);
      const c=blend(base,j%2?riverPaint[2]:riverPaint[3],.22);
      points.push({p:[x,-.107,z],n:[0,1,0],c});
      if(i>=length||j>=bands)continue;
      const at=i*(bands+1)+j,b=at+bands+1;
      faces.push(at,at+1,b+1,at,b+1,b);
    }
  }
  coloredSurface(engine,points,faces);
}
function land(mesh){
  for(let i=0;i<1700;i++){
    const x=(rng(i*7+131)-.5)*280,z=river(x)+(rng(i*7+6125)-.5)*riverWidth(x)*1.9;
    const length=.14+rng(i*7+412)*1.59,dz=.026+rng(i*7+912)*.095,y=-.096+rng(i*7+313)*.005;
    mesh.quad([x-length,y,z],[x,y,z+dz],[x+length*.9,y,z+.03],[x,y,z-dz],
      i%3===0?'#a5b7ab':i%3===1?'#83a7a0':'#7b9c9d',.46);
  }
}
function mountains(engine){
  const layers=[
    {z:-320,base:10,amplitude:69,seed:231,shade:['#8b9b9d','#a3aeb0','#bdc8c6','#e2dbca']},
    {z:-269,base:6,amplitude:61,seed:34,shade:['#74898e','#8c9c9e','#aeb9b7','#ddd7c6']},
    {z:-214,base:3,amplitude:45,seed:712,shade:['#5d7479','#7b8c88','#97a19a','#c2c2ab']},
    {z:-161,base:1,amplitude:27,seed:123,shade:['#4a655d','#5d776a','#809185','#a6ab90']},
  ];
  for(const {z,base,amplitude,seed,shade} of layers){
    const colors=shade.map(linear), vertices=[], indices=[], columns=239, rows=10;
    for(let i=0;i<=columns;i++){
      const x=-536+i*4.48;
      const broad=.29+.56*Math.abs(Math.sin(x*.0101+seed))**6+.17*Math.sin(x*.021+seed*.93)
        +.11*Math.abs(Math.sin(x*.105+seed*.33))+.047*Math.sin(x*.233+seed*.4);
      const ridge=base+amplitude*bound(broad,.1,1.21);
      for(let j=0;j<=rows;j++){
        const t=j/rows, warp=(1-t)*Math.sin(i*.17+j*.25+seed);
        const p=[x+9*warp,-31+(ridge+31)*t,z+(1-t)*31+3*Math.cos(i*.11+j*.28)];
        const indirect=.46+.23*Math.sin(x*.029+seed+j*.31)+.19*Math.cos(x*.086+j*.24+seed);
        const frost=1-bound((ridge-6-p[1])/Math.max(2.8,.17*ridge),0,1);
        const snow=bound((ridge/amplitude-.67)*2.35,0,.91)*frost;
        const layer=blend(colors[0],colors[1],bound(indirect*.76+t*.22,0,1));
        const airy=blend(layer,colors[2],bound((t-.25)*.61+.16*indirect,0,1));
        const c=blend(airy,colors[3],snow);
        vertices.push({p,n:[0,0,1],c});
        if(i>=columns||j>=rows)continue;
        const a=i*(rows+1)+j,b=a+rows+1;
        indices.push(a,b,b+1,a,b+1,a+1);
      }
    }
    coloredSurface(engine,vertices,indices);
  }
}
function shrubs(mesh){
  for(let i=0;i<2240;i++){
    const x=(rng(117+i*13)-.5)*208,z=(rng(96+i*23)-.5)*125;
    const local=shoreline(x,z);
    if(local<1.5)continue;
    const y=elevation(x,z)+.05,scale=.18+rng(11+i*17)*.56;
    const warm=Math.sin(x*.116+z*.243)+Math.cos(x*.208-z*.148);
    const tone=warm>.48?'#c79661':warm<-.53?'#788575':'#a07e53';
    const color2=warm>.48?'#8b6042':warm<-.53?'#54634e':'#776143';
    for(let j=0;j<4;j++){
      const a=rng(i*19+j*13)*Math.PI*2, dx=Math.cos(a)*scale,dz=Math.sin(a)*scale;
      const sway=.35+rng(i*29+j*31)*.48;
      mesh.triangle([x-dz*.15,y,z+dx*.15],[x+dz*.15,y,z-dx*.15],[x+dx*sway,y+scale*sway,z+dz*sway],j%2?tone:color2);
    }
  }
  for(let i=0;i<493;i++){
    const x=(rng(i*8+873)-.5)*197,z=(rng(i*8+32)-.5)*104,y=elevation(x,z);
    const w=.085+rng(i*8+57)**2*.63;
    if(shoreline(x,z)<-.7)continue;
    const a=[x-w,y,z+w*.67],b=[x+w*.87,y+.012,z+w*.78],c=[x+w,y,z-w*.53],d=[x-w*.72,y,z-w*.57];
    const e=[x+w*.1,y+w*.57,z-w*.1];
    mesh.triangle(a,e,b,'#797971');mesh.triangle(b,e,c,'#8a8174');mesh.triangle(c,e,d,'#b09b85');mesh.triangle(d,e,a,'#6e7068');
  }
}
function sky(mesh){
  const stops=[[193,179,149],[172,183,172],[116,151,162],[70,112,135]];
  for(let i=0;i<24;i++){
    const t=i/23,p=t*3,j=Math.min(2,Math.floor(p));
    const color='#'+stops[j].map((c,k)=>Math.round(c+(stops[j+1][k]-c)*(p-j)).toString(16).padStart(2,'0')).join('');
    const y=-31+i*10.15;
    mesh.quad([-594,y,-401],[594,y,-401],[594,y+10.2,-401],[-594,y+10.2,-401],color);
  }
  function cloud(x,y,w,h,seed){
    const colors=['#b2b5ad','#b9bbb0','#b4b8b1','#abb4ad','#a4b0ab'];
    for(let i=0;i<10;i++){
      const a=x+i*w/10,b=x+(i+1)*w/10,t=(i+.5)/10, thick=Math.sin(t*Math.PI)**.8*h;
      const p=y+Math.sin(t*9+seed)*h*.19, r=p+thick*(.5+rng(seed+i)*.4);
      const s=p-thick*(.24+rng(seed+i*3)*.22);
      mesh.quad([a,s,-374],[b,s-.5,-374],[b,r+.25,-374],[a,r,-374],colors[i%colors.length]);
    }
  }
  cloud(-151,79,171,4.5,92);cloud(57,102,145,2.6,81);cloud(-227,115,102,3.8,115);cloud(145,72,131,5.5,18);
}
export function makeLandscape(engine){
  const mesh=batches(engine);
  sky(mesh);
  mountains(engine);
  smoothGround(engine);
  land(mesh);
  shrubs(mesh);
  mesh.finish();
}
