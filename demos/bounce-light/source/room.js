import {Geometry,PbrMaterial} from '@margoengine/core';

const TAU=Math.PI*2;
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const minus=(a,b)=>a.map((v,i)=>v-b[i]);
const normal=v=>{const d=Math.hypot(...v)||1;return v.map(x=>x/d);};
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const mul=(a,v)=>a.map(x=>x*v);

const palette={
  clay:['#c44a33',.81], clayLite:['#cb593e',.78], clayShade:['#9b3e30',.87],
  teal:['#208c89',.76], tealLite:['#2f9a91',.75], tealShade:['#26736e',.85],
  bone:['#e3dccc',.76], paper:['#eee6d6',.69], limed:['#c8c2b5',.78],
  shelf:['#b4aaa0',.80], slab:['#504a43',.88],
  seam:['#7b7167',.90], bronze:['#796047',.63], glass:['#b0e8e6',.64,[.44,2.60,3.42]],
  tile0:['#b6ada0',.78],tile1:['#bdbaad',.83],tile2:['#b5ada6',.80],tile3:['#cbc4b8',.76],
};

const linear=hex=>(hex.match(/(..)/g)??[]).map(bytes=>{
  const v=parseInt(bytes,16)/255;
  return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
});

function shape(){
  const p=[],n=[],i=[];
  return {
    tri(a,b,c,ns){
      const first=p.length/3;
      p.push(...a,...b,...c);
      if(ns)n.push(...ns[0],...ns[1],...ns[2]);
      else{
        const face=normal(cross(minus(b,a),minus(c,a)));
        n.push(...face,...face,...face);
      }
      i.push(first,first+1,first+2);
    },
    quad(a,b,c,d){this.tri(a,b,c);this.tri(a,c,d);},
    finish(){return new Geometry(p,n,i);},
  };
}

function block(g,c,ext,b=.015){
  const [x,y,z]=c,[ex,ey,ez]=ext.map(a=>a*.5);
  const bevel=Math.min(b,ex*.45,ey*.45,ez*.45);
  function loop(ry,rx,rz,cut){
    return [[x-rx+cut,y+ry,z+rz],[x+rx-cut,y+ry,z+rz],
      [x+rx,y+ry,z+rz-cut],[x+rx,y+ry,z-rz+cut],[x+rx-cut,y+ry,z-rz],
      [x-rx+cut,y+ry,z-rz],[x-rx,y+ry,z-rz+cut],[x-rx,y+ry,z+rz-cut]];
  }
  const rings=[loop(-ey,ex-bevel,ez-bevel,bevel*.25),loop(-ey+bevel,ex,ez,bevel),
    loop(ey-bevel,ex,ez,bevel),loop(ey,ex-bevel,ez-bevel,bevel*.25)];
  for(let row=0;row<3;row++)for(let i=0;i<8;i++){
    const next=(i+1)%8;
    g.quad(rings[row][i],rings[row][next],rings[row+1][next],rings[row+1][i]);
  }
  for(let i=1;i<7;i++){
    g.tri(rings[0][0],rings[0][i+1],rings[0][i]);
    g.tri(rings[3][0],rings[3][i],rings[3][i+1]);
  }
}

function surfaces(get){
  block(get('seam'),[0,-.115,-.8],[6.65,.19,8.15]);
  for(let r=0;r<8;r++)for(let c=0;c<7;c++){
    const x=(c-3)*.94+(r%2)*.22,z=(r-4.15)*.995;
    block(get('tile'+((r*13+c*7)%4)),[x,-.015,z],[.932,.044,.987],.009);
  }
  block(get('slab'),[0,1.91,-3.57],[6.62,3.82,.30]);
  for(let c=0;c<6;c++){
    const x=(c-2.5)*.985;
    block(get(c%4===1?'limed':'bone'),[x,2.02,-3.393],[.978,3.51,.11],.012);
  }
  block(get('shelf'),[0,.153,-3.287],[6.28,.30,.24],.009);
  block(get('limed'),[0,.309,-3.276],[6.31,.024,.24],.006);
  block(get('bone'),[0,3.735,-3.29],[6.60,.17,.29],.023);
  block(get('slab'),[0,4.03,-3.22],[7.12,.32,1.13],.025);
  block(get('bone'),[0,4.21,-1.55],[7.12,.23,3.69],.018);
  const pigments=[['clay','clayLite','clayShade'],['teal','tealLite','tealShade']];
  for(const [i,side] of [-1,1].entries()){
    const cc=pigments[i],sx=side*3.03;
    block(get(cc[2]),[sx,1.96,-.81],[.21,3.92,5.46],.019);
    for(let j=0;j<6;j++){
      const z=-3.06+j*.91;
      block(get(cc[j===2||j===5?1:0]),[sx-side*.133,2.08,z],[.17,3.37,.902],.014);
    }
    block(get(cc[2]),[sx-side*.119,.15,-.81],[.26,.29,5.61],.014);
    block(get(cc[2]),[sx-side*.119,3.88,-.81],[.29,.26,5.61],.025);
    for(const z of [-2.19,.74]){
      block(get(cc[1]),[sx-side*.29,1.92,z],[.239,3.80,.108],.026);
    }
  }
  // The front lintel shades the gallery. Its inset luminaire sits above the camera crop.
  block(get('shelf'),[0,3.94,1.84],[7.0,.43,.70],.035);
  block(get('bronze'),[.91,4.44,2.52],[3.14,.10,3.59],.032);
  block(get('glass'),[.91,4.365,2.52],[2.96,.056,3.42],.023);
}

