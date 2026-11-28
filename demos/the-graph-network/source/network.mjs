// Fictional ferry connections. Seed positions establish the opening composition; the solver moves every port except the island hubs.
export const islands = [
  {name:'Glass Reach', color:'#6cd9c5', dim:'#498f85', center:[-5.55,3.31], radius:[2.32,2.63], turn:.22},
  {name:'Whitethorn', color:'#e7bd7a', dim:'#a78555', center:[-1.66,4.66], radius:[1.9,2.11], turn:1.4},
  {name:'Lantern Passage', color:'#ed9b83', dim:'#af7362', center:[3.78,4.53], radius:[2.57,1.64], turn:2.13},
  {name:'Northwind', color:'#82b9ef', dim:'#5e86ab', center:[6.37,1.93], radius:[1.5,2.33], turn:2.85},
  {name:'The Vesper Isles', color:'#cdb5ef', dim:'#927cab', center:[2.95,-1.13], radius:[2.41,2.01], turn:-.72},
  {name:'Plover Sound', color:'#c4df94', dim:'#8ba367', center:[6.03,-4.26], radius:[2.19,2.03], turn:.2},
  {name:'Nacre Bay', color:'#77c8e3', dim:'#4d8da2', center:[.10,-4.91], radius:[2.58,1.98], turn:2.63},
  {name:'Rainward', color:'#e6a9c3', dim:'#966c85', center:[-4.71,-2.87], radius:[2.33,2.44], turn:1.51},
];
const nameStems=[
  'Alder','Anvil','Ash','Beacon','Bell','Blackfin','Bracken','Briar','Cairn','Cedar',
  'Clove','Copper','Cormorant','Dawn','Drift','Dusky','Eider','Elm','Fir','Flint',
  'Fog','Granite','Gull','Hawthorn','Heron','Ibis','Juniper','Kelp','Lark','Lime',
  'Linden','Mallow','Marl','Moss','Osprey','Oyster','Pearl','Pine','Redfin','Rush',
  'Sable','Sedge','Silt','Slate','Softwind','Tern','Thistle','Umber','Wren','Yew','Marsh','Mica','Mullet','Nettle','Salal','Saltbrush',
];
const endings=['Cove','Landing','Quay','Haven','Dock','Wharf','Pier','Point'];
const counts=[53,47,48,44,49,50,55,52];
const turns=Math.PI*(3-Math.sqrt(5));
let randomSeed=104723;

function random(){
  randomSeed=(Math.imul(randomSeed,1664525)+1013904223)>>>0;
  return randomSeed/4294967296;
}

export const ports=[];
export const hubs=[];
for(const [group,island] of islands.entries()){
  const {center:[x,y],radius:[rx,ry],turn}=island;
  hubs.push(ports.length);
  ports.push({name:island.name,group,hub:true,x,y});
  for(let local=1;local<counts[group];local++){
    const az=turn+turns*local+.17*(random()-.5);
    const r=.17+.83*Math.sqrt((local+.05)/counts[group]);
    const coast=1+.135*Math.sin(3*az+turn)+.13*Math.cos(az-turn)+.05*random();
    ports.push({
      name:nameStems[(local+7*group)%nameStems.length]+' '+endings[(group+Math.floor(local/nameStems.length))%endings.length],
      group,hub:false,x:x+rx*r*coast*Math.cos(az),y:y+ry*r*coast*Math.sin(az),
    });
  }
}

const routeMap=new Map();
function route(a,b,trunk=false){
  const start=Math.min(a,b),end=Math.max(a,b),id=start*ports.length+end;
  if(!routeMap.has(id)&&start!==end)routeMap.set(id,{start,end,trunk});
}
const distance=(a,b)=>(ports[a].x-ports[b].x)**2+(ports[a].y-ports[b].y)**2;

// Make each region connected via a nearest prior port, and add nearby cyclic lines.
for(const [group,start] of hubs.entries()){
  const end=start+counts[group];
  for(let port=start+1;port<end;port++){
    const local=Array.from({length:counts[group]},(_,i)=>start+i).filter(i=>i!==port);
    local.sort((a,b)=>distance(port,a)-distance(port,b));
    route(port,local.find(i=>i<port));
    route(port,local[0]);
    route(port,local[1]);
    if(port%3===1)route(port,local[2]);
    if(port%11===0)route(port,start);
  }
}
for(const [a,b] of [[0,1],[1,2],[2,3],[3,4],[3,5],[4,5],[5,6],[6,7],[7,0],[4,6],[1,4],[2,4],[0,6]]){
  route(hubs[a],hubs[b],true);
}
export const routes=[...routeMap.values()];
export const adjacency=ports.map(()=>[]);
for(const {start,end} of routes){
  adjacency[start].push(end);
  adjacency[end].push(start);
}
for(const connections of adjacency)connections.sort((a,b)=>ports[a].name.localeCompare(ports[b].name));

export const positions=Float32Array.from(ports.flatMap(({x,y})=>[x,y,0]));
export const graph={
  nodes:ports.length,
  edges:Uint32Array.from(routes.flatMap(({start,end})=>[start,end])),
  weights:Float32Array.from(routes,({trunk})=>trunk?.003:1),
};

export const bounds=[-9.05,9.05,-7.65,7.65,-.6,.6];
export const layoutOptions={
  model:'fruchterman-reingold',dimensions:2,positions,
  fixed:Uint32Array.from(ports,({hub})=>Number(hub)),
  length:.19,temperature:.16,cooling:.88,simmer:.05,gravity:.009,theta:0,gridSide:8,
};
