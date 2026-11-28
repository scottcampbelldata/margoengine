import {Geometry,PbrMaterial} from '@margoengine/core';

const color=(name,roughness=.8,metalness=0)=>new PbrMaterial({color:name,roughness,metalness});
const reefSand=color('#b9ad91'),basalt=color('#494754'),silt=color('#6f6d62'),crust=color('#867871');
const leaves=[color('#456361'),color('#62752f'),color('#677e5d'),color('#365c58')];
const salmon=color('#d9877d',.72),table=color('#b09a6e',.71),brain=color('#c39855',.8),branches=color('#a0719e',.76);
const silver=color('#8fc5c2',.4,.14),pear=color('#b8b07d',.43,.1);
const tau=2*Math.PI;
const zFloor=(x,z)=>-.45+.12*Math.sin(x*.76+z*.26)+.09*Math.cos(z*.71)+.075*Math.sin(x*1.32-z*.51);
function hash(a,b,c=0){
  let v=Math.imul(a+1709,18894361)^Math.imul(b+197,8972371)^Math.imul(c+21,56011493);
  v=Math.imul(v^(v>>>11),2246822519);
  return ((v^(v>>>15))>>>0)/4294967295;
}
function geom(p,n,i){return new Geometry(p,n,i);}
function floor(){
  const p=[],n=[],ix=[],extent=36,res=66;
  for(let iz=0;iz<=res;iz++)for(let ixv=0;ixv<=res;ixv++){
    const x=-extent/2+ixv*extent/res,z=-extent/2+iz*extent/res;
    p.push(x,zFloor(x,z),z);
    const dx=zFloor(x+.1,z)-zFloor(x-.1,z),dz=zFloor(x,z+.1)-zFloor(x,z-.1);
    const len=Math.hypot(dx,.2,dz);n.push(-dx/len,.2/len,-dz/len);
    if(iz&&ixv){
      const d=iz*(res+1)+ixv,a=d-(res+1)-1,b=a+1,c=d-1;
      ix.push(a,c,d,a,d,b);
    }
  }
  return geom(p,n,ix);
}
function boulder(seed,aspect){
  const p=[],n=[],ix=[],segments=16,rings=10;
  for(let r=0;r<=rings;r++){
    const phi=Math.PI*r/rings;
    for(let j=0;j<=segments;j++){
      const a=tau*j/segments;
      const x=Math.cos(a)*Math.sin(phi),y=Math.cos(phi),z=Math.sin(a)*Math.sin(phi);
      const flow=(.5+.5*Math.cos(x*5.2-y*3.5+z*2.4+seed*2.7));
      const tooth=1.+.09*flow+.081*Math.sin(x*7.6+z*4.2+seed);
      p.push(x*aspect[0]*tooth,y*aspect[1]*tooth,z*aspect[2]*tooth);
      const base=[x/aspect[0],y/aspect[1],z/aspect[2]],mag=Math.hypot(...base);
      n.push(...base.map(c=>c/mag));
      if(j&&r){
        const d=r*(segments+1)+j,c=d-1,b=d-segments-1,a=b-1;
        ix.push(a,d,c,a,b,d);
      }
    }
  }
  return geom(p,n,ix);
}
function seaGrass(seed){
  const p=[],n=[],ix=[];
  for(let leaf=0;leaf<11;leaf++){
    const heading=tau*hash(seed,leaf),length=.32+.71*hash(seed,leaf,4),reach=.16+.28*hash(seed,leaf,12);
    const width=.016+.025*hash(seed,leaf,5),root=(hash(seed,leaf,8)-.5)*.29;
    const forward=[Math.cos(heading),Math.sin(heading)],side=[-forward[1],forward[0]];
    const first=p.length/3;
    for(let j=0;j<=10;j++){
      const t=j/10,r=reach*t**1.5,twist=.48*Math.sin(t*1.82+heading),lineWidth=width*Math.sin(Math.PI*(.09+.90*t));
      for(const sign of [-1,1]){
        p.push(root+forward[0]*r+side[0]*lineWidth*sign,
          length*(t-.19*t**2)+twist*t*.048,
          forward[1]*r+side[1]*lineWidth*sign);
        n.push(forward[0]*.47,.62,forward[1]*.47);
      }
      if(j){const d=first+j*2,a=d-2;ix.push(a,a+1,d,a+1,d+1,d);}
    }
  }
  return geom(p,n,ix);
}
function sergeant(){
  const pos=[-.38,0,0,-.22,.135,0,.09,.126,0,.22,.042,0,.22,-.036,0,.07,-.109,0,-.23,-.085,0,-.305,0,.07,-.305,0,-.07,
    .43,.112,0,.187,0,0,.44,-.104,0];
  const nor=Array.from({length:pos.length/3},(_,k)=>k===8?[0,0,-1]:[0,0,1]).flat();
  const body=[0,1,7,1,2,7,2,3,7,3,4,7,4,5,7,5,6,7,6,0,7,0,8,1,1,8,2,2,8,3,3,8,4,4,8,5,5,8,6,6,8,0,9,10,11];
  return geom(pos,nor,body);
}
const shelf=[[-.12,-.17,-.3],[2.37,-.26,-2.0],[-2.77,-.24,-1.45],[.33,-.25,-3.89]];
export function createReef(engine,starter,shadows){
  const meshes=[];
  const add=(geometry,material,at=[0,0,0],yaw=0)=>{
    const item=engine.createMesh().setGeometry(geometry).setMaterial(material).setPosition(at).setRotation([0,yaw,0]);
    meshes.push(item);return item;
  };
  add(boulder(79,[40,39,40]),color('#277280'));
  shadows.add(add(floor(),reefSand),{castShadow:false});
  for(let i=0;i<4;i++){
    const [x,y,z]=shelf[i],dims=[[1.30,.39,1.38],[1.52,.43,1.30],[1.33,.34,1.29],[1.6,.47,1.21]][i];
    shadows.add(add(boulder(i+7,dims),i%2===0?basalt:crust,[x,y,z],.28*i),{static:true});
  }
  for(let j=0;j<50;j++){
    const seed=hash(j,62),x=(hash(j,14)-.5)*22,z=(hash(j,34)-.64)*18,size=.11+seed**2.8*.91;
    if(Math.hypot(x,z)<2.7)continue;
    const shape=boulder(j+170,[size*(.89+seed*.45),size*.43,size]);
    shadows.add(add(shape,j%3===0?crust:j%4===0?silt:basalt,[x,zFloor(x,z)+size*.13,z],seed*4),{static:true});
  }
  const sampleColors=[table,brain,branches];
  let colony;
  function replace(shape){
    const {positions,normals,indices}=shape;
    const target=geom(positions,normals,indices);
    if(!colony){
      colony=add(target,salmon,[-.12,.218,-.30],.08);
      shadows.add(colony);
    }else colony.setGeometry(target);
  }
  replace(starter.evolving);
  for(let i=0;i<starter.neighbours.length;i++){
    const data=starter.neighbours[i],[x,y,z]=shelf[i+1];
    const height=y+[.43,.34,.47][i]-.036;
    shadows.add(add(geom(data.positions,data.normals,data.indices),sampleColors[i],[x,height,z],i*1.07),{static:true});
  }
  const seagrass=Array.from({length:4},(_,k)=>seaGrass(k+41)),grasses=[];
  for(const [region,regionOrigin] of [[0,[-4.6,1.3]],[1,[3.7,.34]],[2,[-2.8,-4.8]],[3,[2.6,-5.8]],[4,[4.9,-2.3]]]){
    for(let i=0;i<10;i++){
      const [cx,cz]=regionOrigin,x=cx+(hash(i,region,12)-.5)*1.5,z=cz+(hash(i,region,2)-.5)*1.3,phase=hash(i,region)*tau;
      const blade=add(seagrass[region%4],leaves[i%4],[x,zFloor(x,z),z],phase);
      grasses.push({blade,phase});
    }
  }
  const fishShape=sergeant(),school=[];
  for(let i=0;i<10;i++){
    const angle=hash(i,91)*tau,offset=hash(i,41)*3.7,alt=1.8+hash(i,69)*1.9,scale=.39+hash(i,25)*.25;
    const fish=add(fishShape,i%4===0?pear:silver).setScale([scale,scale,scale]);
    school.push({fish,angle,offset,alt,scale});
  }
  function frame(time,flow){
    for(const {blade,phase} of grasses)blade.setRotation([.065*Math.sin(time*1.8+phase),phase,.11*Math.sin(time*1.7+phase)+flow*.12]);
    for(const {fish,angle,offset,alt,scale} of school){
      const t=time*.34+angle,r=5.4+offset*.42,x=Math.cos(t)*r,z=-2.2+Math.sin(t)*r;
      fish.setPosition([x,alt+.16*Math.sin(t*1.5+offset),z]);
      const heading=Math.atan2(Math.cos(t),Math.sin(t));
      fish.setRotation([0,heading+.095*Math.sin(time*9+angle),.06*Math.sin(time*2+angle)]);
      fish.setScale([scale,scale,scale]);
    }
  }
  return {replace,frame,dispose(){for(const object of meshes)object.dispose();}};
}