function ellipticalTorso(g,center,scale=1){
  const rings=100,sides=35;
  const point=(i,j)=>{
    const a=i/rings*TAU,b=j/sides*TAU;
    const pivot=[.71*Math.cos(a),.93*Math.sin(a),.176*Math.sin(a*2)+.15*Math.cos(a)];
    const around=normal([.89*Math.cos(a),.71*Math.sin(a),0]);
    const torque=.65*Math.sin(a)+.46*Math.cos(a*2);
    const width=.242+.087*Math.cos(a-.31);
    const depth=.149+.036*Math.sin(a*2+.98);
    const ct=Math.cos(torque),st=Math.sin(torque);
    const u=add(mul(around,ct),[0,0,st]),v=add(mul(around,-st),[0,0,ct]);
    const ribs=1+.04*Math.cos(b*6+a*2);
    const q=add(pivot,add(mul(u,width*Math.cos(b)*ribs),mul(v,depth*Math.sin(b)*ribs)));
    const yaw=-.26;
    return add(center,mul([q[0]*Math.cos(yaw)-q[2]*Math.sin(yaw),q[1],q[2]*Math.cos(yaw)+q[0]*Math.sin(yaw)],scale));
  };
  // Adjacent facets reuse the same positions and finite-difference normals.
  // Ghost rows and columns keep the original evaluation at the periodic seam.
  const rows=Array.from({length:rings+3},(_,u)=>
    Array.from({length:sides+3},(_,v)=>point(u-1,v-1)));
  const samples=(i,j)=>rows[i+1][j+1];
  const normals=Array.from({length:rings+1},(_,i)=>Array.from({length:sides+1},(_,j)=>
    normal(cross(minus(samples(i,j+1),samples(i,j-1)),minus(samples(i+1,j),samples(i-1,j))))));
  for(let i=0;i<rings;i++)for(let j=0;j<sides;j++){
    const a=samples(i,j),b=samples(i,j+1),c=samples(i+1,j+1),d=samples(i+1,j);
    const na=normals[i][j],nb=normals[i][j+1],nc=normals[i+1][j+1],nd=normals[i+1][j];
    g.tri(a,b,c,[na,nb,nc]);
    g.tri(a,c,d,[na,nc,nd]);
  }
}

function sculpture(get){
  block(get('slab'),[-.31,.076,-1.32],[2.49,.15,1.6],.054);
  block(get('shelf'),[-.31,.197,-1.32],[2.35,.131,1.5],.038);
  block(get('paper'),[-.31,.301,-1.32],[2.53,.091,1.69],.035);
  block(get('bronze'),[-.31,.193,-.556],[.274,.065,.024],.007);
  ellipticalTorso(get('paper'),[-.30,1.408,-1.34],.957);
  block(get('limed'),[1.68,.156,-2.18],[.78,.308,.77],.02);
  block(get('bone'),[1.68,.426,-2.18],[.58,.246,.57],.043);
  block(get('bone'),[1.66,.674,-2.18],[.47,.261,.53],.072);
  block(get('paper'),[1.59,.93,-2.18],[.33,.249,.48],.047);
  block(get('shelf'),[1.53,1.14,-2.18],[.22,.175,.36],.038);
  block(get('shelf'),[-1.94,.128,-2.28],[.58,.25,.65],.027);
  block(get('paper'),[-1.94,.39,-2.28],[.39,.277,.46],.08);
  block(get('limed'),[-1.89,.608,-2.28],[.31,.159,.36],.047);
}

export function buildRoom(){
  const records=new Map();
  const get=label=>{
    if(!records.has(label))records.set(label,shape());
    return records.get(label);
  };
  surfaces(get);
  sculpture(get);
  return Array.from(records,([name,data])=>{
    const [color,roughness,emissive]=palette[name];
    const surface={color:linear(color.slice(1)),roughness,emissive,metalness:0};
    return {name,geometry:data.finish(),surface,material:new PbrMaterial({color,roughness,doubleSided:true})};
  });
}
