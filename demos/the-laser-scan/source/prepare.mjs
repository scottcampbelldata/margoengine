import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

const checkout=process.env.MARGO_ENGINE_CHECKOUT;
if(!checkout)throw Error('Set MARGO_ENGINE_CHECKOUT to the built public engine checkout.');
const moduleAt=file=>import(pathToFileURL(resolve(checkout,file)));
const {parseLAS}=await moduleAt('packages/points/dist/las.js');
const {buildOctree}=await moduleAt('packages/points/dist/octree.js');
const directory=process.argv[2]??'qa-output/the-laser-scan/ept';
const assets=new URL('./assets/',import.meta.url);
await mkdir(assets,{recursive:true});
const catalog=JSON.parse(await readFile(resolve(directory,'manifest.json'),'utf8'));
const lat=catalog.center[1]*Math.PI/180;
const cos=Math.cos(lat), sin=Math.sin(lat);
const ellipsoid=.0066943799901413165;
const normal=1/Math.sqrt(1-ellipsoid*sin*sin);
const eastScale=cos*normal;
const northScale=cos*(1-ellipsoid)*normal**3;
const heightOrigin=2200;
const meter=.125;

const positions=[];
const attributes=[];
const receipts=[];
let peak=[0,-Infinity,0],lowest=Infinity;
for(const [key,,length] of catalog.downloaded){
  const file=resolve(directory,'ept-data-'+key+'.laz');
  const packet=await readFile(file);
  assert.equal(packet.length,length);
  const depth=Number(key.split('-')[0]);
  const stride=[1,1,1,1,2,12,75][depth];
  const scan=await parseLAS(packet,{stride,signal:AbortSignal.timeout(30000)});
  const [offsetX,offsetY,offsetZ]=scan.origin;
  receipts.push([key,scan.header.pointCount,createHash('sha256').update(packet).digest('hex')]);
  for(let i=0;i<scan.count;i++){
    const cls=scan.classification[i];
    if(cls===7||cls===18)continue;
    const a=(scan.positions[3*i]+offsetX-catalog.point[0])*eastScale;
    const b=(scan.positions[3*i+1]+offsetY-catalog.point[1])*northScale;
    const h=scan.positions[3*i+2]+offsetZ;
    if(a< -3250||a>3250||b< -3050||b>3250||h<1400||h>3330)continue;
    positions.push(Math.round(a/meter)*meter,Math.round((h-heightOrigin)/meter)*meter,Math.round(-b/meter)*meter);
    attributes.push(Math.min(255,Math.round(Math.sqrt(scan.intensity?.[i]??100)*4)));
    if(h>peak[1])peak=[a,h,-b];
    lowest=Math.min(lowest,h);
  }
}
assert.ok(positions.length/3>30000, 'Too few real returns in this crop');
assert.ok(peak[1]>3000,'Survey should contain the summit district');

const count=positions.length/3;
const dims=126;
const size=6600/dims;
const heights=new Float32Array(dims*dims).fill(-Infinity);
const at=(x,z)=>Math.max(1,Math.min(dims-2,Math.round((x+3300)/size)))+dims*Math.max(1,Math.min(dims-2,Math.round((z+3300)/size)));
for(let i=0;i<count;i++){
  const index=at(positions[i*3],positions[i*3+2]);
  heights[index]=Math.max(heights[index],positions[i*3+1]);
}
const ramp=[
  [0,[21,53,66]], [.24,[33,104,109]], [.52,[84,140,125]], [.73,[178,164,110]], [1,[245,235,186]],
];
const rgb=[];
for(let i=0;i<count;i++){
  const [x,y,z]=positions.slice(i*3,i*3+3);
  const h=(y+heightOrigin-lowest)/(peak[1]-lowest);
  const next=ramp.findIndex(([k])=>k>=h);
  const right=Math.max(1,next<0?ramp.length-1:next);
  const [a,left]=ramp[right-1], [b,end]=ramp[right];
  const t=Math.max(0,Math.min(1,(h-a)/(b-a)));
  const index=at(x,z);
  const yHere=heights[index];
  const h0=offset=>Number.isFinite(heights[index+offset])?heights[index+offset]:yHere;
  const dx=(h0(1)-h0(-1))/(2*size),dz=(h0(dims)-h0(-dims))/(2*size);
  const light=Math.max(.18,Math.min(1,(.63+dx*.28-dz*.32)/Math.hypot(dx,1,dz)));
  const strength=.60+.34*light+attributes[i]*.00105;
  rgb.push(...left.map((base,j)=>Math.min(255,Math.round(strength*(base+(end[j]-base)*t)))));
}
const tree=buildOctree({positions:Float32Array.from(positions),colors:Uint8Array.from(rgb),colorComponents:3},
  {grid:48,maxPointsPerNode:9000,maxDepth:5,seed:7239});
const nodes=[];
let compressed=0, sum=0;
for(const node of tree.nodes()){
  const payload=tree.load(node);
  const record=Buffer.allocUnsafe(node.count*9);
  for(let i=0;i<node.count;i++){
    for(let k=0;k<3;k++)record.writeInt16LE(Math.round(payload.positions[i*3+k]/meter),i*9+k*2);
    for(let k=0;k<3;k++)record[i*9+6+k]=payload.colors[i*3+k];
  }
  const bytes=gzipSync(record,{level:8});
  await writeFile(new URL('cloud-'+node.id+'.tile',assets),bytes);
  compressed+=bytes.length;
  sum+=node.count;
  nodes.push({id:node.id,level:node.level,bounds:Array.from(node.bounds),spacing:node.spacing,
    count:node.count,parent:node.parent?.id??null,children:node.children.map(child=>child?.id??null)});
}
assert.equal(sum,count);
const summary={location:'Glacier Peak',year:'2014–2015',frames:'USGS 3DEP via NOAA Digital Coast',
  nodeCount:nodes.length,sampled:count,meter,heightOrigin,center:catalog.center,peak,lowest,
  root:nodes[0].id,nodes,links:{project:catalog.origin+'ept.json',noaa:'https://www.fisheries.noaa.gov/inport/item/58960'}};
await writeFile(new URL('site.json',assets),JSON.stringify(summary)+'\n');
await writeFile(new URL('source-nodes.json',assets),JSON.stringify({dataset:catalog.origin,receipts},null,2)+'\n');
console.log(JSON.stringify({count,height:[lowest,peak[1]],peak,nodes:nodes.length,root:nodes[0].count,compressed}));
