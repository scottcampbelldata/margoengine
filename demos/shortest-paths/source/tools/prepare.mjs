import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';

const [roadsPath,waterPath]=process.argv.slice(2);
if(!roadsPath||!waterPath)throw new Error('Provide the two ArcGIS JSON responses.');
const [roadBytes,waterBytes]=await Promise.all([readFile(roadsPath),readFile(waterPath)]);
const roadSource=JSON.parse(roadBytes),waterSource=JSON.parse(waterBytes);
for(const data of [roadSource,waterSource]){
  assert.equal(data.spatialReference.wkid,26985);
  assert.ok(data.features.length&&!data.exceededTransferLimit);
}
const [west,south,east,north]=[396075,134398,398900,137050];
const inside=([x,y])=>x>=west&&x<=east&&y>=south&&y<=north;
const packed=([x,y])=>[Math.round((x-west)*10),Math.round((y-south)*10)];
const tolerance=.85;
const roadRuns=[],endpoints=[];
const codes={BD:0,OB:1,IB:-1};

for(const feature of roadSource.features){
  const {LENGTH,OBJECTID,ROADTYPE,ROUTENAME,SUMMARYDIRECTION,NHSTYPE}=feature.attributes;
  const direction=codes[SUMMARYDIRECTION],paths=feature.geometry.paths;
  if(![1,2].includes(Number(ROADTYPE))||direction===undefined||!Number.isFinite(LENGTH)||LENGTH<1||paths.length!==1)continue;
  const path=paths[0].map(p=>p.slice(0,2));
  if(path.length<2||!path.every(inside))continue;
  const first=endpoints.push(path[0])-1;
  const last=endpoints.push(path.at(-1))-1;
  roadRuns.push({first,last,path,street:ROUTENAME,arterial:Number(Boolean(NHSTYPE)),direction,id:OBJECTID,meter:LENGTH});
}
assert.ok(roadRuns.length>300&&roadRuns.length<700);

const parents=Int32Array.from(endpoints,(_,i)=>i);
function root(i){
  while(parents[i]!==i){
    parents[i]=parents[parents[i]];
    i=parents[i];
  }
  return i;
}
const buckets=new Map();
const key=(x,y)=>x+'/'+y;
for(const [i,[x,y]] of endpoints.entries()){
  const ix=Math.floor(x/tolerance),iy=Math.floor(y/tolerance);
  for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){
    for(const j of buckets.get(key(ix+dx,iy+dy))??[]){
      const [a,b]=endpoints[j];
      if(Math.hypot(x-a,y-b)<=tolerance)parents[root(i)]=root(j);
    }
  }
  const cell=key(ix,iy),members=buckets.get(cell)??[];
  members.push(i);
  buckets.set(cell,members);
}
const groups=new Map();
for(const [i,p] of endpoints.entries()){
  const k=root(i),g=groups.get(k)??[];
  g.push(p);
  groups.set(k,g);
}
const vertices=new Map(Array.from(groups.keys(),(r,i)=>[r,i]));
const positions=Array.from(groups.values(),group=>{
  const sum=group.reduce((sum,p)=>[sum[0]+p[0],sum[1]+p[1]],[0,0]);
  const center=sum.map(k=>k/group.length);
  assert.ok(group.every(p=>Math.hypot(p[0]-center[0],p[1]-center[1])<=tolerance));
  return center;
});
const connected=positions.map(()=>[]);
for(const run of roadRuns){
  run.start=vertices.get(root(run.first));
  run.end=vertices.get(root(run.last));
  if(run.start===run.end)continue;
  connected[run.start].push(run.end);
  connected[run.end].push(run.start);
}
const unseen=new Set(positions.map((_,i)=>i)),components=[];
while(unseen.size){
  const seed=unseen.values().next().value;
  const queue=[seed];
  unseen.delete(seed);
  for(let i=0;i<queue.length;i++)for(const v of connected[queue[i]]){
    if(unseen.delete(v))queue.push(v);
  }
  components.push(queue);
}
components.sort((a,b)=>b.length-a.length);
const selected=[...components[0]].sort((a,b)=>a-b);
const current=new Map(selected.map((id,i)=>[id,i]));
const names=[],indices=new Map();
const segments=[];
for(const road of roadRuns){
  const {start,end,street,direction,id,arterial,meter,path}=road;
  if(start===end||!current.has(start)||!current.has(end))continue;
  if(!indices.has(street)){
    indices.set(street,names.length);
    names.push(street);
  }
  segments.push([current.get(start),current.get(end),direction,Math.round(meter*100),indices.get(street),arterial,id,...path.slice(1,-1).flatMap(packed)]);
}

function clipSegment(a,b){
  const dx=b[0]-a[0],dy=b[1]-a[1];
  let first=0,last=1;
  for(const [p,q] of [[-dx,a[0]-west],[dx,east-a[0]],[-dy,a[1]-south],[dy,north-a[1]]]){
    if(Math.abs(p)<1e-10){if(q<0)return null;continue;}
    const t=q/p;
    if(p<0)first=Math.max(first,t);
    else last=Math.min(last,t);
    if(first>=last)return null;
  }
  return [[a[0]+first*dx,a[1]+first*dy],[a[0]+last*dx,a[1]+last*dy]];
}
const shoreline=[],hatched=[];
for(const feature of waterSource.features){
  const rings=feature.geometry.rings;
  for(const ring of rings)for(let i=1;i<ring.length;i++){
    const clipped=clipSegment(ring[i-1],ring[i]);
    if(clipped)shoreline.push(...clipped.flatMap(packed));
  }
  for(let y=south+11;y<north;y+=24){
    const crossings=[];
    for(const ring of rings)for(let i=1;i<ring.length;i++){
      const a=ring[i-1],b=ring[i];
      if((a[1]>y)===(b[1]>y))continue;
      crossings.push(a[0]+(b[0]-a[0])*(y-a[1])/(b[1]-a[1]));
    }
    crossings.sort((a,b)=>a-b);
    for(let k=1;k<crossings.length;k+=2){
      const a=Math.max(west,crossings[k-1]),b=Math.min(east,crossings[k]);
      if(b-a>1)hatched.push(...[ [a,y],[b,y] ].flatMap(packed));
    }
  }
}

const junctions=selected.flatMap(id=>packed(positions[id]));
const references={
  projection:'EPSG:26985',units:'metres',bounds:[west,south,east,north],tolerance,
  roads:'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/POL_LAYERS/MapServer/6',
  water:'https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Planimetrics_2021/MapServer/14',
  sourceSha256:[roadBytes,waterBytes].map(bytes=>createHash('sha256').update(bytes).digest('hex')),
};
const values={references,junctions,segments,names,shoreline,hatched};
const destination=new URL('../data.mjs',import.meta.url);
const contents=Object.entries(values).map(([name,value])=>'export const '+name+'='+JSON.stringify(value)+';').join('\n')+'\n';
await writeFile(destination,contents);
console.log({
  selected:selected.length,edges:segments.length,backward:segments.filter(s=>s[2]===-1).length,
  forward:segments.filter(s=>s[2]===1).length,sourceFeatures:roadSource.features.length,
  components:components.map(c=>c.length).slice(0,14),shoreline:shoreline.length/4,hatched:hatched.length/4,
});
