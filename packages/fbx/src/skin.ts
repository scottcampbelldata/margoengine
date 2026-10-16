import type {SkinData} from '@margoengine/exporters';
import {array, findChild, id, objectName} from './document.js';
import {inverse, multiply} from './math.js';
import {children, convertedMatrix, type SceneContext, type MeshBinding} from './scene.js';

interface PreparedSkin {name:string;cpCount:number;jointIds:Uint16Array;weights:Float64Array;joints:SkinData['joints'];binds:Float32Array}
const prepared=new WeakMap<SceneContext,Map<object,PreparedSkin|null>>();

function insertInfluence(jointIds:Uint16Array,weights:Float64Array,controlPoint:number,joint:number,weight:number):void {
  const start=controlPoint*4;
  for(let slot=0;slot<4;slot++){
    const at=start+slot;
    // Strict comparison keeps earlier joints first when weights tie. Inserting
    // shifts weaker influences down and drops the smallest of the five.
    if(weight<=weights[at])continue;
    for(let k=3;k>slot;k--){weights[start+k]=weights[start+k-1];jointIds[start+k]=jointIds[start+k-1];}
    weights[at]=weight;jointIds[at]=joint;return;
  }
}

function prepare(ctx:SceneContext,mesh:MeshBinding):PreparedSkin|null {
  const skins=children(ctx,id(mesh.source.properties[0])).filter(n=>n.name==='Deformer'&&n.properties[2]==='Skin');
  if(skins.length>1)throw new TypeError('Multiple FBX skins on geometry');if(!skins.length)return null;
  const source=skins[0],type=findChild(source,'SkinningType')?.properties[0];
  if(type!==undefined&&type!=='Linear'&&type!==0)throw new TypeError('Unsupported FBX skinning type');
  const clusters=children(ctx,id(source.properties[0])).filter(n=>n.properties[2]==='Cluster');
  if(!clusters.length||clusters.length>65535)throw new RangeError('Invalid FBX skin cluster count');
  const cpCount=array(mesh.source,'Vertices').length/3;
  if(!Number.isSafeInteger(cpCount)||cpCount<1||cpCount>1_000_000)throw new RangeError('FBX geometry budget exceeded');
  // Reserve control-point scratch once per source, before allocating it. Material
  // groups and instances reuse the same influence reduction and bind matrices.
  ctx.budget.reserve(cpCount*44+clusters.length*144);ctx.budget.work(cpCount*8+clusters.length*1024);
  const jointIds=new Uint16Array(cpCount*4),weights=new Float64Array(cpCount*4),used=new Uint32Array(cpCount);
  const joints:SkinData['joints'][number][]=[],binds=new Float32Array(clusters.length*16),seen=new Set<bigint>();
  for(const cluster of clusters){
    ctx.signal?.throwIfAborted();const label=objectName(cluster),mode=findChild(cluster,'Mode')?.properties[0];
    if(mode!==undefined&&mode!=='Normalize')throw new TypeError(`Unsupported FBX cluster mode: ${label}`);
    const links=children(ctx,id(cluster.properties[0])).filter(n=>n.name==='Model');
    if(links.length!==1)throw new TypeError(`FBX cluster needs one joint: ${label}`);
    const jointKey=id(links[0].properties[0]),joint=ctx.nodes.get(jointKey);if(!joint||seen.has(jointKey))throw new TypeError(`Invalid FBX cluster joint: ${label}`);seen.add(jointKey);
    const jointIndex=joints.length;joints.push(joint);
    let transform:ArrayLike<number>,link:ArrayLike<number>;
    try{transform=array(cluster,'Transform');link=array(cluster,'TransformLink');}catch{throw new TypeError(`Missing FBX bind matrix: ${label}`);}
    if(transform.length!==16||link.length!==16)throw new TypeError(`Invalid FBX bind matrix: ${label}`);
    // Geometry transforms are already baked into vertices. Transform is the mesh-node bind space.
    ctx.budget.reserve(256);
    const bind=multiply(inverse(convertedMatrix(ctx,link)),convertedMatrix(ctx,transform));binds.set(bind,jointIndex*16);
    for(let i=0;i<16;i++)if(!Number.isFinite(binds[jointIndex*16+i]))throw new RangeError(`Invalid FBX bind matrix: ${label}`);
    const indices=array(cluster,'Indexes'),values=array(cluster,'Weights');
    if(indices.length!==values.length)throw new RangeError(`FBX cluster weight count mismatch: ${label}`);
    ctx.budget.work(indices.length*8);
    for(let i=0;i<indices.length;i++){
      const cp=indices[i],weight=values[i];
      if(!Number.isInteger(cp)||cp<0||cp>=cpCount||used[cp]===jointIndex+1||!Number.isFinite(weight)||weight<0)throw new RangeError(`Invalid FBX cluster weight: ${label}`);used[cp]=jointIndex+1;
      if(!weight)continue;
      insertInfluence(jointIds,weights,cp,jointIndex,weight);
    }
  }
  return {name:objectName(source),cpCount,jointIds,weights,joints,binds};
}

export function attachSkin(ctx:SceneContext,mesh:MeshBinding):void {
  let cache=prepared.get(ctx);if(!cache){cache=new Map();prepared.set(ctx,cache);}
  let data=cache.get(mesh.source);
  if(data===undefined){ctx.budget.reserve(128);data=prepare(ctx,mesh);cache.set(mesh.source,data);}
  if(!data)return;
  const {jointIds,weights,joints,binds}=data;
  ctx.budget.reserve(mesh.controlPoints.length*24);ctx.budget.work(mesh.controlPoints.length*8);
  const ids=new Uint16Array(mesh.controlPoints.length*4),out=new Float32Array(ids.length);
  for(let i=0;i<mesh.controlPoints.length;i++){
    const point=mesh.controlPoints[i];if(!Number.isInteger(point)||point<0||point>=data.cpCount)throw new RangeError('Invalid FBX skin control point');
    const cp=point*4,sum=weights[cp]+weights[cp+1]+weights[cp+2]+weights[cp+3];
    if(!(sum>0)||!Number.isFinite(sum))throw new RangeError('FBX skin vertex has no positive weights');
    for(let k=0;k<4;k++){ids[i*4+k]=jointIds[cp+k];out[i*4+k]=weights[cp+k]/sum;}
  }
  mesh.geometry.joints=ids;mesh.geometry.weights=out;mesh.node.skin={name:data.name,joints,inverseBindMatrices:binds};
}
