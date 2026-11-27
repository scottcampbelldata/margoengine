import {Geometry,PbrMaterial,box} from '@margoengine/core';
import {Matrix4,Quaternion} from '@margoengine/math';

const tau=2*Math.PI;
const mat=(color,roughness,metalness=0)=>new PbrMaterial({color,roughness,metalness});
const material={
  navy:mat('#263348',.94),panel:mat('#334748',.89),panelEdge:mat('#465a55',.79),
  walnut:mat('#462a22',.70),edge:mat('#674131',.61),honey:mat('#9b7a4a',.55,.69),
  brass:mat('#be9b59',.32,.64),inner:mat('#6e5634',.49,.56),paper:mat('#d5ba81',.89),
  cloth:mat('#433340',.89),ink:mat('#251e1e',.78),wax:mat('#d5b073',.64),
  pale:mat('#f0cfa2',.58),brick:mat('#5c3140',.57),window:mat('#4d5a77',.76),
};
function profile(points,sectors=40){
  const positions=[],normals=[],indices=[];
  for(let i=0;i<points.length;i++){
    const [y,r]=points[i],a=points[Math.max(0,i-1)],b=points[Math.min(points.length-1,i+1)];
    const u=b[0]-a[0],v=a[1]-b[1],span=Math.hypot(u,v)||1;
    for(let j=0;j<=sectors;j++){
      const t=j*tau/sectors,c=Math.cos(t),s=Math.sin(t);
      positions.push(r*c,y,r*s);normals.push(u/span*c,v/span,u/span*s);
      if(i&&j){
        const k=i*(sectors+1)+j,l=k-sectors-1;
        indices.push(l-1,k-1,k,l-1,k,l);
      }
    }
  }
  return new Geometry(positions,normals,indices);
}
const baseStand=profile([[0,0],[0,.100],[.007,.105],[.015,.105],[.022,.091],
  [.028,.087],[.034,.073],[.040,.048],[.051,.034],[.106,.030],[.117,.038],[.121,.046],
  [.130,.050],[.137,.064],[.144,.068],[.151,.061],[.153,0]]);
function waxGeometry(height,r,seed){
  const rings=28,points=[],normals=[],indices=[];
  function sample(i,j){
    const t=j*tau/rings,u=i/8;
    const wave=Math.cos(t*3+seed)*.3+Math.sin(t*4+seed*1.4)*.35+Math.sin(t*9-seed*.14)*.16;
    const radius=i===8?.007:i===7?r*.78:r*(1+.036*Math.cos(t*7+seed));
    const h=i===8?height-.004:i===7?height-.013+wave*.011:height*u/(6/8)+(i===6?wave*.018:0);
    return [radius*Math.cos(t),Math.max(0,h),radius*Math.sin(t)];
  }
  for(let i=0;i<=8;i++)for(let j=0;j<=rings;j++){
    const here=sample(i,j),a=sample(i,Math.max(0,j-1)),b=sample(i,j+1),lo=sample(Math.max(0,i-1),j),hi=sample(Math.min(8,i+1),j);
    const u=b.map((v,k)=>v-a[k]),v=hi.map((x,k)=>x-lo[k]);
    const n=[v[1]*u[2]-v[2]*u[1],v[2]*u[0]-v[0]*u[2],v[0]*u[1]-v[1]*u[0]];
    const span=Math.hypot(...n)||1;
    points.push(...here);normals.push(...n.map(x=>x/span));
    if(j&&i){
      const k=i*(rings+1)+j,l=k-rings-1;
      indices.push(l-1,k-1,k,l-1,k,l);
    }
  }
  return new Geometry(points,normals,indices);
}
function torus(major,thin){
  const positions=[],normals=[],indices=[],along=64,cross=11;
  for(let i=0;i<=along;i++)for(let j=0;j<=cross;j++){
    const a=i*tau/along,b=j*tau/cross;
    const c=Math.cos(a),s=Math.sin(a),d=Math.cos(b),h=Math.sin(b);
    positions.push((major+thin*d)*c,thin*h,(major+thin*d)*s);
    normals.push(c*d,h,s*d);
    if(i&&j){
      const here=i*(cross+1)+j,prior=here-cross-1;
      indices.push(prior-1,here-1,here,prior-1,here,prior);
    }
  }
  return new Geometry(positions,normals,indices);
}
function pages(width,deep){
  const p=[],n=[],indices=[],step=22;
  for(let s=0;s<=step;s++){
    const f=s/step,x=f*width,y=.020*Math.sin(.9*Math.PI*f)+.006*Math.sin(8*f),derivative=.056*Math.cos(.9*Math.PI*f)/width;
    for(const z of [-deep/2,deep/2]){
      p.push(x,y,z+(z<0?1:-1)*Math.sin(f*Math.PI)*.012);
      const d=Math.hypot(derivative,1);n.push(-derivative/d,1/d,0);
    }
    if(s){
      const i=s*2;
      indices.push(i-2,i-1,i,i,i-1,i+1);
    }
  }
  return new Geometry(p,n,indices);
}
function pageMarkings(sketch){
  const points=[],normals=[],indices=[];
  const surface=x=>.020*Math.sin(.9*Math.PI*x/.275)+.006*Math.sin(8*x/.275)+.0014;
  function stroke(a,b,width){
    const distance=Math.hypot(b[0]-a[0],b[1]-a[1])||1;
    const dx=(b[1]-a[1])*width/distance/2,dz=(a[0]-b[0])*width/distance/2;
    const steps=Math.max(1,Math.ceil(Math.abs(b[0]-a[0])/.012));
    for(let step=0;step<=steps;step++){
      const f=step/steps,x=a[0]+(b[0]-a[0])*f,z=a[1]+(b[1]-a[1])*f;
      const i=points.length/3;
      for(const side of [-1,1]){
        const xx=x+dx*side;
        points.push(xx,surface(xx),z+dz*side);normals.push(0,1,0);
      }
      if(step)indices.push(i-2,i,i-1,i-1,i,i+1);
    }
  }
  if(sketch){
    const cx=.141,cz=-.012;
    for(const radius of [.043,.073,.095]){
      for(let i=0;i<40;i++){
        const a=i*tau/40,b=(i+1)*tau/40;
        stroke([cx+radius*Math.cos(a),cz+radius*Math.sin(a)],[cx+radius*Math.cos(b),cz+radius*Math.sin(b)],.0018);
      }
    }
    stroke([.033,cz],[.249,cz],.0014);
    stroke([cx,-.12],[cx,.105],.0014);
    for(const [x,z] of [[.09,.033],[.186,.068],[.18,-.061],[.132,-.016],[.079,-.051]]){
      stroke([x-.003,z],[x+.003,z],.005);
      stroke([x,z-.004],[x,z+.004],.0024);
    }
  }else{
    for(let i=0;i<13;i++){
      const z=-.125+.020*i;
      let start=.035;
      for(let j=0;j<6;j++){
        const q=.018+.015*Math.abs(Math.sin(i*2.131+j*5.72));
        if(start+q>.246)break;
        stroke([start,z],[start+q,z+.0009*Math.sin(i+j)],.0016);
        start+=q+.006;
      }
    }
  }
  return new Geometry(points,normals,indices);
}

