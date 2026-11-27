import {references,junctions,segments,names,shoreline,hatched} from './data.mjs';

export {references};
const [west,south,east,north]=references.bounds;
export const field={width:east-west,height:north-south};
export const point=(x,y)=>[x*.1-field.width*.5,y*.1-field.height*.5];
export const junction=Array.from({length:junctions.length/2},(_,i)=>point(junctions[i*2],junctions[i*2+1]));
const nodes=junction.map(()=>new Set());
export const roads=segments.map(([start,end,direction,cost,street,arterial,sourceId,...turns])=>{
  const name=names[street];
  nodes[start].add(name);
  nodes[end].add(name);
  const path=[junction[start]];
  for(let j=0;j<turns.length;j+=2)path.push(point(turns[j],turns[j+1]));
  path.push(junction[end]);
  return {start,end,direction,cost,name,arterial:Boolean(arterial),sourceId,path};
});

const byPair=new Map();
const pair=(from,to)=>from*junction.length+to;
function addArc(from,to,road,reversed){
  const key=pair(from,to),old=byPair.get(key);
  if(!old||road.cost<old.cost){
    byPair.set(key,{from,to,road,reversed,cost:road.cost});
  }
}
for(const road of roads){
  const {start,end,direction}=road;
  if(direction>=0)addArc(start,end,road,false);
  if(direction<=0)addArc(end,start,road,true);
}
export const arcs=[...byPair.values()];
export const arc=(a,b)=>byPair.get(pair(a,b));
export const graphData={
  vertices:junction.length,
  sources:Uint32Array.from(arcs,a=>a.from),
  targets:Uint32Array.from(arcs,a=>a.to),
  weights:Float32Array.from(arcs,a=>a.cost),
  directed:true,
};

export const namesByNode=nodes.map((set,index)=>{
  const direct=[...set].filter(Boolean).sort();
  return direct.length===1?direct[0]+' · '+(index+1):direct.join(' / ')||'Junction '+(index+1);
});

function packedSegments(values){
  const points=[];
  for(let i=0;i<values.length;i+=2)points.push(...point(values[i],values[i+1]),0);
  return Float32Array.from(points);
}
export const water={shore:packedSegments(shoreline),hatch:packedSegments(hatched)};

export function nearestWorld(x,y,predicate=()=>true){
  let smallest=Infinity,selected=-1;
  for(const [id,[e,n]] of junction.entries()){
    if(!predicate(id))continue;
    const score=(e-x)**2+(n-y)**2;
    if(score<smallest){smallest=score;selected=id;}
  }
  return {id:selected,distance:Math.sqrt(smallest)};
}

function nearActual(x,y){
  return nearestWorld(x-(west+east)*.5,y-(south+north)*.5,id=>nodes[id].size>=2).id;
}
export const defaultOrigin=nearActual(397227,136610);
export const defaultDestination=nearActual(398475,134827);

export function routeBetween(origin,destination,distances,predecessors){
  if(!Number.isFinite(distances[destination]))return null;
  const steps=[];
  for(let node=destination;node!==origin;){
    const predecessor=predecessors[node],edge=arc(predecessor,node);
    if(!edge||distances[predecessor]+edge.cost!==distances[node]||steps.length>=junction.length)
      throw new Error('The solver predecessor does not follow a legal, strictly shorter road.');
    steps.push(edge);
    node=predecessor;
  }
  return {steps:steps.reverse(),distance:distances[destination]/100};
}
