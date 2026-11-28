import {Metaballs} from '@margoengine/procedural/marching-cubes';

const wax=new Metaballs({resolution:[23,60,23],bounds:[[-.119,.102,-.119],[.119,.637,.119]],threshold:.71});
const defs=[
  {radius:.104,strength:1.53,height:.192,span:.008,rate:.53,offset:.19,x:-.024,z:.01},
  {radius:.091,strength:1.28,height:.201,span:.008,rate:.47,offset:1.89,x:.026,z:-.017},
  {radius:.104,strength:1.29,height:.273,span:.047,rate:.66,offset:.06,x:.008,z:.016},
  {radius:.101,strength:1.23,height:.346,span:.064,rate:.58,offset:.08,x:-.013,z:-.015},
  {radius:.087,strength:1.19,height:.437,span:.067,rate:.62,offset:.27,x:.017,z:.005},
  {radius:.097,strength:1.23,height:.501,span:.043,rate:.56,offset:.92,x:-.023,z:.008},
  {radius:.058,strength:1.04,height:.525,span:.032,rate:.83,offset:1.54,x:.031,z:.008},
];
const drops=defs.map(({x,z,height,radius,strength})=>wax.add([x,height,z],{radius,strength}));

function countParts(indices,vertices){
  const parent=new Int32Array(vertices).fill(-1);
  function root(n){
    let r=n;
    while(parent[r]>=0)r=parent[r];
    while(n!==r){const previous=parent[n];parent[n]=r;n=previous;}
    return r;
  }
  function join(a,b){
    a=root(a);b=root(b);
    if(a===b)return;
    if(parent[a]>parent[b])[a,b]=[b,a];
    parent[a]+=parent[b];
    parent[b]=a;
  }
  for(let i=0;i<indices.length;i+=3){
    join(indices[i],indices[i+1]);join(indices[i],indices[i+2]);
  }
  let count=0;
  for(let i=0;i<parent.length;i++)if(parent[i]<0)count++;
  return count;
}
function extract(time,level,wire){
  wax.options.threshold=level;
  defs.forEach(({x,z,height,span,rate,offset},i)=>{
    const phase=time*rate+offset,point=drops[i].position;
    point[0]=x+.015*Math.sin(phase*.76+i*.61);
    point[1]=height+span*Math.sin(phase);
    point[2]=z+.012*Math.cos(phase*.56+i*.92);
  });
  const shape=wax.geometry();
  if(!shape)return {positions:new Float32Array(),normals:new Float32Array(),indices:new Uint32Array(),
    segments:new Uint32Array(),components:0};
  const {vertices,indices}=shape,n=vertices.length/6,positions=new Float32Array(n*3),normals=new Float32Array(n*3);
  for(let j=0;j<n;j++)for(let k=0;k<3;k++){
    positions[j*3+k]=vertices[j*6+k];
    normals[j*3+k]=vertices[j*6+k+3];
  }
  const edges=[];
  if(wire){
    const seen=new Set();
    function keep(a,b){
      const key=Math.min(a,b)*n+Math.max(a,b);
      if(seen.has(key))return;
      seen.add(key);
      edges.push(a,b);
    }
    for(let j=0;j<indices.length;j+=3){
      const a=indices[j],b=indices[j+1],c=indices[j+2];
      keep(a,b);keep(b,c);keep(c,a);
    }
  }
  const segments=new Uint32Array(edges);
  return {positions,normals,indices,segments,components:countParts(indices,n)};
}

self.onmessage=({data})=>{
  const {revision,time,level,wire}=data,t=performance.now();
  try{
    const result=extract(time,level,wire);
    self.postMessage({...result,revision,time,level,wire,milliseconds:performance.now()-t},
      [result.positions.buffer,result.normals.buffer,result.indices.buffer,result.segments.buffer]);
  }catch(error){self.postMessage({error:error.message});}
};