export const candles=[
  {x:-.73,z:.27,wax:.29,r:.036,kelvin:1940,lumens:13.6},
  {x:-.44,z:-.38,wax:.42,r:.033,kelvin:1810,lumens:12.1},
  {x:.65,z:.44,wax:.24,r:.042,kelvin:1870,lumens:15.8},
  {x:.88,z:-.24,wax:.34,r:.036,kelvin:1930,lumens:13.2},
  {x:.21,z:-.52,wax:.47,r:.030,kelvin:1840,lumens:11.9},
].map(c=>({...c,flame:[c.x,1.064+c.wax,c.z]}));

export function bakeRoom(){
  const pieces=[];
  const object=(geometry,material,position,occluder=false)=>{
    const piece={geometry,material,position,occluder,rotation:[0,0,0]};
    pieces.push(piece);
    return {setRotation(rotation){piece.rotation=rotation;}};
  };
  const block=(a,b,c,m,x,y,z,occluder=false)=>object(box(a,b,c),m,[x,y,z],occluder);
  block(6.2,.18,6.1,material.panel,0,-.105,.3);
  block(6.2,3.35,.12,material.navy,0,1.60,-1.57);
  block(.12,3.35,5.4,material.navy,-2.9,1.6,1.0);
  block(6.2,.985,.10,material.panel,0,.5,-1.49);
  block(6.2,.055,.11,material.panelEdge,0,1.04,-1.40);
  block(6.2,.1,.12,material.panelEdge,0,.09,-1.40);
  for(let x=-2.76;x<=2.80;x+=.54){
    block(.032,.73,.035,material.panelEdge,x,.55,-1.42);
    block(.48,.036,.037,material.panelEdge,x+.25,.89,-1.42);
    block(.48,.028,.035,material.panelEdge,x+.25,.21,-1.42);
  }
  block(.82,1.13,.045,material.inner,-1.91,1.88,-1.43);
  block(.75,1.05,.04,material.window,-1.91,1.88,-1.409);
  for(const x of [-2.31,-1.91,-1.51])block(.031,1.15,.052,material.honey,x,1.88,-1.37,true);
  for(const y of [1.33,1.69,2.06,2.44])block(.8,.027,.048,material.panelEdge,-1.91,y,-1.369,true);
  block(.91,.079,.15,material.edge,-1.91,1.29,-1.35);
  for(let i=0;i<7;i++){
    const z=(i-3)*.042;
    block(2.58,.028,.039,i%2?material.honey:material.edge,0,.797,z+.62);
  }
  block(2.63,.074,1.55,material.walnut,0,.828,0,true);
  block(2.67,.030,1.57,material.edge,0,.869,0,true);
  block(2.56,.036,1.46,material.walnut,0,.889,0);
  block(2.52,.135,.08,material.edge,0,.735,.72,true);
  const leg=profile([[0,.068],[.018,.066],[.040,.052],[.14,.037],[.19,.036],[.27,.046],
      [.38,.042],[.60,.053],[.69,.056],[.79,.071]]);
  for(const x of [-1.14,1.14])for(const z of [-.62,.62])object(leg,material.walnut,[x,.008,z],true);
  for(const x of [-.92,-.62,.62,.92]){
    block(.078,.014,.038,material.brass,x,.767,.767);
  }
  const pedestal=profile([[0,.163],[.019,.173],[.04,.139],[.056,.124],[.066,.073],[.093,.038],
    [.157,.029],[.199,.051],[.211,.041],[.214,0]]);
  object(pedestal,material.inner,[.075,.901,-.17],true);
  const c=[.075,1.303,-.17];
  object(torus(.224,.011),material.brass,c,true).setRotation([.38,.09,.43]);
  object(torus(.214,.009),material.honey,c,true).setRotation([1.16,-.26,.21]);
  object(torus(.19,.0075),material.brass,c,true).setRotation([.45,1.04,1.13]);
  const core=profile([[-.043,0],[-.038,.032],[-.018,.046],[.012,.048],[.039,.031],[.046,0]],30);
  object(core,material.honey,c,true);
  block(.66,.038,.36,material.cloth,-.15,.927,.413,true).setRotation([0,-.14,0]);
  block(.61,.035,.329,material.paper,-.15,.948,.413,true).setRotation([0,-.14,0]);
  const binding=[-.17,.990,.441];
  const page=pages(.275,.335);
  object(page,material.paper,binding,true).setRotation([0,-.19,0]);
  object(page,material.paper,binding,true).setRotation([0,Math.PI-.19,0]);
  object(pageMarkings(true),material.inner,binding).setRotation([0,-.19,0]);
  object(pageMarkings(false),material.ink,binding).setRotation([0,Math.PI-.19,0]);
  for(const [i,c] of candles.entries()){
    object(baseStand,material.brass,[c.x,.901,c.z],true);
    object(waxGeometry(c.wax,c.r,2.17*i),i===2?material.brick:i%2?material.pale:material.wax,[c.x,1.052,c.z],true);
    block(.0045,.018,.0045,material.ink,c.x,1.057+c.wax,c.z).setRotation([.15,-.21,.13]);
    let j=0;
    for(const angle of [1.8+1.1*i,2.7+1.5*i]){
      const drops=profile([[0,0],[.003,.003],[.013,.008],[.033,.008],[.070,.006]],16);
      const r=c.r*.93,dy=.064+j*.018;
      object(drops,i===2?material.brick:material.pale,[c.x+Math.cos(angle)*r,1.046+c.wax-dy,c.z+Math.sin(angle)*r]);
      j++;
    }
  }
  // Combine the stationary objects by material and shadow participation. The folio, fixtures,
  // and furniture retain their original vertices, normals, and occlusion.
  const output=[],batches=new Map(),matrix=new Matrix4(),rotation=new Quaternion();
  for(const piece of pieces){
    if(!batches.has(piece.material))batches.set(piece.material,new Map());
    const byShadow=batches.get(piece.material);
    if(!byShadow.has(piece.occluder))byShadow.set(piece.occluder,{positions:[],normals:[],indices:[]});
    const target=byShadow.get(piece.occluder),first=target.positions.length/3;
    const [x,y,z]=piece.rotation;
    rotation.setFromEuler({x,y,z,order:"XYZ"});
    const [tx,ty,tz]=piece.position;
    matrix.compose({x:tx,y:ty,z:tz},rotation,{x:1,y:1,z:1});
    const m=matrix.elements,data=piece.geometry.vertices;
    for(let i=0;i<data.length;i+=6){
      const px=data[i],py=data[i+1],pz=data[i+2],nx=data[i+3],ny=data[i+4],nz=data[i+5];
      target.positions.push(m[0]*px+m[4]*py+m[8]*pz+m[12],m[1]*px+m[5]*py+m[9]*pz+m[13],m[2]*px+m[6]*py+m[10]*pz+m[14]);
      target.normals.push(m[0]*nx+m[4]*ny+m[8]*nz,m[1]*nx+m[5]*ny+m[9]*nz,m[2]*nx+m[6]*ny+m[10]*nz);
    }
    for(const index of piece.geometry.indices)target.indices.push(first+index);
  }
  for(const [surface,byShadow] of batches)for(const [occluder,batch] of byShadow){
    const name=Object.keys(material).find(key=>material[key]===surface);
    output.push({name,occluder,positions:Float32Array.from(batch.positions),normals:Float32Array.from(batch.normals),indices:Uint32Array.from(batch.indices)});
  }
  return output;
}


export function installRoom(engine,batches){
  const cast=[];
  for(const {name,occluder,positions,normals,indices} of batches){
    const item=engine.createMesh().setGeometry(new Geometry(positions,normals,indices)).setMaterial(material[name]);
    if(occluder)cast.push(item);
  }
  return {cast};
}
