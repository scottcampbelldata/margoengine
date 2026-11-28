import { Geometry,PbrMaterial,box } from '@margoengine/core';
import { sphereGeometry } from '@margoengine/geometry';
import { blockHalf,columns,depth,index,rows,sphereRadius,terrainGrid,width } from './layout.js';

const matte=(color,roughness=.83,metalness=0)=>new PbrMaterial({color,roughness,metalness,doubleSided:false});
const slopeColors=['#505c58','#6c7666','#84856e','#a99a78','#b3a386','#8e826b'].map(color=>matte(color));
const cedar=['#de8a3f','#b86b3d','#e3aa50','#cb7950','#c29355'].map(color=>matte(color,.62));
const enamel=['#497e8b','#356679','#5b9ca3','#69a6a5','#68acbb'].map(color=>matte(color,.25));
const selected=matte('#f2d581',.27);
const base=matte('#344440',.66);
const basin=matte('#596560',.79);
const seam=matte('#ad9062',.28,1);
const dark=matte('#303b38',.65);
const cutLine=matte('#758078',.58);
const oxide=matte('#847457',.56);

function chamferBox(){
  const h=blockHalf,r=.027,positions=[],normals=[],indices=[];
  const rings=[[-h,r],[-h+r,0],[h-r,0],[h,r]].map(([y,inset])=>{
    const a=h-inset,b=r*.68;
    return [[-a+b,y,-a],[a-b,y,-a],[a,y,-a+b],[a,y,a-b],[a-b,y,a],[-a+b,y,a],[-a,y,a-b],[-a,y,-a+b]];
  });
  function face(points){
    const [a,b,c]=points,u=b.map((x,i)=>x-a[i]),v=c.map((x,i)=>x-a[i]);
    const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
    if(n.reduce((sum,x,i)=>sum+x*a[i],0)<0){points=points.slice().reverse();for(let i=0;i<3;i++)n[i]=-n[i];}
    const l=Math.hypot(...n),start=positions.length/3;
    for(const p of points){positions.push(...p);normals.push(n[0]/l,n[1]/l,n[2]/l);}
    for(let i=1;i+1<points.length;i++)indices.push(start,start+i,start+i+1);
  }
  for(let k=1;k<rings.length;k++)for(let i=0;i<8;i++){
    const j=(i+1)%8;
    face([rings[k-1][i],rings[k-1][j],rings[k][j],rings[k][i]]);
  }
  face(rings[0]);face(rings.at(-1));
  return new Geometry(positions,normals,indices);
}

function land(){
  const heights=terrainGrid(),dx=width/columns,dz=depth/rows;
  const positions=new Float32Array(heights.length*3),normals=new Float32Array(positions.length);
  const sections=slopeColors.map(()=>[]);
  const sample=(r,c)=>heights[index(Math.max(0,Math.min(rows,r)),Math.max(0,Math.min(columns,c)))];
  for(let c=0;c<=columns;c++)for(let r=0;r<=rows;r++){
    const i=index(r,c),x=-width/2+c*dx,z=-depth/2+r*dz;
    positions.set([x,heights[i],z],i*3);
    const nx=(sample(r,c-1)-sample(r,c+1))/(2*dx),nz=(sample(r-1,c)-sample(r+1,c))/(2*dz),length=Math.hypot(nx,1,nz);
    normals.set([nx/length,1/length,nz/length],i*3);
  }
  for(let c=0;c<columns;c++)for(let r=0;r<rows;r++){
    const x=-width/2+(c+.5)*dx,z=-depth/2+(r+.5)*dz;
    const radius=Math.hypot(x/9.6,z/8.4);
    const pigment=Math.max(0,Math.min(5,Math.floor(radius*4+.39+.15*Math.sin(.75*z+x))));
    // Identical terrain-diagonal split and coordinates to the Margo heightfield.
    const a=index(r,c),b=index(r+1,c),d=index(r,c+1),e=index(r+1,c+1);
    sections[pigment].push(a,b,d,b,e,d);
  }
  const boundary=[];
  for(let c=0;c<=columns;c++)boundary.push(index(0,c));
  for(let r=1;r<=rows;r++)boundary.push(index(r,columns));
  for(let c=columns-1;c>=0;c--)boundary.push(index(rows,c));
  for(let r=rows-1;r>0;r--)boundary.push(index(r,0));
  const shell=boundary.map((i,k)=>{
    const j=boundary[(k+1)%boundary.length];
    return [positions.slice(i*3,i*3+3),positions.slice(j*3,j*3+3)];
  });
  return {sections:sections.map(indices=>new Geometry(positions,normals,indices)),shell};
}

function sides(edges){
  const positions=[],normals=[],indices=[];
  for(const [a,b] of edges){
    const n=[b[2]-a[2],0,a[0]-b[0]],L=Math.hypot(n[0],n[2]),start=positions.length/3;
    const aa=[a[0],-1.62,a[2]],bb=[b[0],-1.62,b[2]];
    for(const point of [a,b,bb,aa]){positions.push(...point);normals.push(n[0]/L,0,n[2]/L);}
    indices.push(start,start+1,start+2,start,start+2,start+3);
  }
  return new Geometry(positions,normals,indices);
}

export function furnish(engine,entities){
  const add=(shape,material,position=[0,0,0])=>engine.createMesh().setGeometry(shape).setMaterial(material).setPosition(position);
  const island=land();
  island.sections.forEach((mesh,i)=>add(mesh,slopeColors[i]));
  add(sides(island.shell),basin);
  add(box(width+.09,.07,depth+.09),cutLine,[0,-.67,0]);
  add(box(width+.13,.045,depth+.13),oxide,[0,-1.07,0]);
  add(box(width+.19,.095,depth+.19),dark,[0,-1.35,0]);
  add(box(width+.46,.30,depth+.46),base,[0,-1.58,0]);
  add(box(width+.86,.14,depth+.86),seam,[0,-1.81,0]);
  add(box(width+1.12,.19,depth+1.12),dark,[0,-1.96,0]);
  add(box(170,.2,170),matte('#434e4a'),[0,-2.15,0]);
  const copperTick=box(.045,.075,.32);
  for(let i=-15;i<=15;i++){
    const tick=add(copperTick,seam,[i*.68,-1.73,depth/2+.36]);
    if(i%5===0)tick.setScale([1.65,1,1.4]);
  }
  const edgeCap=box(.52,.11,.18);
  for(const x of [-width/2+.4,width/2-.4])for(const z of [-depth/2-.29,depth/2+.29])add(edgeCap,seam,[x,-1.70,z]);
  const sphere=sphereGeometry(sphereRadius,16,10),round=new Geometry(sphere.positions,sphere.normals,sphere.indices);
  const block=chamferBox();
  const materials=entities.map(item=>(item.kind==='sphere'?enamel:cedar)[item.color]);
  const objects=entities.map((item,i)=>add(item.kind==='sphere'?round:block,materials[i],item.position).setQuaternion(item.rotation));
  let marked=-1;
  function mark(id){
    if(marked>=0)objects[marked].setMaterial(materials[marked]);
    marked=id;
    if(id>=0)objects[id].setMaterial(selected);
  }
  function reset(){
    for(let i=0;i<entities.length;i++)objects[i].setPosition(entities[i].position).setQuaternion(entities[i].rotation);
    mark(-1);
  }
  return {objects,mark,reset};
}
